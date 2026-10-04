-- Migration: 018_communications_server_send.sql
-- Descrição: e-mail com ENVIO PELO SERVIDOR e resultado REAL do provedor (substitui o fluxo "assistido" da 015).
--
-- FLUXO: alerta/acompanhamento -> comunicação (rascunho) -> a pessoa revisa -> UM clique em "Enviar" -> o frontend chama a
-- Edge Function `send-communication` (supabase/functions/send-communication) -> a função autentica o JWT, chama
-- begin_communication_send() -> envia ao provedor (Resend) -> chama finish_communication_send() com o resultado real ->
-- a linha vira `sent` (com o id da mensagem do provedor) ou `failed` (com um código fechado). Nada é automático:
-- só há envio quando a pessoa clica; nenhuma regra de alerta dispara e-mail.
--
-- MÁQUINA DE ESTADOS (draft, sending, sent, failed, cancelled):
--   CLIENTES (anon/authenticated), por UPDATE direto OU por mark_communication():
--     * editam rascunho; draft -> cancelled; failed -> draft (reabrir para corrigir) | cancelled.
--     * NUNCA definem `sending` nem `sent` (nem draft -> failed: a falha é um fato do servidor, não declaração).
--     * `sending` é intocável para clientes (inclusive cancelar): o servidor decide o fim. Se a função morrer no meio, o
--       estado `sending` fica "preso" e é RETOMÁVEL por begin_communication_send() após 5 minutos.
--     * `sent` e `cancelled` são terminais e imutáveis.
--     * provider, provider_message_id, attempts, last_attempt_at, failure_reason, sent_at, sent_by: clientes não alteram
--       (os valores enviados são DESCARTADOS silenciosamente pelo guard, como sent_at/sent_by na 015).
--   SERVIDOR (begin/finish, SECURITY DEFINER, EXECUTE só para service_role):
--     draft | failed -> sending -> sent | failed.   (sending antigo > 5 min -> sending de novo = nova tentativa.)
--   Ações sem sessão de cliente (SQL Editor/service_role direto) seguem fora da máquina de estados, como na 015.
--
-- DECISÕES
--   * sent_by guarda QUEM clicou em enviar: é gravado em begin (estado `sending`) e vira o responsável do envio em `sent`.
--     Em `failed`/`draft`/`cancelled` sent_by é NULL (como na 015). Na falha o quem fica em communication_send_log.
--   * sent exige sent_at (CHECK da 015). provider_message_id PODE ser NULL em `sent`: (a) linhas legadas do modelo
--     assistido não têm provedor; (b) se o provedor responder 2xx sem id, o e-mail foi aceito e marcá-lo como falha
--     induziria reenvio duplicado. Para envios novos a Edge Function sempre grava `provider`; provider_message_id só
--     existe em `sent` (CHECK) e nunca em outros estados.
--   * failure_reason: lista fechada. Novos: provider_not_configured, provider_rejected, invalid_address, network, timeout,
--     unknown. Mantidos só por causa de linhas legadas da 015: client_not_opened, bounced, other (o servidor nunca os grava;
--     finish converte qualquer valor fora dos 6 novos em 'unknown').
--   * Rate limit: no máximo 20 envios INICIADOS por usuário por hora (tabela mínima communication_send_log, só funções
--     DEFINER acessam; linhas com mais de 1 dia são apagadas a cada begin). Estourou -> erro estruturado, sem mudar estado.
--   * begin/finish NÃO levantam exceção para erros de negócio: devolvem jsonb {"ok": false, "error": "..."} para a Edge
--     Function mapear em HTTP. Erros: not_found (inexistente OU fora do escopo: não vaza existência), conflict
--     (reason already_sent | in_progress | not_sendable), invalid (field), rate_limited (retry_after_seconds).
--   * finish é idempotente: se a linha não está em `sending`, NADA muda e devolve {"ok": true, "changed": false, status}.
--   * finish atribui o histórico (activity_log) ao usuário que iniciou: define request.jwt.claim.sub apenas dentro da
--     transação da própria função (service_role não tem sub) e o restaura. activity_log recebe `communication_sent` SÓ
--     quando vira `sent` (texto fixo, sem assunto/corpo/e-mail/nome; garantias da 015/016 mantidas).
--   * Escopo (igual à regra de escrita de communications): coordenador, ou líder que CRIOU a comunicação e cujo grupo ATUAL
--     é o do jovem. Comunicação sem jovem (jovem excluído) não é enviável.
--   * ALTER TYPE ... ADD VALUE: o valor `sending` não pode ser USADO na mesma transação que o cria. Por isso ele só aparece
--     em corpos PL/pgSQL (resolvidos em tempo de execução), nunca em CHECK, índice parcial, função SQL ou DEFAULT.
--
-- LIMITAÇÃO DO HARNESS (PGlite): conexão única e sequencial; "concorrência" é testada logicamente (segundo begin sobre um
-- `sending` recente é recusado; `sending` antigo é retomável). Corrida real entre duas transações não é reproduzida;
-- é mitigada por SELECT ... FOR UPDATE + UPDATE condicional.
-- RISCO RESIDUAL: se o provedor aceitar o e-mail e finish falhar (queda de rede/banco), a linha fica em `sending` mesmo
-- tendo saído o e-mail; ao retomar (5 min) o usuário poderia reenviar -> possível duplicata. A Edge Function tenta
-- finish 2 vezes e usa Idempotency-Key (id + attempts), que o provedor só deduplica dentro da mesma tentativa.
--
-- IMPORTANTE: Execute no SQL Editor do Supabase APÓS a migration 017.
-- ============================================================================


