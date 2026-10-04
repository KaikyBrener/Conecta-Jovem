-- Migration: 013_reports.sql
-- Descrição: Fase 7 (bloco 7) — relatórios agregados NO SERVIDOR (RPCs jsonb). O cliente só envia datas; períodos
-- ("hoje", "semana", "30 dias"...) são resolvidos no frontend. Nenhuma linha bruta é devolvida além das listas
-- curtas e limitadas documentadas abaixo.
--
-- Funções (todas SECURITY DEFINER + STABLE + search_path fixo, EXECUTE só para authenticated; anon = negado):
--   report_general(p_from, p_to, p_group_id)
--   report_attendance(p_from, p_to, p_group_id, p_min_absences)
--   report_followups(p_from, p_to, p_group_id)
--   report_alerts(p_from, p_to, p_group_id)
--   report_youth(p_youth_id, p_from, p_to)
--   report_groups(p_from, p_to)
--
-- ESCOPO (checado dentro de cada função, pela infraestrutura da 012): coordenador = tudo; líder = só jovens do
-- grupo ATUAL dele (o histórico segue o jovem, ver 012). p_group_id de grupo fora do escopo => erro P0002
-- "Grupo não encontrado ou sem permissão." (não distingue inexistente de alheio). O escopo é explícito (e não via
-- RLS) porque o RLS de attendance usa o group_id gravado na linha e o líder não enxerga profiles de terceiros.
--
-- PARÂMETROS COMUNS: p_from/p_to = datas INCLUSIVAS (dia no fuso America/Sao_Paulo); exige p_from <= p_to e no
-- máximo 400 dias (inclusive); datas nulas/infinitas => erro pt-BR (P0001).
--
-- REGRAS DE CONTAGEM: frequência = presentes / registrados, só jovens ATIVOS, só encontros NÃO cancelados;
-- "não registrado" (sem linha em attendance) nunca é falta nem entra no denominador. Percentuais são inteiros
-- 0-100 (round) ou null sem registros. Nada é ordenado por desempenho: listas por data, tipo ou nome.
--
-- Em todos os JSONs: "period" = { "from": "YYYY-MM-DD", "to": "YYYY-MM-DD", "days": int, "group_id": uuid|null }.
-- Itens marcados *_now / "snapshot" valem "agora" e não dependem do período.
--
-- Não usa ALTER TYPE ... ADD VALUE; valores de enum (alert_type novos) só aparecem dentro de corpos de função.
-- IMPORTANTE: Execute no SQL Editor do Supabase APÓS a migration 012.
-- ============================================================================


-- ============================================================================
-- 1. Índices dos relatórios
-- ============================================================================
CREATE INDEX IF NOT EXISTS follow_ups_occurred_idx    ON public.follow_ups (occurred_at);
CREATE INDEX IF NOT EXISTS follow_ups_next_due_idx    ON public.follow_ups (next_action_due)
  WHERE next_action_due IS NOT NULL;
CREATE INDEX IF NOT EXISTS follow_up_transfers_at_idx ON public.follow_up_transfers (transferred_at);
CREATE INDEX IF NOT EXISTS alerts_created_idx         ON public.alerts (created_at);
CREATE INDEX IF NOT EXISTS alerts_resolved_idx        ON public.alerts (resolved_at) WHERE resolved_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS tasks_completed_idx        ON public.tasks (completed_at) WHERE completed_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS tasks_created_idx          ON public.tasks (created_at);
-- (já existem: attendance_youth_idx, attendance_event_idx, attendance_group_idx, events_date_idx,
--  event_groups_group_idx, youth_group_idx, alerts_youth_status_idx, follow_ups_youth_idx, tasks_youth_idx)


-- ============================================================================
-- 2. Auxiliares internos (sem EXECUTE para clientes)
-- ============================================================================
-- Validação comum. Retorna o papel do chamador ('coordinator'|'leader'). Erros em pt-BR.
CREATE OR REPLACE FUNCTION public.report_check(p_from date, p_to date, p_group_id uuid)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid  uuid := auth.uid();
  v_role text;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Não autenticado.' USING ERRCODE = '42501';
  END IF;
  v_role := public.get_my_role();
  IF v_role IS NULL THEN
    RAISE EXCEPTION 'Sem permissão.' USING ERRCODE = '42501';
  END IF;
  IF p_from IS NULL OR p_to IS NULL OR NOT isfinite(p_from) OR NOT isfinite(p_to) THEN
    RAISE EXCEPTION 'Informe o período do relatório.' USING ERRCODE = 'P0001';
  END IF;
  IF p_from > p_to THEN
    RAISE EXCEPTION 'A data inicial não pode ser posterior à data final.' USING ERRCODE = 'P0001';
  END IF;
  IF p_to - p_from >= 400 THEN
    RAISE EXCEPTION 'O período do relatório pode ter no máximo 400 dias.' USING ERRCODE = 'P0001';
  END IF;
  IF p_group_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM public.groups g
        WHERE g.id = p_group_id AND (v_role = 'coordinator' OR g.leader_id = v_uid)) THEN
    RAISE EXCEPTION 'Grupo não encontrado ou sem permissão.' USING ERRCODE = 'P0002';
  END IF;
  RETURN v_role;
END;
$$;

-- Percentual inteiro 0-100 ou null (sem registros)
CREATE OR REPLACE FUNCTION public.report_pct(p_present bigint, p_total bigint)
RETURNS integer
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$ SELECT CASE WHEN COALESCE(p_total, 0) > 0 THEN round(100.0 * COALESCE(p_present, 0) / p_total)::integer END $$;

