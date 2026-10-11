-- =====================================================================================================================
-- Conecta Jovem — verificação das migrations no banco REAL (SQL Editor do Supabase)
-- =====================================================================================================================
-- SOMENTE LEITURA: cada consulta é um único SELECT; nada é gravado e nenhuma função do app é executada.
-- Rode UMA consulta por vez (selecione do "-- Qn" até o "order by 1, 2;") e guarde o resultado.
--
-- SEÇÃO A (Q1–Q9): prova que 001–019 estão aplicadas POR INTEIRO. Rode ANTES de aplicar qualquer migration nova.
-- SEÇÃO B (Q10):   confere 020, 021 e 024. Rode só DEPOIS de aplicá-las (antes disso, ela acusa as três, como esperado).
-- SEÇÃO C (Q11/Q12): confere a 023 (pg_cron). Só depois de habilitar o pg_cron no painel e aplicar a 023.
--
-- RESULTADO ESPERADO, igual em todas: UMA única linha  --- | Qn verificados: X | falhas: 0
-- Qualquer outra linha é um problema, com as colunas  mig | item | problema:
--   mig = número  -> aquele item daquela migration está faltando ou em versão antiga (migration PARCIAL ou ausente);
--   mig = ?Q2/?Q7 -> a Q1 viu contagem diferente de colunas/policies: a Q2/Q7 dizem de qual migration;
--   mig = ???     -> objeto que existe no banco mas não está em nenhuma migration (criado à mão?).
-- Se uma migration tiver só ALGUNS itens acusados, ela está PARCIAL: NÃO reaplique a migration inteira (não são
-- idempotentes; 004/005 reaplicadas regridem policies). Traga o resultado: a correção é uma migration nova só com o
-- que falta.
--
-- Validadas num Postgres local em memória (PGlite) com as migrations do repositório: 0 falhas com tudo aplicado, e
-- acusam exatamente as migrations ausentes quando se aplica só um prefixo. NÃO foram executadas no Supabase real.
-- O que NÃO provam: igualdade byte a byte de corpos de função/expressões de policy (há marcadores de versão, não
-- comparação completa), dados (backfills), privilégios default para tabelas futuras, Edge Function e secrets.
-- =====================================================================================================================


-- =====================================================================================================================
-- SEÇÃO A — 001 a 019 (estado atual do banco)
-- =====================================================================================================================

-- Q1  Tabelas: existência, RLS ligado, nº de colunas e nº de policies
--     Esperado: "Q1 verificados: 18 | falhas: 0". TABELA AUSENTE = a migration que a cria não rodou;
--     RLS DESLIGADO = alguém desligou à mão; contagem diferente = veja Q2/Q7.
with esperado(mig, tabela, n_colunas, n_policies) as (values
  ('001', 'profiles', 3, 3), ('001', 'user_roles', 3, 2), ('001', 'groups', 6, 4), ('001', 'youth', 13, 3), ('003', 'events', 11, 2),
  ('003', 'event_groups', 2, 2), ('003', 'attendance', 8, 4), ('006', 'app_settings', 7, 2), ('006', 'alerts', 17, 5), ('006', 'tasks', 15, 5),
  ('011', 'follow_ups', 16, 4), ('011', 'follow_up_transfers', 7, 2), ('014', 'activity_log', 12, 2), ('014', 'event_series', 11, 2),
  ('014', 'event_series_groups', 2, 2), ('015', 'communications', 21, 7), ('016', 'time_alerts_sync_state', 2, 0),
  ('018', 'communication_send_log', 4, 0)
), real as (
  select e.*, c.oid, c.relrowsecurity,
         (select count(*) from information_schema.columns k where k.table_schema='public' and k.table_name=e.tabela) as cols,
         (select count(*) from pg_policies p where p.schemaname='public' and p.tablename=e.tabela) as pols
  from esperado e left join pg_class c on c.relname=e.tabela and c.relnamespace='public'::regnamespace and c.relkind='r'
), falhas as (
  select case when oid is null or not relrowsecurity then mig when cols <> n_colunas then '?Q2' else '?Q7' end as mig, tabela as item,
         case when oid is null then 'TABELA AUSENTE'
              when not relrowsecurity then 'RLS DESLIGADO'
              when cols <> n_colunas then 'colunas: esperado '||n_colunas||', real '||cols||' (a Q2 diz qual migration)'
              else 'policies: esperado '||n_policies||', real '||pols||' (a Q7 diz qual migration)' end as problema
  from real where oid is null or not relrowsecurity or cols <> n_colunas or pols <> n_policies
)
select * from falhas
union all select '---', 'Q1 verificados: '||(select count(*) from esperado), 'falhas: '||(select count(*) from falhas)
order by 1, 2;

-- Q2  Colunas criadas/alteradas por ALTER TABLE: tipo e nulabilidade
--     Esperado: "Q2 verificados: 23 | falhas: 0". COLUNA AUSENTE ou tipo/nulo diferente = migration parcial.
--     Ex.: communication_send_log.communication_id com nulo=NO = 018 aplicada e 019 NÃO.
with esperado(mig, tabela, coluna, tipo, nulo) as (values
  ('006', 'events', 'created_by', 'uuid', 'YES'), ('006', 'youth', 'created_by', 'uuid', 'YES'),
  ('010', 'alerts', 'severity', 'alert_severity', 'NO'), ('010', 'alerts', 'attendance_rate', 'int4', 'YES'),
  ('010', 'alerts', 'previous_rate', 'int4', 'YES'), ('010', 'alerts', 'sample_size', 'int4', 'YES'),
  ('010', 'alerts', 'episode_ended', 'bool', 'NO'), ('010', 'app_settings', 'critical_absence_threshold', 'int4', 'NO'),
  ('011', 'app_settings', 'followup_grace_days', 'int4', 'NO'), ('011', 'tasks', 'completed_by_follow_up_id', 'uuid', 'YES'),
  ('014', 'events', 'series_id', 'uuid', 'YES'), ('014', 'events', 'series_date', 'date', 'YES'),
  ('014', 'events', 'series_customized', 'bool', 'NO'), ('015', 'communications', 'status', 'communication_status', 'NO'),
  ('015', 'communications', 'recipient_email', 'text', 'NO'), ('015', 'communications', 'failure_reason', 'text', 'YES'),
  ('018', 'communications', 'provider', 'text', 'YES'), ('018', 'communications', 'provider_message_id', 'text', 'YES'),
  ('018', 'communications', 'attempts', 'int4', 'NO'), ('018', 'communications', 'last_attempt_at', 'timestamptz', 'YES'),
  ('018', 'communication_send_log', 'user_id', 'uuid', 'NO'), ('018', 'communication_send_log', 'started_at', 'timestamptz', 'NO'),
  ('019', 'communication_send_log', 'communication_id', 'uuid', 'YES')
), falhas as (
  select e.mig, e.tabela||'.'||e.coluna as item,
         case when k.column_name is null then 'COLUNA AUSENTE'
              else 'esperado '||e.tipo||'/nulo='||e.nulo||', real '||k.udt_name||'/nulo='||k.is_nullable end as problema
  from esperado e left join information_schema.columns k
    on k.table_schema='public' and k.table_name=e.tabela and k.column_name=e.coluna
  where k.column_name is null or k.udt_name <> e.tipo or k.is_nullable <> e.nulo
)
select * from falhas
union all select '---', 'Q2 verificados: '||(select count(*) from esperado), 'falhas: '||(select count(*) from falhas)
order by 1, 2;