-- ============================================================================
-- 1. Enum e colunas
-- ============================================================================
ALTER TYPE communication_status ADD VALUE IF NOT EXISTS 'sending' BEFORE 'sent';

ALTER TABLE public.communications
  ADD COLUMN provider            text
    CHECK (provider IS NULL OR provider ~ '^[a-z0-9_-]{1,40}$'),
  ADD COLUMN provider_message_id text
    CHECK (provider_message_id IS NULL
           OR (length(provider_message_id) BETWEEN 1 AND 200 AND provider_message_id !~ '[\x01-\x1f\x7f]')),
  ADD COLUMN attempts            integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  ADD COLUMN last_attempt_at     timestamp with time zone;

-- provider_message_id só existe em `sent` (não referencia o valor novo do enum).
ALTER TABLE public.communications
  ADD CONSTRAINT communications_provider_message_id_sent
  CHECK (provider_message_id IS NULL OR status = 'sent');

-- failure_reason: troca o CHECK de coluna única (nome automático) por um superconjunto. A constraint de consistência
-- (status <-> failure_reason, duas colunas) NÃO é tocada.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT c.conname
      FROM pg_constraint c
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
     WHERE c.conrelid = 'public.communications'::regclass
       AND c.contype = 'c'
       AND array_length(c.conkey, 1) = 1
       AND a.attname = 'failure_reason'
  LOOP
    EXECUTE format('ALTER TABLE public.communications DROP CONSTRAINT %I', r.conname);
  END LOOP;
END;
$$;

ALTER TABLE public.communications ADD CONSTRAINT communications_failure_reason_check
  CHECK (failure_reason IN (
    'provider_not_configured', 'provider_rejected', 'invalid_address', 'network', 'timeout', 'unknown',
    'client_not_opened', 'bounced', 'other'));   -- as 3 últimas: só linhas legadas (015)


-- ============================================================================
-- 2. Tabela mínima do rate limit (e trilha de quem iniciou cada tentativa)
-- ============================================================================
CREATE TABLE public.communication_send_log (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id          uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  communication_id uuid NOT NULL REFERENCES public.communications(id) ON DELETE CASCADE,
  started_at       timestamp with time zone NOT NULL DEFAULT now()
);
CREATE INDEX communication_send_log_user_idx ON public.communication_send_log (user_id, started_at DESC);

ALTER TABLE public.communication_send_log ENABLE ROW LEVEL SECURITY;   -- sem policies: nenhum cliente lê/escreve
REVOKE ALL ON public.communication_send_log FROM PUBLIC, anon, authenticated;


-- ============================================================================
-- 3. Guard (CREATE OR REPLACE da 015): nova máquina de estados
-- ============================================================================
CREATE OR REPLACE FUNCTION public.communications_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_client  boolean := current_user IN ('anon', 'authenticated');
  v_uid     uuid := auth.uid();
  v_ref     uuid;
  v_changed boolean;
