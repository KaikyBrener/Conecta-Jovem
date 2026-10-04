-- Migration: 010_attendance_states_alerts.sql
-- Descrição: Fase 7 (blocos 1-2) — chamada com 3 estados e alertas objetivos.
--
--   A) Chamada com 3 estados. "Não registrado" = AUSÊNCIA de linha em attendance (não é falta);
--      presente = present true; ausente = present false. Nada no banco precisa mudar para isso:
--      todo o cálculo (faltas consecutivas, frequência) já lê somente as linhas existentes.
--      A RPC `save_attendance` grava só quem foi marcado, de forma atômica.
--   B) Alertas objetivos: coluna `severity` e novos tipos `low_attendance` e `attendance_drop`,
--      além da severidade crítica para faltas consecutivas (app_settings.critical_absence_threshold).
--   C) Regra fundamental: resolver/dispensar um alerta NUNCA apaga nem altera attendance. Um alerta
--      de faltas encerrado MANUALMENTE não é recriado enquanto a sequência de faltas for a mesma.
--   D) Índice alerts(youth_id, status). (attendance(youth_id), attendance(event_id) e events(event_date)
--      já existem desde a 006: attendance_youth_idx, attendance_event_idx, events_date_idx.)
--
-- ATENÇÃO — ALTER TYPE ... ADD VALUE dentro de transação:
--   No PostgreSQL >= 12 (Supabase usa 15+) ADD VALUE PODE rodar dentro de uma transação, mas o valor
--   novo NÃO pode ser USADO antes do COMMIT ("unsafe use of new value of enum type"). O SQL Editor do
--   Supabase executa o script como um bloco só; por isso esta migration NÃO usa 'low_attendance' nem
--   'attendance_drop' em nenhum comando executado durante a própria migration:
--     - as funções que citam os novos valores são PL/pgSQL (corpo só é executado depois do commit);
--     - NÃO há "recalcular alertas" no final (diferente da 006). Depois de aplicar, o coordenador deve
--       acionar "Recalcular alertas" (RPC recalculate_all_alerts) uma vez, para gerar os alertas dos
--       novos tipos a partir do histórico existente. Os triggers cuidam de tudo daí em diante.
--   Não há CHECK/índice parcial/DEFAULT que referencie os novos valores, pelo mesmo motivo.
--
-- IMPORTANTE: Execute no SQL Editor do Supabase APÓS a migration 009.
-- ============================================================================


-- ============================================================================
-- 1. Novos tipos de alerta, severidade e colunas auxiliares
-- ============================================================================
ALTER TYPE alert_type ADD VALUE IF NOT EXISTS 'low_attendance';
ALTER TYPE alert_type ADD VALUE IF NOT EXISTS 'attendance_drop';

CREATE TYPE alert_severity AS ENUM ('attention', 'critical');

ALTER TABLE public.alerts
  ADD COLUMN severity               alert_severity NOT NULL DEFAULT 'attention',
  -- Métricas dos alertas de frequência (NULL em faltas consecutivas).
  --   low_attendance : attendance_rate = % de presença nos últimos sample_size registros
  --   attendance_drop: attendance_rate = % dos 4 registros mais recentes; previous_rate = % dos 4 anteriores
  ADD COLUMN attendance_rate        integer CHECK (attendance_rate BETWEEN 0 AND 100),
  ADD COLUMN previous_rate          integer CHECK (previous_rate   BETWEEN 0 AND 100),
  ADD COLUMN sample_size            integer CHECK (sample_size >= 0),
  -- Tipos de frequência: true quando, depois do encerramento deste alerta, a condição deixou de valer
  -- ao menos uma vez (só então um alerta encerrado manualmente pode ser recriado).
  ADD COLUMN episode_ended          boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS alerts_youth_status_idx ON public.alerts (youth_id, status);
-- (já existentes desde a 006; mantidos aqui por idempotência)
CREATE INDEX IF NOT EXISTS attendance_youth_idx ON public.attendance (youth_id);
CREATE INDEX IF NOT EXISTS attendance_event_idx ON public.attendance (event_id);
CREATE INDEX IF NOT EXISTS events_date_idx      ON public.events (event_date);