-- Q3  Enums: valores e ORDEM; e o tipo composto youth_situation_row
--     Esperado: "Q3 verificados: 11 | falhas: 0". Valor faltando = a migration que o adiciona não rodou
--     (ex.: communication_status sem 'sending' = 018 ausente).
with esperado(mig, tipo, valores) as (values
  ('001', 'user_role', 'coordinator,leader'), ('001', 'gender_type', 'male,female,other'), ('003', 'event_status', 'scheduled,completed,cancelled'),
  ('006', 'alert_status', 'open,resolved,dismissed'), ('006', 'task_status', 'pending,in_progress,done,cancelled'),
  ('006', 'task_priority', 'low,medium,high'), ('010', 'alert_severity', 'attention,critical'),
  ('011', 'follow_up_type', 'conversation,call,in_person,guidance,return,other'),
  ('011', 'alert_type', 'consecutive_absences,low_attendance,attendance_drop,no_followup,overdue_action'),
  ('018', 'communication_status', 'draft,sending,sent,failed,cancelled')
), real as (
  select e.*, (select string_agg(x.enumlabel, ',' order by x.enumsortorder)
                 from pg_type t join pg_enum x on x.enumtypid=t.oid
                where t.typname=e.tipo and t.typnamespace='public'::regnamespace) as atual
  from esperado e
), falhas as (
  select mig, tipo as item, coalesce('real: '||atual, 'ENUM AUSENTE')||' | esperado: '||valores as problema
  from real where atual is distinct from valores
  union all
  select '011', 'youth_situation_row', 'TIPO COMPOSTO AUSENTE'
  where not exists (select 1 from pg_type where typname='youth_situation_row' and typnamespace='public'::regnamespace and typtype='c')
)
select * from falhas
union all select '---', 'Q3 verificados: '||((select count(*) from esperado)+1), 'falhas: '||(select count(*) from falhas)
order by 1, 2;

