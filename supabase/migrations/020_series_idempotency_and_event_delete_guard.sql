-- Migration: 020_series_idempotency_and_event_delete_guard.sql
-- Descrição: itens "importantes, mas não urgentes" da auditoria pré-produção. Nenhuma migration anterior foi editada.
--
--   1) create_event_series IDEMPOTENTE: chamada repetida (reenvio, duplo clique) com os mesmos dados não cria uma
--      segunda série. Se já existe série ATIVA com mesmo nome, dia da semana, horário, recorrência e período,
--      a função falha com erro pt-BR (P0001) em vez de duplicar os encontros. Corpo idêntico ao da 014, só com a
--      checagem (serializada por pg_advisory_xact_lock) antes do INSERT. Grants da 014 permanecem (CREATE OR REPLACE).
--      Complemento no frontend: desabilitar o botão enquanto a chamada está em andamento.
--   2) EXCLUSÃO DE ENCONTRO COM CHAMADA: events -> attendance é ON DELETE CASCADE, então excluir um encontro apagava
--      a chamada. O trigger events_block_delete_with_attendance bloqueia o DELETE quando existe presença registrada;
--      o caminho correto é cancelar o encontro. Encontros sem chamada continuam excluíveis.
--
-- LIMITAÇÃO DE TESTE (PGlite): o advisory lock não é testável contra concorrência real (uma conexão).
-- IMPORTANTE: Execute no SQL Editor do Supabase APÓS a migration 019.
-- ============================================================================

