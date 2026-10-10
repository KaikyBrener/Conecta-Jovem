-- Migration: 023_cron_time_alerts.sql
-- Descrição: recálculo DIÁRIO dos alertas temporais (no_followup, overdue_action, ...) por pg_cron, para que fiquem
-- "frescos" mesmo que ninguém abra Alertas/Dashboard. Nada de 001-019 foi editado.
--
--   1) public.cron_refresh_time_alerts(): SECURITY DEFINER, sem depender de auth.uid()/papel (usa o mesmo
--      refresh_time_alerts() de sync_time_alerts, que já é interno e sem EXECUTE para clientes). Respeita o mesmo advisory
--      lock de sync_time_alerts (não varre em paralelo) e atualiza time_alerts_sync_state.last_run (o throttle de 60 s do
--      app passa a considerar a varredura do cron). EXECUTE: ninguém além do dono (postgres), que é quem o pg_cron usa.
--   2) Agendamento (só se pg_cron estiver disponível; veja "ORDEM" abaixo):
--        conecta-jovem-time-alerts   0 9 * * *   = 06:00 em Brasília (UTC-3; pg_cron usa UTC)
--        conecta-jovem-cron-cleanup  30 9 * * *  = 06:30 em Brasília: apaga cron.job_run_details com mais de 7 dias
--      Brasília está em UTC-3 o ano todo (sem horário de verão desde 2019). Se o Brasil voltar a ter horário de verão,
--      o job passa a rodar 1 h mais cedo/tarde em UTC; reagende com cron.schedule (mesmo nome substitui).
--
-- Efeitos a conhecer:
--   * Alertas criados pelo cron NÃO geram linha em activity_log: activity_write() não registra sem sessão (auth.uid() nulo).
--     O alerta existe e aparece normalmente; só o histórico "quem fez" não é escrito (não há "quem").
--   * Mesma regra de alertas do app; nenhuma regra nova. Idempotente (rodar duas vezes não duplica alertas).
--
-- ORDEM: (1) habilite a extensão pg_cron no PAINEL (Database > Extensions) ANTES de aplicar esta migration (no Supabase a
--        extensão se habilita pelo painel; esta migration não a cria). (2) Aplique esta migration no SQL Editor, após a 019 (e após
--        as migrations 020-022, se existirem). Se pg_cron não estiver disponível, a função é criada, o agendamento é pulado
--        e aparece um NOTICE: habilite a extensão e rode APENAS o bloco "-- 2) AGENDAMENTO" de novo.
-- VERIFICAR (somente leitura):
--        SELECT jobid, jobname, schedule, command, active FROM cron.job WHERE jobname LIKE 'conecta-jovem-%';
-- DESFAZER (não remove a função):
--        SELECT cron.unschedule('conecta-jovem-time-alerts');
--        SELECT cron.unschedule('conecta-jovem-cron-cleanup');
--        -- e, se também quiser remover a função:  DROP FUNCTION public.cron_refresh_time_alerts();
--
-- LIMITAÇÃO DE TESTE (PGlite): o PGlite não tem pg_cron. Testado: a função (efeito, idempotência, grants, lock, throttle) e
-- que a migration aplica sem pg_cron (o bloco de agendamento é pulado). NÃO testado: o agendamento real, o horário UTC, a
-- limpeza de cron.job_run_details e as permissões do pg_cron no Supabase (precisam ser conferidos no projeto real).
-- ============================================================================

-- ---------------------------------------------------------------- 1) função
CREATE OR REPLACE FUNCTION public.cron_refresh_time_alerts()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_n integer;
BEGIN
  -- Defesa extra: sessão de usuário (JWT) nunca executa a varredura do cron (os grants já impedem).
  IF auth.uid() IS NOT NULL THEN
    RAISE EXCEPTION 'Função interna.' USING ERRCODE = '42501';
  END IF;

  -- Mesma chave de sync_time_alerts(): se um usuário estiver varrendo agora, o resultado já será fresco.
  IF NOT pg_try_advisory_xact_lock(hashtext('public.sync_time_alerts'), 1) THEN
    RETURN 0;
  END IF;

  v_n := public.refresh_time_alerts();
  UPDATE public.time_alerts_sync_state SET last_run = clock_timestamp() WHERE id;
  RETURN v_n;
END;
$$;
REVOKE ALL ON FUNCTION public.cron_refresh_time_alerts() FROM PUBLIC, anon, authenticated, service_role;

-- ---------------------------------------------------------------- 2) AGENDAMENTO
DO $cron$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    RAISE NOTICE 'pg_cron NÃO está habilitada: agendamento pulado. Habilite em Database > Extensions e rode de novo só este bloco.';
    RETURN;
  END IF;

  -- cron.schedule com nome existente substitui o job (idempotente). Horários em UTC (06:00 e 06:30 de Brasília).
  PERFORM cron.schedule('conecta-jovem-time-alerts', '0 9 * * *', 'SELECT public.cron_refresh_time_alerts()');
  PERFORM cron.schedule('conecta-jovem-cron-cleanup', '30 9 * * *',
                        $job$DELETE FROM cron.job_run_details WHERE end_time < now() - interval '7 days'$job$);
END;
$cron$;