-- Q4  Funções: existência pela ASSINATURA exata, SECURITY DEFINER/INVOKER e pg_temp no search_path das DEFINER
--     mig = migration que CRIA a função (a versão do corpo é conferida na Q5)
--     Esperado: "Q4 verificados: 84 | falhas: 0". FUNÇÃO/ASSINATURA AUSENTE = migration não criou a função;
--     "DEFINER sem pg_temp" com mig 016 = o endurecimento de search_path da 016 não rodou.
with esperado(mig, nome, args, definer) as (values
  ('014', 'activity_log_immutable', '', false), ('014', 'activity_write', 'text, text, uuid, uuid, uuid, text, jsonb', true),
  ('006', 'alerts_guard', '', false), ('014', 'alerts_log_activity', '', true), ('011', 'alerts_refresh_time_alerts', '', true),
  ('011', 'app_today', '', false), ('011', 'assignable_responsibles', 'uuid', true), ('014', 'attendance_log_activity', '', true),
  ('006', 'attendance_refresh_alert', '', true), ('014', 'batch_set_youth_active', 'uuid[], boolean', false),
  ('014', 'batch_set_youth_group', 'uuid[], uuid', true), ('018', 'begin_communication_send', 'uuid, uuid', true),
  ('014', 'cancel_event_series_future', 'uuid', true), ('015', 'communications_guard', '', false),
  ('019', 'communications_leader_recipient', '', false), ('015', 'communications_log_activity', '', true),
  ('014', 'create_event_series', 'text, integer, time, text, date, date, text, uuid[]', true), ('012', 'dashboard_overview', '', true),
  ('014', 'event_groups_series_customize', '', false), ('006', 'events_refresh_alerts', '', true), ('014', 'events_series_guard', '', false),
  ('014', 'extend_event_series', 'uuid, date', true), ('018', 'finish_communication_send', 'uuid, boolean, text, text, text', true),
  ('011', 'follow_up_people', 'uuid', true), ('011', 'follow_up_transfers_immutable', '', false),
  ('014', 'follow_up_transfers_log_activity', '', true), ('011', 'follow_ups_complete_task', '', false), ('011', 'follow_ups_guard', '', false),
  ('014', 'follow_ups_log_activity', '', true), ('016', 'follow_ups_protect_history', '', true), ('011', 'follow_ups_refresh_time_alerts', '', true),
  ('002', 'get_my_role', '', true), ('014', 'global_search', 'text, integer', false), ('012', 'group_indicators', 'uuid[]', true),
  ('017', 'groups_block_delete_with_history', '', true), ('001', 'handle_new_user', '', true), ('015', 'is_single_line_text', 'text', false),
  ('011', 'is_task_overdue', 'task_status, date', false), ('015', 'is_valid_email', 'text', false),
  ('015', 'mark_communication', 'uuid, text, text', false), ('006', 'recalculate_all_alerts', '', true),
  ('006', 'recalculate_all_alerts_internal', '', true), ('011', 'refresh_time_alerts', '', true), ('006', 'refresh_youth_alert', 'uuid', true),
  ('011', 'refresh_youth_time_alerts', 'uuid', true), ('013', 'report_alerts', 'date, date, uuid', true),
  ('012', 'report_att_rows', 'date, date, uuid', true), ('013', 'report_attendance', 'date, date, uuid, integer', true),
  ('013', 'report_check', 'date, date, uuid', true), ('013', 'report_followups', 'date, date, uuid', true),
  ('013', 'report_general', 'date, date, uuid', true), ('013', 'report_groups', 'date, date', true), ('013', 'report_pct', 'bigint, bigint', false),
  ('012', 'report_pending_followups', 'uuid', true), ('013', 'report_period', 'date, date, uuid', false),
  ('012', 'report_scope_events', 'timestamptz, timestamptz, uuid', true), ('012', 'report_scope_tasks', 'uuid', true),
  ('012', 'report_scope_youth', 'uuid', true), ('013', 'report_youth', 'uuid, date, date', true), ('010', 'save_attendance', 'uuid, jsonb', false),
  ('009', 'save_event', 'uuid, text, text, timestamp with time zone, event_status, uuid[]', false), ('014', 'search_norm', 'text', false),
  ('014', 'series_dates', 'integer, text, date, date', false), ('014', 'set_series_groups', 'uuid, uuid[], date', true),
  ('001', 'set_updated_at', '', false), ('006', 'set_user_role', 'uuid, user_role', true), ('006', 'settings_refresh_alerts', '', true),
  ('006', 'settings_stamp_user', '', false), ('015', 'suggest_communication_recipients', 'uuid', true),
  ('010', 'sync_rate_alert', 'uuid, uuid, alert_type, boolean, integer, integer, integer, uuid, text', true), ('011', 'sync_time_alerts', '', true),
  ('011', 'tasks_followup_guard', '', false), ('006', 'tasks_guard', '', false), ('014', 'tasks_log_activity', '', true),
  ('011', 'tasks_refresh_time_alerts', '', true), ('006', 'tasks_resolve_alert', '', true), ('011', 'transfer_follow_up', 'uuid, uuid, text', true),
  ('006', 'youth_consecutive_absences', 'uuid', true), ('014', 'youth_log_activity', '', true), ('006', 'youth_refresh_alert', '', true),
  ('011', 'youth_refresh_time_alerts', '', true), ('011', 'youth_situation', 'uuid', false), ('011', 'youth_situations', 'uuid[]', true),
  ('012', 'youth_sync_attendance_group', '', true)
), real as (
  select e.*, to_regprocedure('public.'||e.nome||'('||e.args||')') as oid from esperado e
), det as (
  select r.*, p.prosecdef, array_to_string(p.proconfig, ' ') as cfg from real r left join pg_proc p on p.oid = r.oid
), falhas as (
  select case when oid is not null and prosecdef = definer then '016' else mig end as mig, nome||'('||args||')' as item,
         case when oid is null then 'FUNÇÃO/ASSINATURA AUSENTE'
              when prosecdef <> definer then 'security: esperado '||case when definer then 'DEFINER' else 'INVOKER' end
              else 'DEFINER sem pg_temp no search_path ('||coalesce(cfg,'sem search_path')||')' end as problema
  from det
  where oid is null or prosecdef <> definer or (prosecdef and coalesce(cfg,'') !~ 'search_path=.*pg_temp')
)
select * from falhas
union all select '---', 'Q4 verificados: '||(select count(*) from esperado), 'falhas: '||(select count(*) from falhas)
order by 1, 2;

-- Q5  Versão do CORPO das funções regravadas com CREATE OR REPLACE (marcadores de texto por migration)
--     deve_conter = false: texto da versão ANTIGA, que não pode mais existir
--     Esperado: "Q5 verificados: 21 | falhas: 0". "corpo ANTIGO" = a função existe, mas com o corpo de uma migration
--     anterior (a migration em `mig` não a regravou). Ex.: begin_communication_send sem v_day_limit = 019 ausente.
with esperado(mig, nome, marcador, deve_conter) as (values
  ('008', 'set_user_role', 'pg_advisory_xact_lock', true), ('010', 'alerts_guard', 'severity', true),
  ('010', 'refresh_youth_alert', 'sync_rate_alert', true), ('010', 'settings_refresh_alerts', 'critical_absence_threshold', true),
  ('011', 'settings_refresh_alerts', 'followup_grace_days', true), ('011', 'recalculate_all_alerts_internal', 'refresh_time_alerts', true),
  ('012', 'save_attendance', 'is_active', true), ('016', 'sync_time_alerts', 'time_alerts_sync_state', true),
  ('016', 'report_youth', 'Encontro de outro grupo', true), ('016', 'report_attendance', 'Encontro de outro grupo', true),
  ('017', 'youth_log_activity', 'EXISTS', true), ('017', 'refresh_youth_time_alerts', 'ampliad', true),
  ('018', 'communications_guard', 'sending', true), ('018', 'mark_communication', 'servidor', true),
  ('018', 'communications_log_activity', 'por e-mail enviada', true), ('018', 'communications_log_activity', 'marcada como enviada', false),
  ('018', 'finish_communication_send', 'request.jwt.claim.sub', true), ('018', 'begin_communication_send', 'rate_limited', true),
  ('019', 'begin_communication_send', 'v_day_limit', true), ('019', 'begin_communication_send', 'pg_advisory_xact_lock', true),
  ('019', 'communications_leader_recipient', 'e-mail cadastrado', true)
), real as (
  select e.*,
         (select count(*) from pg_proc p where p.proname=e.nome and p.pronamespace='public'::regnamespace) as n,
         (select bool_or(position(e.marcador in p.prosrc) > 0) from pg_proc p where p.proname=e.nome and p.pronamespace='public'::regnamespace) as tem
  from esperado e
), falhas as (
  select mig, nome as item,
         case when n = 0 then 'FUNÇÃO AUSENTE'
              when deve_conter then 'corpo ANTIGO: falta o marcador "'||marcador||'"'
              else 'corpo ANTIGO: ainda contém "'||marcador||'"' end as problema
  from real where n = 0 or tem is distinct from deve_conter
)
select * from falhas
union all select '---', 'Q5 verificados: '||(select count(*) from esperado), 'falhas: '||(select count(*) from falhas)
order by 1, 2;

