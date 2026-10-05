-- Migration: 019_communications_hardening.sql
-- Descrição: endurecimento do envio de e-mail (achados da auditoria de segurança da 018). Nada da 015-018 foi editado.
--
--   1) RELAY/PHISHING (médio): um LÍDER só pode enviar ao e-mail cadastrado do PRÓPRIO jovem da comunicação
--      (recipient_kind = 'youth' e lower(recipient_email) = lower(youth.email)). Aplicado em dois pontos:
--        * gravação do rascunho (trigger communications_leader_recipient, só para clientes com papel leader): falha cedo
--          com erro pt-BR; vale em INSERT e em UPDATE que mude destinatário/tipo;
--        * begin_communication_send (defesa final, vale mesmo para linhas antigas/adulteradas): {ok:false,error:'invalid',
--          field:'recipient'} -> HTTP 422 invalid_content field recipient.
--      Coordenador continua livre (destinatário digitado). Efeito: líder não envia a responsável/outra pessoa;
--      um jovem sem e-mail cadastrado não recebe e-mail de líder (peça ao coordenador).
--   2) LIMITES (por usuário, janela deslizante, contados em communication_send_log): líder 10/hora e 30/dia;
--      coordenador 20/hora e 100/dia. begin serializa a contagem por usuário com pg_advisory_xact_lock.
--      Estouro -> {ok:false,error:'rate_limited',window:'hour'|'day',retry_after_seconds}.
--   3) communication_send_log.communication_id: FK passa a ON DELETE SET NULL (coluna anulável): o log (e portanto o limite)
--      sobrevive à exclusão da comunicação, impedindo "criar rascunho -> enviar -> excluir" para zerar a contagem.
--      Linhas com mais de 2 dias são apagadas a cada begin.
--   (O item "Idempotency-Key estável por conteúdo" é da Edge Function; não há mudança de banco.)
--
-- LIMITAÇÃO DE TESTE (PGlite): o advisory lock não é testável contra concorrência real (uma conexão).
-- IMPORTANTE: Execute no SQL Editor do Supabase APÓS a migration 018.
-- ============================================================================

-- ---------------------------------------------------------------- 3) log sobrevive
ALTER TABLE public.communication_send_log DROP CONSTRAINT IF EXISTS communication_send_log_communication_id_fkey;
ALTER TABLE public.communication_send_log ALTER COLUMN communication_id DROP NOT NULL;
ALTER TABLE public.communication_send_log
  ADD CONSTRAINT communication_send_log_communication_id_fkey
  FOREIGN KEY (communication_id) REFERENCES public.communications(id) ON DELETE SET NULL;


-- ---------------------------------------------------------------- 1a) rascunho de líder
CREATE OR REPLACE FUNCTION public.communications_leader_recipient()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_email text;
BEGIN
  -- Só clientes com papel leader. (communications_guard, que roda antes por ordem alfabética, já normalizou o e-mail.)
  IF current_user NOT IN ('anon', 'authenticated') OR public.get_my_role() IS DISTINCT FROM 'leader' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE'
     AND NEW.recipient_email IS NOT DISTINCT FROM OLD.recipient_email
     AND NEW.recipient_kind  IS NOT DISTINCT FROM OLD.recipient_kind THEN
    RETURN NEW;
  END IF;
  SELECT lower(btrim(y.email)) INTO v_email FROM public.youth y WHERE y.id = NEW.youth_id;
  IF NEW.recipient_kind IS DISTINCT FROM 'youth' OR v_email IS NULL OR v_email IS DISTINCT FROM NEW.recipient_email THEN
    RAISE EXCEPTION 'Líderes só podem enviar ao e-mail cadastrado do próprio jovem.' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.communications_leader_recipient() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER communications_leader_recipient
  BEFORE INSERT OR UPDATE ON public.communications
  FOR EACH ROW EXECUTE PROCEDURE public.communications_leader_recipient();