BEGIN
  -- Normalização (não altera o que já está normalizado, então comparações com OLD continuam válidas)
  NEW.recipient_email := lower(btrim(NEW.recipient_email));
  NEW.recipient_name  := NULLIF(btrim(NEW.recipient_name), '');
  NEW.subject         := btrim(NEW.subject);

  IF TG_OP = 'INSERT' THEN
    IF v_client THEN
      IF v_uid IS NULL THEN
        RAISE EXCEPTION 'Sessão inválida.' USING ERRCODE = '42501';
      END IF;
      NEW.created_by          := v_uid;
      NEW.created_at          := timezone('utc', now());
      NEW.sent_at             := NULL;
      NEW.sent_by             := NULL;
      NEW.failure_reason      := NULL;
      NEW.provider            := NULL;
      NEW.provider_message_id := NULL;
      NEW.attempts            := 0;
      NEW.last_attempt_at     := NULL;
      IF NEW.status::text IS DISTINCT FROM 'draft' THEN
        RAISE EXCEPTION 'A comunicação deve ser criada como rascunho.' USING ERRCODE = 'P0001';
      END IF;
      IF NEW.youth_id IS NULL THEN
        RAISE EXCEPTION 'Informe o jovem da comunicação.' USING ERRCODE = 'P0001';
      END IF;
    END IF;
  ELSE
    IF v_client THEN
      IF NEW.id IS DISTINCT FROM OLD.id OR NEW.channel IS DISTINCT FROM OLD.channel
         OR NEW.youth_id IS DISTINCT FROM OLD.youth_id
         OR NEW.alert_id IS DISTINCT FROM OLD.alert_id
         OR NEW.follow_up_id IS DISTINCT FROM OLD.follow_up_id THEN
        RAISE EXCEPTION 'O jovem e os vínculos de uma comunicação não podem ser alterados.' USING ERRCODE = '42501';
      END IF;
      -- Tudo que é "fato do servidor" é restaurado: o cliente não escreve nestas colunas.
      NEW.created_by          := OLD.created_by;
      NEW.created_at          := OLD.created_at;
      NEW.failure_reason      := OLD.failure_reason;
      NEW.sent_at             := OLD.sent_at;
      NEW.sent_by             := OLD.sent_by;
      NEW.provider            := OLD.provider;
      NEW.provider_message_id := OLD.provider_message_id;
      NEW.attempts            := OLD.attempts;
      NEW.last_attempt_at     := OLD.last_attempt_at;

      -- sent, cancelled e sending: nenhuma alteração por clientes (um UPDATE que não muda nada passa).
      IF OLD.status::text IN ('sent', 'cancelled', 'sending')
         AND (to_jsonb(NEW) - 'updated_at') IS DISTINCT FROM (to_jsonb(OLD) - 'updated_at') THEN
        RAISE EXCEPTION '%', CASE OLD.status::text
          WHEN 'sent'      THEN 'Comunicações enviadas não podem ser alteradas.'
          WHEN 'sending'   THEN 'Comunicação em envio não pode ser alterada.'
          ELSE                  'Comunicações canceladas não podem ser alteradas.' END
          USING ERRCODE = 'P0001';
      END IF;

      v_changed := (NEW.recipient_email, NEW.recipient_name, NEW.recipient_kind, NEW.subject, NEW.body)
                   IS DISTINCT FROM
                   (OLD.recipient_email, OLD.recipient_name, OLD.recipient_kind, OLD.subject, OLD.body);

      IF NEW.status = OLD.status THEN
        IF OLD.status::text = 'failed' AND v_changed THEN
          RAISE EXCEPTION 'Para editar uma comunicação que falhou, volte-a para rascunho.' USING ERRCODE = 'P0001';
        END IF;
      ELSE
        IF v_changed THEN
          RAISE EXCEPTION 'Altere o conteúdo e o status em operações separadas.' USING ERRCODE = 'P0001';
        END IF;
        IF NEW.status::text IN ('sending', 'sent') THEN
          RAISE EXCEPTION 'O envio é feito pelo servidor: não é possível marcar como enviada.' USING ERRCODE = 'P0001';
        END IF;
        IF NOT ((OLD.status::text = 'draft'  AND NEW.status::text = 'cancelled')
             OR (OLD.status::text = 'failed' AND NEW.status::text IN ('draft', 'cancelled'))) THEN
          RAISE EXCEPTION 'Mudança de status não permitida.' USING ERRCODE = 'P0001';
        END IF;
      END IF;
    END IF;
  END IF;

  -- Consistência (vale também para quem não é cliente)
  IF NEW.status::text = 'failed' THEN
    NEW.failure_reason := COALESCE(NEW.failure_reason, 'unknown');
  ELSE
    NEW.failure_reason := NULL;
  END IF;
  IF NEW.status::text = 'sent' THEN
    IF NEW.sent_at IS NULL THEN
      NEW.sent_at := timezone('utc', now());
      NEW.sent_by := COALESCE(NEW.sent_by, v_uid);
    END IF;
  ELSE
    NEW.sent_at := NULL;
  END IF;
  IF NEW.status::text NOT IN ('sent', 'sending') THEN
    NEW.sent_by := NULL;      -- em `sending` sent_by = quem iniciou o envio
  END IF;
  IF NEW.status::text <> 'sent' THEN
    NEW.provider_message_id := NULL;
  END IF;
  IF NEW.status::text NOT IN ('sent', 'failed') THEN
    NEW.provider := NULL;
  END IF;

  -- Mensagens amigáveis (os CHECKs são a rede de segurança)
  IF NOT public.is_valid_email(NEW.recipient_email) THEN
    RAISE EXCEPTION 'Informe um e-mail de destinatário válido.' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.recipient_name IS NOT NULL AND NOT public.is_single_line_text(NEW.recipient_name) THEN
    RAISE EXCEPTION 'O nome do destinatário não pode ter quebras de linha.' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.subject IS NULL OR length(NEW.subject) = 0 THEN
    RAISE EXCEPTION 'Informe o assunto.' USING ERRCODE = 'P0001';
  END IF;
  IF NOT public.is_single_line_text(NEW.subject) THEN
    RAISE EXCEPTION 'O assunto não pode ter quebras de linha.' USING ERRCODE = 'P0001';
  END IF;

  -- Jovem, alerta e acompanhamento: precisam existir (e ser visíveis a quem grava) e ser do MESMO jovem.
  IF NEW.youth_id IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.youth_id IS DISTINCT FROM OLD.youth_id) THEN
    PERFORM 1 FROM public.youth y WHERE y.id = NEW.youth_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Jovem não encontrado ou sem permissão.' USING ERRCODE = 'P0002';
    END IF;
  END IF;
  IF NEW.youth_id IS NOT NULL AND NEW.alert_id IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW.alert_id IS DISTINCT FROM OLD.alert_id) THEN
    SELECT a.youth_id INTO v_ref FROM public.alerts a WHERE a.id = NEW.alert_id;
    IF NOT FOUND OR v_ref IS DISTINCT FROM NEW.youth_id THEN
      RAISE EXCEPTION 'O alerta informado não pertence a este jovem.' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  IF NEW.youth_id IS NOT NULL AND NEW.follow_up_id IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW.follow_up_id IS DISTINCT FROM OLD.follow_up_id) THEN
    SELECT f.youth_id INTO v_ref FROM public.follow_ups f WHERE f.id = NEW.follow_up_id;
    IF NOT FOUND OR v_ref IS DISTINCT FROM NEW.youth_id THEN
      RAISE EXCEPTION 'O acompanhamento informado não pertence a este jovem.' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.communications_guard() FROM PUBLIC, anon, authenticated;