-- Q6  Triggers: existência na tabela certa e habilitados; definição estreitada pela 012; triggers excedentes
--     Esperado: "Q6 verificados: 42 | falhas: 0". TRIGGER AUSENTE / DESABILITADO / "definição antiga (006)" = parcial;
--     ??? = trigger que não está em nenhuma migration. (O trigger da 020 é ignorado aqui e conferido na Q10.)
with esperado(mig, gatilho, tabela) as (values
  ('014', 'activity_log_immutable', 'public.activity_log'), ('006', 'alerts_guard', 'public.alerts'), ('014', 'alerts_log_activity', 'public.alerts'),
  ('011', 'alerts_refresh_time_alerts', 'public.alerts'), ('006', 'alerts_updated_at', 'public.alerts'),
  ('006', 'app_settings_updated_at', 'public.app_settings'), ('014', 'attendance_log_activity_ins', 'public.attendance'),
  ('014', 'attendance_log_activity_upd', 'public.attendance'), ('006', 'attendance_refresh_alert', 'public.attendance'),
  ('015', 'communications_guard', 'public.communications'), ('019', 'communications_leader_recipient', 'public.communications'),
  ('015', 'communications_log_activity', 'public.communications'), ('015', 'communications_updated_at', 'public.communications'),
  ('014', 'event_groups_series_customize', 'public.event_groups'), ('006', 'events_refresh_alerts', 'public.events'),
  ('014', 'events_series_guard', 'public.events'), ('003', 'events_updated_at', 'public.events'),
  ('011', 'follow_up_transfers_immutable', 'public.follow_up_transfers'), ('014', 'follow_up_transfers_log_activity', 'public.follow_up_transfers'),
  ('011', 'follow_ups_complete_task', 'public.follow_ups'), ('011', 'follow_ups_guard', 'public.follow_ups'),
  ('014', 'follow_ups_log_activity', 'public.follow_ups'), ('016', 'follow_ups_protect_history', 'public.follow_ups'),
  ('011', 'follow_ups_refresh_time_alerts', 'public.follow_ups'), ('011', 'follow_ups_updated_at', 'public.follow_ups'),
  ('017', 'groups_block_delete_with_history', 'public.groups'), ('001', 'groups_updated_at', 'public.groups'),
  ('001', 'on_auth_user_created', 'auth.users'), ('006', 'settings_refresh_alerts', 'public.app_settings'),
  ('006', 'settings_stamp_user', 'public.app_settings'), ('011', 'tasks_followup_guard', 'public.tasks'), ('006', 'tasks_guard', 'public.tasks'),
  ('014', 'tasks_log_activity', 'public.tasks'), ('011', 'tasks_refresh_time_alerts', 'public.tasks'), ('006', 'tasks_resolve_alert', 'public.tasks'),
  ('006', 'tasks_updated_at', 'public.tasks'), ('014', 'youth_log_activity', 'public.youth'), ('006', 'youth_refresh_alert', 'public.youth'),
  ('011', 'youth_refresh_time_alerts', 'public.youth'), ('012', 'youth_sync_attendance_group', 'public.youth'),
  ('001', 'youth_updated_at', 'public.youth')
), real as (
  select e.*, t.oid, t.tgenabled
  from esperado e left join pg_trigger t on t.tgname=e.gatilho and not t.tgisinternal and t.tgrelid = to_regclass(e.tabela)
), falhas as (
  select mig, gatilho||' em '||tabela as item,
         case when oid is null then 'TRIGGER AUSENTE' else 'trigger DESABILITADO (tgenabled='||tgenabled::text||')' end as problema
  from real where oid is null or tgenabled <> 'O'
  union all
  select '012', 'attendance_refresh_alert', 'definição antiga (006): deveria ser UPDATE OF event_id, youth_id, present'
  where not exists (select 1 from pg_trigger t where t.tgname='attendance_refresh_alert' and t.tgrelid = to_regclass('public.attendance')
                      and pg_get_triggerdef(t.oid) ~* 'UPDATE OF .*present')
  union all
  select '???', t.tgname||' em '||t.tgrelid::regclass, 'trigger EXTRA (não está em nenhuma migration)'
  from pg_trigger t join pg_class c on c.oid=t.tgrelid
  where not t.tgisinternal and c.relnamespace='public'::regnamespace
    and not exists (select 1 from esperado e where e.gatilho=t.tgname)
    and t.tgname not in ('events_block_delete_with_attendance')  -- da 020: conferido na Q10
)
select * from falhas
union all select '---', 'Q6 verificados: '||((select count(*) from esperado)+1), 'falhas: '||(select count(*) from falhas)
order by 1, 2;