-- ---------------------------------------------------------------- 1) create_event_series
CREATE OR REPLACE FUNCTION public.create_event_series(
  p_name        text,
  p_weekday     integer,
  p_start_time  time,
  p_recurrence  text,
  p_start_date  date,
  p_end_date    date,
  p_description text,
  p_group_ids   uuid[] DEFAULT '{}'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid     uuid := auth.uid();
  v_name    text := btrim(COALESCE(p_name, ''));
  v_desc    text := NULLIF(btrim(COALESCE(p_description, '')), '');
  v_groups  uuid[];
  v_dates   date[];
  v_series  uuid;
  v_created integer;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Não autenticado.' USING ERRCODE = '42501';
  END IF;
  IF public.get_my_role() IS DISTINCT FROM 'coordinator' THEN
    RAISE EXCEPTION 'Apenas coordenadores podem criar séries de encontros.' USING ERRCODE = '42501';
  END IF;

  IF v_name = '' THEN
    RAISE EXCEPTION 'Informe o nome da série.' USING ERRCODE = 'P0001';
  END IF;
  IF length(v_name) > 120 THEN
    RAISE EXCEPTION 'O nome da série pode ter no máximo 120 caracteres.' USING ERRCODE = 'P0001';
  END IF;
  IF p_weekday IS NULL OR p_weekday NOT BETWEEN 0 AND 6 THEN
    RAISE EXCEPTION 'Dia da semana inválido (use 0 = domingo até 6 = sábado).' USING ERRCODE = 'P0001';
  END IF;
  IF p_start_time IS NULL THEN
    RAISE EXCEPTION 'Informe o horário do encontro.' USING ERRCODE = 'P0001';
  END IF;
  IF p_recurrence IS NULL OR p_recurrence NOT IN ('weekly', 'biweekly', 'monthly_nth_weekday') THEN
    RAISE EXCEPTION 'Recorrência inválida.' USING ERRCODE = 'P0001';
  END IF;
  IF p_start_date IS NULL OR p_end_date IS NULL THEN
    RAISE EXCEPTION 'Informe a data inicial e a data final da série.' USING ERRCODE = 'P0001';
  END IF;
  IF p_end_date < p_start_date THEN
    RAISE EXCEPTION 'A data final não pode ser anterior à data inicial.' USING ERRCODE = 'P0001';
  END IF;
  IF p_end_date - p_start_date > 731 THEN
    RAISE EXCEPTION 'O período da série não pode passar de 2 anos.' USING ERRCODE = 'P0001';
  END IF;

  SELECT COALESCE(array_agg(DISTINCT g), '{}') INTO v_groups
    FROM unnest(COALESCE(p_group_ids, '{}')) AS g WHERE g IS NOT NULL;
  IF (SELECT count(*) FROM public.groups WHERE id = ANY (v_groups)) <> cardinality(v_groups) THEN
    RAISE EXCEPTION 'Há grupos inexistentes na lista.' USING ERRCODE = 'P0001';
  END IF;

  SELECT array_agg(d ORDER BY d) INTO v_dates
    FROM public.series_dates(p_weekday, p_recurrence, p_start_date, p_end_date) AS d;
  IF v_dates IS NULL THEN
    RAISE EXCEPTION 'O período informado não contém nenhuma data para este dia da semana.' USING ERRCODE = 'P0001';
  END IF;
  IF cardinality(v_dates) > 120 THEN
    RAISE EXCEPTION 'A série geraria mais de 120 encontros. Reduza o período.' USING ERRCODE = 'P0001';
  END IF;

  -- Idempotência (migration 020): reenvio ou duplo clique não cria uma segunda série idêntica.
  -- O lock serializa chamadas concorrentes com os mesmos parâmetros; o 2º chamador enxerga a série do 1º.
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'create_event_series|' || v_name || '|' || p_weekday || '|' || p_start_time || '|' || p_recurrence
      || '|' || p_start_date || '|' || p_end_date, 0));
  IF EXISTS (
    SELECT 1 FROM public.event_series s
     WHERE s.active
       AND s.name = v_name AND s.weekday = p_weekday AND s.start_time = p_start_time
       AND s.recurrence = p_recurrence AND s.start_date = p_start_date AND s.end_date = p_end_date
  ) THEN
    RAISE EXCEPTION 'Já existe uma série ativa com o mesmo nome, dia, horário, recorrência e período. Verifique a lista de séries antes de criar outra.'
      USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO public.event_series (name, weekday, start_time, recurrence, start_date, end_date,
                                   default_description, created_by)
  VALUES (v_name, p_weekday, p_start_time, p_recurrence, p_start_date, p_end_date, v_desc, v_uid)
  RETURNING id INTO v_series;

  INSERT INTO public.event_series_groups (series_id, group_id)
  SELECT v_series, g FROM unnest(v_groups) AS g;

  WITH ins AS (
    INSERT INTO public.events (title, description, event_date, status, created_by, series_id, series_date)
    SELECT v_name, v_desc, ((d + p_start_time)::timestamp AT TIME ZONE 'America/Sao_Paulo'),
           'scheduled', v_uid, v_series, d
      FROM unnest(v_dates) AS d
    ON CONFLICT (series_id, series_date) WHERE series_id IS NOT NULL DO NOTHING
    RETURNING id
  ), grp AS (
    INSERT INTO public.event_groups (event_id, group_id)
    SELECT ins.id, g FROM ins CROSS JOIN unnest(v_groups) AS g
    RETURNING 1
  )
  SELECT count(*) INTO v_created FROM ins;

  PERFORM public.activity_write('event_series_created', 'event_series', v_series, NULL, NULL,
                                'Série de encontros criada.',
                                jsonb_build_object('recurrence', p_recurrence, 'created', v_created));

  RETURN jsonb_build_object('series_id', v_series, 'created', v_created,
                            'skipped', cardinality(v_dates) - v_created);
END;
$$;


-- ---------------------------------------------------------------- 2) bloqueio de exclusão com chamada
CREATE OR REPLACE FUNCTION public.events_block_delete_with_attendance()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.attendance a WHERE a.event_id = OLD.id) THEN
    RAISE EXCEPTION 'Este encontro já tem chamada registrada e não pode ser excluído. Cancele o encontro para preservar o histórico de presença.'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN OLD;
END;
$$;
REVOKE ALL ON FUNCTION public.events_block_delete_with_attendance() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS events_block_delete_with_attendance ON public.events;
CREATE TRIGGER events_block_delete_with_attendance
  BEFORE DELETE ON public.events
  FOR EACH ROW EXECUTE FUNCTION public.events_block_delete_with_attendance();
