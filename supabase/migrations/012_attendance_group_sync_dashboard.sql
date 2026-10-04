-- Migration: 012_attendance_group_sync_dashboard.sql
-- Descrição: Fase 7 (bloco 6) — correção do group_id desnormalizado de attendance, resumo da chamada só com
-- jovens ativos, infraestrutura de escopo para relatórios e os indicadores do Dashboard e dos Grupos.
--
--   1) BUG: attendance.group_id é desnormalizado (usado só pelo RLS) e ficava VELHO quando o jovem mudava de
--      grupo: o novo líder não conseguia salvar (42501 em leader_update_attendance) em encontros que já tinham
--      registro do jovem e via attendance = [] (aparecia como "não registrado"), enquanto o líder ANTIGO
--      continuava lendo as presenças de um jovem que já não é dele.
--      DECISÃO: o histórico passa a SEGUIR O JOVEM. Trigger AFTER UPDATE OF group_id em youth reescreve
--      attendance.group_id de TODAS as linhas do jovem para o novo grupo (+ backfill dos dados existentes).
--        * Alertas / situação: nada muda — faltas consecutivas, frequência e youth_situation já usam o histórico
--          COMPLETO do jovem (não dependem de attendance.group_id); alerts.group_id e o RLS de alerts/tasks/
--          follow_ups já seguem youth.group_id (grupo ATUAL). O trigger de attendance que recalcula alertas foi
--          estreitado (UPDATE OF event_id, youth_id, present) para que reescrever group_id NÃO dispare N
--          recálculos de alerta inúteis; o resultado dos alertas é o mesmo.
--        * Jovem sem grupo (group_id NULL): attendance.group_id é NOT NULL, então as linhas guardam o último
--          grupo; para o líder desse grupo não vazar histórico de quem já não é dele, a policy de leitura do
--          líder passou a exigir também que o jovem ESTEJA no grupo da linha (só restringe; nada foi afrouxado).
--          Ao entrar em outro grupo, o trigger reaponta tudo para o grupo novo. Coordenador lê sempre tudo.
--        * Linhas de encontros que o novo grupo não tem (event_groups) continuam legíveis para o novo líder
--          (são do jovem dele), mas ele só EDITA encontros vinculados ao seu grupo (save_attendance recusa os
--          demais com mensagem clara).
--        * Função do trigger: SECURITY DEFINER (o líder pode mover o jovem entre dois grupos seus e a nova linha
--          pode não passar na policy de UPDATE de attendance); sem EXECUTE para clientes; quem pode mudar o
--          grupo continua sendo decidido pelo RLS de youth.
--   2) save_attendance: o resumo (present/absent/total_registered/rate) conta só jovens ATIVOS (a tela de
--      chamada só lista ativos). Assinatura e JSON iguais.
--   3) Infra de escopo (internas, sem EXECUTE para clientes) usada por Dashboard e relatórios (013):
--      report_scope_youth / report_scope_events / report_scope_tasks / report_att_rows / report_pending_followups.
--      Escopo: coordenador = tudo; líder = jovens do grupo ATUAL dele (tarefas: o que o RLS já lhe mostra);
--      anon e usuário sem papel = nada.
--   4) RPCs: dashboard_overview() e group_indicators(uuid[]).
--
-- Regras de data: "dia" = America/Sao_Paulo (app_today()). Encontros cancelados ficam fora de toda conta de
-- frequência e "não registrado" (sem linha em attendance) nunca é falta.
--
-- Não há ALTER TYPE ... ADD VALUE nesta migration; nenhum valor novo de enum é usado em comando executado
-- durante a migration (só dentro de corpos PL/pgSQL / SQL de função, avaliados depois).
--
-- IMPORTANTE: Execute no SQL Editor do Supabase APÓS a migration 011.
-- ============================================================================


-- ============================================================================
-- 1. Sincronização de attendance.group_id com o grupo atual do jovem
-- ============================================================================
CREATE INDEX IF NOT EXISTS attendance_group_idx ON public.attendance (group_id);
CREATE INDEX IF NOT EXISTS event_groups_group_idx ON public.event_groups (group_id);

