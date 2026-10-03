-- Migration: 011_followups_actions_situation.sql
-- Descrição: Fase 7 (blocos 2-5) — acompanhamento, ações, alertas por tempo e situação do jovem.
--
--   1) ACOMPANHAMENTO: tabelas `follow_ups` (registro de contato com o jovem) e `follow_up_transfers`
--      (histórico IMUTÁVEL de trocas de responsável) + RPC `transfer_follow_up`.
--   2) AÇÕES: Alerta -> Ação (tasks.alert_id) -> Responsável (tasks.assigned_to) -> Prazo (tasks.due_date)
--      -> Acompanhamento (follow_ups.task_id) -> Conclusão (tasks.status = 'done'; opcionalmente feita pelo
--      acompanhamento: follow_ups.completes_task + tasks.completed_by_follow_up_id).
--      "Ação atrasada" = status em (pending, in_progress) E due_date < app_today() (ver is_task_overdue).
--      Concluir/cancelar ação NUNCA toca em attendance (nenhum trigger desta migration escreve lá).
--   3) ALERTAS POR TEMPO (novos valores de alert_type: 'no_followup', 'overdue_action'), calculados no banco:
--        refresh_youth_time_alerts(uuid) / refresh_time_alerts()  -> internas (sem EXECUTE para clientes)
--        sync_time_alerts()                                       -> RPC idempotente (authenticated)
--   4) SITUAÇÃO DO JOVEM: youth_situation(uuid) e youth_situations(uuid[]).
--   5) Índices, grants e REVOKEs explícitos.
--
-- ATENÇÃO — ALTER TYPE ... ADD VALUE dentro de transação (mesmo padrão da 010):
--   os valores novos 'no_followup' e 'overdue_action' NÃO são usados em nenhum comando executado durante
--   esta migration (só dentro de corpos PL/pgSQL, avaliados em tempo de execução, após o COMMIT; nenhum
--   índice/CHECK/DEFAULT os cita). Por isso NÃO há "recalcular" ao final. Depois de aplicar, o coordenador
--   deve acionar "Recalcular alertas" (recalculate_all_alerts, que agora também gera os alertas por tempo)
--   uma vez; ou qualquer usuário autenticado chama sync_time_alerts(). Triggers cuidam do resto.
--
-- TEMPO: alertas por tempo dependem do relógio (nada "acontece" quando o prazo vence). Eles são
--   (re)calculados por eventos (follow_ups, tasks, alerts de faltas, youth, app_settings) e por
--   sync_time_alerts() — o app deve chamá-la ao abrir Alertas/Dashboard (ou agende no pg_cron).
--
-- IMPORTANTE: Execute no SQL Editor do Supabase APÓS a migration 010.
-- ============================================================================


-- ============================================================================
-- 1. Enums, configuração e utilitários de data
-- ============================================================================
ALTER TYPE alert_type ADD VALUE IF NOT EXISTS 'no_followup';
ALTER TYPE alert_type ADD VALUE IF NOT EXISTS 'overdue_action';

CREATE TYPE follow_up_type AS ENUM ('conversation', 'call', 'in_person', 'guidance', 'return', 'other');

-- Dias de tolerância entre o alerta de faltas e o primeiro acompanhamento (regra no_followup)
ALTER TABLE public.app_settings
  ADD COLUMN followup_grace_days integer NOT NULL DEFAULT 7
    CHECK (followup_grace_days BETWEEN 1 AND 90);

-- "Hoje" no fuso do produto (o servidor roda em UTC; o ministério está no Brasil).
CREATE OR REPLACE FUNCTION public.app_today()
RETURNS date
LANGUAGE sql
STABLE
SET search_path = public
AS $$ SELECT (now() AT TIME ZONE 'America/Sao_Paulo')::date $$;

-- Ação atrasada: aberta (pending/in_progress) com prazo anterior a hoje. Sem prazo nunca atrasa.
CREATE OR REPLACE FUNCTION public.is_task_overdue(p_status task_status, p_due_date date)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT p_status IN ('pending', 'in_progress')
     AND p_due_date IS NOT NULL
     AND p_due_date < public.app_today()
$$;