-- ============================================================================
-- 4. mark_communication (015): clientes só cancelam ou reabrem
-- ============================================================================
-- Assinatura e retorno mantidos. 'sent', 'failed' e 'sending' NÃO são mais aceitos de clientes (erro em pt-BR).
-- p_failure_reason é mantido por compatibilidade e IGNORADO (clientes não definem motivo de falha).
CREATE OR REPLACE FUNCTION public.mark_communication(
  p_id             uuid,
  p_status         text,
  p_failure_reason text DEFAULT NULL
)
RETURNS public.communications
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_old public.communications;
  v_new public.communications;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Sessão inválida.' USING ERRCODE = '42501';
  END IF;
  IF p_status IS NULL OR p_status NOT IN ('draft', 'sending', 'sent', 'failed', 'cancelled') THEN
    RAISE EXCEPTION 'Status inválido.' USING ERRCODE = 'P0001';
  END IF;
  IF p_status IN ('sending', 'sent', 'failed') THEN
    RAISE EXCEPTION 'O envio é feito pelo servidor: não é possível marcar como enviada ou falha.' USING ERRCODE = 'P0001';
  END IF;

  -- FOR UPDATE aplica as policies de SELECT e UPDATE: fora do escopo => "não encontrada" (não vaza existência).
  SELECT * INTO v_old FROM public.communications WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Comunicação não encontrada ou sem permissão.' USING ERRCODE = 'P0002';
  END IF;
  IF v_old.status::text = p_status THEN
    RAISE EXCEPTION 'A comunicação já está com esse status.' USING ERRCODE = 'P0001';
  END IF;

  UPDATE public.communications
     SET status = p_status::communication_status
   WHERE id = p_id
   RETURNING * INTO v_new;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Comunicação não encontrada ou sem permissão.' USING ERRCODE = 'P0002';
  END IF;
  RETURN v_new;
