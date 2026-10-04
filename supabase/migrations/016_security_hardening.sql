-- Migration: 016_security_hardening.sql
-- Descrição: correções confirmadas por auditoria de segurança (nenhuma migration anterior foi editada; nada foi
-- afrouxado). Itens:
--
--   1) sync_time_alerts() (011) varria o banco inteiro a cada chamada e é executável por qualquer usuário autenticado
--      => DoS barato. Agora há throttle NO BANCO: tabela de estado `time_alerts_sync_state` (RLS ligado, sem policies,
--      sem privilégio para clientes; só funções SECURITY DEFINER a acessam) + pg_try_advisory_xact_lock. Se a última
--      varredura foi há menos de 60 s, ou outra transação está varrendo agora, a função retorna imediatamente sem
--      varrer (o resultado visível é o mesmo: alertas por tempo só mudam com o passar do tempo e os eventos já os
--      atualizam por trigger). refresh_time_alerts() (interna) continua SEM throttle e é a usada por
--      recalculate_all_alerts() (só coordenador) e por settings_refresh_alerts().
--      LIMITAÇÃO DE TESTE: o harness PGlite tem uma única conexão; o ramo "outra transação está varrendo"
--      (advisory lock ocupado) não é reproduzível lá (o lock é reentrante na mesma sessão) e NÃO foi testado.
--      Efeito colateral para quem usa o app: dois cliques em "abrir Alertas" em < 60 s fazem uma única varredura.
--
--   2) Relatórios de LÍDER: report_attendance (013) devolvia título/data/event_id de encontro de OUTRO grupo quando o
--      histórico de um jovem que mudou de grupo vinha junto (by_event), e report_youth (013) o mesmo em
--      attendance.events. Para encontros fora de report_scope_events() do chamador, o título passa a ser
--      "Encontro de outro grupo" e event_id NULL; data e estado (presente/falta/status) são mantidos, porque o
--      histórico do jovem segue o jovem. Coordenador: inalterado. report_att_rows (012) é interna e só alimenta
--      agregados (dashboard_overview, report_general, report_groups só devolvem contagens), portanto não vaza título;
--      o vazamento estava nas duas saídas acima. FRONTEND: by_event[].event_id e attendance.events[].event_id agora
--      podem ser null (AttendanceTab usa rowKey = event_id; ajustar o tipo/chave).
--
--   3) follow_ups: o DELETE do coordenador apagava em cascata o histórico "imutável" de follow_up_transfers.
--      Agora um trigger BEFORE DELETE bloqueia (P0001, pt-BR) a exclusão de acompanhamento que tenha transferências,
--      para TODOS os papéis (inclusive SQL Editor/service_role) enquanto o jovem existir.
--      DECISÃO sobre a exclusão de jovem: a cascata youth -> follow_ups -> follow_up_transfers CONTINUA possível.
--      Motivo: (a) quem exclui o jovem (coordenador, ação deliberada e rara; o app só desativa) precisa poder
--      apagar o dado pessoal dele (LGPD); bloquear deixaria o jovem inexcluível; (b) o histórico é imutável apenas
--      para clientes, mas sem o jovem ele perde o sentido. O trigger reconhece a cascata porque, quando a ação
--      referencial dispara, a linha do jovem já não é visível (EXISTS em youth falha); um DELETE direto em
--      follow_ups sempre encontra o jovem. A função é SECURITY DEFINER para que o RLS de youth não mascare isso.
--
--   4) is_valid_email (015) aceitava '%' no local-part (a%0d%0abcc%3dx@y.com) => risco de injeção em cabeçalhos
--      via mailto:/percent-decoding. '%' removido. Os CHECKs que usam a função (communications.recipient_email)
--      passam a valer automaticamente; linhas existentes não são revalidadas (a tabela é nova). O frontend
--      (src/lib/communications.ts EMAIL_RE) deve ser ajustado em separado.
--
--   5) Privilégios de tabela: REVOKE TRUNCATE/REFERENCES/TRIGGER de anon e authenticated em todas as tabelas de
--      public (TRUNCATE ignora RLS!) e REVOKE ALL de anon (anon não tem nenhum acesso a dados; o login/Auth do
--      Supabase usa o schema auth e o trigger handle_new_user é SECURITY DEFINER, nada depende de tabela pública para
--      anon). Também ALTER DEFAULT PRIVILEGES para as tabelas futuras. NO SUPABASE: os privilégios padrão pertencem ao
--      papel que cria as tabelas (postgres no SQL Editor; supabase_admin tem os seus próprios). Esta migration ajusta os
--      do papel que a executa e tenta os de supabase_admin (se não houver permissão, só avisa). Sequences: não alteradas.
--      Depois de aplicar, confira no painel: `SELECT grantee, privilege_type FROM information_schema.role_table_grants
--      WHERE table_schema = 'public' AND grantee IN ('anon','authenticated')`.
--
--   6) search_path das funções SECURITY DEFINER do schema public: ganha `pg_temp` no FIM (evita que um objeto temporário
--      sombreie objetos de public). Preserva o valor existente e só acrescenta pg_temp; funções de extensões ficam de fora.
--
-- RETENÇÃO DE DADOS (PONTOS LGPD PENDENTES; NADA É IMPLEMENTADO AQUI):
--   * activity_log (014) cresce sem teto e sem expurgo (só o coordenador lê; ninguém apaga pelo app). Definir prazo de
--     retenção e rotina de limpeza (ex.: pg_cron) é decisão de produto/jurídica.
--   * communications (015): ON DELETE SET NULL preserva o histórico de envio depois da exclusão do jovem, e com ele
--     recipient_email/recipient_name/subject/body (dado pessoal). Para atender a um pedido de eliminação, o coordenador
--     precisa remover essas linhas manualmente no SQL Editor. Falta rotina/endpoint de anonimização.
--
-- IMPORTANTE: Execute no SQL Editor do Supabase APÓS a migration 015.
-- ============================================================================