REVOKE ALL ON FUNCTION public.app_today() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.is_task_overdue(task_status, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.app_today() TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_task_overdue(task_status, date) TO authenticated;


-- ============================================================================
-- 2. Acompanhamentos
-- ============================================================================
CREATE TABLE public.follow_ups (
  id              uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  youth_id        uuid NOT NULL REFERENCES public.youth(id) ON DELETE CASCADE,
  -- Grupo do jovem NO MOMENTO do registro (preenchido por trigger; informativo/relatórios).
  -- A RLS usa o grupo ATUAL do jovem (youth.group_id), não esta coluna.
  group_id        uuid REFERENCES public.groups(id) ON DELETE SET NULL,
  alert_id        uuid REFERENCES public.alerts(id) ON DELETE SET NULL,
  task_id         uuid REFERENCES public.tasks(id)  ON DELETE SET NULL,
  occurred_at     date NOT NULL DEFAULT public.app_today() CHECK (occurred_at >= DATE '2000-01-01'),
  type            follow_up_type NOT NULL DEFAULT 'conversation',
  reason          text NOT NULL CHECK (length(btrim(reason)) > 0),
  notes           text,
  next_action     text,
  next_action_due date,
  -- Marca a ação (task_id) como concluída ao registrar este acompanhamento.
  completes_task  boolean NOT NULL DEFAULT false,
  -- Responsável ATUAL (só ele é "ativo"; anteriores aparecem em follow_up_transfers).
  -- Só muda pela RPC transfer_follow_up.
  responsible_id  uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_by      uuid REFERENCES public.profiles(id) ON DELETE SET NULL DEFAULT auth.uid(),
  created_at      timestamp with time zone DEFAULT timezone('utc', now()) NOT NULL,
  updated_at      timestamp with time zone DEFAULT timezone('utc', now()) NOT NULL,
  CHECK (next_action_due IS NULL OR next_action_due >= occurred_at)
  -- (completes_task exige task_id: validado no trigger follow_ups_guard, e NÃO por CHECK, porque a FK
  --  task_id ON DELETE SET NULL precisa poder anular task_id ao excluir a ação)
);

CREATE INDEX follow_ups_youth_idx       ON public.follow_ups (youth_id, occurred_at DESC);
CREATE INDEX follow_ups_responsible_idx ON public.follow_ups (responsible_id);
CREATE INDEX follow_ups_alert_idx       ON public.follow_ups (alert_id) WHERE alert_id IS NOT NULL;
CREATE INDEX follow_ups_task_idx        ON public.follow_ups (task_id)  WHERE task_id  IS NOT NULL;

-- Histórico de transferências: somente leitura para clientes, gravado só por transfer_follow_up()
CREATE TABLE public.follow_up_transfers (
  id                  uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  follow_up_id        uuid NOT NULL REFERENCES public.follow_ups(id) ON DELETE CASCADE,
  from_responsible_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  to_responsible_id   uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  reason              text NOT NULL CHECK (length(btrim(reason)) > 0),
  transferred_by      uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  transferred_at      timestamp with time zone DEFAULT timezone('utc', now()) NOT NULL
);

CREATE INDEX follow_up_transfers_followup_idx ON public.follow_up_transfers (follow_up_id, transferred_at);

ALTER TABLE public.follow_ups          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.follow_up_transfers ENABLE ROW LEVEL SECURITY;

-- Privilégios: anon nada; authenticated lê/escreve acompanhamentos (RLS decide) e SÓ LÊ o histórico.
REVOKE ALL ON public.follow_ups          FROM PUBLIC, anon;
REVOKE ALL ON public.follow_up_transfers FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.follow_ups TO authenticated;
GRANT SELECT ON public.follow_up_transfers TO authenticated;

CREATE TRIGGER follow_ups_updated_at
  BEFORE UPDATE ON public.follow_ups
  FOR EACH ROW EXECUTE PROCEDURE public.set_updated_at();

-- Guarda de acompanhamentos (SECURITY INVOKER: as leituras abaixo respeitam o RLS de quem grava).
--   * reason obrigatório (mensagem em pt-BR); data do contato não pode estar no futuro (+1 dia de folga de fuso);
--   * group_id sempre derivado do jovem; alerta/ação vinculados precisam ser do MESMO jovem;
--   * clientes: created_by/created_at forçados/imutáveis, youth_id e responsible_id imutáveis no UPDATE
--     (o responsável só muda pela RPC transfer_follow_up, que roda como dono e passa direto);
--   * responsável na criação: líder -> sempre ele mesmo; coordenador -> ele mesmo (padrão) ou outro
--     coordenador / líder do grupo atual do jovem.
CREATE OR REPLACE FUNCTION public.follow_ups_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_client  boolean := current_user IN ('anon', 'authenticated');
  v_uid     uuid := auth.uid();
  v_group   uuid;
  v_ref     uuid;
BEGIN
  IF NEW.reason IS NULL OR length(btrim(NEW.reason)) = 0 THEN
    RAISE EXCEPTION 'Informe o motivo do acompanhamento.' USING ERRCODE = 'P0001';
  END IF;
  NEW.reason := btrim(NEW.reason);

  IF NEW.occurred_at IS NULL THEN
    RAISE EXCEPTION 'Informe a data do contato.' USING ERRCODE = 'P0001';
  END IF;
  IF (TG_OP = 'INSERT' OR NEW.occurred_at IS DISTINCT FROM OLD.occurred_at)
     AND NEW.occurred_at > public.app_today() + 1 THEN
    RAISE EXCEPTION 'A data do contato não pode estar no futuro.' USING ERRCODE = 'P0001';
  END IF;

  IF NEW.next_action_due IS NOT NULL AND NEW.next_action_due < NEW.occurred_at THEN
    RAISE EXCEPTION 'O prazo da próxima ação não pode ser anterior à data do contato.' USING ERRCODE = 'P0001';
  END IF;

  IF NEW.completes_task AND NEW.task_id IS NULL
     AND (TG_OP = 'INSERT' OR NEW.completes_task IS DISTINCT FROM OLD.completes_task) THEN
    RAISE EXCEPTION 'Selecione a ação que será concluída.' USING ERRCODE = 'P0001';
  END IF;

  IF TG_OP = 'INSERT' THEN
    SELECT y.group_id INTO v_group FROM public.youth y WHERE y.id = NEW.youth_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Jovem não encontrado ou sem permissão.' USING ERRCODE = 'P0002';
    END IF;
    NEW.group_id := v_group;

    IF v_client THEN
      NEW.created_by := v_uid;
      NEW.created_at := timezone('utc', now());
      IF NEW.responsible_id IS NULL THEN
        NEW.responsible_id := v_uid;
      END IF;
      IF NEW.responsible_id <> v_uid THEN
        IF public.get_my_role() IS DISTINCT FROM 'coordinator' THEN
          RAISE EXCEPTION 'Líderes só podem registrar acompanhamentos sob a sua responsabilidade.'
            USING ERRCODE = '42501';
        END IF;
        -- Coordenador lê user_roles/groups inteiros (RLS), então a checagem vale com os seus direitos.
        IF NOT (EXISTS (SELECT 1 FROM public.user_roles ur
                         WHERE ur.user_id = NEW.responsible_id AND ur.role = 'coordinator')
                OR EXISTS (SELECT 1 FROM public.groups g
                            WHERE g.id = v_group AND g.leader_id = NEW.responsible_id)) THEN
          RAISE EXCEPTION 'O responsável precisa ser coordenador ou líder do grupo do jovem.'
            USING ERRCODE = 'P0001';
        END IF;
      END IF;
    END IF;
  ELSE
    IF v_client THEN
      IF NEW.youth_id IS DISTINCT FROM OLD.youth_id THEN
        RAISE EXCEPTION 'Não é possível trocar o jovem de um acompanhamento.' USING ERRCODE = '42501';
      END IF;
      IF NEW.responsible_id IS DISTINCT FROM OLD.responsible_id THEN
        RAISE EXCEPTION 'O responsável só pode ser alterado pela transferência.' USING ERRCODE = '42501';
      END IF;
      NEW.group_id   := OLD.group_id;
      NEW.created_by := OLD.created_by;
      NEW.created_at := OLD.created_at;
    END IF;
  END IF;

  -- Alerta e ação vinculados precisam ser do mesmo jovem (e visíveis a quem grava)
  IF NEW.alert_id IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.alert_id IS DISTINCT FROM OLD.alert_id) THEN
    SELECT a.youth_id INTO v_ref FROM public.alerts a WHERE a.id = NEW.alert_id;
    IF NOT FOUND OR v_ref <> NEW.youth_id THEN
      RAISE EXCEPTION 'O alerta informado não pertence a este jovem.' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  IF NEW.task_id IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.task_id IS DISTINCT FROM OLD.task_id) THEN
    SELECT t.youth_id INTO v_ref FROM public.tasks t WHERE t.id = NEW.task_id;
    IF NOT FOUND OR v_ref IS DISTINCT FROM NEW.youth_id THEN
      RAISE EXCEPTION 'A ação informada não pertence a este jovem.' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER follow_ups_guard
  BEFORE INSERT OR UPDATE ON public.follow_ups
  FOR EACH ROW EXECUTE PROCEDURE public.follow_ups_guard();