END;
$$;

REVOKE ALL ON FUNCTION public.mark_communication(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mark_communication(uuid, text, text) TO authenticated;


-- ============================================================================
-- 5. begin_communication_send (SÓ service_role)
-- ============================================================================
-- Devolve {"ok": true, id, attempts, recipient_email, recipient_name, subject, body, sender_name, sender_email}
-- ou {"ok": false, "error": ...} (ver cabeçalho). sender_email = e-mail do usuário que clicou (vai como reply-to).
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
  v_sname      text;
  v_semail     text;
  v_stale      constant interval := interval '5 minutes';
  v_window     constant interval := interval '1 hour';
  v_limit      constant integer  := 20;
  v_field      text;
BEGIN
  IF p_id IS NULL OR p_user_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_found');
  END IF;

  SELECT r.role INTO v_role FROM public.user_roles r WHERE r.user_id = p_user_id;
  IF v_role IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_found');
  END IF;

  SELECT * INTO c FROM public.communications WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_found');
  END IF;

  -- Escopo = regra de escrita de communications (policies da 015).
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

  -- Estado
  IF c.status::text = 'sent' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'conflict', 'reason', 'already_sent');
  ELSIF c.status::text = 'cancelled' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'conflict', 'reason', 'not_sendable');
  ELSIF c.status::text = 'sending'
        AND c.last_attempt_at IS NOT NULL AND c.last_attempt_at >= now() - v_stale THEN
    RETURN jsonb_build_object('ok', false, 'error', 'conflict', 'reason', 'in_progress');
  END IF;

  -- Conteúdo (os CHECKs da tabela já garantem; revalida porque o que sai do banco é o que será enviado)
  v_field := CASE
    WHEN NOT public.is_valid_email(c.recipient_email) THEN 'recipient_email'
    WHEN c.recipient_name IS NOT NULL AND NOT public.is_single_line_text(c.recipient_name) THEN 'recipient_name'
    WHEN c.subject IS NULL OR length(btrim(c.subject)) = 0 OR length(c.subject) > 200
         OR NOT public.is_single_line_text(c.subject) THEN 'subject'
    WHEN c.body IS NULL OR length(btrim(c.body, E' \t\r\n')) = 0 OR length(c.body) > 5000
         OR c.body ~ '[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]' THEN 'body'
    ELSE NULL END;
  IF v_field IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid', 'field', v_field);
  END IF;

  -- Rate limit por usuário (nenhuma mudança de estado se estourar)
  DELETE FROM public.communication_send_log WHERE started_at < now() - interval '1 day';
  SELECT count(*)::integer, min(started_at) INTO v_count, v_oldest
    FROM public.communication_send_log
   WHERE user_id = p_user_id AND started_at > now() - v_window;
  IF v_count >= v_limit THEN
    RETURN jsonb_build_object('ok', false, 'error', 'rate_limited',
      'retry_after_seconds', GREATEST(1, ceil(extract(epoch FROM (v_oldest + v_window - now())))::integer));
  END IF;

  -- Transição atômica (a linha já está travada; o predicado repete a regra de forma defensiva)
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


