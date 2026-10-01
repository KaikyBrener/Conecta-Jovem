-- Migration: 006_settings_alerts_tasks.sql
-- Data: 2026-09-30
-- Descrição: Módulos de Configurações, Alertas e Tarefas/Ações.
--   1. Hardening: search_path fixo nas funções SECURITY DEFINER existentes e
--      created_by anulável em events/youth (FK usa ON DELETE SET NULL).
--   2. app_settings (linha única) com parâmetros de alerta.
--   3. alerts: gerados pelo banco a partir das faltas consecutivas (triggers).
--   4. tasks: tarefas/ações de acompanhamento, integradas a jovens, grupos e alertas.
--   5. RPCs: set_user_role, recalculate_all_alerts.
--
-- IMPORTANTE: Execute no SQL Editor do Supabase APÓS as migrations 001–005.
-- ============================================================================


-- ============================================================================
-- 1. Hardening de objetos existentes
-- ============================================================================
ALTER FUNCTION public.get_my_role() SET search_path = public;
ALTER FUNCTION public.handle_new_user() SET search_path = public;

-- created_by era NOT NULL com ON DELETE SET NULL: excluir o usuário autor falharia.
ALTER TABLE public.events ALTER COLUMN created_by DROP NOT NULL;
ALTER TABLE public.youth  ALTER COLUMN created_by DROP NOT NULL;

-- Índices para as consultas de chamada/relatórios/alertas
CREATE INDEX IF NOT EXISTS attendance_youth_idx ON public.attendance (youth_id);
CREATE INDEX IF NOT EXISTS attendance_event_idx ON public.attendance (event_id);
CREATE INDEX IF NOT EXISTS youth_group_idx      ON public.youth (group_id);
CREATE INDEX IF NOT EXISTS events_date_idx      ON public.events (event_date);


-- ============================================================================
-- 2. Configurações do sistema (linha única)
-- ============================================================================
CREATE TABLE public.app_settings (
  id                        boolean PRIMARY KEY DEFAULT true CHECK (id),
  absence_alert_threshold   integer NOT NULL DEFAULT 3
                              CHECK (absence_alert_threshold BETWEEN 1 AND 20),
  low_attendance_threshold  integer NOT NULL DEFAULT 70
                              CHECK (low_attendance_threshold BETWEEN 0 AND 100),
  updated_by                uuid REFERENCES auth.users ON DELETE SET NULL,
  updated_at                timestamp with time zone DEFAULT timezone('utc', now()) NOT NULL
);

INSERT INTO public.app_settings (id) VALUES (true);

ALTER TABLE public.app_settings ENABLE ROW LEVEL SECURITY;

CREATE TRIGGER app_settings_updated_at
  BEFORE UPDATE ON public.app_settings
  FOR EACH ROW EXECUTE PROCEDURE public.set_updated_at();

-- Qualquer usuário autenticado lê os parâmetros
CREATE POLICY "authenticated_select_settings"
  ON public.app_settings FOR SELECT
  USING (auth.uid() IS NOT NULL);

-- Somente coordenador altera (INSERT/DELETE não existem: linha única)
CREATE POLICY "coordinator_update_settings"
  ON public.app_settings FOR UPDATE
  USING (public.get_my_role() = 'coordinator')
  WITH CHECK (public.get_my_role() = 'coordinator');


-- ============================================================================
-- 3. Alertas
-- ============================================================================
CREATE TYPE alert_type   AS ENUM ('consecutive_absences');
CREATE TYPE alert_status AS ENUM ('open', 'resolved', 'dismissed');

