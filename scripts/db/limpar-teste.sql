-- ============================================================================
-- limpar-teste.sql — apaga SOMENTE o que scripts/db/seed-teste.sql criou
-- ============================================================================
-- O QUE FAZ:
--   Remove os dados fictícios do seed, identificados pelo prefixo fixo 5eed5eed- nos UUIDs (grupos, jovens, encontros,
--   séries, acompanhamentos, transferências, tarefas, e-mails e Histórico), e tudo o que ficou preso a esses jovens,
--   grupos e encontros, inclusive o que foi criado pelo app durante os testes em cima deles: alertas (gerados pelo banco),
--   chamada, tarefas, acompanhamentos, e-mails e linhas do Histórico daqueles jovens/grupos.
--
-- COMO RODAR:
--   Painel do Supabase > SQL Editor > cole este arquivo inteiro e clique em Run (roda como `postgres`).
--   O resultado final é uma tabela de conferência; todas as quantidades devem ser 0.
--   Rodar de novo é seguro (não há mais nada para apagar). Se der erro, nada é apagado (transação inteira); se o editor
--   reclamar de "current transaction is aborted", rode ROLLBACK; e corrija o que a mensagem indicar.
--   Validado num PGlite com todas as migrations (veja a seção VALIDAÇÃO do seed-teste.sql).
--
-- O QUE NÃO TOCA: profiles, user_roles, app_settings e auth.users (inclusive o usuário líder de teste, se você criou
--   um: apague-o à mão em Authentication > Users). Também não toca em communication_send_log (estado do limite de
--   envios; o próprio banco apaga linhas com mais de 2 dias) nem em nada que não seja do seed.
--
-- QUANDO USAR: antes de o sistema entrar em uso real. O seed NÃO deve ficar no banco de produção.
--
-- SE FALHAR com "Não é possível excluir um grupo com jovens ou histórico de chamada": alguém moveu um jovem REAL para um
--   grupo "[TESTE] ..." (trigger groups_block_delete_with_history). Mova esse jovem para outro grupo e rode de novo.
--   A transação inteira é desfeita quando algo falha, então nada fica pela metade.
--
-- ORDEM (filhas antes das mães; respeita os triggers de proteção):
--   e-mails > Histórico > transferências > acompanhamentos > tarefas > chamada > alertas > jovens > encontros > séries
--   > grupos. A chamada sai antes dos alertas e dos encontros porque os triggers recriam/resolvem alertas a cada linha
--   removida e porque encontro com chamada não pode ser excluído (trigger events_block_delete_with_attendance).
-- ============================================================================

BEGIN;

-- 1. E-mails (do seed ou ligados a jovens do seed, inclusive rascunhos feitos pelo app)
DELETE FROM public.communications
 WHERE id::text LIKE '5eed5eed-%'
    OR youth_id::text LIKE '5eed5eed-%';

-- 2. Histórico (o trigger de imutabilidade só barra anon/authenticated; o dono do banco pode apagar)
DELETE FROM public.activity_log
 WHERE id::text LIKE '5eed5eed-%'
    OR youth_id::text LIKE '5eed5eed-%'
    OR group_id::text LIKE '5eed5eed-%'
    OR entity_id::text LIKE '5eed5eed-%';

-- 3. Histórico de transferências (precisa sair antes dos acompanhamentos: follow_ups_protect_history)
DELETE FROM public.follow_up_transfers
 WHERE id::text LIKE '5eed5eed-%'
    OR follow_up_id IN (SELECT f.id FROM public.follow_ups f
                         WHERE f.id::text LIKE '5eed5eed-%' OR f.youth_id::text LIKE '5eed5eed-%');

-- 4. Acompanhamentos
DELETE FROM public.follow_ups
 WHERE id::text LIKE '5eed5eed-%'
    OR youth_id::text LIKE '5eed5eed-%';

-- 5. Tarefas
DELETE FROM public.tasks
 WHERE id::text LIKE '5eed5eed-%'
    OR youth_id::text LIKE '5eed5eed-%'
    OR group_id::text LIKE '5eed5eed-%';