-- ============================================================================
-- 1. Throttle de sync_time_alerts()
-- ============================================================================
CREATE TABLE public.time_alerts_sync_state (
  id       boolean PRIMARY KEY DEFAULT true CHECK (id),   -- linha única
  last_run timestamp with time zone NOT NULL DEFAULT '-infinity'
);
INSERT INTO public.time_alerts_sync_state (id) VALUES (true);

ALTER TABLE public.time_alerts_sync_state ENABLE ROW LEVEL SECURITY;   -- sem policies: nenhum cliente lê/escreve
REVOKE ALL ON public.time_alerts_sync_state FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.sync_time_alerts()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_last timestamptz;
BEGIN
  IF auth.uid() IS NULL OR public.get_my_role() IS NULL THEN
    RAISE EXCEPTION 'Não autenticado.' USING ERRCODE = '42501';
  END IF;

  -- Outra transação já está varrendo: não espera nem repete o trabalho.
  IF NOT pg_try_advisory_xact_lock(hashtext('public.sync_time_alerts'), 1) THEN
    RETURN;
  END IF;

  -- Varredura recente (< 60 s): nada a fazer. O lock acima serializa quem chega aqui.
  SELECT s.last_run INTO v_last FROM public.time_alerts_sync_state s WHERE s.id;
  IF v_last > clock_timestamp() - interval '60 seconds' THEN
    RETURN;
  END IF;

  PERFORM public.refresh_time_alerts();
  UPDATE public.time_alerts_sync_state SET last_run = clock_timestamp() WHERE id;
END;
$$;

REVOKE ALL ON FUNCTION public.sync_time_alerts() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.sync_time_alerts() TO authenticated;