CREATE TABLE public.alerts (
  id                    uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  youth_id              uuid REFERENCES public.youth(id)  ON DELETE CASCADE NOT NULL,
  group_id              uuid REFERENCES public.groups(id) ON DELETE SET NULL,
  type                  alert_type   DEFAULT 'consecutive_absences' NOT NULL,
  status                alert_status DEFAULT 'open' NOT NULL,
  consecutive_absences  integer DEFAULT 0 NOT NULL,
  last_event_id         uuid REFERENCES public.events(id) ON DELETE SET NULL,
  resolution_notes      text,
  resolved_by           uuid REFERENCES auth.users ON DELETE SET NULL,
  resolved_at           timestamp with time zone,
  created_at            timestamp with time zone DEFAULT timezone('utc', now()) NOT NULL,
  updated_at            timestamp with time zone DEFAULT timezone('utc', now()) NOT NULL
);

-- No máximo um alerta aberto por jovem e tipo
CREATE UNIQUE INDEX alerts_one_open_per_youth
  ON public.alerts (youth_id, type) WHERE status = 'open';
CREATE INDEX alerts_status_idx ON public.alerts (status);

ALTER TABLE public.alerts ENABLE ROW LEVEL SECURITY;

CREATE TRIGGER alerts_updated_at
  BEFORE UPDATE ON public.alerts
  FOR EACH ROW EXECUTE PROCEDURE public.set_updated_at();

-- Guarda: clientes (anon/authenticated) só alteram status e resolution_notes.
-- Funções internas (SECURITY DEFINER) rodam como dono e passam direto.
CREATE OR REPLACE FUNCTION public.alerts_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF current_user IN ('anon', 'authenticated') THEN
    IF NEW.youth_id IS DISTINCT FROM OLD.youth_id
       OR NEW.group_id IS DISTINCT FROM OLD.group_id
       OR NEW.type IS DISTINCT FROM OLD.type
       OR NEW.consecutive_absences IS DISTINCT FROM OLD.consecutive_absences
       OR NEW.last_event_id IS DISTINCT FROM OLD.last_event_id
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'Somente o status e as observações do alerta podem ser alterados.'
        USING ERRCODE = '42501';
    END IF;

    IF NEW.status IS DISTINCT FROM OLD.status THEN
      IF NEW.status = 'open' THEN
        NEW.resolved_by := NULL;
        NEW.resolved_at := NULL;
      ELSE
        NEW.resolved_by := auth.uid();
        NEW.resolved_at := timezone('utc', now());
      END IF;
    ELSE
      NEW.resolved_by := OLD.resolved_by;
      NEW.resolved_at := OLD.resolved_at;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER alerts_guard
  BEFORE UPDATE ON public.alerts
  FOR EACH ROW EXECUTE PROCEDURE public.alerts_guard();

-- RLS: coordenador lê/atualiza/exclui (alertas são criados apenas pelo banco)
CREATE POLICY "coordinator_select_alerts"
  ON public.alerts FOR SELECT
  USING (public.get_my_role() = 'coordinator');

CREATE POLICY "coordinator_update_alerts"
  ON public.alerts FOR UPDATE
  USING (public.get_my_role() = 'coordinator')
  WITH CHECK (public.get_my_role() = 'coordinator');

CREATE POLICY "coordinator_delete_alerts"
  ON public.alerts FOR DELETE
  USING (public.get_my_role() = 'coordinator');

-- RLS: líder lê/atualiza alertas de jovens que estão atualmente nos seus grupos
CREATE POLICY "leader_select_alerts"
  ON public.alerts FOR SELECT
  USING (
    youth_id IN (
      SELECT y.id FROM public.youth y
      WHERE y.group_id IN (SELECT id FROM public.groups WHERE leader_id = auth.uid())
    )
  );