CREATE OR REPLACE FUNCTION public.youth_sync_attendance_group()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- group_id NULL (jovem sem grupo): attendance.group_id é NOT NULL; as linhas ficam com o último grupo
  -- (a policy de leitura do líder, abaixo, esconde essas linhas de quem já não lidera o jovem).
  IF NEW.group_id IS NOT NULL AND NEW.group_id IS DISTINCT FROM OLD.group_id THEN
    UPDATE public.attendance
       SET group_id = NEW.group_id
     WHERE youth_id = NEW.id
       AND group_id IS DISTINCT FROM NEW.group_id;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.youth_sync_attendance_group() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER youth_sync_attendance_group
  AFTER UPDATE OF group_id ON public.youth
  FOR EACH ROW
  WHEN (NEW.group_id IS NOT NULL AND NEW.group_id IS DISTINCT FROM OLD.group_id)
  EXECUTE PROCEDURE public.youth_sync_attendance_group();

-- Reescrever só o group_id não muda faltas/frequência: o recálculo de alertas por linha de attendance fica
-- restrito às colunas que importam (inclusive o upsert de save_attendance, que altera `present`).
DROP TRIGGER IF EXISTS attendance_refresh_alert ON public.attendance;
CREATE TRIGGER attendance_refresh_alert
  AFTER INSERT OR DELETE OR UPDATE OF event_id, youth_id, present ON public.attendance
  FOR EACH ROW EXECUTE PROCEDURE public.attendance_refresh_alert();

-- Líder só LÊ presença de jovem que está atualmente no grupo da linha (só restringe: antes bastava o group_id
-- da linha ser de um grupo dele).
DROP POLICY IF EXISTS "leader_select_attendance" ON public.attendance;
CREATE POLICY "leader_select_attendance"
  ON public.attendance FOR SELECT
  USING (
    group_id IN (SELECT id FROM public.groups WHERE leader_id = auth.uid())
    AND youth_id IN (SELECT id FROM public.youth WHERE group_id = attendance.group_id)
  );

-- >>> BACKFILL (marcadores usados pelo teste; não remova)
UPDATE public.attendance a
   SET group_id = y.group_id
  FROM public.youth y
 WHERE y.id = a.youth_id
   AND y.group_id IS NOT NULL
   AND a.group_id IS DISTINCT FROM y.group_id;
-- <<< BACKFILL