-- ============================================================================
-- 6. finish_communication_send (SÓ service_role)
-- ============================================================================
-- Devolve {"ok": true, "changed": bool, "status", "sent_at", "failure_reason"} ou {"ok": false, "error": "not_found"}.
CREATE OR REPLACE FUNCTION public.finish_communication_send(
  p_id                  uuid,
  p_ok                  boolean,
  p_provider            text,
  p_provider_message_id text,
  p_failure_reason      text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  c          public.communications;
  v_provider text;
  v_msg_id   text;
  v_reason   text;
  v_prev_sub text;
BEGIN
  IF p_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_found');
  END IF;
  SELECT * INTO c FROM public.communications WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_found');
  END IF;

  -- Idempotência: fora de `sending` nada muda (segunda chamada, ou chamada sem begin).
  IF c.status::text <> 'sending' THEN
    RETURN jsonb_build_object('ok', true, 'changed', false, 'status', c.status::text,
                              'sent_at', c.sent_at, 'failure_reason', c.failure_reason);
  END IF;

  v_provider := NULLIF(left(regexp_replace(lower(COALESCE(p_provider, '')), '[^a-z0-9_-]', '', 'g'), 40), '');
  v_provider := COALESCE(v_provider, 'unknown');
  v_msg_id := NULLIF(left(btrim(regexp_replace(COALESCE(p_provider_message_id, ''), '[\x01-\x1f\x7f]', '', 'g')), 200), '');

  IF COALESCE(p_ok, false) THEN
    -- O histórico (activity_log) é atribuído a quem iniciou o envio: auth.uid() lê request.jwt.claim.sub
    -- (service_role não tem sub). Local à transação da função; o valor anterior é restaurado.
    v_prev_sub := current_setting('request.jwt.claim.sub', true);
    IF c.sent_by IS NOT NULL THEN
      PERFORM set_config('request.jwt.claim.sub', c.sent_by::text, true);
    END IF;

    UPDATE public.communications
       SET status = 'sent',
           sent_at = timezone('utc', now()),
           provider = v_provider,
           provider_message_id = v_msg_id
     WHERE id = p_id
     RETURNING * INTO c;

    PERFORM set_config('request.jwt.claim.sub', COALESCE(v_prev_sub, ''), true);
  ELSE
    v_reason := CASE WHEN p_failure_reason IN ('provider_not_configured', 'provider_rejected', 'invalid_address',
                                               'network', 'timeout', 'unknown')
                     THEN p_failure_reason ELSE 'unknown' END;
    UPDATE public.communications
       SET status = 'failed',
           failure_reason = v_reason,
           provider = v_provider
     WHERE id = p_id
     RETURNING * INTO c;
  END IF;

  RETURN jsonb_build_object('ok', true, 'changed', true, 'status', c.status::text,
                            'sent_at', c.sent_at, 'failure_reason', c.failure_reason);
END;
$$;

REVOKE ALL ON FUNCTION public.finish_communication_send(uuid, boolean, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finish_communication_send(uuid, boolean, text, text, text) TO service_role;


-- ============================================================================
-- 7. Histórico operacional: o texto agora descreve um envio real
-- ============================================================================
-- Mesmo gatilho da 015 (AFTER UPDATE OF status ... WHEN vira `sent`); como cliente não consegue mais chegar a `sent`,
-- só o servidor (finish) o dispara. Texto fixo; meta só com ids/enums (nunca assunto, corpo, nome ou e-mail).
CREATE OR REPLACE FUNCTION public.communications_log_activity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM public.activity_write(
    'communication_sent', 'communication', NEW.id, NEW.youth_id,
    (SELECT y.group_id FROM public.youth y WHERE y.id = NEW.youth_id),
    'Comunicação por e-mail enviada.',
    jsonb_build_object('channel', NEW.channel, 'recipient_kind', NEW.recipient_kind,
                       'alert_id', NEW.alert_id, 'follow_up_id', NEW.follow_up_id, 'provider', NEW.provider));
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.communications_log_activity() FROM PUBLIC, anon, authenticated;

NOTIFY pgrst, 'reload schema';