-- Limite de faltas consecutivas a partir do qual o alerta é crítico.
-- Sem CHECK contra absence_alert_threshold de propósito: o app só edita o limite de alerta, e um CHECK
-- entre colunas faria "subir o limite para 8" falhar até que o crítico fosse subido junto. Em vez disso o
-- cálculo usa GREATEST(critical_absence_threshold, absence_alert_threshold) (crítico nunca < limite).
ALTER TABLE public.app_settings
  ADD COLUMN critical_absence_threshold integer NOT NULL DEFAULT 6
    CHECK (critical_absence_threshold BETWEEN 1 AND 50);

-- Backfill (somente valores antigos do enum): severidade dos alertas de faltas já existentes.
UPDATE public.alerts
   SET severity = CASE WHEN consecutive_absences >= 6 THEN 'critical'::alert_severity
                       ELSE 'attention'::alert_severity END
 WHERE type = 'consecutive_absences';


-- ============================================================================
-- 2. alerts_guard: clientes continuam alterando só status e observações
-- ============================================================================
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
       OR NEW.severity IS DISTINCT FROM OLD.severity
       OR NEW.consecutive_absences IS DISTINCT FROM OLD.consecutive_absences
       OR NEW.attendance_rate IS DISTINCT FROM OLD.attendance_rate
       OR NEW.previous_rate IS DISTINCT FROM OLD.previous_rate
       OR NEW.sample_size IS DISTINCT FROM OLD.sample_size
       OR NEW.episode_ended IS DISTINCT FROM OLD.episode_ended
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


-- ============================================================================
-- 3. Cálculo dos alertas
-- ============================================================================