-- ============================================================================
-- 2. save_attendance — resumo só com jovens ATIVOS (CREATE OR REPLACE; assinatura e JSON iguais à 010)
-- ============================================================================
CREATE OR REPLACE FUNCTION public.save_attendance(p_event_id uuid, p_entries jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_uid       uuid := auth.uid();
  v_status    event_status;
  v_el        jsonb;
  v_raw_ids   uuid[] := '{}';
  v_raw_flags boolean[] := '{}';
  v_ids       uuid[];
  v_flags     boolean[];
  v_id        uuid;
  v_bad       integer;
  v_present   integer;
  v_absent    integer;
  v_total     integer;
  v_new       jsonb;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Não autenticado.' USING ERRCODE = '42501';
  END IF;

  IF p_entries IS NULL OR jsonb_typeof(p_entries) <> 'array' THEN
    RAISE EXCEPTION 'Lista de presenças inválida.' USING ERRCODE = 'P0001';
  END IF;

  -- Encontro: 0 linhas = não existe OU o RLS escondeu (líder sem vínculo). Não distinguimos.
  SELECT status INTO v_status FROM public.events WHERE id = p_event_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Encontro não encontrado ou sem permissão.' USING ERRCODE = 'P0002';
  END IF;
  IF v_status = 'cancelled' THEN
    RAISE EXCEPTION 'Encontro cancelado: não é possível registrar chamada.' USING ERRCODE = 'P0001';
  END IF;

  -- Leitura estrita do JSON (qualquer formato inesperado aborta tudo, nada é gravado)
  FOR v_el IN SELECT value FROM jsonb_array_elements(p_entries) LOOP
    IF jsonb_typeof(v_el) <> 'object' OR jsonb_typeof(v_el -> 'youth_id') IS DISTINCT FROM 'string' THEN
      RAISE EXCEPTION 'Lista de presenças inválida.' USING ERRCODE = 'P0001';
    END IF;
    IF COALESCE(jsonb_typeof(v_el -> 'present'), 'null') NOT IN ('boolean', 'null') THEN
      RAISE EXCEPTION 'Lista de presenças inválida.' USING ERRCODE = 'P0001';
    END IF;
    BEGIN
      v_id := (v_el ->> 'youth_id')::uuid;
    EXCEPTION WHEN invalid_text_representation THEN
      RAISE EXCEPTION 'Lista de presenças inválida.' USING ERRCODE = 'P0001';
    END;
    IF jsonb_typeof(v_el -> 'present') = 'boolean' THEN   -- null/ausente: ignorado
      v_raw_ids   := v_raw_ids   || v_id;
      v_raw_flags := v_raw_flags || (v_el ->> 'present')::boolean;
    END IF;
  END LOOP;

  -- Remove repetidos (vale o último enviado)
  SELECT COALESCE(array_agg(s.id), '{}'), COALESCE(array_agg(s.flag), '{}')
    INTO v_ids, v_flags
    FROM (
      SELECT DISTINCT ON (u.id) u.id, u.flag
        FROM unnest(v_raw_ids, v_raw_flags) WITH ORDINALITY AS u(id, flag, ord)
       ORDER BY u.id, u.ord DESC
    ) s;

  -- Todo jovem gravado precisa estar (e ser visível ao chamador via RLS) num grupo vinculado ao encontro
  SELECT count(*) INTO v_bad
    FROM unnest(v_ids) AS i(id)
   WHERE NOT EXISTS (
     SELECT 1
       FROM public.youth y
       JOIN public.event_groups eg ON eg.group_id = y.group_id AND eg.event_id = p_event_id
      WHERE y.id = i.id);
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'Há jovens que não pertencem a um grupo deste encontro.' USING ERRCODE = 'P0001';
  END IF;

  -- Upsert atômico; group_id vem do cadastro do jovem. Linhas iguais não são tocadas.
  INSERT INTO public.attendance (event_id, youth_id, group_id, present, recorded_by)
  SELECT p_event_id, u.id, y.group_id, u.flag, v_uid
    FROM unnest(v_ids, v_flags) AS u(id, flag)
    JOIN public.youth y ON y.id = u.id
  ON CONFLICT (event_id, youth_id) DO UPDATE
     SET present = EXCLUDED.present,
         group_id = EXCLUDED.group_id,
         recorded_by = EXCLUDED.recorded_by
   WHERE attendance.present IS DISTINCT FROM EXCLUDED.present
      OR attendance.group_id IS DISTINCT FROM EXCLUDED.group_id;

  -- Totais do encontro: somente linhas visíveis ao chamador e somente jovens ATIVOS (a tela só lista ativos)
  SELECT count(*) FILTER (WHERE a.present), count(*) FILTER (WHERE NOT a.present), count(*)
    INTO v_present, v_absent, v_total
    FROM public.attendance a
    JOIN public.youth y ON y.id = a.youth_id
   WHERE a.event_id = p_event_id AND y.is_active;

  -- Alertas criados NESTA transação para os jovens enviados, visíveis ao chamador (RLS de alerts/youth).
  -- timezone('utc', now()) é o mesmo valor/conversão do DEFAULT de alerts.created_at.
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'id', al.id,
           'youth_id', al.youth_id,
           'youth_name', y.full_name,
           'type', al.type::text,
           'severity', al.severity::text,
           'consecutive_absences', al.consecutive_absences
         ) ORDER BY y.full_name, al.type::text), '[]'::jsonb)
    INTO v_new
    FROM public.alerts al
    JOIN public.youth y ON y.id = al.youth_id
   WHERE al.youth_id = ANY (v_ids)
     AND al.status = 'open'
     AND al.created_at >= timezone('utc', now());

  RETURN jsonb_build_object(
    'saved', COALESCE(array_length(v_ids, 1), 0),
    'present', v_present,
    'absent', v_absent,
    'total_registered', v_total,
    'rate', CASE WHEN v_total = 0 THEN 0 ELSE round(100.0 * v_present / v_total)::integer END,
    'new_alerts', v_new
  );
END;
$$;