-- Histórico imutável (defesa em profundidade: clientes também não têm privilégio de escrita)
CREATE OR REPLACE FUNCTION public.follow_up_transfers_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF current_user IN ('anon', 'authenticated') THEN
    RAISE EXCEPTION 'O histórico de transferências não pode ser alterado.' USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER follow_up_transfers_immutable
  BEFORE UPDATE OR DELETE ON public.follow_up_transfers
  FOR EACH ROW EXECUTE PROCEDURE public.follow_up_transfers_immutable();

-- Ação -> Acompanhamento -> Conclusão: registrar o acompanhamento com completes_task conclui a ação.
-- SECURITY INVOKER: o UPDATE em tasks passa pelo RLS e por tasks_guard de quem registra.
CREATE OR REPLACE FUNCTION public.follow_ups_complete_task()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.completes_task AND NEW.task_id IS NOT NULL
     AND (TG_OP = 'INSERT' OR NOT OLD.completes_task) THEN
    UPDATE public.tasks
       SET status = 'done',
           completed_by_follow_up_id = NEW.id
     WHERE id = NEW.task_id
       AND status IN ('pending', 'in_progress');
  END IF;
  RETURN NEW;
END;
$$;

-- RLS: follow_ups — coordenador: tudo (inclusive DELETE)
CREATE POLICY "coordinator_all_follow_ups"
  ON public.follow_ups FOR ALL
  USING (public.get_my_role() = 'coordinator')
  WITH CHECK (public.get_my_role() = 'coordinator');

-- RLS: líder lê acompanhamentos de jovens que estão atualmente nos seus grupos
CREATE POLICY "leader_select_follow_ups"
  ON public.follow_ups FOR SELECT
  USING (
    youth_id IN (
      SELECT y.id FROM public.youth y
      WHERE y.group_id IN (SELECT id FROM public.groups WHERE leader_id = auth.uid())
    )
  );

-- RLS: líder registra acompanhamentos de jovens dos seus grupos, SEMPRE sob a sua responsabilidade
-- (o guard força responsible_id = ele mesmo; para passar a outra pessoa usa transfer_follow_up).
CREATE POLICY "leader_insert_follow_ups"
  ON public.follow_ups FOR INSERT
  WITH CHECK (
    public.get_my_role() = 'leader'
    AND created_by = auth.uid()
    AND responsible_id = auth.uid()
    AND youth_id IN (
      SELECT y.id FROM public.youth y
      WHERE y.group_id IN (SELECT id FROM public.groups WHERE leader_id = auth.uid())
    )
  );

-- RLS: líder edita só os acompanhamentos pelos quais é o responsável ATUAL (ou, se o responsável foi
-- removido, os que criou), enquanto o jovem estiver nos seus grupos. Não há DELETE para líder.
CREATE POLICY "leader_update_follow_ups"
  ON public.follow_ups FOR UPDATE
  USING (
    public.get_my_role() = 'leader'
    AND (responsible_id = auth.uid() OR (responsible_id IS NULL AND created_by = auth.uid()))
    AND youth_id IN (
      SELECT y.id FROM public.youth y
      WHERE y.group_id IN (SELECT id FROM public.groups WHERE leader_id = auth.uid())
    )
  )
  WITH CHECK (
    youth_id IN (
      SELECT y.id FROM public.youth y
      WHERE y.group_id IN (SELECT id FROM public.groups WHERE leader_id = auth.uid())
    )
  );