-- 6. Chamada (dos encontros do seed, da série do seed, dos jovens do seed ou dos grupos do seed)
DELETE FROM public.attendance
 WHERE event_id IN (SELECT e.id FROM public.events e
                     WHERE e.id::text LIKE '5eed5eed-%' OR e.series_id::text LIKE '5eed5eed-%')
    OR youth_id::text LIKE '5eed5eed-%'
    OR group_id::text LIKE '5eed5eed-%';

-- 7. Alertas dos jovens do seed (os que sobraram depois que os triggers reagiram à remoção da chamada)
DELETE FROM public.alerts
 WHERE youth_id::text LIKE '5eed5eed-%';

-- 8. Jovens (o que ainda estiver preso a eles sai em cascata)
DELETE FROM public.youth
 WHERE id::text LIKE '5eed5eed-%';

-- 9. Encontros (event_groups sai em cascata). Inclui encontros gerados a partir da série do seed pelo app.
DELETE FROM public.events
 WHERE id::text LIKE '5eed5eed-%'
    OR series_id::text LIKE '5eed5eed-%';

-- 10. Séries (event_series_groups sai em cascata)
DELETE FROM public.event_series
 WHERE id::text LIKE '5eed5eed-%';

-- 11. Grupos
DELETE FROM public.groups
 WHERE id::text LIKE '5eed5eed-%';

COMMIT;

-- ============================================================================
-- CONFERÊNCIA — tudo deve estar em 0 (o editor do Supabase mostra só o resultado do último comando)
-- ============================================================================
SELECT t.tabela, t.quantidade
FROM (
  SELECT  1 AS o, 'groups'              AS tabela, count(*) AS quantidade FROM public.groups              WHERE id::text LIKE '5eed5eed-%'
  UNION ALL SELECT  2, 'youth',                count(*) FROM public.youth               WHERE id::text LIKE '5eed5eed-%'
  UNION ALL SELECT  3, 'event_series',         count(*) FROM public.event_series        WHERE id::text LIKE '5eed5eed-%'
  UNION ALL SELECT  4, 'event_series_groups',  count(*) FROM public.event_series_groups WHERE series_id::text LIKE '5eed5eed-%'
  UNION ALL SELECT  5, 'events',               count(*) FROM public.events              WHERE id::text LIKE '5eed5eed-%' OR series_id::text LIKE '5eed5eed-%'
  UNION ALL SELECT  6, 'event_groups',         count(*) FROM public.event_groups        WHERE event_id::text LIKE '5eed5eed-%' OR group_id::text LIKE '5eed5eed-%'
  UNION ALL SELECT  7, 'attendance',           count(*) FROM public.attendance          WHERE event_id::text LIKE '5eed5eed-%' OR youth_id::text LIKE '5eed5eed-%' OR group_id::text LIKE '5eed5eed-%'
  UNION ALL SELECT  8, 'alerts',               count(*) FROM public.alerts              WHERE youth_id::text LIKE '5eed5eed-%'
  UNION ALL SELECT  9, 'follow_ups',           count(*) FROM public.follow_ups          WHERE id::text LIKE '5eed5eed-%' OR youth_id::text LIKE '5eed5eed-%'
  UNION ALL SELECT 10, 'follow_up_transfers',  count(*) FROM public.follow_up_transfers WHERE id::text LIKE '5eed5eed-%'
  UNION ALL SELECT 11, 'tasks',                count(*) FROM public.tasks               WHERE id::text LIKE '5eed5eed-%' OR youth_id::text LIKE '5eed5eed-%' OR group_id::text LIKE '5eed5eed-%'
  UNION ALL SELECT 12, 'communications',       count(*) FROM public.communications      WHERE id::text LIKE '5eed5eed-%' OR youth_id::text LIKE '5eed5eed-%'
  UNION ALL SELECT 13, 'activity_log',         count(*) FROM public.activity_log        WHERE id::text LIKE '5eed5eed-%' OR youth_id::text LIKE '5eed5eed-%' OR group_id::text LIKE '5eed5eed-%'
) t
ORDER BY t.o;