REVOKE ALL ON FUNCTION public.save_attendance(uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_attendance(uuid, jsonb) TO authenticated;


-- ============================================================================
-- 3. Infraestrutura de escopo (INTERNA: sem EXECUTE para clientes)
-- ============================================================================
-- Todas são SECURITY DEFINER com search_path fixo e checagem explícita de escopo por auth.uid()/get_my_role():
--   coordenador -> tudo; líder -> só jovens cujo grupo ATUAL ele lidera; sem sessão/sem papel -> nada.
-- Só são chamadas por RPCs (DEFINER) deste arquivo e da 013, que rodam como dono e por isso não precisam de
-- EXECUTE para authenticated.

-- Jovens no escopo do chamador (inclui inativos; quem usa filtra is_active). p_group_id filtra pelo grupo ATUAL.
CREATE OR REPLACE FUNCTION public.report_scope_youth(p_group_id uuid DEFAULT NULL)
RETURNS TABLE (youth_id uuid, group_id uuid, is_active boolean)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT y.id, y.group_id, y.is_active
    FROM public.youth y
    LEFT JOIN public.groups g ON g.id = y.group_id
   WHERE auth.uid() IS NOT NULL
     AND public.get_my_role() IS NOT NULL
     AND (public.get_my_role() = 'coordinator' OR g.leader_id = auth.uid())
     AND (p_group_id IS NULL OR y.group_id = p_group_id)
$$;

-- Encontros no escopo dentro de [p_t0, p_t1). Coordenador sem filtro: todos; demais casos: encontros vinculados
-- (event_groups) ao grupo filtrado / aos grupos do líder.
CREATE OR REPLACE FUNCTION public.report_scope_events(p_t0 timestamptz, p_t1 timestamptz, p_group_id uuid DEFAULT NULL)
RETURNS TABLE (event_id uuid, title text, event_date timestamptz, status event_status)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT e.id, e.title, e.event_date, e.status
    FROM public.events e
   WHERE e.event_date >= p_t0 AND e.event_date < p_t1
     AND auth.uid() IS NOT NULL
     AND public.get_my_role() IS NOT NULL
     AND ( (public.get_my_role() = 'coordinator' AND p_group_id IS NULL)
        OR EXISTS (SELECT 1
                     FROM public.event_groups eg
                     JOIN public.groups g ON g.id = eg.group_id
                    WHERE eg.event_id = e.id
                      AND (p_group_id IS NULL OR eg.group_id = p_group_id)
                      AND (public.get_my_role() = 'coordinator' OR g.leader_id = auth.uid())) )
$$;

-- Tarefas/ações no escopo: coordenador = todas; líder = as que o RLS de tasks já lhe mostra. Com p_group_id:
-- só as do grupo (tasks.group_id) ou de jovens que estão nele agora.
CREATE OR REPLACE FUNCTION public.report_scope_tasks(p_group_id uuid DEFAULT NULL)
RETURNS TABLE (task_id uuid, status task_status, due_date date, completed_at timestamptz,
               created_at timestamptz, youth_id uuid, group_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT t.id, t.status, t.due_date, t.completed_at, t.created_at, t.youth_id, t.group_id
    FROM public.tasks t
   WHERE auth.uid() IS NOT NULL
     AND public.get_my_role() IS NOT NULL
     AND ( public.get_my_role() = 'coordinator'
        OR t.assigned_to = auth.uid()
        OR t.created_by = auth.uid()
        OR t.group_id IN (SELECT g.id FROM public.groups g WHERE g.leader_id = auth.uid())
        OR t.youth_id IN (SELECT s.youth_id FROM public.report_scope_youth(NULL) s) )
     AND ( p_group_id IS NULL
        OR t.group_id = p_group_id
        OR t.youth_id IN (SELECT s.youth_id FROM public.report_scope_youth(p_group_id) s) )
$$;

-- Linhas de presença (um registro por jovem ATIVO no escopo e encontro NÃO cancelado) com encontro dentro de
-- [p_from, p_to] (datas inclusivas, fuso America/Sao_Paulo). "Não registrado" = sem linha, não aparece aqui.
-- Com p_group_id: jovens que estão HOJE no grupo, em encontros vinculados a esse grupo (event_groups).
-- O histórico segue o jovem (decisão da seção 1): youth_group_id é o grupo ATUAL do jovem.
CREATE OR REPLACE FUNCTION public.report_att_rows(p_from date, p_to date, p_group_id uuid DEFAULT NULL)
RETURNS TABLE (event_id uuid, event_date timestamptz, title text, status event_status,
               youth_id uuid, youth_group_id uuid, present boolean)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT e.id, e.event_date, e.title, e.status, a.youth_id, s.group_id, a.present
    FROM public.report_scope_youth(p_group_id) s
    JOIN public.attendance a ON a.youth_id = s.youth_id
    JOIN public.events e ON e.id = a.event_id
   WHERE s.is_active
     AND e.status <> 'cancelled'
     AND e.event_date >= (p_from::timestamp AT TIME ZONE 'America/Sao_Paulo')
     AND e.event_date <  ((p_to + 1)::timestamp AT TIME ZONE 'America/Sao_Paulo')
     AND (p_group_id IS NULL
          OR EXISTS (SELECT 1 FROM public.event_groups eg
                      WHERE eg.event_id = e.id AND eg.group_id = p_group_id))
$$;

-- Próximas ações de acompanhamento PENDENTES (follow_ups.next_action_due) de jovens ATIVOS no escopo.
-- Pendente = tem prazo; não foi superada por um acompanhamento mais novo do mesmo jovem (o contato seguinte
-- substitui a "próxima ação" anterior); e não está ligada a uma ação (task) já concluída/cancelada.
-- Nome do responsável: só o responsável ATUAL de acompanhamentos que o chamador já acessa (mesmo critério de
-- follow_up_people, 011); nenhum outro perfil é exposto.
CREATE OR REPLACE FUNCTION public.report_pending_followups(p_group_id uuid DEFAULT NULL)
RETURNS TABLE (follow_up_id uuid, youth_id uuid, youth_name text, next_action text, next_action_due date,
               responsible_id uuid, responsible_name text, occurred_at date)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT f.id, f.youth_id, y.full_name, f.next_action, f.next_action_due, f.responsible_id, p.full_name, f.occurred_at
    FROM public.report_scope_youth(p_group_id) s
    JOIN public.follow_ups f ON f.youth_id = s.youth_id
    JOIN public.youth y ON y.id = f.youth_id
    LEFT JOIN public.profiles p ON p.id = f.responsible_id
   WHERE s.is_active
     AND f.next_action_due IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.follow_ups n
                      WHERE n.youth_id = f.youth_id
                        AND (n.occurred_at, n.created_at, n.id) > (f.occurred_at, f.created_at, f.id))
     AND (f.task_id IS NULL
          OR NOT EXISTS (SELECT 1 FROM public.tasks t
                          WHERE t.id = f.task_id AND t.status IN ('done', 'cancelled')))
$$;

REVOKE ALL ON FUNCTION public.report_scope_youth(uuid)                  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.report_scope_events(timestamptz, timestamptz, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.report_scope_tasks(uuid)                  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.report_att_rows(date, date, uuid)         FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.report_pending_followups(uuid)            FROM PUBLIC, anon, authenticated;


-- ============================================================================
-- 4a. dashboard_overview()
-- ============================================================================
-- STABLE, SECURITY DEFINER com escopo explícito (coordenador tudo; líder só jovens do grupo ATUAL dele).
-- anon/sem papel => erro 42501. Retorna jsonb (todas as listas ordenadas por severidade/data e depois nome,
-- NUNCA por "ranking" numérico):
--   {
--     "attention":          [ até 10 { "youth_id", "full_name", "group_name"|null, "situation": "critical"|"attention",
--                                      "reasons": ["3 faltas seguidas", ...] } ]  -- críticos primeiro, depois nome
--     "attention_total":    int            -- quantos jovens ativos estão em critical/attention (a lista corta em 10)
--     "open_alerts":        { "total", "critical", "attention" }   -- alertas abertos de jovens no escopo
--     "overdue_actions":    int            -- ações atrasadas (is_task_overdue) que o chamador enxerga
--     "upcoming_follow_ups":[ até 10 { "follow_up_id", "youth_id", "youth_name", "next_action"|null,
--                                      "next_action_due": "YYYY-MM-DD", "responsible_name"|null } ]
--                              -- pendentes (ver report_pending_followups) vencidos OU com prazo em até 14 dias,
--                              -- por prazo, depois nome do jovem
--     "youth_without_group":int            -- jovens ativos sem grupo (só coordenador; líder = 0)
--     "upcoming_events":    [ até 5 { "id", "title", "event_date", "groups": [ { "id", "name" } ] } ]
--                              -- encontros 'scheduled' de hoje (fuso SP) em diante; líder só vê os seus grupos
--     "avg_attendance":     int|null       -- % presentes/registrados de jovens ATIVOS, encontros dos últimos 30 dias
--                                           -- (hoje e os 29 dias anteriores); null se não há registros
--     "avg_attendance_records": int        -- nº de registros usados em avg_attendance
--     "active_youth":       int
--   }
-- A situação vem de youth_situations (011), em blocos de 500 ids (limite dessa função); jovens inativos
-- não entram. Este RPC não recalcula alertas por tempo (use sync_time_alerts() ao abrir a tela).
CREATE OR REPLACE FUNCTION public.dashboard_overview()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid       uuid := auth.uid();
  v_role      text;
  v_today     date := public.app_today();
  v_start     timestamptz := public.app_today()::timestamp AT TIME ZONE 'America/Sao_Paulo';
  v_ids       uuid[];
  v_active    integer;
  v_sit       youth_situation_row[] := '{}';
  v_i         integer;
  v_attention jsonb;
  v_att_total integer;
  v_alerts    jsonb;
  v_overdue   integer;
  v_fups      jsonb;
  v_nogroup   integer := 0;
  v_events    jsonb;
  v_p         integer;
  v_n         integer;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Não autenticado.' USING ERRCODE = '42501';
  END IF;
  v_role := public.get_my_role();
  IF v_role IS NULL THEN
    RAISE EXCEPTION 'Sem permissão.' USING ERRCODE = '42501';
  END IF;

  SELECT COALESCE(array_agg(s.youth_id ORDER BY s.youth_id), '{}'), count(*)::integer
    INTO v_ids, v_active
    FROM public.report_scope_youth(NULL) s
   WHERE s.is_active;

  -- Situação (reuso integral das regras da 011), em blocos de 500
  v_i := 1;
  WHILE v_i <= COALESCE(cardinality(v_ids), 0) LOOP
    v_sit := v_sit || ARRAY(
      SELECT x FROM public.youth_situations(v_ids[v_i : v_i + 499]) x
       WHERE x.situation <> 'normal' AND NOT x.inactive);
    v_i := v_i + 500;
  END LOOP;

  v_att_total := COALESCE(cardinality(v_sit), 0);
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'youth_id', r.youth_id, 'full_name', r.full_name, 'group_name', r.group_name,
           'situation', r.situation, 'reasons', to_jsonb(r.reasons))
           ORDER BY (r.situation = 'critical') DESC, r.full_name, r.youth_id), '[]'::jsonb)
    INTO v_attention
    FROM (SELECT * FROM unnest(v_sit) u
           ORDER BY (u.situation = 'critical') DESC, u.full_name, u.youth_id
           LIMIT 10) r;

  SELECT jsonb_build_object(
           'total', count(*),
           'critical', count(*) FILTER (WHERE a.severity = 'critical'),
           'attention', count(*) FILTER (WHERE a.severity = 'attention'))
    INTO v_alerts
    FROM public.alerts a
   WHERE a.status = 'open'
     AND a.youth_id IN (SELECT s.youth_id FROM public.report_scope_youth(NULL) s);

  SELECT count(*)::integer INTO v_overdue
    FROM public.report_scope_tasks(NULL) t
   WHERE public.is_task_overdue(t.status, t.due_date);

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'follow_up_id', f.follow_up_id, 'youth_id', f.youth_id, 'youth_name', f.youth_name,
           'next_action', f.next_action, 'next_action_due', f.next_action_due,
           'responsible_name', f.responsible_name)
           ORDER BY f.next_action_due, f.youth_name, f.follow_up_id), '[]'::jsonb)
    INTO v_fups
    FROM (SELECT * FROM public.report_pending_followups(NULL) p
           WHERE p.next_action_due <= v_today + 14
           ORDER BY p.next_action_due, p.youth_name, p.follow_up_id
           LIMIT 10) f;

  IF v_role = 'coordinator' THEN
    SELECT count(*)::integer INTO v_nogroup
      FROM public.report_scope_youth(NULL) s
     WHERE s.is_active AND s.group_id IS NULL;
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'id', e.event_id, 'title', e.title, 'event_date', e.event_date,
           'groups', (SELECT COALESCE(jsonb_agg(jsonb_build_object('id', g.id, 'name', g.name)
                                                ORDER BY g.name, g.id), '[]'::jsonb)
                        FROM public.event_groups eg
                        JOIN public.groups g ON g.id = eg.group_id
                       WHERE eg.event_id = e.event_id
                         AND (v_role = 'coordinator' OR g.leader_id = v_uid)))
           ORDER BY e.event_date, e.event_id), '[]'::jsonb)
    INTO v_events
    FROM (SELECT * FROM public.report_scope_events(v_start, 'infinity'::timestamptz, NULL) ev
           WHERE ev.status = 'scheduled'
           ORDER BY ev.event_date, ev.event_id
           LIMIT 5) e;

  SELECT count(*) FILTER (WHERE r.present)::integer, count(*)::integer
    INTO v_p, v_n
    FROM public.report_att_rows(v_today - 29, v_today, NULL) r;

  RETURN jsonb_build_object(
    'attention', v_attention,
    'attention_total', v_att_total,
    'open_alerts', v_alerts,
    'overdue_actions', v_overdue,
    'upcoming_follow_ups', v_fups,
    'youth_without_group', v_nogroup,
    'upcoming_events', v_events,
    'avg_attendance', CASE WHEN v_n = 0 THEN NULL ELSE round(100.0 * v_p / v_n)::integer END,
    'avg_attendance_records', v_n,
    'active_youth', v_active);