-- ---------------------------------------------------------------- 1b/2) begin
CREATE OR REPLACE FUNCTION public.begin_communication_send(p_id uuid, p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  c            public.communications;
  v_role       public.user_role;
  v_in_scope   boolean;
  v_count      integer;
  v_oldest     timestamptz;
  v_yemail     text;
  v_sname      text;
  v_semail     text;
  v_stale      constant interval := interval '5 minutes';
  v_field      text;
  v_hour_limit integer;
  v_day_limit  integer;
BEGIN
  IF p_id IS NULL OR p_user_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_found');
  END IF;

  -- Serializa a contagem de limites por usuário (chamadas concorrentes do mesmo usuário esperam).
  PERFORM pg_advisory_xact_lock(hashtext(p_user_id::text));

  SELECT r.role INTO v_role FROM public.user_roles r WHERE r.user_id = p_user_id;
  IF v_role IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_found');
  END IF;

  SELECT * INTO c FROM public.communications WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_found');
  END IF;

  IF v_role = 'coordinator' THEN
    v_in_scope := true;
  ELSE
    v_in_scope := c.created_by IS NOT DISTINCT FROM p_user_id
      AND EXISTS (SELECT 1 FROM public.youth y
                    JOIN public.groups g ON g.id = y.group_id
                   WHERE y.id = c.youth_id AND g.leader_id = p_user_id);
  END IF;
  IF NOT v_in_scope THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_found');
  END IF;

  IF c.youth_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid', 'field', 'youth');
  END IF;

  IF c.status::text = 'sent' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'conflict', 'reason', 'already_sent');
  ELSIF c.status::text = 'cancelled' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'conflict', 'reason', 'not_sendable');
  ELSIF c.status::text = 'sending'
        AND c.last_attempt_at IS NOT NULL AND c.last_attempt_at >= now() - v_stale THEN
    RETURN jsonb_build_object('ok', false, 'error', 'conflict', 'reason', 'in_progress');
  END IF;

  v_field := CASE
    WHEN NOT public.is_valid_email(c.recipient_email) THEN 'recipient_email'
    WHEN c.recipient_name IS NOT NULL AND NOT public.is_single_line_text(c.recipient_name) THEN 'recipient_name'
    WHEN c.subject IS NULL OR length(btrim(c.subject)) = 0 OR length(c.subject) > 200
         OR NOT public.is_single_line_text(c.subject) THEN 'subject'
    WHEN c.body IS NULL OR length(btrim(c.body, E' \t\r\n')) = 0 OR length(c.body) > 5000
         OR c.body ~ '[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]' THEN 'body'
    ELSE NULL END;
  -- Líder: só o e-mail cadastrado do próprio jovem (anti-relay/phishing).
  IF v_field IS NULL AND v_role = 'leader' THEN
    SELECT lower(btrim(y.email)) INTO v_yemail FROM public.youth y WHERE y.id = c.youth_id;
    IF c.recipient_kind <> 'youth' OR v_yemail IS NULL OR lower(c.recipient_email) <> v_yemail THEN
      v_field := 'recipient';
    END IF;
  END IF;
  IF v_field IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid', 'field', v_field);
  END IF;

  -- Limites (nenhuma mudança de estado se estourar)
  v_hour_limit := CASE WHEN v_role = 'leader' THEN 10 ELSE 20 END;
  v_day_limit  := CASE WHEN v_role = 'leader' THEN 30 ELSE 100 END;
  DELETE FROM public.communication_send_log WHERE started_at < now() - interval '2 days';

  SELECT count(*)::integer, min(started_at) INTO v_count, v_oldest
    FROM public.communication_send_log
   WHERE user_id = p_user_id AND started_at > now() - interval '1 hour';
  IF v_count >= v_hour_limit THEN
    RETURN jsonb_build_object('ok', false, 'error', 'rate_limited', 'window', 'hour',
      'retry_after_seconds', GREATEST(1, ceil(extract(epoch FROM (v_oldest + interval '1 hour' - now())))::integer));
  END IF;
  SELECT count(*)::integer, min(started_at) INTO v_count, v_oldest
    FROM public.communication_send_log
   WHERE user_id = p_user_id AND started_at > now() - interval '1 day';
  IF v_count >= v_day_limit THEN
    RETURN jsonb_build_object('ok', false, 'error', 'rate_limited', 'window', 'day',
      'retry_after_seconds', GREATEST(1, ceil(extract(epoch FROM (v_oldest + interval '1 day' - now())))::integer));
  END IF;

  UPDATE public.communications
     SET status = 'sending',
         attempts = attempts + 1,
         last_attempt_at = now(),
         sent_by = p_user_id
   WHERE id = p_id
     AND (status::text IN ('draft', 'failed')
          OR (status::text = 'sending' AND (last_attempt_at IS NULL OR last_attempt_at < now() - v_stale)))
   RETURNING * INTO c;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'conflict', 'reason', 'in_progress');
  END IF;

  INSERT INTO public.communication_send_log (user_id, communication_id) VALUES (p_user_id, p_id);

  SELECT p.full_name INTO v_sname FROM public.profiles p WHERE p.id = p_user_id;
  SELECT u.email INTO v_semail FROM auth.users u WHERE u.id = p_user_id;

  RETURN jsonb_build_object(
    'ok', true,
    'id', c.id,
    'attempts', c.attempts,
    'recipient_email', c.recipient_email,
    'recipient_name', c.recipient_name,
    'subject', c.subject,
    'body', c.body,
    'sender_name', v_sname,
    'sender_email', CASE WHEN public.is_valid_email(lower(btrim(v_semail))) THEN lower(btrim(v_semail)) END);
END;
$$;

REVOKE ALL ON FUNCTION public.begin_communication_send(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.begin_communication_send(uuid, uuid) TO service_role;

NOTIFY pgrst, 'reload schema';