CREATE POLICY "leader_update_alerts"
  ON public.alerts FOR UPDATE
  USING (
    youth_id IN (
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


-- ============================================================================
-- 4. Cálculo de faltas consecutivas e geração de alertas
-- ============================================================================

-- Número de faltas consecutivas mais recentes (encontros cancelados ignorados)
CREATE OR REPLACE FUNCTION public.youth_consecutive_absences(p_youth_id uuid)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH ordered AS (
    SELECT a.present,
           row_number() OVER (ORDER BY e.event_date DESC, a.created_at DESC) AS rn
    FROM public.attendance a
    JOIN public.events e ON e.id = a.event_id
    WHERE a.youth_id = p_youth_id
      AND e.status <> 'cancelled'
  )
  SELECT COALESCE(
    (SELECT min(rn) - 1 FROM ordered WHERE present),
    (SELECT count(*) FROM ordered)
  )::integer;
$$;

-- Cria/atualiza/resolve o alerta de faltas consecutivas de um jovem
CREATE OR REPLACE FUNCTION public.refresh_youth_alert(p_youth_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_threshold  integer;
  v_count      integer;
  v_group      uuid;
  v_active     boolean;
  v_last_event uuid;
BEGIN
  SELECT group_id, is_active INTO v_group, v_active
  FROM public.youth WHERE id = p_youth_id;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  SELECT absence_alert_threshold INTO v_threshold FROM public.app_settings WHERE id;
  v_threshold := COALESCE(v_threshold, 3);
  v_count := public.youth_consecutive_absences(p_youth_id);

  IF v_active AND v_count >= v_threshold THEN
    SELECT a.event_id INTO v_last_event
    FROM public.attendance a
    JOIN public.events e ON e.id = a.event_id
    WHERE a.youth_id = p_youth_id AND e.status <> 'cancelled'
    ORDER BY e.event_date DESC, a.created_at DESC
    LIMIT 1;

    UPDATE public.alerts
       SET consecutive_absences = v_count,
           last_event_id = v_last_event,
           group_id = v_group
     WHERE youth_id = p_youth_id
       AND type = 'consecutive_absences'
       AND status = 'open';

    -- Não recria um alerta já encerrado manualmente (por usuário ou tarefa)
    -- para a mesma última falta. Encerramentos automáticos não bloqueiam.
    IF NOT FOUND AND NOT EXISTS (
      SELECT 1 FROM public.alerts
      WHERE youth_id = p_youth_id
        AND type = 'consecutive_absences'
        AND status <> 'open'
        AND (status = 'dismissed' OR resolved_by IS NOT NULL)
        AND last_event_id = v_last_event
    ) THEN
      INSERT INTO public.alerts (youth_id, group_id, type, consecutive_absences, last_event_id)
      VALUES (p_youth_id, v_group, 'consecutive_absences', v_count, v_last_event);
    END IF;
  ELSE
    UPDATE public.alerts
       SET status = 'resolved',
           resolved_at = timezone('utc', now()),
           consecutive_absences = v_count,
           group_id = v_group,
           resolution_notes = CASE
             WHEN NOT v_active THEN 'Resolvido automaticamente: jovem inativado.'
             ELSE 'Resolvido automaticamente: faltas consecutivas abaixo do limite.'
           END
     WHERE youth_id = p_youth_id
       AND type = 'consecutive_absences'
       AND status = 'open';
  END IF;
END;
$$;

-- Funções internas: não expostas a clientes
REVOKE ALL ON FUNCTION public.youth_consecutive_absences(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.refresh_youth_alert(uuid) FROM PUBLIC, anon, authenticated;

-- Trigger: attendance
CREATE OR REPLACE FUNCTION public.attendance_refresh_alert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM public.refresh_youth_alert(OLD.youth_id);
    RETURN OLD;
  END IF;
  PERFORM public.refresh_youth_alert(NEW.youth_id);
  IF TG_OP = 'UPDATE' AND OLD.youth_id IS DISTINCT FROM NEW.youth_id THEN
    PERFORM public.refresh_youth_alert(OLD.youth_id);
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER attendance_refresh_alert
  AFTER INSERT OR UPDATE OR DELETE ON public.attendance
  FOR EACH ROW EXECUTE PROCEDURE public.attendance_refresh_alert();

-- Trigger: events (status/data mudam a sequência de faltas)
CREATE OR REPLACE FUNCTION public.events_refresh_alerts()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r record;
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status OR NEW.event_date IS DISTINCT FROM OLD.event_date THEN
    FOR r IN SELECT DISTINCT youth_id FROM public.attendance WHERE event_id = NEW.id LOOP
      PERFORM public.refresh_youth_alert(r.youth_id);
    END LOOP;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER events_refresh_alerts
  AFTER UPDATE ON public.events
  FOR EACH ROW EXECUTE PROCEDURE public.events_refresh_alerts();

-- Trigger: youth (inativação ou troca de grupo)
CREATE OR REPLACE FUNCTION public.youth_refresh_alert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.is_active IS DISTINCT FROM OLD.is_active OR NEW.group_id IS DISTINCT FROM OLD.group_id THEN
    PERFORM public.refresh_youth_alert(NEW.id);
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER youth_refresh_alert
  AFTER UPDATE ON public.youth
  FOR EACH ROW EXECUTE PROCEDURE public.youth_refresh_alert();

-- Recalcula os alertas de todos os jovens (uso interno + RPC do coordenador)
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
  RETURN n;
END;
$$;

REVOKE ALL ON FUNCTION public.recalculate_all_alerts_internal() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.recalculate_all_alerts()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF public.get_my_role() IS DISTINCT FROM 'coordinator' THEN
    RAISE EXCEPTION 'Apenas coordenadores podem recalcular alertas.' USING ERRCODE = '42501';
  END IF;
  RETURN public.recalculate_all_alerts_internal();
END;
$$;

REVOKE ALL ON FUNCTION public.recalculate_all_alerts() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.recalculate_all_alerts() TO authenticated;

-- Trigger: app_settings (mudança do limite recalcula tudo)
CREATE OR REPLACE FUNCTION public.settings_refresh_alerts()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.absence_alert_threshold IS DISTINCT FROM OLD.absence_alert_threshold THEN
    PERFORM public.recalculate_all_alerts_internal();
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER settings_refresh_alerts
  AFTER UPDATE ON public.app_settings
  FOR EACH ROW EXECUTE PROCEDURE public.settings_refresh_alerts();

-- Carimba quem alterou as configurações
CREATE OR REPLACE FUNCTION public.settings_stamp_user()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_by := auth.uid();
  RETURN NEW;
END;
$$;

CREATE TRIGGER settings_stamp_user
  BEFORE UPDATE ON public.app_settings
  FOR EACH ROW EXECUTE PROCEDURE public.settings_stamp_user();


-- ============================================================================
-- 5. Tarefas / Ações
-- ============================================================================
CREATE TYPE task_status   AS ENUM ('pending', 'in_progress', 'done', 'cancelled');
CREATE TYPE task_priority AS ENUM ('low', 'medium', 'high');

CREATE TABLE public.tasks (
  id            uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  title         text NOT NULL CHECK (length(btrim(title)) > 0),
  description   text,
  status        task_status   DEFAULT 'pending' NOT NULL,
  priority      task_priority DEFAULT 'medium'  NOT NULL,
  due_date      date,
  youth_id      uuid REFERENCES public.youth(id)    ON DELETE SET NULL,
  group_id      uuid REFERENCES public.groups(id)   ON DELETE SET NULL,
  alert_id      uuid REFERENCES public.alerts(id)   ON DELETE SET NULL,
  assigned_to   uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_by    uuid REFERENCES auth.users ON DELETE SET NULL DEFAULT auth.uid(),
  completed_at  timestamp with time zone,
  created_at    timestamp with time zone DEFAULT timezone('utc', now()) NOT NULL,
  updated_at    timestamp with time zone DEFAULT timezone('utc', now()) NOT NULL
);

CREATE INDEX tasks_assigned_idx ON public.tasks (assigned_to);
CREATE INDEX tasks_status_idx   ON public.tasks (status);
CREATE INDEX tasks_alert_idx    ON public.tasks (alert_id);

ALTER TABLE public.tasks ENABLE ROW LEVEL SECURITY;

CREATE TRIGGER tasks_updated_at
  BEFORE UPDATE ON public.tasks
  FOR EACH ROW EXECUTE PROCEDURE public.set_updated_at();

-- Guarda: completed_at automático; created_by imutável; líder não reatribui
-- para terceiros nem aponta a tarefa para grupo/jovem que não lidera.
CREATE OR REPLACE FUNCTION public.tasks_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    NEW.created_by := OLD.created_by;
    NEW.created_at := OLD.created_at;
  END IF;

  IF NEW.status = 'done' THEN
    IF TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'done' THEN
      NEW.completed_at := timezone('utc', now());
    END IF;
  ELSE
    NEW.completed_at := NULL;
  END IF;

  IF TG_OP = 'UPDATE'
     AND current_user IN ('anon', 'authenticated')
     AND public.get_my_role() IS DISTINCT FROM 'coordinator' THEN
    IF NEW.assigned_to IS DISTINCT FROM OLD.assigned_to
       AND NEW.assigned_to IS NOT NULL
       AND NEW.assigned_to <> auth.uid() THEN
      RAISE EXCEPTION 'Líderes só podem atribuir tarefas a si mesmos.' USING ERRCODE = '42501';
    END IF;

    IF NEW.group_id IS DISTINCT FROM OLD.group_id
       AND NEW.group_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM public.groups g
                       WHERE g.id = NEW.group_id AND g.leader_id = auth.uid()) THEN
      RAISE EXCEPTION 'Grupo não pertence ao líder.' USING ERRCODE = '42501';
    END IF;

    IF NEW.youth_id IS DISTINCT FROM OLD.youth_id
       AND NEW.youth_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM public.youth y
                       JOIN public.groups g ON g.id = y.group_id
                       WHERE y.id = NEW.youth_id AND g.leader_id = auth.uid()) THEN
      RAISE EXCEPTION 'Jovem não pertence a um grupo do líder.' USING ERRCODE = '42501';
    END IF;

    IF NEW.alert_id IS DISTINCT FROM OLD.alert_id
       AND NEW.alert_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM public.alerts a
                       JOIN public.youth y ON y.id = a.youth_id
                       JOIN public.groups g ON g.id = y.group_id
                       WHERE a.id = NEW.alert_id AND g.leader_id = auth.uid()) THEN
      RAISE EXCEPTION 'Alerta não pertence a um grupo do líder.' USING ERRCODE = '42501';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER tasks_guard
  BEFORE INSERT OR UPDATE ON public.tasks
  FOR EACH ROW EXECUTE PROCEDURE public.tasks_guard();

-- Integração: concluir tarefa vinculada resolve o alerta aberto
CREATE OR REPLACE FUNCTION public.tasks_resolve_alert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.alert_id IS NOT NULL
     AND NEW.status = 'done'
     AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'done') THEN
    UPDATE public.alerts
       SET status = 'resolved',
           resolved_by = auth.uid(),
           resolved_at = timezone('utc', now()),
           resolution_notes = COALESCE(resolution_notes, 'Resolvido pela tarefa: ' || NEW.title)
     WHERE id = NEW.alert_id
       AND status = 'open';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER tasks_resolve_alert
  AFTER INSERT OR UPDATE ON public.tasks
  FOR EACH ROW EXECUTE PROCEDURE public.tasks_resolve_alert();