-- Q7  Policies: nome, tabela e comando; faltantes E excedentes
--     Esperado: "Q7 verificados: 56 | falhas: 0". POLICY AUSENTE, "definição ANTIGA" (002/004/005/012 não regravaram a
--     policy de mesmo nome) ou policy EXTRA (sobra antiga ou criada à mão). A 004 é toda substituída pela 005.
with esperado(mig, tabela, policy, cmd) as (values
  ('014', 'activity_log', 'coordinator_select_activity_log', 'SELECT'), ('014', 'activity_log', 'leader_select_activity_log', 'SELECT'),
  ('006', 'alerts', 'coordinator_delete_alerts', 'DELETE'), ('006', 'alerts', 'coordinator_select_alerts', 'SELECT'),
  ('006', 'alerts', 'coordinator_update_alerts', 'UPDATE'), ('006', 'alerts', 'leader_select_alerts', 'SELECT'),
  ('006', 'alerts', 'leader_update_alerts', 'UPDATE'), ('006', 'app_settings', 'authenticated_select_settings', 'SELECT'),
  ('006', 'app_settings', 'coordinator_update_settings', 'UPDATE'), ('003', 'attendance', 'coordinator_all_attendance', 'ALL'),
  ('005', 'attendance', 'leader_insert_attendance', 'INSERT'), ('012', 'attendance', 'leader_select_attendance', 'SELECT'),
  ('005', 'attendance', 'leader_update_attendance', 'UPDATE'), ('015', 'communications', 'coordinator_delete_communications', 'DELETE'),
  ('015', 'communications', 'coordinator_insert_communications', 'INSERT'), ('015', 'communications', 'coordinator_select_communications', 'SELECT'),
  ('015', 'communications', 'coordinator_update_communications', 'UPDATE'), ('015', 'communications', 'leader_insert_communications', 'INSERT'),
  ('015', 'communications', 'leader_select_communications', 'SELECT'), ('015', 'communications', 'leader_update_communications', 'UPDATE'),
  ('003', 'event_groups', 'coordinator_all_event_groups', 'ALL'), ('003', 'event_groups', 'leader_select_event_groups', 'SELECT'),
  ('014', 'event_series_groups', 'coordinator_all_event_series_groups', 'ALL'),
  ('014', 'event_series_groups', 'leader_select_event_series_groups', 'SELECT'), ('014', 'event_series', 'coordinator_all_event_series', 'ALL'),
  ('014', 'event_series', 'leader_select_event_series', 'SELECT'), ('003', 'events', 'coordinator_all_events', 'ALL'),
  ('003', 'events', 'leader_select_events', 'SELECT'), ('011', 'follow_up_transfers', 'coordinator_select_follow_up_transfers', 'SELECT'),
  ('011', 'follow_up_transfers', 'leader_select_follow_up_transfers', 'SELECT'), ('011', 'follow_ups', 'coordinator_all_follow_ups', 'ALL'),
  ('011', 'follow_ups', 'leader_insert_follow_ups', 'INSERT'), ('011', 'follow_ups', 'leader_select_follow_ups', 'SELECT'),
  ('011', 'follow_ups', 'leader_update_follow_ups', 'UPDATE'), ('001', 'groups', 'coordinator_all_groups', 'ALL'),
  ('001', 'groups', 'coordinator_select_groups', 'SELECT'), ('001', 'groups', 'leader_select_own_group', 'SELECT'),
  ('001', 'groups', 'leader_update_own_group', 'UPDATE'), ('001', 'profiles', 'Users can update own profile', 'UPDATE'),
  ('001', 'profiles', 'Users can view own profile', 'SELECT'), ('002', 'profiles', 'coordinator_select_all_profiles', 'SELECT'),
  ('006', 'tasks', 'coordinator_all_tasks', 'ALL'), ('006', 'tasks', 'leader_delete_tasks', 'DELETE'),
  ('006', 'tasks', 'leader_insert_tasks', 'INSERT'), ('006', 'tasks', 'leader_select_tasks', 'SELECT'),
  ('006', 'tasks', 'leader_update_tasks', 'UPDATE'), ('001', 'user_roles', 'Users can view own role', 'SELECT'),
  ('002', 'user_roles', 'coordinator_select_all_user_roles', 'SELECT'), ('001', 'youth', 'coordinator_all_youth', 'ALL'),
  ('001', 'youth', 'leader_select_youth', 'SELECT'), ('002', 'youth', 'leader_update_youth', 'UPDATE')
), d_esp(mig, tabela, policy, onde, marcador) as (values
  ('002', 'youth', 'leader_update_youth', 'check', 'IS NULL'), ('004', 'attendance', 'leader_insert_attendance', 'check', 'event_groups'),
  ('005', 'attendance', 'leader_insert_attendance', 'check', 'recorded_by'),
  ('005', 'attendance', 'leader_update_attendance', 'check', 'recorded_by'), ('012', 'attendance', 'leader_select_attendance', 'using', 'youth')
), falhas as (
  select d.mig, d.tabela||': '||d.policy as item, 'definição ANTIGA: '||d.onde||' sem "'||d.marcador||'"' as problema
  from d_esp d join pg_policies p on p.schemaname='public' and p.tablename=d.tabela and p.policyname=d.policy
  where position(d.marcador in coalesce(case d.onde when 'check' then p.with_check else p.qual end, '')) = 0
  union all
  select e.mig, e.tabela||': '||e.policy as item,
         case when p.policyname is null then 'POLICY AUSENTE' else 'comando: esperado '||e.cmd||', real '||p.cmd end as problema
  from esperado e left join pg_policies p on p.schemaname='public' and p.tablename=e.tabela and p.policyname=e.policy
  where p.policyname is null or p.cmd <> e.cmd
  union all
  select '???', p.tablename||': '||p.policyname, 'policy EXTRA ('||p.cmd||'): não existe no estado final das migrations'
  from pg_policies p where p.schemaname='public'
    and not exists (select 1 from esperado e where e.tabela=p.tablename and e.policy=p.policyname)
)
select * from falhas
union all select '---', 'Q7 verificados: '||((select count(*) from esperado)+(select count(*) from d_esp)), 'falhas: '||(select count(*) from falhas)
order by 1, 2;