-- Sincroniza UM alerta de frequência (low_attendance / attendance_drop) de um jovem.
-- Interna (sem EXECUTE para clientes). PL/pgSQL: o enum novo só é resolvido em tempo de execução.
CREATE OR REPLACE FUNCTION public.sync_rate_alert(
  p_youth_id   uuid,
  p_group_id   uuid,
  p_type       alert_type,
  p_condition  boolean,   -- a condição do alerta vale agora? (já inclui "jovem ativo")
  p_rate       integer,
  p_prev_rate  integer,
  p_sample     integer,
  p_last_event uuid,
  p_note       text       -- motivo do encerramento automático
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_open uuid;
BEGIN
  IF p_condition THEN
    SELECT id INTO v_open FROM public.alerts
     WHERE youth_id = p_youth_id AND type = p_type AND status = 'open';

    IF v_open IS NOT NULL THEN
      UPDATE public.alerts
         SET group_id = p_group_id, attendance_rate = p_rate,
             previous_rate = p_prev_rate, sample_size = p_sample, last_event_id = p_last_event
       WHERE id = v_open
         AND (group_id        IS DISTINCT FROM p_group_id
           OR attendance_rate IS DISTINCT FROM p_rate
           OR previous_rate   IS DISTINCT FROM p_prev_rate
           OR sample_size     IS DISTINCT FROM p_sample
           OR last_event_id   IS DISTINCT FROM p_last_event);
    ELSIF NOT EXISTS (
      -- Encerrado manualmente (usuário/tarefa) e a condição ainda não deixou de valer desde então:
      -- é o mesmo episódio, não recria.
      SELECT 1 FROM public.alerts
       WHERE youth_id = p_youth_id AND type = p_type AND status <> 'open'
         AND (status = 'dismissed' OR resolved_by IS NOT NULL)
         AND NOT episode_ended
    ) THEN
      INSERT INTO public.alerts (youth_id, group_id, type, severity, attendance_rate,
                                 previous_rate, sample_size, last_event_id)
      VALUES (p_youth_id, p_group_id, p_type, 'attention', p_rate, p_prev_rate, p_sample, p_last_event)
      ON CONFLICT (youth_id, type) WHERE status = 'open' DO NOTHING;
    END IF;
  ELSE
    UPDATE public.alerts
       SET status = 'resolved',
           resolved_at = timezone('utc', now()),
           group_id = p_group_id,
           resolution_notes = p_note
     WHERE youth_id = p_youth_id AND type = p_type AND status = 'open';

    -- A condição deixou de valer: um futuro alerta deste tipo é um novo episódio.
    UPDATE public.alerts
       SET episode_ended = true
     WHERE youth_id = p_youth_id AND type = p_type AND status <> 'open' AND NOT episode_ended;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.sync_rate_alert(uuid, uuid, alert_type, boolean, integer, integer, integer, uuid, text)
  FROM PUBLIC, anon, authenticated;

-- Cria/atualiza/resolve os alertas de um jovem (faltas consecutivas, frequência baixa, queda).
--
-- Regra das FALTAS CONSECUTIVAS (mudou em relação à 006):
--   * "Sequência de faltas" = as faltas desde a presença mais recente (encontros cancelados ignorados;
--     "não registrado" = sem linha em attendance, não é falta e não entra na conta).
--   * Alerta encerrado MANUALMENTE (dispensado, ou resolvido por usuário/tarefa) NÃO é recriado enquanto a
--     sequência for a mesma, isto é, enquanto nenhuma presença for MAIS RECENTE (event_date) que a última
--     falta do alerta encerrado (last_event_id, congelado no encerramento). Novas faltas, ou faltas
--     retroativas mais antigas, continuam na mesma sequência e não reabrem o que a pessoa fechou.
--     (A 006 recriava sempre que last_event_id mudava, ou seja, a cada nova falta.) Comparar por data do
--     evento torna a regra imune a chamadas retroativas: presença/falta registrada depois para um
--     encontro ANTIGO não forma sequência nova nem duplica alerta.
--   * Uma presença mais recente que a última falta zera a sequência; quando o limite for atingido de novo,
--     é um alerta novo. Resolver/dispensar nunca toca em attendance: só uma presença quebra a sequência.
--   * Encerramento AUTOMÁTICO (contagem caiu abaixo do limite, jovem inativado) continua permitido e não
--     bloqueia a recriação. Os alertas antigos (resolved/dismissed) permanecem como histórico.
--   * Nunca há duplicidade: no máximo 1 alerta aberto por jovem e tipo (índice parcial + ON CONFLICT).
CREATE OR REPLACE FUNCTION public.refresh_youth_alert(p_youth_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_threshold   integer;
  v_critical    integer;
  v_low         integer;
  v_count       integer;
  v_group       uuid;
  v_active      boolean;
  v_last_event  uuid;
  v_open        uuid;
  v_severity    alert_severity;
  v_n           integer;  -- registros na janela (até 8 mais recentes, encontros não cancelados)
  v_p           integer;  -- presenças na janela
  v_p_recent    integer;  -- presenças nos 4 mais recentes
  v_p_prev      integer;  -- presenças nos 4 anteriores
BEGIN
  SELECT group_id, is_active INTO v_group, v_active
  FROM public.youth WHERE id = p_youth_id;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  SELECT absence_alert_threshold, critical_absence_threshold, low_attendance_threshold
    INTO v_threshold, v_critical, v_low
    FROM public.app_settings WHERE id;
  v_threshold := COALESCE(v_threshold, 3);
  v_critical  := GREATEST(COALESCE(v_critical, 6), v_threshold);
  v_low       := COALESCE(v_low, 70);
  v_count     := public.youth_consecutive_absences(p_youth_id);

  SELECT a.event_id INTO v_last_event
    FROM public.attendance a
    JOIN public.events e ON e.id = a.event_id
   WHERE a.youth_id = p_youth_id AND e.status <> 'cancelled'
   ORDER BY e.event_date DESC, a.created_at DESC
   LIMIT 1;

  -- ---------------------------------------------------------------- faltas consecutivas
  IF v_active AND v_count >= v_threshold THEN
    v_severity := CASE WHEN v_count >= v_critical THEN 'critical' ELSE 'attention' END;

    SELECT id INTO v_open FROM public.alerts
     WHERE youth_id = p_youth_id AND type = 'consecutive_absences' AND status = 'open';

    IF v_open IS NOT NULL THEN
      UPDATE public.alerts
         SET consecutive_absences = v_count,
             last_event_id = v_last_event,
             group_id = v_group,
             severity = v_severity
       WHERE id = v_open
         AND (consecutive_absences IS DISTINCT FROM v_count
           OR last_event_id IS DISTINCT FROM v_last_event
           OR group_id IS DISTINCT FROM v_group
           OR severity IS DISTINCT FROM v_severity);
    ELSIF NOT EXISTS (
      SELECT 1
        FROM public.alerts x
        JOIN public.events le ON le.id = x.last_event_id
       WHERE x.youth_id = p_youth_id
         AND x.type = 'consecutive_absences'
         AND x.status <> 'open'
         AND (x.status = 'dismissed' OR x.resolved_by IS NOT NULL)
         AND NOT EXISTS (   -- nenhuma presença mais recente que a última falta do alerta encerrado
           SELECT 1
             FROM public.attendance p
             JOIN public.events pe ON pe.id = p.event_id
            WHERE p.youth_id = p_youth_id AND p.present AND pe.status <> 'cancelled'
              AND pe.event_date > le.event_date)
    ) THEN
      INSERT INTO public.alerts (youth_id, group_id, type, severity, consecutive_absences, last_event_id)
      VALUES (p_youth_id, v_group, 'consecutive_absences', v_severity, v_count, v_last_event)
      ON CONFLICT (youth_id, type) WHERE status = 'open' DO NOTHING;
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

  -- ---------------------------------------------------------------- frequência
  -- Janela: até 8 registros mais recentes (encontros cancelados e "não registrado" ficam de fora).
  SELECT count(*), count(*) FILTER (WHERE present),
         count(*) FILTER (WHERE present AND rn <= 4),
         count(*) FILTER (WHERE present AND rn BETWEEN 5 AND 8)
    INTO v_n, v_p, v_p_recent, v_p_prev
    FROM (
      SELECT a.present,
             row_number() OVER (ORDER BY e.event_date DESC, a.created_at DESC, a.id) AS rn
        FROM public.attendance a
        JOIN public.events e ON e.id = a.event_id
       WHERE a.youth_id = p_youth_id AND e.status <> 'cancelled'
       ORDER BY e.event_date DESC, a.created_at DESC, a.id
       LIMIT 8
    ) w;

  -- Frequência baixa: >= 4 registros e % de presença (exata, sem arredondar) abaixo do limite
  PERFORM public.sync_rate_alert(
    p_youth_id, v_group, 'low_attendance',
    v_active AND v_n >= 4 AND v_p * 100 < v_low * v_n,
    CASE WHEN v_n > 0 THEN round(100.0 * v_p / v_n)::integer END,
    NULL, v_n, v_last_event,
    CASE WHEN v_active THEN 'Resolvido automaticamente: frequência acima do limite.'
         ELSE 'Resolvido automaticamente: jovem inativado.' END);

  -- Queda de frequência: 8 registros; 4 mais recentes >= 30 pontos abaixo dos 4 anteriores
  PERFORM public.sync_rate_alert(
    p_youth_id, v_group, 'attendance_drop',
    v_active AND v_n = 8 AND (v_p_prev - v_p_recent) * 25 >= 30,
    v_p_recent * 25, v_p_prev * 25, v_n, v_last_event,
    CASE WHEN v_active THEN 'Resolvido automaticamente: frequência recuperada.'
         ELSE 'Resolvido automaticamente: jovem inativado.' END);
END;
$$;

REVOKE ALL ON FUNCTION public.refresh_youth_alert(uuid) FROM PUBLIC, anon, authenticated;

-- Mudar qualquer limite recalcula todos os alertas
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
  END IF;
  RETURN NEW;
END;
$$;


-- ============================================================================
-- 4. save_attendance — grava somente quem foi marcado (atômico, RLS vale)
-- ============================================================================
-- p_entries = [{"youth_id": "<uuid>", "present": true|false|null}, ...]
--   * present null/ausente = ignorar (não grava, não apaga linha existente);
--   * group_id é derivado do jovem no banco (nunca vem do cliente);
--   * o jovem precisa estar num grupo vinculado ao encontro; encontro cancelado é rejeitado;
--   * repetidos no mesmo envio: vale o último não nulo.
-- SECURITY INVOKER: as policies de attendance continuam a barreira real (líder só dos seus grupos,
-- recorded_by = auth.uid()). Nenhuma policy foi criada/alterada; não há DELETE.
-- Retorno: saved (entradas gravadas nesta chamada) + contagens do ENCONTRO inteiro visíveis ao chamador.
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

  -- Totais do encontro (somente linhas visíveis ao chamador)
  SELECT count(*) FILTER (WHERE present), count(*) FILTER (WHERE NOT present), count(*)
    INTO v_present, v_absent, v_total
    FROM public.attendance WHERE event_id = p_event_id;

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

NOTIFY pgrst, 'reload schema';
