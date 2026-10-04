-- ============================================================================
-- 017 — Correções finais (achados confirmados após a 016)
-- ============================================================================
--   1) Excluir grupo: BUG (FK em activity_log) + perda de histórico de chamada.
--   2) Nota de resolução do alerta `no_followup` quando followup_grace_days AUMENTA.
--   3) Hardening: funções que RETORNAM trigger não são executáveis por PUBLIC/anon/authenticated.
--   4) Sanidade (somente documentação): linhas legadas de `communications` com e-mail inválido.
--
-- ----------------------------------------------------------------------------
-- 4) VERIFICAÇÃO PRÉ-APLICAÇÃO DA 016 (nenhum dado é alterado por esta migration)
-- ----------------------------------------------------------------------------
-- A 016 trocou is_valid_email() para recusar '%' no local-part. Se a tabela `communications` (015) já tinha
-- linhas com e-mail aceito pela versão antiga (ex.: 'a%b@dominio.com'), elas passam a violar a regra recém-criada
-- (a 016 não revalida linhas existentes; um UPDATE futuro dessas linhas seria recusado). ANTES de aplicar a 016
-- (ou agora, se já aplicada) rode no SQL Editor:
--
--     SELECT id FROM public.communications WHERE NOT public.is_valid_email(recipient_email);
--
-- Resultado vazio = nada a fazer. Havendo linhas, corrigir/arquivar manualmente (comunicações são histórico:
-- avalie caso a caso; não há correção automática segura). Esta migration NÃO executa essa correção.
-- (Se a 016 ainda não foi aplicada, a consulta usa a is_valid_email da 015, que ACEITA '%': nesse caso procure
--  por `WHERE recipient_email LIKE '%\%%@%'`.)
--
-- ----------------------------------------------------------------------------
-- 1) Exclusão de grupo
-- ----------------------------------------------------------------------------
-- Problemas:
--   * ON DELETE SET NULL de youth.group_id dispara youth_log_activity (014), que gravava
--     group_id = COALESCE(NEW.group_id, OLD.group_id) = o grupo que está sendo excluído -> violação de FK em
--     activity_log (o grupo já não existe) e a exclusão inteira falhava com erro técnico.
--   * attendance.group_id é ON DELETE CASCADE: excluir o grupo apagaria a chamada; como o histórico segue o jovem
--     (012), isso destruiria presença de jovens atuais.
-- Solução mínima e segura: BEFORE DELETE recusa excluir grupo com jovens (qualquer status) ou com registros de
-- attendance. Grupo vazio e sem histórico continua excluível (coordenador, via RLS). Além disso
-- youth_log_activity nunca grava group_id inexistente (guarda EXISTS).
-- A função é SECURITY DEFINER para que a contagem não dependa do RLS de quem exclui.
CREATE OR REPLACE FUNCTION public.groups_block_delete_with_history()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.youth y WHERE y.group_id = OLD.id)
     OR EXISTS (SELECT 1 FROM public.attendance a WHERE a.group_id = OLD.id) THEN
    RAISE EXCEPTION 'Não é possível excluir um grupo com jovens ou histórico de chamada. Mova os jovens para outro grupo primeiro.'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN OLD;
END;
$$;

REVOKE ALL ON FUNCTION public.groups_block_delete_with_history() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER groups_block_delete_with_history
  BEFORE DELETE ON public.groups
  FOR EACH ROW EXECUTE PROCEDURE public.groups_block_delete_with_history();

-- youth_log_activity (014) com guarda: só grava group_id que ainda existe. search_path mantém pg_temp (016).
CREATE OR REPLACE FUNCTION public.youth_log_activity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_gid uuid;
BEGIN
  IF NEW.group_id IS DISTINCT FROM OLD.group_id THEN
    v_gid := COALESCE(NEW.group_id, OLD.group_id);
    IF v_gid IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.groups g WHERE g.id = v_gid) THEN
      v_gid := NULL;
    END IF;
    PERFORM public.activity_write('youth_group_changed', 'youth', NEW.id, NEW.id,
                                  v_gid,
                                  CASE WHEN NEW.group_id IS NULL THEN 'Jovem desassociado do grupo.'
                                       ELSE 'Grupo do jovem alterado.' END,
                                  jsonb_build_object('from_group_id', OLD.group_id, 'to_group_id', NEW.group_id));
  END IF;
  IF NEW.is_active IS DISTINCT FROM OLD.is_active THEN
    v_gid := NEW.group_id;
    IF v_gid IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.groups g WHERE g.id = v_gid) THEN
      v_gid := NULL;
    END IF;
    PERFORM public.activity_write(
      CASE WHEN NEW.is_active THEN 'youth_activated' ELSE 'youth_deactivated' END,
      'youth', NEW.id, NEW.id, v_gid,
      CASE WHEN NEW.is_active THEN 'Jovem reativado.' ELSE 'Jovem inativado.' END,
      '{}'::jsonb);
  END IF;
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.youth_log_activity() FROM PUBLIC, anon, authenticated;