-- RLS: follow_up_transfers — SOMENTE leitura, e só do que o chamador enxerga em follow_ups
-- (a subconsulta sofre o RLS de follow_ups). Sem policies de escrita: ninguém grava direto.
CREATE POLICY "coordinator_select_follow_up_transfers"
  ON public.follow_up_transfers FOR SELECT
  USING (public.get_my_role() = 'coordinator');

CREATE POLICY "leader_select_follow_up_transfers"
  ON public.follow_up_transfers FOR SELECT
  USING (follow_up_id IN (SELECT f.id FROM public.follow_ups f));

-- Transferência de responsável (atômica: histórico + novo responsável).
-- SECURITY DEFINER porque o líder não enxerga profiles/user_roles de terceiros; por isso o escopo é
-- verificado aqui explicitamente:
--   * coordenador: qualquer acompanhamento; líder: só de jovem do seu grupo E se for o responsável atual
--     (ou o criador, quando o responsável foi removido). Fora disso: "não encontrado" (não vaza existência).
--   * o novo responsável precisa ser coordenador ou o líder do grupo ATUAL do jovem.
-- Retorna o registro do histórico: {id, follow_up_id, from_responsible_id, to_responsible_id, reason,
-- transferred_by, transferred_at}.
CREATE OR REPLACE FUNCTION public.transfer_follow_up(
  p_follow_up_id       uuid,
  p_new_responsible_id uuid,
  p_reason             text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid    uuid := auth.uid();
  v_role   text;
  v_f      public.follow_ups%ROWTYPE;
  v_leader uuid;
  v_reason text := btrim(COALESCE(p_reason, ''));
  v_t      public.follow_up_transfers%ROWTYPE;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Não autenticado.' USING ERRCODE = '42501';
  END IF;
  v_role := public.get_my_role();
  IF v_role IS NULL THEN
    RAISE EXCEPTION 'Sem permissão.' USING ERRCODE = '42501';
  END IF;
  IF v_reason = '' THEN
    RAISE EXCEPTION 'Informe o motivo da transferência.' USING ERRCODE = 'P0001';
  END IF;
  IF p_new_responsible_id IS NULL THEN
    RAISE EXCEPTION 'Informe o novo responsável.' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_f FROM public.follow_ups WHERE id = p_follow_up_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Acompanhamento não encontrado ou sem permissão.' USING ERRCODE = 'P0002';
  END IF;

  SELECT g.leader_id INTO v_leader
    FROM public.youth y
    LEFT JOIN public.groups g ON g.id = y.group_id
   WHERE y.id = v_f.youth_id;

  IF v_role <> 'coordinator' THEN
    IF v_leader IS DISTINCT FROM v_uid THEN
      RAISE EXCEPTION 'Acompanhamento não encontrado ou sem permissão.' USING ERRCODE = 'P0002';
    END IF;
    IF NOT COALESCE(v_f.responsible_id = v_uid
                    OR (v_f.responsible_id IS NULL AND v_f.created_by = v_uid), false) THEN
      RAISE EXCEPTION 'Somente o responsável atual pode transferir este acompanhamento.'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  IF v_f.responsible_id IS NOT DISTINCT FROM p_new_responsible_id THEN
    RAISE EXCEPTION 'Esta pessoa já é a responsável por este acompanhamento.' USING ERRCODE = 'P0001';
  END IF;

  IF NOT (EXISTS (SELECT 1 FROM public.user_roles ur
                   WHERE ur.user_id = p_new_responsible_id AND ur.role = 'coordinator')
          OR COALESCE(v_leader = p_new_responsible_id, false)) THEN
    RAISE EXCEPTION 'O novo responsável precisa ser coordenador ou líder do grupo atual do jovem.'
      USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO public.follow_up_transfers
    (follow_up_id, from_responsible_id, to_responsible_id, reason, transferred_by)
  VALUES (v_f.id, v_f.responsible_id, p_new_responsible_id, v_reason, v_uid)
  RETURNING * INTO v_t;

  UPDATE public.follow_ups SET responsible_id = p_new_responsible_id WHERE id = v_f.id;

  RETURN to_jsonb(v_t);
END;
$$;


-- ============================================================================
-- 3. Ações (tasks): vínculo com o acompanhamento que as concluiu + índices
-- ============================================================================
ALTER TABLE public.tasks
  ADD COLUMN completed_by_follow_up_id uuid REFERENCES public.follow_ups(id) ON DELETE SET NULL;

CREATE INDEX tasks_due_open_idx ON public.tasks (due_date)
  WHERE status IN ('pending', 'in_progress') AND due_date IS NOT NULL;
CREATE INDEX tasks_youth_idx ON public.tasks (youth_id) WHERE youth_id IS NOT NULL;
CREATE INDEX tasks_completed_by_followup_idx ON public.tasks (completed_by_follow_up_id)
  WHERE completed_by_follow_up_id IS NOT NULL;

-- completed_by_follow_up_id só vale para tarefa concluída e só aponta para um acompanhamento visível
-- ao chamador que esteja vinculado a esta própria tarefa (follow_ups.task_id = tasks.id).
CREATE OR REPLACE FUNCTION public.tasks_followup_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM 'done' THEN
    NEW.completed_by_follow_up_id := NULL;
  ELSIF NEW.completed_by_follow_up_id IS NOT NULL
        AND (TG_OP = 'INSERT' OR NEW.completed_by_follow_up_id IS DISTINCT FROM OLD.completed_by_follow_up_id)
        AND NOT EXISTS (SELECT 1 FROM public.follow_ups f
                         WHERE f.id = NEW.completed_by_follow_up_id AND f.task_id = NEW.id) THEN
    RAISE EXCEPTION 'Acompanhamento inválido para esta ação.' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER tasks_followup_guard
  BEFORE INSERT OR UPDATE ON public.tasks
  FOR EACH ROW EXECUTE PROCEDURE public.tasks_followup_guard();

-- (criado depois de tasks.completed_by_follow_up_id existir)
CREATE TRIGGER follow_ups_complete_task
  AFTER INSERT OR UPDATE OF completes_task ON public.follow_ups
  FOR EACH ROW EXECUTE PROCEDURE public.follow_ups_complete_task();


-- ============================================================================
-- 4. Alertas baseados em tempo
-- ============================================================================
-- Reaproveita sync_rate_alert (010): 1 aberto por jovem+tipo (índice parcial + ON CONFLICT); resolução
-- automática quando a condição cai; encerramento MANUAL (dispensado ou resolvido por usuário/tarefa) não
-- recria o alerta enquanto a condição não tiver deixado de valer ao menos uma vez (episode_ended).
--
--   no_followup    : jovem ATIVO com alerta ABERTO de faltas consecutivas criado há >= followup_grace_days
--                    dias e SEM nenhum follow_up com occurred_at >= data (America/Sao_Paulo) da criação desse
--                    alerta de faltas. sample_size = dias desde a criação do alerta de faltas;
--                    last_event_id = o do alerta de faltas. Resolve sozinho ao registrar acompanhamento, ao
--                    fechar o alerta de faltas ou ao inativar o jovem.
--   overdue_action : jovem ATIVO com ao menos uma ação atrasada (is_task_overdue) vinculada a ele.
--                    sample_size = quantidade de ações atrasadas. Tarefas sem jovem não geram alerta.
CREATE OR REPLACE FUNCTION public.refresh_youth_time_alerts(p_youth_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_group     uuid;
  v_active    boolean;
  v_grace     integer;
  v_fa_at     timestamptz;
  v_fa_event  uuid;
  v_fa_found  boolean := false;
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
    v_cond := v_active
      AND v_fa_at <= now() - make_interval(days => v_grace)
      AND NOT EXISTS (
        SELECT 1 FROM public.follow_ups f
         WHERE f.youth_id = p_youth_id
           AND f.occurred_at >= (v_fa_at AT TIME ZONE 'America/Sao_Paulo')::date);
  END IF;

  PERFORM public.sync_rate_alert(
    p_youth_id, v_group, 'no_followup', v_cond, NULL, NULL, v_days, v_fa_event,
    CASE WHEN NOT v_active THEN 'Resolvido automaticamente: jovem inativado.'
         WHEN NOT v_fa_found THEN 'Resolvido automaticamente: o alerta de faltas foi encerrado.'
         ELSE 'Resolvido automaticamente: acompanhamento registrado.' END);

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

-- Recalcula os alertas por tempo de todos os jovens relevantes (idempotente). Retorna quantos processou.
CREATE OR REPLACE FUNCTION public.refresh_time_alerts()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r record;
  n integer := 0;
BEGIN
  FOR r IN
    SELECT DISTINCT c.youth_id FROM (
      SELECT a.youth_id FROM public.alerts a
       WHERE a.type::text IN ('consecutive_absences', 'no_followup', 'overdue_action')
         AND (a.status = 'open' OR (a.type::text <> 'consecutive_absences' AND NOT a.episode_ended))
      UNION
      SELECT t.youth_id FROM public.tasks t
       WHERE t.youth_id IS NOT NULL AND public.is_task_overdue(t.status, t.due_date)
    ) c
  LOOP
    PERFORM public.refresh_youth_time_alerts(r.youth_id);
    n := n + 1;
  END LOOP;
  RETURN n;
END;
$$;

REVOKE ALL ON FUNCTION public.refresh_youth_time_alerts(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.refresh_time_alerts()           FROM PUBLIC, anon, authenticated;

-- RPC para o app: qualquer usuário autenticado pode pedir a sincronização. É segura porque só deriva
-- dados que já estão no banco (idempotente), não aceita parâmetros e não devolve nada. A visibilidade
-- dos alertas gerados continua sendo a do RLS de alerts.
CREATE OR REPLACE FUNCTION public.sync_time_alerts()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL OR public.get_my_role() IS NULL THEN
    RAISE EXCEPTION 'Não autenticado.' USING ERRCODE = '42501';
  END IF;
  PERFORM public.refresh_time_alerts();
END;
$$;

REVOKE ALL ON FUNCTION public.sync_time_alerts() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.sync_time_alerts() TO authenticated;

-- Triggers de eventos: follow_ups
CREATE OR REPLACE FUNCTION public.follow_ups_refresh_time_alerts()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM public.refresh_youth_time_alerts(OLD.youth_id);
    RETURN OLD;
  END IF;
  PERFORM public.refresh_youth_time_alerts(NEW.youth_id);
  IF TG_OP = 'UPDATE' AND OLD.youth_id IS DISTINCT FROM NEW.youth_id THEN
    PERFORM public.refresh_youth_time_alerts(OLD.youth_id);
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER follow_ups_refresh_time_alerts
  AFTER INSERT OR DELETE OR UPDATE OF youth_id, occurred_at ON public.follow_ups
  FOR EACH ROW EXECUTE PROCEDURE public.follow_ups_refresh_time_alerts();

-- Triggers de eventos: tasks (status, prazo ou jovem mudam o conjunto de ações atrasadas)
CREATE OR REPLACE FUNCTION public.tasks_refresh_time_alerts()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.youth_id IS NOT NULL THEN
      PERFORM public.refresh_youth_time_alerts(OLD.youth_id);
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'INSERT'
     OR NEW.status IS DISTINCT FROM OLD.status
     OR NEW.due_date IS DISTINCT FROM OLD.due_date
     OR NEW.youth_id IS DISTINCT FROM OLD.youth_id THEN
    IF NEW.youth_id IS NOT NULL THEN
      PERFORM public.refresh_youth_time_alerts(NEW.youth_id);
    END IF;
    IF TG_OP = 'UPDATE' AND OLD.youth_id IS NOT NULL AND OLD.youth_id IS DISTINCT FROM NEW.youth_id THEN
      PERFORM public.refresh_youth_time_alerts(OLD.youth_id);
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER tasks_refresh_time_alerts
  AFTER INSERT OR UPDATE OR DELETE ON public.tasks
  FOR EACH ROW EXECUTE PROCEDURE public.tasks_refresh_time_alerts();

-- Triggers de eventos: o alerta de faltas abriu/fechou (encerra o episódio de no_followup)
CREATE OR REPLACE FUNCTION public.alerts_refresh_time_alerts()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.refresh_youth_time_alerts(NEW.youth_id);
  RETURN NEW;
END;
$$;

CREATE TRIGGER alerts_refresh_time_alerts
  AFTER INSERT OR UPDATE OF status ON public.alerts
  FOR EACH ROW WHEN (NEW.type::text = 'consecutive_absences')
  EXECUTE PROCEDURE public.alerts_refresh_time_alerts();

-- Triggers de eventos: jovem inativado/trocou de grupo
CREATE OR REPLACE FUNCTION public.youth_refresh_time_alerts()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.is_active IS DISTINCT FROM OLD.is_active OR NEW.group_id IS DISTINCT FROM OLD.group_id THEN
    PERFORM public.refresh_youth_time_alerts(NEW.id);
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER youth_refresh_time_alerts
  AFTER UPDATE OF is_active, group_id ON public.youth
  FOR EACH ROW EXECUTE PROCEDURE public.youth_refresh_time_alerts();

-- "Recalcular alertas" agora inclui os alertas por tempo
CREATE OR REPLACE FUNCTION public.recalculate_all_alerts_internal()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r record;
  n integer := 0;
BEGIN
  FOR r IN SELECT id FROM public.youth LOOP
    PERFORM public.refresh_youth_alert(r.id);
    n := n + 1;
  END LOOP;
  PERFORM public.refresh_time_alerts();
  RETURN n;
END;
$$;

-- Mudar limites recalcula; mudar só followup_grace_days recalcula apenas os alertas por tempo
CREATE OR REPLACE FUNCTION public.settings_refresh_alerts()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.absence_alert_threshold IS DISTINCT FROM OLD.absence_alert_threshold
     OR NEW.critical_absence_threshold IS DISTINCT FROM OLD.critical_absence_threshold
     OR NEW.low_attendance_threshold IS DISTINCT FROM OLD.low_attendance_threshold THEN
    PERFORM public.recalculate_all_alerts_internal();
  ELSIF NEW.followup_grace_days IS DISTINCT FROM OLD.followup_grace_days THEN
    PERFORM public.refresh_time_alerts();
  END IF;
  RETURN NEW;
END;
$$;


-- ============================================================================
-- 5. Situação do jovem
-- ============================================================================
-- Tipo de retorno (compartilhado por youth_situation e youth_situations)
CREATE TYPE youth_situation_row AS (
  youth_id              uuid,
  full_name             text,
  inactive              boolean,       -- true = jovem inativo (situação 'normal' NÃO é diagnóstico)
  group_id              uuid,
  group_name            text,
  leader_name           text,
  attendance_rate       integer,       -- % de presença nos 8 registros mais recentes (não cancelados); NULL se 0 registros
  consecutive_absences  integer,
  events_total          integer,       -- registros de chamada em encontros não cancelados
  last_event            timestamptz,   -- data do encontro mais recente com registro
  open_actions          integer,       -- ações pending/in_progress vinculadas ao jovem
  overdue_actions       integer,       -- subconjunto atrasado (is_task_overdue)
  last_follow_up        date,
  situation             text,          -- 'normal' | 'attention' | 'critical'
  reasons               text[]         -- motivos objetivos, em pt-BR
);

-- REGRA OBJETIVA da situação (jovem ATIVO; inativo => 'normal', reasons vazio, inactive = true):
--   critical  = faltas consecutivas >= GREATEST(critical_absence_threshold, absence_alert_threshold)
--   attention = faltas consecutivas >= absence_alert_threshold
--               OU alerta ABERTO de low_attendance / attendance_drop / no_followup
--               OU ao menos uma ação atrasada (overdue_actions > 0)
--   normal    = nenhuma das anteriores
-- Faltas consecutivas / frequência usam a mesma base dos alertas (histórico completo do jovem, encontros
-- cancelados e "não registrado" fora da conta).
--
-- SECURITY DEFINER com ESCOPO EXPLÍCITO (em vez de INVOKER): o RLS de attendance usa o group_id gravado em
-- cada linha, então, se o jovem trocou de grupo, um líder INVOKER veria só parte do histórico e a situação
-- divergiria dos alertas (que o banco calcula com o histórico inteiro). Escopo equivalente ao RLS de youth:
--   coordenador -> qualquer jovem; líder -> só jovens cujo grupo ATUAL ele lidera; qualquer outro id
--   (inexistente, de outro grupo, sem grupo) simplesmente não retorna linha.
CREATE OR REPLACE FUNCTION public.youth_situations(p_ids uuid[])
RETURNS SETOF youth_situation_row
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid   uuid := auth.uid();
  v_role  text;
  v_t     integer;
  v_c     integer;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Não autenticado.' USING ERRCODE = '42501';
  END IF;
  v_role := public.get_my_role();
  IF v_role IS NULL THEN
    RAISE EXCEPTION 'Sem permissão.' USING ERRCODE = '42501';
  END IF;
  IF p_ids IS NULL OR cardinality(p_ids) = 0 THEN
    RETURN;
  END IF;
  IF cardinality(p_ids) > 500 THEN
    RAISE EXCEPTION 'Informe no máximo 500 jovens por consulta.' USING ERRCODE = 'P0001';
  END IF;

  SELECT absence_alert_threshold, GREATEST(critical_absence_threshold, absence_alert_threshold)
    INTO v_t, v_c FROM public.app_settings WHERE id;
  v_t := COALESCE(v_t, 3);
  v_c := GREATEST(COALESCE(v_c, 6), v_t);

  RETURN QUERY
  WITH sc AS (
    SELECT y.id, y.full_name, y.is_active, y.group_id, g.name AS gname, pr.full_name AS lname
      FROM (SELECT DISTINCT i AS id FROM unnest(p_ids) AS i) ids
      JOIN public.youth y ON y.id = ids.id
      LEFT JOIN public.groups g ON g.id = y.group_id
      LEFT JOIN public.profiles pr ON pr.id = g.leader_id
     WHERE v_role = 'coordinator' OR g.leader_id = v_uid
  ),
  att AS (
    SELECT a.youth_id, a.present, e.event_date,
           row_number() OVER (PARTITION BY a.youth_id
                              ORDER BY e.event_date DESC, a.created_at DESC, a.id) AS rn
      FROM public.attendance a
      JOIN public.events e ON e.id = a.event_id
     WHERE a.youth_id IN (SELECT id FROM sc) AND e.status <> 'cancelled'
  ),
  att_agg AS (
    SELECT s.youth_id,
           count(*)::integer                                          AS total,
           max(s.event_date)                                          AS last_event,
           count(*) FILTER (WHERE s.rn <= 8)::integer                 AS n8,
           count(*) FILTER (WHERE s.rn <= 8 AND s.present)::integer   AS p8,
           COALESCE(min(s.rn) FILTER (WHERE s.present) - 1, count(*))::integer AS consec
      FROM att s GROUP BY s.youth_id
  ),
  tk AS (
    SELECT t.youth_id,
           count(*) FILTER (WHERE t.status IN ('pending', 'in_progress'))::integer AS open_n,
           count(*) FILTER (WHERE public.is_task_overdue(t.status, t.due_date))::integer AS overdue_n
      FROM public.tasks t
     WHERE t.youth_id IN (SELECT id FROM sc)
     GROUP BY t.youth_id
  ),
  fu AS (
    SELECT f.youth_id, max(f.occurred_at) AS last_fu
      FROM public.follow_ups f
     WHERE f.youth_id IN (SELECT id FROM sc)
     GROUP BY f.youth_id
  ),
  base AS (
    SELECT sc.*,
           COALESCE(aa.consec, 0)         AS consec,
           COALESCE(aa.total, 0)          AS total,
           aa.last_event,
           CASE WHEN COALESCE(aa.n8, 0) > 0 THEN round(100.0 * aa.p8 / aa.n8)::integer END AS rate,
           COALESCE(tk.open_n, 0)         AS open_n,
           COALESCE(tk.overdue_n, 0)      AS overdue_n,
           fu.last_fu,
           lo.attendance_rate AS lo_rate,  lo.sample_size AS lo_n,
           dr.attendance_rate AS dr_recent, dr.previous_rate AS dr_prev,
           nf.sample_size     AS nf_days
      FROM sc
      LEFT JOIN att_agg aa ON aa.youth_id = sc.id
      LEFT JOIN tk ON tk.youth_id = sc.id
      LEFT JOIN fu ON fu.youth_id = sc.id
      LEFT JOIN LATERAL (SELECT a.attendance_rate, a.sample_size FROM public.alerts a
                          WHERE a.youth_id = sc.id AND a.type::text = 'low_attendance' AND a.status = 'open'
                          LIMIT 1) lo ON true
      LEFT JOIN LATERAL (SELECT a.attendance_rate, a.previous_rate FROM public.alerts a
                          WHERE a.youth_id = sc.id AND a.type::text = 'attendance_drop' AND a.status = 'open'
                          LIMIT 1) dr ON true
      LEFT JOIN LATERAL (SELECT a.sample_size FROM public.alerts a
                          WHERE a.youth_id = sc.id AND a.type::text = 'no_followup' AND a.status = 'open'
                          LIMIT 1) nf ON true
  ),
  flags AS (
    SELECT b.*,
           (b.consec >= v_t)                  AS f_abs,
           (b.consec >= v_c)                  AS f_crit,
           (b.lo_n IS NOT NULL OR b.lo_rate IS NOT NULL) AS f_low,
           (b.dr_recent IS NOT NULL)          AS f_drop,
           (b.nf_days IS NOT NULL)            AS f_nofu,
           (b.overdue_n > 0)                  AS f_over
      FROM base b
  )
  SELECT f.id, f.full_name, NOT f.is_active, f.group_id, f.gname, f.lname,
         f.rate, f.consec, f.total, f.last_event, f.open_n, f.overdue_n, f.last_fu,
         CASE WHEN NOT f.is_active THEN 'normal'
              WHEN f.f_crit THEN 'critical'
              WHEN f.f_abs OR f.f_low OR f.f_drop OR f.f_nofu OR f.f_over THEN 'attention'
              ELSE 'normal' END,
         CASE WHEN NOT f.is_active THEN ARRAY[]::text[]
              ELSE array_remove(ARRAY[
                CASE WHEN f.f_abs THEN f.consec || CASE WHEN f.consec = 1 THEN ' falta seguida' ELSE ' faltas seguidas' END END,
                CASE WHEN f.f_low THEN 'Frequência baixa (' || COALESCE(f.lo_rate::text, '?') || '% nos últimos '
                                       || COALESCE(f.lo_n::text, '?') || ' registros)' END,
                CASE WHEN f.f_drop THEN 'Queda de frequência (de ' || COALESCE(f.dr_prev::text, '?') || '% para '
                                        || f.dr_recent || '%)' END,
                CASE WHEN f.f_nofu THEN 'Sem acompanhamento há ' || f.nf_days
                                        || CASE WHEN f.nf_days = 1 THEN ' dia' ELSE ' dias' END END,
                CASE WHEN f.f_over THEN f.overdue_n || CASE WHEN f.overdue_n = 1 THEN ' ação atrasada' ELSE ' ações atrasadas' END END
              ], NULL)
         END
    FROM flags f
   ORDER BY f.full_name, f.id;
END;
$$;

CREATE OR REPLACE FUNCTION public.youth_situation(p_youth_id uuid)
RETURNS SETOF youth_situation_row
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$ SELECT * FROM public.youth_situations(ARRAY[p_youth_id]) $$;

REVOKE ALL ON FUNCTION public.youth_situations(uuid[])      FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.youth_situation(uuid)         FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.youth_situations(uuid[])   TO authenticated;
GRANT EXECUTE ON FUNCTION public.youth_situation(uuid)      TO authenticated;


-- ============================================================================
-- 5b. Nomes de pessoas para a UI (o líder não lê profiles de terceiros)
-- ============================================================================
-- Candidatos a responsável: coordenadores + líder do grupo ATUAL do jovem (os mesmos destinos válidos de
-- transfer_follow_up). Só para quem tem escopo sobre o jovem (coordenador, ou líder do grupo atual dele);
-- fora do escopo, jovem inexistente ou sem grupo para líder => vazio. Expõe apenas id, nome e papel.
CREATE OR REPLACE FUNCTION public.assignable_responsibles(p_youth_id uuid)
RETURNS TABLE (id uuid, full_name text, role user_role)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT p.id, p.full_name, ur.role
    FROM public.youth y
    LEFT JOIN public.groups g ON g.id = y.group_id
    CROSS JOIN public.user_roles ur
    JOIN public.profiles p ON p.id = ur.user_id
   WHERE y.id = p_youth_id
     AND auth.uid() IS NOT NULL
     AND (public.get_my_role() = 'coordinator' OR g.leader_id = auth.uid())
     AND (ur.role = 'coordinator' OR p.id = g.leader_id)
   ORDER BY p.full_name, p.id
$$;

-- Nomes das pessoas ligadas a UM acompanhamento (responsável atual, criador, e de/para/quem de cada
-- transferência). Só para quem tem acesso ao acompanhamento (coordenador, ou líder do grupo atual do jovem);
-- caso contrário, vazio. Devolve apenas id e nome, sem duplicar pessoas.
CREATE OR REPLACE FUNCTION public.follow_up_people(p_follow_up_id uuid)
RETURNS TABLE (id uuid, full_name text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH f AS (
    SELECT fu.id AS fid, fu.responsible_id, fu.created_by
      FROM public.follow_ups fu
      JOIN public.youth y ON y.id = fu.youth_id
      LEFT JOIN public.groups g ON g.id = y.group_id
     WHERE fu.id = p_follow_up_id
       AND auth.uid() IS NOT NULL
       AND (public.get_my_role() = 'coordinator' OR g.leader_id = auth.uid())
  ),
  ids AS (
    SELECT responsible_id AS uid FROM f
    UNION SELECT created_by FROM f
    UNION SELECT tr.from_responsible_id FROM public.follow_up_transfers tr JOIN f ON f.fid = tr.follow_up_id
    UNION SELECT tr.to_responsible_id FROM public.follow_up_transfers tr JOIN f ON f.fid = tr.follow_up_id
    UNION SELECT tr.transferred_by FROM public.follow_up_transfers tr JOIN f ON f.fid = tr.follow_up_id
  )
  SELECT p.id, p.full_name FROM public.profiles p WHERE p.id IN (SELECT uid FROM ids WHERE uid IS NOT NULL)
  ORDER BY p.full_name, p.id
$$;

REVOKE ALL ON FUNCTION public.assignable_responsibles(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.follow_up_people(uuid)        FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.assignable_responsibles(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.follow_up_people(uuid)        TO authenticated;


-- ============================================================================
-- 6. Grants explícitos nas demais funções novas
-- ============================================================================
-- Triggers e RPC de transferência: nada de EXECUTE para anon; só transfer_follow_up para authenticated.
REVOKE ALL ON FUNCTION public.follow_ups_guard()                  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.follow_up_transfers_immutable()     FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.follow_ups_complete_task()          FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.tasks_followup_guard()              FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.follow_ups_refresh_time_alerts()    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.tasks_refresh_time_alerts()         FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.alerts_refresh_time_alerts()        FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.youth_refresh_time_alerts()         FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.transfer_follow_up(uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.transfer_follow_up(uuid, uuid, text) TO authenticated;

NOTIFY pgrst, 'reload schema';