-- ============================================================================
-- 2. Relatórios do líder: não devolver dados de encontro de outro grupo
-- ============================================================================
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
SET search_path = public, pg_temp
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
      -- Encontro fora do escopo do chamador (histórico de jovem que mudou de grupo): sem título nem id.
      'by_event', COALESCE((SELECT jsonb_agg(jsonb_build_object(
          'event_id', CASE WHEN v_role = 'coordinator' OR EXISTS (SELECT 1 FROM scope_ev se WHERE se.event_id = s.event_id)
                           THEN s.event_id END,
          'event_date', s.event_date,
          'title', CASE WHEN v_role = 'coordinator' OR EXISTS (SELECT 1 FROM scope_ev se WHERE se.event_id = s.event_id)
                        THEN s.title ELSE 'Encontro de outro grupo' END,
          'status', s.status,
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


CREATE OR REPLACE FUNCTION public.report_youth(p_youth_id uuid, p_from date, p_to date)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
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
    WITH sev AS MATERIALIZED (   -- encontros do escopo do chamador (líder: só os dos seus grupos)
      SELECT s.event_id FROM public.report_scope_events(v_t0, v_t1, NULL) s
    ),
    ev AS (
      SELECT e.id, e.event_date, e.title, a.present,
             (public.get_my_role() = 'coordinator' OR EXISTS (SELECT 1 FROM sev WHERE sev.event_id = e.id)) AS vis
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
            'event_id', CASE WHEN x.vis THEN x.id END, 'event_date', x.event_date,
            'title', CASE WHEN x.vis THEN x.title ELSE 'Encontro de outro grupo' END,
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
-- 3. Histórico de transferências não some com a exclusão do acompanhamento
-- ============================================================================
CREATE OR REPLACE FUNCTION public.follow_ups_protect_history()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  -- Exclusão em cascata do jovem: a linha do jovem já não existe quando a ação referencial dispara. Permitida.
  IF NOT EXISTS (SELECT 1 FROM public.youth y WHERE y.id = OLD.youth_id) THEN
    RETURN OLD;
  END IF;
  IF EXISTS (SELECT 1 FROM public.follow_up_transfers t WHERE t.follow_up_id = OLD.id) THEN
    RAISE EXCEPTION 'Este acompanhamento tem histórico de transferências e não pode ser excluído.'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN OLD;
END;
$$;

REVOKE ALL ON FUNCTION public.follow_ups_protect_history() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER follow_ups_protect_history
  BEFORE DELETE ON public.follow_ups
  FOR EACH ROW EXECUTE PROCEDURE public.follow_ups_protect_history();


-- ============================================================================
-- 4. is_valid_email sem '%'
-- ============================================================================
-- Local-part: [A-Za-z0-9._+-] (sem '%'). Demais regras idênticas à 015. Grants preservados (CREATE OR REPLACE).
CREATE OR REPLACE FUNCTION public.is_valid_email(p_email text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = public
AS $$
  SELECT COALESCE(
    length(p_email) <= 254
    AND p_email ~ '^[A-Za-z0-9._+-]{1,64}@([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,24}$'
    AND p_email !~ '\.\.'
    AND p_email !~ '^\.|\.@',
    false)
$$;


-- ============================================================================
-- 5. Privilégios de tabela
-- ============================================================================
-- TRUNCATE ignora RLS; REFERENCES/TRIGGER não têm uso para o app. anon não acessa dado nenhum.
REVOKE TRUNCATE, REFERENCES, TRIGGER ON ALL TABLES IN SCHEMA public FROM anon, authenticated;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon;

-- Tabelas futuras criadas pelo papel que executa esta migration
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE TRUNCATE, REFERENCES, TRIGGER ON TABLES FROM authenticated;

-- No Supabase o papel supabase_admin também tem privilégios padrão no schema public. Melhor esforço: se o papel
-- não existir (ex.: PGlite) ou o executor não tiver permissão, apenas avisa (documentado no cabeçalho).
DO $$
BEGIN
  ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public REVOKE ALL ON TABLES FROM anon;
  ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public
    REVOKE TRUNCATE, REFERENCES, TRIGGER ON TABLES FROM authenticated;
EXCEPTION
  WHEN undefined_object OR insufficient_privilege THEN
    RAISE NOTICE 'Privilégios padrão de supabase_admin não alterados (%).', SQLERRM;
END;
$$;


-- ============================================================================
-- 6. pg_temp no fim do search_path de TODAS as funções SECURITY DEFINER de public
-- ============================================================================
-- Mantém o search_path existente e acrescenta pg_temp; sem search_path, usa 'public, pg_temp'. Ignora funções de extensões.
DO $$
DECLARE
  r record;
  v_path text;
BEGIN
  FOR r IN
    SELECT p.oid, p.oid::regprocedure AS sig,
           (SELECT substr(c, length('search_path=') + 1)
              FROM unnest(COALESCE(p.proconfig, '{}'::text[])) AS c
             WHERE c LIKE 'search_path=%') AS sp
      FROM pg_proc p
     WHERE p.pronamespace = 'public'::regnamespace
       AND p.prosecdef
       AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
  LOOP
    IF r.sp IS NULL THEN
      v_path := 'public, pg_temp';
    ELSIF r.sp ~* '(^|[ ,])pg_temp($|[ ,])' THEN
      CONTINUE;
    ELSIF btrim(r.sp) IN ('', '""') THEN
      v_path := 'pg_temp';
    ELSE
      v_path := r.sp || ', pg_temp';
    END IF;
    EXECUTE format('ALTER FUNCTION %s SET search_path = %s', r.sig, v_path);
  END LOOP;
END;
$$;

NOTIFY pgrst, 'reload schema';