-- ----------------------------------------------------------------------------
-- 2) Nota do encerramento automático de no_followup
-- ----------------------------------------------------------------------------
-- 011 usava 'acompanhamento registrado' em qualquer caso que não fosse jovem inativado / faltas encerradas,
-- inclusive quando a causa era só o aumento de followup_grace_days. Agora a nota reflete a causa real:
--   jovem inativado > alerta de faltas encerrado > acompanhamento registrado > prazo de carência ampliado.
-- Corpo idêntico ao da 011, exceto v_has_fu e a nota; search_path mantém pg_temp (016).
CREATE OR REPLACE FUNCTION public.refresh_youth_time_alerts(p_youth_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_group     uuid;
  v_active    boolean;
  v_grace     integer;
  v_fa_at     timestamptz;
  v_fa_event  uuid;
  v_fa_found  boolean := false;
  v_has_fu    boolean := false;
  v_days      integer := 0;
  v_cond      boolean := false;
  v_overdue   integer;
BEGIN
  SELECT group_id, is_active INTO v_group, v_active FROM public.youth WHERE id = p_youth_id;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  SELECT COALESCE(followup_grace_days, 7) INTO v_grace FROM public.app_settings WHERE id;
  v_grace := COALESCE(v_grace, 7);

  -- ------------------------------------------------------------ no_followup
  SELECT a.created_at, a.last_event_id INTO v_fa_at, v_fa_event
    FROM public.alerts a
   WHERE a.youth_id = p_youth_id AND a.type = 'consecutive_absences' AND a.status = 'open';
  v_fa_found := FOUND;

  IF v_fa_found THEN
    v_days := GREATEST(0, floor(extract(epoch FROM (now() - v_fa_at)) / 86400)::integer);
    v_has_fu := EXISTS (
      SELECT 1 FROM public.follow_ups f
       WHERE f.youth_id = p_youth_id
         AND f.occurred_at >= (v_fa_at AT TIME ZONE 'America/Sao_Paulo')::date);
    v_cond := v_active
      AND v_fa_at <= now() - make_interval(days => v_grace)
      AND NOT v_has_fu;
  END IF;

  PERFORM public.sync_rate_alert(
    p_youth_id, v_group, 'no_followup', v_cond, NULL, NULL, v_days, v_fa_event,
    CASE WHEN NOT v_active THEN 'Resolvido automaticamente: jovem inativado.'
         WHEN NOT v_fa_found THEN 'Resolvido automaticamente: o alerta de faltas foi encerrado.'
         WHEN v_has_fu THEN 'Resolvido automaticamente: acompanhamento registrado.'
         ELSE 'Resolvido automaticamente: prazo de carência ampliado.' END);

  -- ------------------------------------------------------------ overdue_action
  SELECT count(*)::integer INTO v_overdue
    FROM public.tasks t
   WHERE t.youth_id = p_youth_id AND public.is_task_overdue(t.status, t.due_date);

  PERFORM public.sync_rate_alert(
    p_youth_id, v_group, 'overdue_action', v_active AND v_overdue > 0, NULL, NULL, v_overdue, NULL,
    CASE WHEN NOT v_active THEN 'Resolvido automaticamente: jovem inativado.'
         ELSE 'Resolvido automaticamente: nenhuma ação atrasada.' END);
END;
$$;

REVOKE ALL ON FUNCTION public.refresh_youth_time_alerts(uuid) FROM PUBLIC, anon, authenticated;


-- ----------------------------------------------------------------------------
-- 3) Funções-trigger não executáveis pelos clientes
-- ----------------------------------------------------------------------------
-- Funções que retornam `trigger` não são chamáveis via SELECT/RPC (erro "trigger functions can only be called
-- as triggers"), mas o EXECUTE default (PUBLIC + grants default do Supabase a anon/authenticated) as expõe ao
-- PostgREST sem necessidade. Triggers continuam funcionando: o EXECUTE é checado na criação do trigger, não a
-- cada disparo. Funções de extensões são ignoradas. RPCs do app (get_my_role, set_user_role, save_event, ...)
-- não retornam trigger e não são tocadas.
-- Atenção: funções-trigger FUTURAS recebem EXECUTE pelos privilégios default; cada migration nova deve
-- terminar com REVOKE explícito (padrão já usado) ou repetir este bloco.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS sig
      FROM pg_proc p
     WHERE p.pronamespace = 'public'::regnamespace
       AND p.prorettype = 'trigger'::regtype
       AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', r.sig);
  END LOOP;
END;
$$;

NOTIFY pgrst, 'reload schema';