-- Q8  Grants: EXECUTE de cada função para anon/authenticated; begin/finish só service_role;
--     anon sem privilégio em tabelas e authenticated sem TRUNCATE/REFERENCES/TRIGGER
--     Esperado: "Q8 verificados: 84 | falhas: 0". Função-trigger com EXECUTE para clientes = 017 ausente;
--     anon com privilégio em tabela = 016 ausente; begin/finish executáveis por authenticated = GRAVE (018).
--     Ressalva: divergência SÓ em anon_exec (authenticated correto) pode ser diferença de privilégio default do
--     ambiente, não migration parcial: traga para análise.
with esperado(mig, nome, args, anon_exec, auth_exec) as (values
  ('017', 'activity_log_immutable', '', false, false), ('014', 'activity_write', 'text, text, uuid, uuid, uuid, text, jsonb', false, false),
  ('017', 'alerts_guard', '', false, false), ('017', 'alerts_log_activity', '', false, false),
  ('017', 'alerts_refresh_time_alerts', '', false, false), ('011', 'app_today', '', false, true),
  ('011', 'assignable_responsibles', 'uuid', false, true), ('017', 'attendance_log_activity', '', false, false),
  ('017', 'attendance_refresh_alert', '', false, false), ('014', 'batch_set_youth_active', 'uuid[], boolean', false, true),
  ('014', 'batch_set_youth_group', 'uuid[], uuid', false, true), ('019', 'begin_communication_send', 'uuid, uuid', false, false),
  ('014', 'cancel_event_series_future', 'uuid', false, true), ('018', 'communications_guard', '', false, false),
  ('019', 'communications_leader_recipient', '', false, false), ('018', 'communications_log_activity', '', false, false),
  ('014', 'create_event_series', 'text, integer, time, text, date, date, text, uuid[]', false, true), ('012', 'dashboard_overview', '', false, true),
  ('017', 'event_groups_series_customize', '', false, false), ('017', 'events_refresh_alerts', '', false, false),
  ('017', 'events_series_guard', '', false, false), ('014', 'extend_event_series', 'uuid, date', false, true),
  ('018', 'finish_communication_send', 'uuid, boolean, text, text, text', false, false), ('011', 'follow_up_people', 'uuid', false, true),
  ('017', 'follow_up_transfers_immutable', '', false, false), ('017', 'follow_up_transfers_log_activity', '', false, false),
  ('017', 'follow_ups_complete_task', '', false, false), ('017', 'follow_ups_guard', '', false, false),
  ('017', 'follow_ups_log_activity', '', false, false), ('017', 'follow_ups_protect_history', '', false, false),
  ('017', 'follow_ups_refresh_time_alerts', '', false, false), ('002', 'get_my_role', '', true, true),
  ('014', 'global_search', 'text, integer', false, true), ('012', 'group_indicators', 'uuid[]', false, true),
  ('017', 'groups_block_delete_with_history', '', false, false), ('017', 'handle_new_user', '', false, false),
  ('015', 'is_single_line_text', 'text', false, true), ('011', 'is_task_overdue', 'task_status, date', false, true),
  ('016', 'is_valid_email', 'text', false, true), ('018', 'mark_communication', 'uuid, text, text', false, true),
  ('006', 'recalculate_all_alerts', '', false, true), ('011', 'recalculate_all_alerts_internal', '', false, false),
  ('011', 'refresh_time_alerts', '', false, false), ('010', 'refresh_youth_alert', 'uuid', false, false),
  ('017', 'refresh_youth_time_alerts', 'uuid', false, false), ('013', 'report_alerts', 'date, date, uuid', false, true),
  ('012', 'report_att_rows', 'date, date, uuid', false, false), ('016', 'report_attendance', 'date, date, uuid, integer', false, true),
  ('013', 'report_check', 'date, date, uuid', false, false), ('013', 'report_followups', 'date, date, uuid', false, true),
  ('013', 'report_general', 'date, date, uuid', false, true), ('013', 'report_groups', 'date, date', false, true),
  ('013', 'report_pct', 'bigint, bigint', false, false), ('012', 'report_pending_followups', 'uuid', false, false),
  ('013', 'report_period', 'date, date, uuid', false, false), ('012', 'report_scope_events', 'timestamptz, timestamptz, uuid', false, false),
  ('012', 'report_scope_tasks', 'uuid', false, false), ('012', 'report_scope_youth', 'uuid', false, false),
  ('016', 'report_youth', 'uuid, date, date', false, true), ('012', 'save_attendance', 'uuid, jsonb', false, true),
  ('009', 'save_event', 'uuid, text, text, timestamp with time zone, event_status, uuid[]', false, true), ('014', 'search_norm', 'text', false, true),
  ('014', 'series_dates', 'integer, text, date, date', false, false), ('014', 'set_series_groups', 'uuid, uuid[], date', false, true),
  ('017', 'set_updated_at', '', false, false), ('008', 'set_user_role', 'uuid, user_role', false, true),
  ('017', 'settings_refresh_alerts', '', false, false), ('017', 'settings_stamp_user', '', false, false),
  ('015', 'suggest_communication_recipients', 'uuid', false, true),
  ('010', 'sync_rate_alert', 'uuid, uuid, alert_type, boolean, integer, integer, integer, uuid, text', false, false),
  ('016', 'sync_time_alerts', '', false, true), ('017', 'tasks_followup_guard', '', false, false), ('017', 'tasks_guard', '', false, false),
  ('017', 'tasks_log_activity', '', false, false), ('017', 'tasks_refresh_time_alerts', '', false, false),
  ('017', 'tasks_resolve_alert', '', false, false), ('011', 'transfer_follow_up', 'uuid, uuid, text', false, true),
  ('006', 'youth_consecutive_absences', 'uuid', false, false), ('017', 'youth_log_activity', '', false, false),
  ('017', 'youth_refresh_alert', '', false, false), ('017', 'youth_refresh_time_alerts', '', false, false),
  ('011', 'youth_situation', 'uuid', false, true), ('011', 'youth_situations', 'uuid[]', false, true),
  ('017', 'youth_sync_attendance_group', '', false, false)
), real as (
  select e.*, to_regprocedure('public.'||e.nome||'('||e.args||')') as oid from esperado e
), falhas as (
  select mig, nome||'('||args||')' as item,
         'EXECUTE anon: esperado '||anon_exec||', real '||has_function_privilege('anon', oid, 'execute')||
         ' | authenticated: esperado '||auth_exec||', real '||has_function_privilege('authenticated', oid, 'execute') as problema
  from real where oid is not null
    and (has_function_privilege('anon', oid, 'execute') <> anon_exec or has_function_privilege('authenticated', oid, 'execute') <> auth_exec)
  union all
  select '018', f, 'service_role SEM EXECUTE (a Edge Function não conseguiria enviar)'
  from (values ('public.begin_communication_send(uuid, uuid)'), ('public.finish_communication_send(uuid, boolean, text, text, text)')) v(f)
  where to_regprocedure(f) is not null and not has_function_privilege('service_role', to_regprocedure(f), 'execute')
  union all
  select '016', 'tabela '||table_name, 'anon ainda tem '||string_agg(privilege_type, ',')
  from information_schema.role_table_grants where table_schema='public' and grantee='anon' group by table_name
  union all
  select '016', 'tabela '||table_name, 'authenticated ainda tem '||string_agg(privilege_type, ',')
  from information_schema.role_table_grants
  where table_schema='public' and grantee='authenticated' and privilege_type in ('TRUNCATE','REFERENCES','TRIGGER') group by table_name
  union all
  select case table_name when 'communication_send_log' then '018' else '016' end, 'tabela '||table_name,
         'authenticated tem '||string_agg(privilege_type, ',')||' (deveria ser nenhum)'
  from information_schema.role_table_grants
  where table_schema='public' and grantee='authenticated' and table_name in ('communication_send_log','time_alerts_sync_state') group by table_name
)
select * from falhas
union all select '---', 'Q8 verificados: '||(select count(*) from esperado), 'falhas: '||(select count(*) from falhas)
order by 1, 2;