-- RLS: coordenador — acesso total
CREATE POLICY "coordinator_all_tasks"
  ON public.tasks FOR ALL
  USING (public.get_my_role() = 'coordinator')
  WITH CHECK (public.get_my_role() = 'coordinator');

-- RLS: líder — leitura
CREATE POLICY "leader_select_tasks"
  ON public.tasks FOR SELECT
  USING (
    assigned_to = auth.uid()
    OR created_by = auth.uid()
    OR group_id IN (SELECT id FROM public.groups WHERE leader_id = auth.uid())
    OR youth_id IN (
      SELECT y.id FROM public.youth y
      WHERE y.group_id IN (SELECT id FROM public.groups WHERE leader_id = auth.uid())
    )
  );

-- RLS: líder — criação (para si ou sem responsável; somente com dados dos seus grupos)
CREATE POLICY "leader_insert_tasks"
  ON public.tasks FOR INSERT
  WITH CHECK (
    public.get_my_role() = 'leader'
    AND created_by = auth.uid()
    AND (assigned_to IS NULL OR assigned_to = auth.uid())
    AND (group_id IS NULL
         OR group_id IN (SELECT id FROM public.groups WHERE leader_id = auth.uid()))
    AND (youth_id IS NULL
         OR youth_id IN (
           SELECT y.id FROM public.youth y
           WHERE y.group_id IN (SELECT id FROM public.groups WHERE leader_id = auth.uid())
         ))
    AND (alert_id IS NULL
         OR alert_id IN (
           SELECT a.id FROM public.alerts a
           WHERE a.youth_id IN (
             SELECT y.id FROM public.youth y
             WHERE y.group_id IN (SELECT id FROM public.groups WHERE leader_id = auth.uid())
           )
         ))
  );