CREATE OR REPLACE FUNCTION public.report_period(p_from date, p_to date, p_group_id uuid)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$ SELECT jsonb_build_object('from', p_from, 'to', p_to, 'days', p_to - p_from + 1, 'group_id', p_group_id) $$;

REVOKE ALL ON FUNCTION public.report_check(date, date, uuid)  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.report_pct(bigint, bigint)      FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.report_period(date, date, uuid) FROM PUBLIC, anon, authenticated;


-- ============================================================================
-- 3. report_general
-- ============================================================================
-- {
--   "period": {...},
--   "active_youth": int,                       -- jovens ativos no escopo AGORA (snapshot)
--   "events":   { "held": int,                 -- encontros com status 'completed' no período (escopo)
--                 "cancelled": int },
--   "attendance": { "present", "absent", "registered": int, "rate": int|null },
--   "alerts":   { "open_now": int,             -- snapshot: abertos agora
--                 "created": int,              -- criados no período
--                 "resolved": int,             -- status 'resolved' com resolved_at no período
--                 "dismissed": int },          -- status 'dismissed' com resolved_at no período
--   "follow_ups": { "total": int, "youth_reached": int },   -- occurred_at no período
--   "actions":  { "open_now": int,             -- pending/in_progress agora (snapshot)
--                 "overdue_now": int,          -- atrasadas agora (snapshot)
--                 "created": int,              -- criadas no período
--                 "completed": int }           -- status 'done' com completed_at no período
-- }
CREATE OR REPLACE FUNCTION public.report_general(p_from date, p_to date, p_group_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_t0        timestamptz;
  v_t1        timestamptz;
  v_active    integer;
  v_held      integer;
  v_cancelled integer;
  v_p         integer;
  v_n         integer;
  v_alerts    jsonb;
  v_fu        jsonb;
  v_tasks     jsonb;
BEGIN
  PERFORM public.report_check(p_from, p_to, p_group_id);
  v_t0 := p_from::timestamp AT TIME ZONE 'America/Sao_Paulo';
  v_t1 := (p_to + 1)::timestamp AT TIME ZONE 'America/Sao_Paulo';

  SELECT count(*)::integer INTO v_active
    FROM public.report_scope_youth(p_group_id) s WHERE s.is_active;

  SELECT (count(*) FILTER (WHERE e.status = 'completed'))::integer,
         (count(*) FILTER (WHERE e.status = 'cancelled'))::integer
    INTO v_held, v_cancelled
    FROM public.report_scope_events(v_t0, v_t1, p_group_id) e;

  SELECT (count(*) FILTER (WHERE r.present))::integer, count(*)::integer
    INTO v_p, v_n
    FROM public.report_att_rows(p_from, p_to, p_group_id) r;

  SELECT jsonb_build_object(
           'open_now',  count(*) FILTER (WHERE a.status = 'open'),
           'created',   count(*) FILTER (WHERE a.created_at >= v_t0 AND a.created_at < v_t1),
           'resolved',  count(*) FILTER (WHERE a.status = 'resolved'
                                           AND a.resolved_at >= v_t0 AND a.resolved_at < v_t1),
           'dismissed', count(*) FILTER (WHERE a.status = 'dismissed'
                                           AND a.resolved_at >= v_t0 AND a.resolved_at < v_t1))
    INTO v_alerts
    FROM public.alerts a
   WHERE a.youth_id IN (SELECT s.youth_id FROM public.report_scope_youth(p_group_id) s);

  SELECT jsonb_build_object('total', count(*), 'youth_reached', count(DISTINCT f.youth_id))
    INTO v_fu
    FROM public.follow_ups f
   WHERE f.occurred_at BETWEEN p_from AND p_to
     AND f.youth_id IN (SELECT s.youth_id FROM public.report_scope_youth(p_group_id) s);

  SELECT jsonb_build_object(
           'open_now',    count(*) FILTER (WHERE t.status IN ('pending', 'in_progress')),
           'overdue_now', count(*) FILTER (WHERE public.is_task_overdue(t.status, t.due_date)),
           'created',     count(*) FILTER (WHERE t.created_at >= v_t0 AND t.created_at < v_t1),
           'completed',   count(*) FILTER (WHERE t.status = 'done'
                                             AND t.completed_at >= v_t0 AND t.completed_at < v_t1))
    INTO v_tasks
    FROM public.report_scope_tasks(p_group_id) t;

  RETURN jsonb_build_object(
    'period', public.report_period(p_from, p_to, p_group_id),
    'active_youth', v_active,
    'events', jsonb_build_object('held', v_held, 'cancelled', v_cancelled),
    'attendance', jsonb_build_object(
      'present', v_p, 'absent', v_n - v_p, 'registered', v_n, 'rate', public.report_pct(v_p, v_n)),
    'alerts', v_alerts,
    'follow_ups', v_fu,
    'actions', v_tasks);
END;
$$;


-- ============================================================================
-- 4. report_attendance
-- ============================================================================
-- p_min_absences (padrão 3, 1..50): corte da lista "youth_absences".
-- {
--   "period": {...},
--   "summary":  { "events": int,               -- encontros não cancelados do período (inclui os sem registro)
--                 "events_with_records": int, "events_cancelled": int,
--                 "present", "absent", "registered": int, "rate": int|null },
--   "by_event": [ { "event_id", "event_date" (timestamptz), "title", "status",
--                   "present", "absent", "registered": int, "rate": int|null } ],   -- por data
--   "series":   [ { "date": "YYYY-MM-DD", "present", "registered": int, "rate": int } ],  -- um ponto por dia com
--                                                                                         -- registro (gráfico)
--   "by_group": [ { "group_id": uuid|null, "name", "events": int, "present", "absent", "registered": int,
--                   "rate": int|null } ],       -- por nome do grupo; considera jovens que estão no grupo HOJE em
--                                               -- encontros vinculados a ele; o coordenador sem filtro vê também
--                                               -- "Sem grupo" (group_id null) quando houver registros
--   "youth_absences": { "min_absences": int, "total": int,    -- jovens com >= N faltas (present=false) no período
--                       "limit": 50,
--                       "items": [ { "youth_id", "full_name", "group_name"|null, "absences", "registered": int } ] }
--                                                             -- ordem alfabética, até 50
-- }
-- by_event inclui encontros do escopo sem nenhum registro (registered 0, rate null) e encontros de outro grupo
-- onde há registro de jovem do escopo (o histórico segue o jovem). Esses registros entram no total geral, mas
-- não em by_group (que só conta encontros vinculados ao grupo ATUAL do jovem).
CREATE OR REPLACE FUNCTION public.report_attendance(
  p_from         date,
  p_to           date,
  p_group_id     uuid DEFAULT NULL,
  p_min_absences integer DEFAULT 3
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid  uuid := auth.uid();
  v_role text;
  v_t0   timestamptz;
  v_t1   timestamptz;
BEGIN
  v_role := public.report_check(p_from, p_to, p_group_id);
  IF p_min_absences IS NULL OR p_min_absences < 1 OR p_min_absences > 50 THEN
    RAISE EXCEPTION 'O número mínimo de faltas deve estar entre 1 e 50.' USING ERRCODE = 'P0001';
  END IF;
  v_t0 := p_from::timestamp AT TIME ZONE 'America/Sao_Paulo';
  v_t1 := (p_to + 1)::timestamp AT TIME ZONE 'America/Sao_Paulo';

  RETURN (
    WITH rws AS MATERIALIZED (
      SELECT * FROM public.report_att_rows(p_from, p_to, p_group_id)
    ),
    scope_ev AS MATERIALIZED (
      SELECT * FROM public.report_scope_events(v_t0, v_t1, p_group_id)
    ),
    evs AS (
      SELECT e.event_id, e.event_date, e.title, e.status FROM scope_ev e WHERE e.status <> 'cancelled'
      UNION
      SELECT r.event_id, r.event_date, r.title, r.status FROM rws r
    ),
    ev_stats AS (
      SELECT ev.event_id, ev.event_date, ev.title, ev.status,
             count(r.youth_id)::integer AS n,
             (count(r.youth_id) FILTER (WHERE r.present))::integer AS p
        FROM evs ev
        LEFT JOIN rws r ON r.event_id = ev.event_id
       GROUP BY ev.event_id, ev.event_date, ev.title, ev.status
    ),
    day_stats AS (
      SELECT (r.event_date AT TIME ZONE 'America/Sao_Paulo')::date AS d,
             count(*)::integer AS n,
             (count(*) FILTER (WHERE r.present))::integer AS p
        FROM rws r
       GROUP BY 1
    ),
    grp AS (
      SELECT g.id AS gid, g.name AS gname
        FROM public.groups g
       WHERE (v_role = 'coordinator' OR g.leader_id = v_uid)
         AND (p_group_id IS NULL OR g.id = p_group_id)
    ),
    g_stats AS (
      SELECT grp.gid, grp.gname,
             count(DISTINCT r.event_id)::integer AS ev,
             count(r.youth_id)::integer AS n,
             (count(r.youth_id) FILTER (WHERE r.present))::integer AS p
        FROM grp
        LEFT JOIN rws r
               ON r.youth_group_id = grp.gid
              AND EXISTS (SELECT 1 FROM public.event_groups eg
                           WHERE eg.event_id = r.event_id AND eg.group_id = grp.gid)
       GROUP BY grp.gid, grp.gname
    ),
    no_group AS (
      SELECT count(DISTINCT r.event_id)::integer AS ev, count(*)::integer AS n,
             (count(*) FILTER (WHERE r.present))::integer AS p
        FROM rws r WHERE r.youth_group_id IS NULL
    ),
    ab AS (
      SELECT r.youth_id,
             count(*)::integer AS n,
             (count(*) FILTER (WHERE NOT r.present))::integer AS a
        FROM rws r
       GROUP BY r.youth_id
      HAVING count(*) FILTER (WHERE NOT r.present) >= p_min_absences
    )
    SELECT jsonb_build_object(
      'period', public.report_period(p_from, p_to, p_group_id),
      'summary', jsonb_build_object(
        'events', (SELECT count(*) FROM ev_stats),
        'events_with_records', (SELECT count(*) FROM ev_stats WHERE n > 0),
        'events_cancelled', (SELECT count(*) FROM scope_ev WHERE status = 'cancelled'),
        'present', (SELECT count(*) FILTER (WHERE present) FROM rws),
        'absent', (SELECT count(*) FILTER (WHERE NOT present) FROM rws),
        'registered', (SELECT count(*) FROM rws),
        'rate', (SELECT public.report_pct(count(*) FILTER (WHERE present), count(*)) FROM rws)),
      'by_event', COALESCE((SELECT jsonb_agg(jsonb_build_object(
          'event_id', s.event_id, 'event_date', s.event_date, 'title', s.title, 'status', s.status,
          'present', s.p, 'absent', s.n - s.p, 'registered', s.n, 'rate', public.report_pct(s.p, s.n))
          ORDER BY s.event_date, s.event_id) FROM ev_stats s), '[]'::jsonb),
      'series', COALESCE((SELECT jsonb_agg(jsonb_build_object(
          'date', d.d, 'present', d.p, 'registered', d.n, 'rate', public.report_pct(d.p, d.n))
          ORDER BY d.d) FROM day_stats d), '[]'::jsonb),
      'by_group', COALESCE((SELECT jsonb_agg(jsonb_build_object(
          'group_id', s.gid, 'name', s.gname, 'events', s.ev, 'present', s.p, 'absent', s.n - s.p,
          'registered', s.n, 'rate', public.report_pct(s.p, s.n))
          ORDER BY s.gname, s.gid) FROM g_stats s), '[]'::jsonb)
        || CASE WHEN v_role = 'coordinator' AND p_group_id IS NULL AND (SELECT n FROM no_group) > 0
                THEN (SELECT jsonb_build_array(jsonb_build_object(
                        'group_id', NULL, 'name', 'Sem grupo', 'events', ng.ev, 'present', ng.p,
                        'absent', ng.n - ng.p, 'registered', ng.n, 'rate', public.report_pct(ng.p, ng.n)))
                        FROM no_group ng)
                ELSE '[]'::jsonb END,
      'youth_absences', jsonb_build_object(
        'min_absences', p_min_absences,
        'total', (SELECT count(*) FROM ab),
        'limit', 50,
        'items', COALESCE((SELECT jsonb_agg(jsonb_build_object(
            'youth_id', q.id, 'full_name', q.full_name, 'group_name', q.gname,
            'absences', q.a, 'registered', q.n) ORDER BY q.full_name, q.id)
          FROM (SELECT y.id, y.full_name, g.name AS gname, ab.a, ab.n
                  FROM ab
                  JOIN public.youth y ON y.id = ab.youth_id
                  LEFT JOIN public.groups g ON g.id = y.group_id
                 ORDER BY y.full_name, y.id
                 LIMIT 50) q), '[]'::jsonb))
    )
  );
END;
$$;


-- ============================================================================
-- 5. report_followups
-- ============================================================================
-- {
--   "period": {...},
--   "total": int, "youth_reached": int,                      -- acompanhamentos com occurred_at no período
--   "by_type": [ { "type": "conversation|call|in_person|guidance|return|other", "count": int } ],  -- todos os tipos
--   "by_responsible": [ { "responsible_id": uuid|null, "name": text|null, "count": int } ],  -- responsável ATUAL;
--                       -- por nome. Nome = só do responsável de acompanhamentos que o chamador já acessa (mesmo
--                       -- critério de follow_up_people, 011); null quando o responsável foi removido.
--   "transfers": { "count": int, "follow_ups": int },        -- transferências com transferred_at no período
--   "next_actions": {                                         -- SNAPSHOT (não depende do período)
--       "pending": int, "overdue": int, "upcoming": int,      -- pendentes = ver report_pending_followups (012)
--       "limit": 50,
--       "items": [ { "follow_up_id", "youth_id", "youth_name", "next_action"|null, "next_action_due": "YYYY-MM-DD",
--                    "overdue": bool, "responsible_name"|null } ] }   -- por prazo, depois nome do jovem
-- }
CREATE OR REPLACE FUNCTION public.report_followups(p_from date, p_to date, p_group_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_t0    timestamptz;
  v_t1    timestamptz;
  v_today date := public.app_today();
BEGIN
  PERFORM public.report_check(p_from, p_to, p_group_id);
  v_t0 := p_from::timestamp AT TIME ZONE 'America/Sao_Paulo';
  v_t1 := (p_to + 1)::timestamp AT TIME ZONE 'America/Sao_Paulo';

  RETURN (
    WITH sy AS MATERIALIZED (
      SELECT * FROM public.report_scope_youth(p_group_id)
    ),
    fu AS MATERIALIZED (
      SELECT f.id, f.youth_id, f.type, f.responsible_id
        FROM public.follow_ups f
       WHERE f.occurred_at BETWEEN p_from AND p_to
         AND f.youth_id IN (SELECT s.youth_id FROM sy s)
    ),
    trf AS (
      SELECT t.follow_up_id
        FROM public.follow_up_transfers t
        JOIN public.follow_ups f ON f.id = t.follow_up_id
       WHERE f.youth_id IN (SELECT s.youth_id FROM sy s)
         AND t.transferred_at >= v_t0 AND t.transferred_at < v_t1
    ),
    resp AS (
      SELECT fu.responsible_id AS rid, count(*)::integer AS c FROM fu GROUP BY fu.responsible_id
    ),
    pend AS MATERIALIZED (
      SELECT * FROM public.report_pending_followups(p_group_id)
    )
    SELECT jsonb_build_object(
      'period', public.report_period(p_from, p_to, p_group_id),
      'total', (SELECT count(*) FROM fu),
      'youth_reached', (SELECT count(DISTINCT youth_id) FROM fu),
      'by_type', (SELECT jsonb_agg(jsonb_build_object(
          'type', u.ty::text, 'count', (SELECT count(*) FROM fu WHERE fu.type = u.ty)) ORDER BY u.ord)
          FROM unnest(enum_range(NULL::follow_up_type)) WITH ORDINALITY AS u(ty, ord)),
      'by_responsible', COALESCE((SELECT jsonb_agg(jsonb_build_object(
          'responsible_id', r.rid, 'name', p.full_name, 'count', r.c)
          ORDER BY p.full_name NULLS LAST, r.rid)
          FROM resp r LEFT JOIN public.profiles p ON p.id = r.rid), '[]'::jsonb),
      'transfers', jsonb_build_object(
        'count', (SELECT count(*) FROM trf),
        'follow_ups', (SELECT count(DISTINCT follow_up_id) FROM trf)),
      'next_actions', jsonb_build_object(
        'pending', (SELECT count(*) FROM pend),
        'overdue', (SELECT count(*) FROM pend WHERE next_action_due < v_today),
        'upcoming', (SELECT count(*) FROM pend WHERE next_action_due >= v_today),
        'limit', 50,
        'items', COALESCE((SELECT jsonb_agg(jsonb_build_object(
            'follow_up_id', q.follow_up_id, 'youth_id', q.youth_id, 'youth_name', q.youth_name,
            'next_action', q.next_action, 'next_action_due', q.next_action_due,
            'overdue', q.next_action_due < v_today, 'responsible_name', q.responsible_name)
            ORDER BY q.next_action_due, q.youth_name, q.follow_up_id)
          FROM (SELECT * FROM pend
                 ORDER BY next_action_due, youth_name, follow_up_id
                 LIMIT 50) q), '[]'::jsonb))
    )
  );
END;
$$;


-- ============================================================================
-- 6. report_alerts
-- ============================================================================
-- Alertas de jovens do escopo (inclui jovens hoje inativos: o histórico de alertas nunca é apagado).
-- {
--   "period": {...},
--   "open_now":  { "total", "critical", "attention": int },           -- SNAPSHOT: abertos agora
--   "created":   { "total", "critical", "attention": int },           -- created_at no período
--   "resolved":  int,          -- status 'resolved' com resolved_at no período
--   "resolved_automatically": int,   -- subconjunto de "resolved" encerrado pelo sistema (resolved_by null)
--   "dismissed": int,          -- status 'dismissed' com resolved_at no período
--   "avg_resolution_hours": number|null,   -- média (resolved_at - created_at) dos "resolved" do período, 1 casa
--   "by_type":     [ { "type", "created", "resolved", "dismissed", "open_now": int } ],     -- todos os tipos
--   "by_severity": [ { "severity", "created", "resolved", "dismissed", "open_now": int } ]  -- attention, critical
-- }
CREATE OR REPLACE FUNCTION public.report_alerts(p_from date, p_to date, p_group_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_t0 timestamptz;
  v_t1 timestamptz;
BEGIN
  PERFORM public.report_check(p_from, p_to, p_group_id);
  v_t0 := p_from::timestamp AT TIME ZONE 'America/Sao_Paulo';
  v_t1 := (p_to + 1)::timestamp AT TIME ZONE 'America/Sao_Paulo';

  RETURN (
    WITH al AS MATERIALIZED (
      SELECT a.id, a.type, a.severity, a.status, a.created_at, a.resolved_at, a.resolved_by,
             (a.created_at >= v_t0 AND a.created_at < v_t1)                                   AS cr,
             (a.status = 'resolved'  AND a.resolved_at >= v_t0 AND a.resolved_at < v_t1)     AS rs,
             (a.status = 'dismissed' AND a.resolved_at >= v_t0 AND a.resolved_at < v_t1)     AS ds,
             (a.status = 'open')                                                              AS op
        FROM public.alerts a
       WHERE a.youth_id IN (SELECT s.youth_id FROM public.report_scope_youth(p_group_id) s)
         AND (a.status = 'open'
              OR (a.created_at  >= v_t0 AND a.created_at  < v_t1)
              OR (a.resolved_at >= v_t0 AND a.resolved_at < v_t1))
    )
    SELECT jsonb_build_object(
      'period', public.report_period(p_from, p_to, p_group_id),
      'open_now', jsonb_build_object(
        'total', (SELECT count(*) FROM al WHERE op),
        'critical', (SELECT count(*) FROM al WHERE op AND severity = 'critical'),
        'attention', (SELECT count(*) FROM al WHERE op AND severity = 'attention')),
      'created', jsonb_build_object(
        'total', (SELECT count(*) FROM al WHERE cr),
        'critical', (SELECT count(*) FROM al WHERE cr AND severity = 'critical'),
        'attention', (SELECT count(*) FROM al WHERE cr AND severity = 'attention')),
      'resolved', (SELECT count(*) FROM al WHERE rs),
      'resolved_automatically', (SELECT count(*) FROM al WHERE rs AND resolved_by IS NULL),
      'dismissed', (SELECT count(*) FROM al WHERE ds),
      'avg_resolution_hours', (SELECT round((avg(extract(epoch FROM (resolved_at - created_at)) / 3600.0))::numeric, 1)
                                 FROM al WHERE rs),
      'by_type', (SELECT jsonb_agg(jsonb_build_object(
          'type', q.ty::text, 'created', q.c, 'resolved', q.r, 'dismissed', q.d, 'open_now', q.o) ORDER BY q.ord)
          FROM (SELECT u.ty, u.ord,
                       count(al.id) FILTER (WHERE al.cr) AS c, count(al.id) FILTER (WHERE al.rs) AS r,
                       count(al.id) FILTER (WHERE al.ds) AS d, count(al.id) FILTER (WHERE al.op) AS o
                  FROM unnest(enum_range(NULL::alert_type)) WITH ORDINALITY AS u(ty, ord)
                  LEFT JOIN al ON al.type = u.ty
                 GROUP BY u.ty, u.ord) q),
      'by_severity', (SELECT jsonb_agg(jsonb_build_object(
          'severity', q.sv::text, 'created', q.c, 'resolved', q.r, 'dismissed', q.d, 'open_now', q.o) ORDER BY q.ord)
          FROM (SELECT u.sv, u.ord,
                       count(al.id) FILTER (WHERE al.cr) AS c, count(al.id) FILTER (WHERE al.rs) AS r,
                       count(al.id) FILTER (WHERE al.ds) AS d, count(al.id) FILTER (WHERE al.op) AS o
                  FROM unnest(enum_range(NULL::alert_severity)) WITH ORDINALITY AS u(sv, ord)
                  LEFT JOIN al ON al.severity = u.sv
                 GROUP BY u.sv, u.ord) q)
    )
  );
END;
$$;


-- ============================================================================
-- 7. report_youth — ficha individual
-- ============================================================================
-- Jovem fora do escopo (inexistente, de outro grupo, sem grupo para líder) => erro P0002
-- "Jovem não encontrado ou sem permissão." (não distingue os casos).
-- {
--   "period": {...},
--   "youth": { "id", "full_name", "is_active", "group_id"|null, "group_name"|null, "leader_name"|null },
--   "situation": { "situation": "normal|attention|critical", "inactive", "reasons": [text], "consecutive_absences",
--                  "attendance_rate"|null, "events_total", "last_event"|null, "open_actions", "overdue_actions",
--                  "last_follow_up"|null },               -- youth_situation (011), SNAPSHOT
--   "attendance": { "present", "absent", "not_registered", "registered": int, "rate": int|null,
--                   "events": [ { "event_id", "event_date", "title", "state": "present|absent|not_registered" } ] },
--       -- eventos não cancelados do período em que há registro do jovem (de qualquer grupo: o histórico segue o
--       -- jovem) + eventos já ocorridos do grupo ATUAL sem registro = "not_registered" (só para jovem ativo;
--       -- não conta como falta nem entra em registered/rate). Em ordem de data.
--   "follow_ups": { "total", "limit": 100, "items": [ { "id", "occurred_at", "type", "reason", "next_action"|null,
--                   "next_action_due"|null, "responsible_name"|null } ] },     -- occurred_at no período, mais novos antes
--   "actions":    { "total", "limit": 100, "items": [ { "id", "title", "status", "priority", "due_date"|null,
--                   "overdue": bool, "completed_at"|null } ] },   -- abertas (qualquer data) + criadas, vencendo ou
--                                                                 -- concluídas no período
--   "alerts":     { "total", "limit": 100, "items": [ { "id", "type", "severity", "status", "created_at",
--                   "resolved_at"|null, "consecutive_absences", "attendance_rate"|null } ] }   -- abertos + criados
--                                                                 -- ou encerrados no período
-- }
CREATE OR REPLACE FUNCTION public.report_youth(p_youth_id uuid, p_from date, p_to date)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_t0     timestamptz;
  v_t1     timestamptz;
  v_now    timestamptz := now();
  v_active boolean;
  v_group  uuid;
  v_s      public.youth_situation_row;
BEGIN
  PERFORM public.report_check(p_from, p_to, NULL);
  IF p_youth_id IS NULL OR NOT EXISTS (
       SELECT 1 FROM public.report_scope_youth(NULL) s WHERE s.youth_id = p_youth_id) THEN
    RAISE EXCEPTION 'Jovem não encontrado ou sem permissão.' USING ERRCODE = 'P0002';
  END IF;
  v_t0 := p_from::timestamp AT TIME ZONE 'America/Sao_Paulo';
  v_t1 := (p_to + 1)::timestamp AT TIME ZONE 'America/Sao_Paulo';

  SELECT y.is_active, y.group_id INTO v_active, v_group FROM public.youth y WHERE y.id = p_youth_id;
  SELECT * INTO v_s FROM public.youth_situations(ARRAY[p_youth_id]);

  RETURN (
    WITH ev AS (
      SELECT e.id, e.event_date, e.title, a.present
        FROM public.events e
        LEFT JOIN public.attendance a ON a.event_id = e.id AND a.youth_id = p_youth_id
       WHERE e.status <> 'cancelled'
         AND e.event_date >= v_t0 AND e.event_date < v_t1
         AND (a.id IS NOT NULL
              OR (v_active AND v_group IS NOT NULL AND e.event_date <= v_now
                  AND EXISTS (SELECT 1 FROM public.event_groups eg
                               WHERE eg.event_id = e.id AND eg.group_id = v_group)))
    ),
    fu AS (
      SELECT f.id, f.occurred_at, f.type, f.reason, f.next_action, f.next_action_due, f.created_at,
             p.full_name AS rname
        FROM public.follow_ups f
        LEFT JOIN public.profiles p ON p.id = f.responsible_id
       WHERE f.youth_id = p_youth_id AND f.occurred_at BETWEEN p_from AND p_to
    ),
    tk AS (
      SELECT t.id, t.title, t.status, t.priority, t.due_date, t.completed_at, t.created_at
        FROM public.tasks t
       WHERE t.youth_id = p_youth_id
         AND (t.status IN ('pending', 'in_progress')
              OR (t.created_at >= v_t0 AND t.created_at < v_t1)
              OR (t.completed_at >= v_t0 AND t.completed_at < v_t1)
              OR t.due_date BETWEEN p_from AND p_to)
    ),
    al AS (
      SELECT a.id, a.type, a.severity, a.status, a.created_at, a.resolved_at, a.consecutive_absences,
             a.attendance_rate
        FROM public.alerts a
       WHERE a.youth_id = p_youth_id
         AND (a.status = 'open'
              OR (a.created_at  >= v_t0 AND a.created_at  < v_t1)
              OR (a.resolved_at >= v_t0 AND a.resolved_at < v_t1))
    )
    SELECT jsonb_build_object(
      'period', public.report_period(p_from, p_to, NULL),
      'youth', jsonb_build_object(
        'id', v_s.youth_id, 'full_name', v_s.full_name, 'is_active', NOT v_s.inactive,
        'group_id', v_s.group_id, 'group_name', v_s.group_name, 'leader_name', v_s.leader_name),
      'situation', jsonb_build_object(
        'situation', v_s.situation, 'inactive', v_s.inactive, 'reasons', to_jsonb(v_s.reasons),
        'consecutive_absences', v_s.consecutive_absences, 'attendance_rate', v_s.attendance_rate,
        'events_total', v_s.events_total, 'last_event', v_s.last_event,
        'open_actions', v_s.open_actions, 'overdue_actions', v_s.overdue_actions,
        'last_follow_up', v_s.last_follow_up),
      'attendance', jsonb_build_object(
        'present', (SELECT count(*) FROM ev WHERE present IS TRUE),
        'absent', (SELECT count(*) FROM ev WHERE present IS FALSE),
        'not_registered', (SELECT count(*) FROM ev WHERE present IS NULL),
        'registered', (SELECT count(*) FROM ev WHERE present IS NOT NULL),
        'rate', (SELECT public.report_pct(count(*) FILTER (WHERE present IS TRUE),
                                          count(*) FILTER (WHERE present IS NOT NULL)) FROM ev),
        'events', COALESCE((SELECT jsonb_agg(jsonb_build_object(
            'event_id', x.id, 'event_date', x.event_date, 'title', x.title,
            'state', CASE WHEN x.present IS TRUE THEN 'present'
                          WHEN x.present IS FALSE THEN 'absent'
                          ELSE 'not_registered' END)
            ORDER BY x.event_date, x.id) FROM ev x), '[]'::jsonb)),
      'follow_ups', jsonb_build_object(
        'total', (SELECT count(*) FROM fu),
        'limit', 100,
        'items', COALESCE((SELECT jsonb_agg(jsonb_build_object(
            'id', q.id, 'occurred_at', q.occurred_at, 'type', q.type::text, 'reason', q.reason,
            'next_action', q.next_action, 'next_action_due', q.next_action_due,
            'responsible_name', q.rname) ORDER BY q.occurred_at DESC, q.created_at DESC, q.id)
          FROM (SELECT * FROM fu ORDER BY occurred_at DESC, created_at DESC, id LIMIT 100) q), '[]'::jsonb)),
      'actions', jsonb_build_object(
        'total', (SELECT count(*) FROM tk),
        'limit', 100,
        'items', COALESCE((SELECT jsonb_agg(jsonb_build_object(
            'id', q.id, 'title', q.title, 'status', q.status::text, 'priority', q.priority::text,
            'due_date', q.due_date, 'overdue', public.is_task_overdue(q.status, q.due_date),
            'completed_at', q.completed_at)
            ORDER BY q.due_date NULLS LAST, q.created_at DESC, q.id)
          FROM (SELECT * FROM tk ORDER BY due_date NULLS LAST, created_at DESC, id LIMIT 100) q), '[]'::jsonb)),
      'alerts', jsonb_build_object(
        'total', (SELECT count(*) FROM al),
        'limit', 100,
        'items', COALESCE((SELECT jsonb_agg(jsonb_build_object(
            'id', q.id, 'type', q.type::text, 'severity', q.severity::text, 'status', q.status::text,
            'created_at', q.created_at, 'resolved_at', q.resolved_at,
            'consecutive_absences', q.consecutive_absences, 'attendance_rate', q.attendance_rate)
            ORDER BY q.created_at DESC, q.id)
          FROM (SELECT * FROM al ORDER BY created_at DESC, id LIMIT 100) q), '[]'::jsonb))
    )
  );
END;
$$;


-- ============================================================================
-- 8. report_groups
-- ============================================================================
-- Uma entrada por grupo no escopo, por nome (sem ranking). Combina group_indicators (012) com os totais do período.
-- {
--   "period": {...},
--   "groups": [ { "group_id", "name", "leader_name"|null,
--                 "active_youth", "attendance_rate"|null, "trend"|null, "trend_delta"|null,   -- snapshot (012)
--                 "youth_in_attention", "overdue_actions",                                     -- snapshot (012)
--                 "period": { "events_held": int,        -- encontros 'completed' vinculados ao grupo no período
--                             "events_with_records": int, "present", "absent", "registered": int,
--                             "rate": int|null,          -- jovens ativos que estão no grupo hoje, encontros dele
--                             "follow_ups": int,         -- acompanhamentos de jovens do grupo no período
--                             "alerts_created": int,     -- alertas de jovens do grupo criados no período
--                             "actions_completed": int } -- ações concluídas no período (grupo ou jovens ativos)
--               } ]
-- }
CREATE OR REPLACE FUNCTION public.report_groups(p_from date, p_to date)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_t0 timestamptz;
  v_t1 timestamptz;
BEGIN
  PERFORM public.report_check(p_from, p_to, NULL);
  v_t0 := p_from::timestamp AT TIME ZONE 'America/Sao_Paulo';
  v_t1 := (p_to + 1)::timestamp AT TIME ZONE 'America/Sao_Paulo';

  RETURN (
    WITH gi AS MATERIALIZED (SELECT * FROM public.group_indicators(NULL)),
    yo  AS MATERIALIZED (SELECT * FROM public.report_scope_youth(NULL)),
    tk  AS MATERIALIZED (SELECT * FROM public.report_scope_tasks(NULL)),
    rws AS MATERIALIZED (SELECT * FROM public.report_att_rows(p_from, p_to, NULL)),
    att AS (
      SELECT r.youth_group_id AS gid, count(*)::integer AS n,
             (count(*) FILTER (WHERE r.present))::integer AS p, count(DISTINCT r.event_id)::integer AS ev
        FROM rws r
       WHERE EXISTS (SELECT 1 FROM public.event_groups eg
                      WHERE eg.event_id = r.event_id AND eg.group_id = r.youth_group_id)
       GROUP BY r.youth_group_id
    ),
    held AS (
      SELECT eg.group_id AS gid, count(*)::integer AS c
        FROM public.event_groups eg
        JOIN public.events e ON e.id = eg.event_id
       WHERE eg.group_id IN (SELECT g.group_id FROM gi g)
         AND e.status = 'completed'
         AND e.event_date >= v_t0 AND e.event_date < v_t1
       GROUP BY eg.group_id
    ),
    fus AS (
      SELECT y.group_id AS gid, count(*)::integer AS c
        FROM public.follow_ups f
        JOIN yo y ON y.youth_id = f.youth_id
       WHERE f.occurred_at BETWEEN p_from AND p_to
       GROUP BY y.group_id
    ),
    als AS (
      SELECT y.group_id AS gid, count(*)::integer AS c
        FROM public.alerts a
        JOIN yo y ON y.youth_id = a.youth_id
       WHERE a.created_at >= v_t0 AND a.created_at < v_t1
       GROUP BY y.group_id
    ),
    done AS (
      SELECT g.group_id AS gid, count(DISTINCT t.task_id)::integer AS c
        FROM gi g
        JOIN tk t
          ON t.status = 'done' AND t.completed_at >= v_t0 AND t.completed_at < v_t1
         AND (t.group_id = g.group_id
              OR t.youth_id IN (SELECT y.youth_id FROM yo y WHERE y.group_id = g.group_id AND y.is_active))
       GROUP BY g.group_id
    )
    SELECT jsonb_build_object(
      'period', public.report_period(p_from, p_to, NULL),
      'groups', COALESCE((SELECT jsonb_agg(jsonb_build_object(
          'group_id', g.group_id, 'name', g.name, 'leader_name', g.leader_name,
          'active_youth', g.active_youth, 'attendance_rate', g.attendance_rate,
          'trend', g.trend, 'trend_delta', g.trend_delta,
          'youth_in_attention', g.youth_in_attention, 'overdue_actions', g.overdue_actions,
          'period', jsonb_build_object(
            'events_held', COALESCE(h.c, 0),
            'events_with_records', COALESCE(a.ev, 0),
            'present', COALESCE(a.p, 0),
            'absent', COALESCE(a.n, 0) - COALESCE(a.p, 0),
            'registered', COALESCE(a.n, 0),
            'rate', public.report_pct(a.p, a.n),
            'follow_ups', COALESCE(f.c, 0),
            'alerts_created', COALESCE(l.c, 0),
            'actions_completed', COALESCE(d.c, 0)))
          ORDER BY g.name, g.group_id)
        FROM gi g
        LEFT JOIN att  a ON a.gid = g.group_id
        LEFT JOIN held h ON h.gid = g.group_id
        LEFT JOIN fus  f ON f.gid = g.group_id
        LEFT JOIN als  l ON l.gid = g.group_id
        LEFT JOIN done d ON d.gid = g.group_id), '[]'::jsonb)
    )
  );
END;
$$;


-- ============================================================================
-- 9. Grants: anon nada; authenticated executa as RPCs (a autorização está no corpo de cada uma)
-- ============================================================================
REVOKE ALL ON FUNCTION public.report_general(date, date, uuid)               FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.report_attendance(date, date, uuid, integer)   FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.report_followups(date, date, uuid)             FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.report_alerts(date, date, uuid)                FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.report_youth(uuid, date, date)                 FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.report_groups(date, date)                      FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.report_general(date, date, uuid)             TO authenticated;
GRANT EXECUTE ON FUNCTION public.report_attendance(date, date, uuid, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.report_followups(date, date, uuid)           TO authenticated;
GRANT EXECUTE ON FUNCTION public.report_alerts(date, date, uuid)              TO authenticated;
GRANT EXECUTE ON FUNCTION public.report_youth(uuid, date, date)               TO authenticated;
GRANT EXECUTE ON FUNCTION public.report_groups(date, date)                    TO authenticated;

NOTIFY pgrst, 'reload schema';