-- Q9  Constraints (nome + definição), índices (nome, tabela, unicidade) e dados de controle
--     Esperado: "Q9 verificados: 51 | falhas: 0" (inclui o índice ÚNICO events_series_slot_uidx da 014).
--     CONSTRAINT/ÍNDICE AUSENTE ou "definição inesperada" = parcial. FK de communication_send_log com CASCADE = 019
--     ausente. Se groups_leader_id_fkey aparecer só por "public.profiles(id)" em vez de "profiles(id)", é formatação.
with c_esp(mig, tabela, nome, deve_conter) as (values
  ('007', 'groups', 'groups_leader_id_fkey', 'REFERENCES profiles(id)'), ('015', 'activity_log', 'activity_log_action_check', 'communication_sent'),
  ('015', 'activity_log', 'activity_log_entity_type_check', 'communication'),
  ('015', 'communications', 'communications_failure_reason_consistent', 'failed'),
  ('015', 'communications', 'communications_sent_at_consistent', 'sent'),
  ('018', 'communications', 'communications_provider_message_id_sent', 'provider_message_id'),
  ('018', 'communications', 'communications_failure_reason_check', 'provider_not_configured'),
  ('019', 'communication_send_log', 'communication_send_log_communication_id_fkey', 'ON DELETE SET NULL')
), c_real as (
  select e.*, (select pg_get_constraintdef(k.oid) from pg_constraint k
                where k.conname=e.nome and k.conrelid = to_regclass('public.'||e.tabela)) as def
  from c_esp e
), i_esp(mig, indice, tabela, unico) as (values
  ('014', 'activity_log_group_idx', 'activity_log', false), ('014', 'activity_log_occurred_idx', 'activity_log', false),
  ('014', 'activity_log_tx_idx', 'activity_log', false), ('014', 'activity_log_youth_idx', 'activity_log', false),
  ('013', 'alerts_created_idx', 'alerts', false), ('006', 'alerts_one_open_per_youth', 'alerts', true),
  ('013', 'alerts_resolved_idx', 'alerts', false), ('006', 'alerts_status_idx', 'alerts', false), ('010', 'alerts_youth_status_idx', 'alerts', false),
  ('006', 'attendance_event_idx', 'attendance', false), ('012', 'attendance_group_idx', 'attendance', false),
  ('006', 'attendance_youth_idx', 'attendance', false), ('018', 'communication_send_log_user_idx', 'communication_send_log', false),
  ('015', 'communications_alert_idx', 'communications', false), ('015', 'communications_follow_up_idx', 'communications', false),
  ('015', 'communications_status_idx', 'communications', false), ('015', 'communications_youth_idx', 'communications', false),
  ('012', 'event_groups_group_idx', 'event_groups', false), ('014', 'event_series_groups_group_idx', 'event_series_groups', false),
  ('006', 'events_date_idx', 'events', false), ('014', 'events_series_idx', 'events', false), ('014', 'events_series_slot_uidx', 'events', true),
  ('014', 'events_title_search_idx', 'events', false), ('013', 'follow_up_transfers_at_idx', 'follow_up_transfers', false),
  ('011', 'follow_up_transfers_followup_idx', 'follow_up_transfers', false), ('011', 'follow_ups_alert_idx', 'follow_ups', false),
  ('013', 'follow_ups_next_due_idx', 'follow_ups', false), ('013', 'follow_ups_occurred_idx', 'follow_ups', false),
  ('011', 'follow_ups_responsible_idx', 'follow_ups', false), ('011', 'follow_ups_task_idx', 'follow_ups', false),
  ('011', 'follow_ups_youth_idx', 'follow_ups', false), ('014', 'groups_name_search_idx', 'groups', false),
  ('006', 'tasks_alert_idx', 'tasks', false), ('006', 'tasks_assigned_idx', 'tasks', false),
  ('011', 'tasks_completed_by_followup_idx', 'tasks', false), ('013', 'tasks_completed_idx', 'tasks', false),
  ('013', 'tasks_created_idx', 'tasks', false), ('011', 'tasks_due_open_idx', 'tasks', false), ('006', 'tasks_status_idx', 'tasks', false),
  ('011', 'tasks_youth_idx', 'tasks', false), ('006', 'youth_group_idx', 'youth', false), ('014', 'youth_name_search_idx', 'youth', false)
), i_real as (
  select e.*, i.indexrelid, i.indisunique, i.indisvalid
  from i_esp e left join pg_class c on c.relname=e.indice and c.relnamespace='public'::regnamespace and c.relkind='i'
  left join pg_index i on i.indexrelid=c.oid and i.indrelid = to_regclass('public.'||e.tabela)
), falhas as (
  select mig, tabela||'.'||nome as item,
         case when def is null then 'CONSTRAINT AUSENTE' else 'definição inesperada: '||left(def, 160) end as problema
  from c_real where def is null or position(deve_conter in def) = 0
  union all
  select '018', 'communications.failure_reason', 'CHECK antigo da 015 ainda existe: '||k.conname
  from pg_constraint k where k.conrelid = to_regclass('public.communications') and k.contype='c'
    and k.conname <> 'communications_failure_reason_check' and array_length(k.conkey,1)=1
    and (select a.attname from pg_attribute a where a.attrelid=k.conrelid and a.attnum=k.conkey[1])='failure_reason'
  union all
  select mig, indice||' em '||tabela,
         case when indexrelid is null then 'ÍNDICE AUSENTE'
              when not indisvalid then 'índice INVÁLIDO'
              else 'unicidade: esperado '||unico||', real '||indisunique end
  from i_real where indexrelid is null or not indisvalid or indisunique <> unico
)
select * from falhas
union all select '---', 'Q9 verificados: '||((select count(*) from c_esp)+(select count(*) from i_esp)+1), 'falhas: '||(select count(*) from falhas)
order by 1, 2;