-- RLS: líder — atualização de tarefas que enxerga (regras finas no trigger tasks_guard)
CREATE POLICY "leader_update_tasks"
  ON public.tasks FOR UPDATE
  USING (
    assigned_to = auth.uid()
    OR created_by = auth.uid()
    OR group_id IN (SELECT id FROM public.groups WHERE leader_id = auth.uid())
    OR youth_id IN (
      SELECT y.id FROM public.youth y
      WHERE y.group_id IN (SELECT id FROM public.groups WHERE leader_id = auth.uid())
    )
  )
  WITH CHECK (
    assigned_to = auth.uid()
    OR created_by = auth.uid()
    OR group_id IN (SELECT id FROM public.groups WHERE leader_id = auth.uid())
    OR youth_id IN (
      SELECT y.id FROM public.youth y
      WHERE y.group_id IN (SELECT id FROM public.groups WHERE leader_id = auth.uid())
    )
  );

-- RLS: líder — exclusão apenas das tarefas que criou
CREATE POLICY "leader_delete_tasks"
  ON public.tasks FOR DELETE
  USING (created_by = auth.uid());


-- ============================================================================
-- 6. Gestão de papéis (somente coordenador)
-- ============================================================================
CREATE OR REPLACE FUNCTION public.set_user_role(p_user_id uuid, p_role user_role)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_current user_role;
BEGIN
  IF public.get_my_role() IS DISTINCT FROM 'coordinator' THEN
    RAISE EXCEPTION 'Apenas coordenadores podem alterar papéis.' USING ERRCODE = '42501';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = p_user_id) THEN
    RAISE EXCEPTION 'Usuário não encontrado.' USING ERRCODE = 'P0002';
  END IF;

  SELECT role INTO v_current FROM public.user_roles WHERE user_id = p_user_id;

  IF v_current = 'coordinator' AND p_role <> 'coordinator'
     AND (SELECT count(*) FROM public.user_roles WHERE role = 'coordinator') <= 1 THEN
    RAISE EXCEPTION 'Não é possível remover o último coordenador.' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO public.user_roles (user_id, role)
  VALUES (p_user_id, p_role)
  ON CONFLICT (user_id) DO UPDATE SET role = EXCLUDED.role;
END;
$$;

REVOKE ALL ON FUNCTION public.set_user_role(uuid, user_role) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_user_role(uuid, user_role) TO authenticated;


-- ============================================================================
-- 7. Alertas iniciais para o histórico de chamadas já existente
-- ============================================================================
SELECT public.recalculate_all_alerts_internal();