END;
$$;

REVOKE ALL ON FUNCTION public.dashboard_overview() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.dashboard_overview() TO authenticated;


-- ============================================================================
-- 4b. group_indicators(p_group_ids uuid[] DEFAULT NULL)
-- ============================================================================
-- Uma linha por grupo no escopo (coordenador: todos; líder: os que ele lidera), filtrado por p_group_ids se
-- informado (ids fora do escopo são ignorados em silêncio). SEMPRE ordenado por nome do grupo (e id): não há
-- ordenação por desempenho. Colunas:
--   group_id, name, leader_name (nome do líder DO grupo; null sem líder)
--   active_youth          jovens ativos hoje no grupo
--   attendance_rate       % de presença (0-100) nos ÚLTIMOS 8 ENCONTROS do grupo que tenham registro (encontros
--                         vinculados ao grupo via event_groups, não cancelados, com ao menos um registro de um
--                         jovem ativo do grupo; só registros desses jovens contam). null se nenhum.
--   trend / trend_delta   'up' | 'down' | 'stable' e a diferença em PONTOS PERCENTUAIS entre os 4 encontros
--                         mais recentes e os 4 anteriores (dentro dos 8 acima). MÍNIMO: 8 encontros com registro
--                         (4 + 4); abaixo disso ambos são NULL. 'up' se delta >= +10, 'down' se <= -10.
--   youth_in_attention    jovens ativos do grupo com situação critical/attention (youth_situations, 011)
--   overdue_actions       ações atrasadas (is_task_overdue) do grupo (tasks.group_id) ou de jovens ATIVOS dele
CREATE OR REPLACE FUNCTION public.group_indicators(p_group_ids uuid[] DEFAULT NULL)
RETURNS TABLE (
  group_id            uuid,
  name                text,
  leader_name         text,
  active_youth        integer,
  attendance_rate     integer,
  trend               text,
  trend_delta         integer,
  youth_in_attention  integer,
  overdue_actions     integer
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  v_uid   uuid := auth.uid();
  v_role  text;
  v_ids   uuid[];
  v_sit   youth_situation_row[] := '{}';
  v_i     integer;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Não autenticado.' USING ERRCODE = '42501';
  END IF;
  v_role := public.get_my_role();
  IF v_role IS NULL THEN
    RAISE EXCEPTION 'Sem permissão.' USING ERRCODE = '42501';
  END IF;

  SELECT COALESCE(array_agg(y.id ORDER BY y.id), '{}') INTO v_ids
    FROM public.youth y
    JOIN public.groups g ON g.id = y.group_id
   WHERE y.is_active
     AND (v_role = 'coordinator' OR g.leader_id = v_uid)
     AND (p_group_ids IS NULL OR g.id = ANY (p_group_ids));

  v_i := 1;
  WHILE v_i <= COALESCE(cardinality(v_ids), 0) LOOP
    v_sit := v_sit || ARRAY(
      SELECT x FROM public.youth_situations(v_ids[v_i : v_i + 499]) x
       WHERE x.situation <> 'normal' AND NOT x.inactive);
    v_i := v_i + 500;
  END LOOP;

  RETURN QUERY
  WITH sg AS (
    SELECT g.id AS gid, g.name AS gname, g.leader_id
      FROM public.groups g
     WHERE (v_role = 'coordinator' OR g.leader_id = v_uid)
       AND (p_group_ids IS NULL OR g.id = ANY (p_group_ids))
  ),
  members AS (
    SELECT y.id AS yid, y.group_id AS gid
      FROM public.youth y
      JOIN sg ON sg.gid = y.group_id
     WHERE y.is_active
  ),
  ev AS (   -- um registro por (grupo, encontro): total e presentes dos membros ativos
    SELECT eg.group_id AS gid, e.id AS eid, e.event_date,
           count(*)::integer AS n,
           (count(*) FILTER (WHERE a.present))::integer AS p
      FROM sg
      JOIN public.event_groups eg ON eg.group_id = sg.gid
      JOIN public.events e ON e.id = eg.event_id AND e.status <> 'cancelled'
      JOIN public.attendance a ON a.event_id = e.id
      JOIN members m ON m.yid = a.youth_id AND m.gid = sg.gid
     GROUP BY eg.group_id, e.id, e.event_date
  ),
  ranked AS (
    SELECT ev.*, row_number() OVER (PARTITION BY ev.gid ORDER BY ev.event_date DESC, ev.eid) AS rn
      FROM ev
  ),
  agg AS (
    SELECT r.gid,
           (count(*) FILTER (WHERE r.rn <= 8))::integer         AS ne,
           sum(r.n) FILTER (WHERE r.rn <= 8)                   AS n8,
           sum(r.p) FILTER (WHERE r.rn <= 8)                   AS p8,
           sum(r.n) FILTER (WHERE r.rn <= 4)                   AS nr,
           sum(r.p) FILTER (WHERE r.rn <= 4)                   AS pr,
           sum(r.n) FILTER (WHERE r.rn BETWEEN 5 AND 8)        AS np,
           sum(r.p) FILTER (WHERE r.rn BETWEEN 5 AND 8)        AS pp
      FROM ranked r
     GROUP BY r.gid
  ),
  calc AS (
    SELECT a.gid,
           CASE WHEN a.n8 > 0 THEN round(100.0 * a.p8 / a.n8)::integer END AS rate,
           CASE WHEN a.ne >= 8 AND a.nr > 0 AND a.np > 0
                THEN round(100.0 * a.pr / a.nr - 100.0 * a.pp / a.np)::integer END AS delta
      FROM agg a
  ),
  sit AS (
    SELECT u.group_id AS gid, count(*)::integer AS c
      FROM unnest(v_sit) u
     GROUP BY u.group_id
  ),
  tk AS (
    SELECT sg.gid, count(DISTINCT t.id)::integer AS c
      FROM sg
      JOIN public.tasks t
        ON public.is_task_overdue(t.status, t.due_date)
       AND (t.group_id = sg.gid
            OR t.youth_id IN (SELECT m.yid FROM members m WHERE m.gid = sg.gid))
     GROUP BY sg.gid
  ),
  cnt AS (
    SELECT m.gid, count(*)::integer AS c FROM members m GROUP BY m.gid
  )
  SELECT sg.gid, sg.gname, pr.full_name,
         COALESCE(cnt.c, 0),
         calc.rate,
         CASE WHEN calc.delta IS NULL THEN NULL
              WHEN calc.delta >= 10 THEN 'up'
              WHEN calc.delta <= -10 THEN 'down'
              ELSE 'stable' END,
         calc.delta,
         COALESCE(sit.c, 0),
         COALESCE(tk.c, 0)
    FROM sg
    LEFT JOIN public.profiles pr ON pr.id = sg.leader_id
    LEFT JOIN cnt  ON cnt.gid  = sg.gid
    LEFT JOIN calc ON calc.gid = sg.gid
    LEFT JOIN sit  ON sit.gid  = sg.gid
    LEFT JOIN tk   ON tk.gid   = sg.gid
   ORDER BY sg.gname, sg.gid;
END;
$$;

REVOKE ALL ON FUNCTION public.group_indicators(uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.group_indicators(uuid[]) TO authenticated;

NOTIFY pgrst, 'reload schema';