-- =====================================================================================================================
-- SEÇÃO B — 020, 021 e 024: rodar SÓ DEPOIS de aplicá-las (antes disso a Q10 acusa as três, o que é esperado)
-- =====================================================================================================================

-- Q10 020 (série idempotente + guarda de exclusão), 021 (anonymize_youth) e 024 (set_user_role com recheck)
--     Esperado: "Q10 verificados: 11 | falhas: 0".
--     FUNÇÃO/ASSINATURA AUSENTE = a migration não criou a função; "corpo ANTIGO" = a função existe mas não foi
--     regravada (ex.: set_user_role sem "Refaz a checagem" = 024 não aplicada); "sem pg_temp" = função recriada sem o
--     endurecimento; EXECUTE inesperado = grant/revoke parcial; TRIGGER AUSENTE = 020 parcial.
with f_esp(mig, nome, args, auth_exec) as (values
  ('020', 'create_event_series', 'text, integer, time, text, date, date, text, uuid[]', true),
  ('020', 'events_block_delete_with_attendance', '', false),
  ('021', 'anonymize_youth', 'uuid', true),
  ('024', 'set_user_role', 'uuid, user_role', true)
), m_esp(mig, nome, marcador) as (values
  ('020', 'create_event_series', 'Já existe uma série ativa'),
  ('020', 'create_event_series', 'hashtextextended'),
  ('020', 'events_block_delete_with_attendance', 'já tem chamada registrada'),
  ('021', 'anonymize_youth', 'Jovem anonimizado'),
  ('021', 'anonymize_youth', 'PERFORM 1 FROM public.communications WHERE youth_id = p_youth_id FOR UPDATE'),
  ('024', 'set_user_role', 'Refaz a checagem')
), det as (
  select e.*, p.oid, p.prosecdef, array_to_string(p.proconfig, ' ') as cfg
  from f_esp e left join pg_proc p on p.oid = to_regprocedure('public.'||e.nome||'('||e.args||')')
), falhas as (
  select mig, nome||'('||args||')' as item, 'FUNÇÃO/ASSINATURA AUSENTE' as problema from det where oid is null
  union all
  select mig, nome||'('||args||')', 'deveria ser SECURITY DEFINER' from det where oid is not null and not prosecdef
  union all
  select mig, nome||'('||args||')', 'DEFINER sem pg_temp no search_path ('||coalesce(cfg, 'sem search_path')||')'
  from det where oid is not null and prosecdef and coalesce(cfg, '') !~ 'search_path=.*pg_temp'
  union all
  select mig, nome||'('||args||')',
         'EXECUTE anon='||has_function_privilege('anon', oid, 'execute')||', authenticated='||
         has_function_privilege('authenticated', oid, 'execute')||' (esperado anon=false, authenticated='||auth_exec||')'
  from det where oid is not null
    and (has_function_privilege('anon', oid, 'execute') or has_function_privilege('authenticated', oid, 'execute') <> auth_exec)
  union all
  select m.mig, m.nome, 'corpo ANTIGO: falta o marcador "'||m.marcador||'"' from m_esp m
  where not exists (select 1 from pg_proc p where p.proname = m.nome and p.pronamespace = 'public'::regnamespace
                     and position(m.marcador in p.prosrc) > 0)
  union all
  select '020', 'events_block_delete_with_attendance em public.events', 'TRIGGER AUSENTE, DESABILITADO ou não é BEFORE DELETE'
  where not exists (select 1 from pg_trigger t where t.tgname = 'events_block_delete_with_attendance' and not t.tgisinternal
                      and t.tgrelid = to_regclass('public.events') and t.tgenabled = 'O'
                      and pg_get_triggerdef(t.oid) ~* 'BEFORE DELETE')
)
select * from falhas
union all select '---', 'Q10 verificados: '||((select count(*) from f_esp)+(select count(*) from m_esp)+1), 'falhas: '||(select count(*) from falhas)
order by 1, 2;


-- =====================================================================================================================
-- SEÇÃO C — 023 (pg_cron, OPCIONAL): só depois de habilitar pg_cron no painel e aplicar a 023
-- =====================================================================================================================

-- Q11 Função da 023
--     Esperado: "Q11 verificados: 1 | falhas: 0". FUNÇÃO AUSENTE = 023 não aplicada; EXECUTE para algum papel de
--     cliente (ou service_role) = grant indevido.
with det as (
  select p.oid, p.prosecdef, array_to_string(p.proconfig, ' ') as cfg
  from (select to_regprocedure('public.cron_refresh_time_alerts()') as f) x left join pg_proc p on p.oid = x.f
), falhas as (
  select '023' as mig, 'cron_refresh_time_alerts()' as item, 'FUNÇÃO AUSENTE' as problema from det where oid is null
  union all
  select '023', 'cron_refresh_time_alerts()', 'deveria ser SECURITY DEFINER com pg_temp ('||coalesce(cfg, 'sem search_path')||')'
  from det where oid is not null and (not prosecdef or coalesce(cfg, '') !~ 'search_path=.*pg_temp')
  union all
  select '023', 'cron_refresh_time_alerts()', 'EXECUTE indevido para '||r
  from det, unnest(array['anon', 'authenticated', 'service_role']) r
  where det.oid is not null and has_function_privilege(r, det.oid, 'execute')
)
select * from falhas
union all select '---', 'Q11 verificados: 1', 'falhas: '||(select count(*) from falhas)
order by 1, 2;

-- Q12 Agendamentos da 023 (formato diferente: LISTA os jobs)
--     Esperado: exatamente 2 linhas, ambas active = true:
--       conecta-jovem-cron-cleanup | 30 9 * * * | DELETE FROM cron.job_run_details WHERE end_time < now() - interval '7 days'
--       conecta-jovem-time-alerts  | 0 9 * * *  | SELECT public.cron_refresh_time_alerts()
--     Erro "relation cron.job does not exist" = pg_cron não está habilitada. 0 linhas = a 023 rodou antes de habilitar
--     a extensão (o agendamento foi pulado): habilite e rode de novo só o bloco "2) AGENDAMENTO" da 023.
--     Horários em UTC: 9h UTC = 6h em Brasília.
select jobname, schedule, command, active
  from cron.job
 where jobname like 'conecta-jovem-%'
 order by jobname;
