-- ============================================================================
-- seed-teste.sql — dados FICTÍCIOS para validar todas as telas do ConectJovem
-- ============================================================================
-- O QUE CRIA (tudo marcado como teste):
--   4 grupos "[TESTE] ...", 28 jovens (4 inativos, 2 sem grupo), 1 série semanal e 12 encontros (8 realizados,
--   1 cancelado, 3 agendados), ~176 registros de chamada, acompanhamentos (6 tipos, 3 transferências), 11 tarefas
--   (4 status, 3 prioridades, 3 vencidas), 3 e-mails (rascunho, enviado, falhou) e 9 linhas no Histórico.
--   Os ALERTAS não são inseridos à mão: nascem dos triggers do banco quando a chamada é gravada (faltas
--   consecutivas, frequência baixa, queda de frequência, sem acompanhamento, ação atrasada). Por leitura das
--   migrations, o esperado é ~28 alertas: 23 abertos, 3 resolvidos e 2 dispensados, 2 deles críticos.
--
-- COMO RODAR:
--   1. Painel do Supabase > SQL Editor > cole este arquivo inteiro e clique em Run (o editor roda como `postgres`).
--   2. Confira o resultado da tabela "tabela | quantidade" que aparece no final.
--   3. Pode rodar de novo: é idempotente (UUIDs fixos com prefixo 5eed5eed- e ON CONFLICT DO NOTHING).
--
-- QUEM É O "RESPONSÁVEL" DOS DADOS:
--   * O coordenador é descoberto sozinho em user_roles (role = 'coordinator', o mais antigo). Se não houver nenhum,
--     o script para com uma mensagem clara e não grava nada.
--   * LÍDER (opcional): o script NÃO cria usuários em auth.users. Sem líder, os grupos Alfa e Beta ficam sob o próprio
--     coordenador, o grupo Gama também, e o Delta fica SEM líder; nesse caso não há transferências de acompanhamento
--     (precisariam de duas pessoas diferentes). Para testar a visão do líder:
--       a) Authentication > Users > Add user > Create new user (e-mail + senha, marque "Auto Confirm User");
--          o papel nasce como 'leader' (trigger handle_new_user).
--       b) Copie o UUID desse usuário (coluna "User UID") e cole em v_leader logo abaixo, entre aspas simples.
--       c) Se o seed já tinha rodado sem líder, rode scripts/db/limpar-teste.sql e depois este arquivo de novo:
--          rodar só este arquivo não troca o líder de grupos que já existem (ON CONFLICT DO NOTHING).
--
-- SEGURANÇA DOS DADOS:
--   * Nomes inventados, telefones com DDD 00 (não existem) e e-mails SEMPRE @example.com (domínio reservado, RFC 2606):
--     nenhum envio (Resend) chega a uma pessoa real. Nada aqui é dado pessoal real.
--   * Não mexe em profiles, user_roles, app_settings nem auth.users. Não usa session_replication_role.
--   * Todo o script está em uma transação: se qualquer comando falhar, nada é gravado.
--
-- ATENÇÃO: este seed é só para o ambiente de TESTE/VALIDAÇÃO. NÃO deve ficar no banco quando o sistema entrar em
-- uso real. Antes disso, rode scripts/db/limpar-teste.sql (apaga somente o que este script criou).
--
-- NOTAS TÉCNICAS (por que cada coisa é feita assim):
--   * Os triggers de alerta e de histórico rodam normalmente. Como o SQL Editor não tem sessão de usuário
--     (auth.uid() nulo), activity_write() não grava nada sozinha: por isso o Histórico recebe INSERTs diretos ao
--     final (permitido: a tabela só é imutável para anon/authenticated, e não há trigger de INSERT).
--   * A chamada é gravada evento por evento, do mais antigo ao mais novo, para o histórico de alertas ficar natural
--     (um alerta de faltas abre e depois é resolvido sozinho quando o jovem volta).
--   * communication_send_log (limite de envios) NÃO é preenchida: o schema não a exige para comunicações, linhas com
--     mais de 2 dias são apagadas pelo próprio banco e linhas novas consumiriam o limite de envios do coordenador.
--   * Os limites usados nos cálculos são os padrões do app_settings (3 faltas, crítico em 6, frequência baixa 70%,
--     7 dias sem acompanhamento). Se foram alterados em Configurações, o número de alertas muda.
-- ============================================================================

BEGIN;

-- UUID determinístico e reconhecível: 5eed5eed-<tabela:4>-4000-8000-<n:12>
--   tabela: 1 grupos | 2 jovens | 3 encontros | 4 séries | 5 acompanhamentos | 6 transferências | 7 tarefas
--           8 comunicações | 9 histórico
CREATE OR REPLACE FUNCTION pg_temp.sid(t integer, n integer)
RETURNS uuid
LANGUAGE sql
IMMUTABLE
AS $f$ SELECT ('5eed5eed-' || lpad(t::text, 4, '0') || '-4000-8000-' || lpad(n::text, 12, '0'))::uuid $f$;

DO $seed$
DECLARE
  -- >>> OPCIONAL: UUID do usuário LÍDER (veja o cabeçalho). Deixe NULL para rodar sem líder.
  v_leader      uuid := NULL;   -- exemplo: '11111111-2222-3333-4444-555555555555'::uuid

  v_coord       uuid;
  v_coord_name  text;
  v_lead        uuid;
  v_today       date := public.app_today();
  v_back        integer;
  v_d0          date;           -- último sábado antes de hoje (âncora da série semanal)
  v_pos         integer;
  v_ev          uuid[];
  v_pat         text[];

  v_al_bruno    uuid;
  v_al_valent   uuid;
  v_al_lucas    uuid;
  v_al_olivia   uuid;
  v_al_pedro    uuid;
BEGIN
  -- ---------------------------------------------------------------- responsáveis
  SELECT ur.user_id INTO v_coord
    FROM public.user_roles ur
   WHERE ur.role = 'coordinator'
   ORDER BY ur.created_at, ur.user_id
   LIMIT 1;
  IF v_coord IS NULL THEN
    RAISE EXCEPTION 'Nenhum coordenador encontrado em user_roles. Crie ou promova um coordenador antes de rodar o seed.';
  END IF;
  SELECT p.full_name INTO v_coord_name FROM public.profiles p WHERE p.id = v_coord;

  IF v_leader IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = v_leader) THEN
    RAISE EXCEPTION 'v_leader (%) não existe em profiles. Confira o "User UID" em Authentication > Users.', v_leader;
  END IF;
  v_lead := COALESCE(v_leader, v_coord);

  v_back := (extract(dow FROM v_today)::integer + 1) % 7;   -- dias desde o último sábado
  IF v_back = 0 THEN v_back := 7; END IF;
  v_d0 := v_today - v_back;

  -- ---------------------------------------------------------------- grupos
  INSERT INTO public.groups (id, name, description, leader_id) VALUES
    (pg_temp.sid(1, 1), '[TESTE] Grupo Alfa',  'Grupo fictício de teste (adolescentes).',        v_lead),
    (pg_temp.sid(1, 2), '[TESTE] Grupo Beta',  'Grupo fictício de teste (jovens).',              v_lead),
    (pg_temp.sid(1, 3), '[TESTE] Grupo Gama',  'Grupo fictício de teste, sob a coordenação.',    v_coord),
    (pg_temp.sid(1, 4), '[TESTE] Grupo Delta', 'Grupo fictício de teste, sem líder definido.',   NULL)
  ON CONFLICT (id) DO NOTHING;

  -- ---------------------------------------------------------------- jovens
  INSERT INTO public.youth (id, full_name, birth_date, gender, phone, email, address, notes, is_active, group_id, created_by)
  SELECT pg_temp.sid(2, y.n),
         y.name,
         y.birth::date,
         y.gender::gender_type,
         '(00) 90000-' || lpad(y.n::text, 4, '0'),
         y.email,
         CASE WHEN y.n % 4 = 0 THEN NULL ELSE 'Rua Fictícia, ' || (y.n * 7) || ' - Bairro Teste' END,
         y.notes,
         y.active,
         CASE WHEN y.g IS NULL THEN NULL ELSE pg_temp.sid(1, y.g) END,
         v_coord
    FROM (VALUES
      ( 1, 'Ana Beatriz Moraes',        '2008-03-14', 'female', 'ana.moraes.teste@example.com',        NULL,                              true,  1),
      ( 2, 'Bruno Teixeira Lima',       '2007-11-02', 'male',   'bruno.lima.teste@example.com',        NULL,                              true,  1),
      ( 3, 'Camila Duarte Rocha',       '2009-06-21', 'female', 'camila.rocha.teste@example.com',      NULL,                              true,  1),
      ( 4, 'Davi Nogueira Prado',       '2006-01-30', 'male',   'davi.prado.teste@example.com',        NULL,                              true,  1),
      ( 5, 'Eduarda Campos Vieira',     '2010-09-08', 'female', 'eduarda.vieira.teste@example.com',    NULL,                              true,  1),
      ( 6, 'Felipe Andrade Souza',      '2008-12-17', 'male',   'felipe.souza.teste@example.com',      NULL,                              true,  1),
      ( 7, 'Gabriela Farias Menezes',   '2007-04-25', 'female', 'gabriela.menezes.teste@example.com',  NULL,                              true,  1),
      ( 8, 'Heitor Barros Cavalcante',  '2011-02-11', 'other',  'heitor.cavalcante.teste@example.com', NULL,                              true,  1),
      ( 9, 'Isadora Pinheiro Lacerda',  '2012-07-19', 'female', 'isadora.lacerda.teste@example.com',   'Entrou há poucas semanas (fictício).', true, 1),
      (10, 'João Pedro Albuquerque',    '2006-08-05', 'male',   'joao.albuquerque.teste@example.com',  NULL,                              true,  2),
      (11, 'Karina Salgado Brito',      '2008-05-27', 'female', 'karina.brito.teste@example.com',      'Mudou de cidade (fictício).',     false, 2),
      (12, 'Lucas Ferraz Tavares',      '2009-10-13', 'male',   'lucas.tavares.teste@example.com',     NULL,                              true,  2),
      (13, 'Mariana Costa Leal',        '2007-03-03', 'female', 'mariana.leal.teste@example.com',      NULL,                              true,  2),
      (14, 'Nicolas Peixoto Gama',      '2010-01-22', 'male',   'nicolas.gama.teste@example.com',      NULL,                              true,  2),
      (15, 'Olívia Ramos Fontes',       '2008-09-16', 'female', 'olivia.fontes.teste@example.com',     NULL,                              true,  2),
      (16, 'Pedro Henrique Matos',      '2011-11-29', 'male',   'pedro.matos.teste@example.com',       NULL,                              true,  2),
      (17, 'Quézia Amorim Dantas',      '2009-02-07', NULL,     'quezia.dantas.teste@example.com',     'Gênero não informado (fictício).', true, 2),
      (18, 'Rafael Cordeiro Brandão',   '2005-12-12', 'male',   'rafael.brandao.teste@example.com',    NULL,                              true,  3),
      (19, 'Sofia Vasconcelos Arruda',  '2007-07-07', 'female', 'sofia.arruda.teste@example.com',      NULL,                              true,  3),
      (20, 'Tiago Sampaio Neves',       '2006-06-18', 'male',   'tiago.neves.teste@example.com',       'Afastado por motivo de saúde (fictício).', false, 3),
      (21, 'Valentina Guedes Maia',     '2010-04-01', 'female', 'valentina.maia.teste@example.com',    NULL,                              true,  3),
      (22, 'Wesley Ornelas Pires',      '2008-10-24', 'male',   'wesley.pires.teste@example.com',      NULL,                              true,  3),
      (23, 'Yasmin Cordeiro Falcão',    '2009-08-30', 'female', 'yasmin.falcao.teste@example.com',     NULL,                              true,  3),
      (24, 'Arthur Meireles Quintela',  '2012-03-09', 'male',   'arthur.quintela.teste@example.com',   NULL,                              true,  4),
      (25, 'Beatriz Lobo Siqueira',     '2011-05-15', 'female', 'beatriz.siqueira.teste@example.com',  NULL,                              false, 4),
      (26, 'Caetano Rios Valadares',    '2010-12-04', 'other',  'caetano.valadares.teste@example.com', NULL,                              true,  4),
      (27, 'Débora Lins Carvalhal',     '2007-09-26', 'female', 'debora.carvalhal.teste@example.com',  'Ainda sem grupo (fictício).',     true,  NULL),
      (28, 'Ícaro Bastos Fidalgo',      NULL,         'male',   'icaro.fidalgo.teste@example.com',     'Cadastro antigo, sem data de nascimento (fictício).', false, NULL)
    ) AS y(n, name, birth, gender, email, notes, active, g)
  ON CONFLICT (id) DO NOTHING;

  -- ---------------------------------------------------------------- série e encontros
  INSERT INTO public.event_series (id, name, weekday, start_time, recurrence, start_date, end_date, default_description, created_by, active)
  VALUES (pg_temp.sid(4, 1), '[TESTE] Culto de Jovens (semanal)', 6, TIME '19:00', 'weekly',
          v_d0 - 35, v_d0 + 63, 'Série fictícia de teste: todo sábado às 19h.', v_coord, true)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.event_series_groups (series_id, group_id) VALUES
    (pg_temp.sid(4, 1), pg_temp.sid(1, 1)),
    (pg_temp.sid(4, 1), pg_temp.sid(1, 2)),
    (pg_temp.sid(4, 1), pg_temp.sid(1, 3))
  ON CONFLICT DO NOTHING;

  -- n=1 retiro | 2-4 culto (série) | 5 noite de louvor | 6 culto (série) | 7 cancelado | 8-9 culto (série) | 10-12 futuros
  INSERT INTO public.events (id, title, description, event_date, status, created_by, series_id, series_date)
  SELECT pg_temp.sid(3, e.n),
         e.title,
         e.descr,
         ((e.d + e.t)::timestamp AT TIME ZONE 'America/Sao_Paulo'),
         e.status::event_status,
         v_coord,
         CASE WHEN e.ser THEN pg_temp.sid(4, 1) END,
         CASE WHEN e.ser THEN e.d END
    FROM (VALUES
      ( 1, '[TESTE] Retiro de Jovens',            'Retiro fictício de um dia.',            v_d0 - 38, TIME '08:00', 'completed', false),
      ( 2, '[TESTE] Culto de Jovens',             'Culto semanal fictício.',               v_d0 - 35, TIME '19:00', 'completed', true),
      ( 3, '[TESTE] Culto de Jovens',             'Culto semanal fictício.',               v_d0 - 28, TIME '19:00', 'completed', true),
      ( 4, '[TESTE] Culto de Jovens',             'Culto semanal fictício.',               v_d0 - 21, TIME '19:00', 'completed', true),
      ( 5, '[TESTE] Noite de Louvor',             'Encontro fictício só dos grupos Alfa e Beta.', v_d0 - 17, TIME '19:30', 'completed', false),
      ( 6, '[TESTE] Culto de Jovens',             'Culto semanal fictício.',               v_d0 - 14, TIME '19:00', 'completed', true),
      ( 7, '[TESTE] Culto Cancelado (chuva)',     'Cancelado de propósito para testar o estado.', v_d0 - 10, TIME '19:00', 'cancelled', false),
      ( 8, '[TESTE] Culto de Jovens',             'Culto semanal fictício.',               v_d0 - 7,  TIME '19:00', 'completed', true),
      ( 9, '[TESTE] Culto de Jovens',             'Culto semanal fictício.',               v_d0,      TIME '19:00', 'completed', true),
      (10, '[TESTE] Culto de Jovens',             'Culto semanal fictício.',               v_d0 + 7,  TIME '19:00', 'scheduled', true),
      (11, '[TESTE] Culto de Jovens',             'Culto semanal fictício.',               v_d0 + 14, TIME '19:00', 'scheduled', true),
      (12, '[TESTE] Culto de Jovens',             'Culto semanal fictício.',               v_d0 + 21, TIME '19:00', 'scheduled', true)
    ) AS e(n, title, descr, d, t, status, ser)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.event_groups (event_id, group_id)
  SELECT pg_temp.sid(3, g.en), pg_temp.sid(1, g.gn)
    FROM (VALUES
      (1, 1), (1, 2), (1, 3), (1, 4),
      (2, 1), (2, 2), (2, 3),  (3, 1), (3, 2), (3, 3),  (4, 1), (4, 2), (4, 3),
      (5, 1), (5, 2),
      (6, 1), (6, 2), (6, 3),
      (7, 1), (7, 2),
      (8, 1), (8, 2), (8, 3),  (9, 1), (9, 2), (9, 3),
      (10, 1), (10, 2), (10, 3),  (11, 1), (11, 2), (11, 3),  (12, 1), (12, 2), (12, 3)
    ) AS g(en, gn)
  ON CONFLICT DO NOTHING;

  -- ---------------------------------------------------------------- chamada
  -- Uma posição por encontro REALIZADO, em ordem cronológica: 0 retiro, 1-3 cultos, 4 louvor (só Alfa/Beta),
  -- 5-7 cultos. Caractere: 1 presente | 0 ausente | - não registrado (sem linha). Um jovem só tem linha nos encontros
  -- dos grupos em que está hoje. Perfis (efeito esperado, conforme os limites padrão):
  --   11111111 sempre presente                11000000 faltas seguidas CRÍTICAS (+ frequência baixa + queda)
  --   11111000 3 faltas seguidas (atenção)    10100101 frequência baixa
  --   11110101 queda de frequência            00011111 faltou, voltou (alerta de faltas resolve sozinho)
  --   11011101 faltas esporádicas (normal)    -----111 jovem novo, poucos registros
  v_ev  := ARRAY[pg_temp.sid(3, 1), pg_temp.sid(3, 2), pg_temp.sid(3, 3), pg_temp.sid(3, 4),
                 pg_temp.sid(3, 5), pg_temp.sid(3, 6), pg_temp.sid(3, 8), pg_temp.sid(3, 9)];
  v_pat := ARRAY[
    '11111111', '11000000', '11111000', '11111111', '10100101', '11110101', '00011111', '11011101', '-----111',   -- 1-9   Alfa
    '11111111', '11000000', '11111000', '11111111', '11000000', '10100101', '11110101', '11101110',               -- 10-17 Beta
    '11111111', '11000000', '11111111', '11111000', '10100101', '11011101',                                       -- 18-23 Gama
    '1-------', '0-------', '1-------',                                                                           -- 24-26 Delta (só o retiro)
    '--------', '--------'                                                                                        -- 27-28 sem grupo
  ];

  FOR v_pos IN 0..7 LOOP
    INSERT INTO public.attendance (event_id, youth_id, group_id, present, notes, recorded_by)
    SELECT v_ev[v_pos + 1],
           y.id,
           y.group_id,
           substr(v_pat[n.i], v_pos + 1, 1) = '1',
           CASE WHEN n.i = 7 AND substr(v_pat[n.i], v_pos + 1, 1) = '0' THEN 'Avisou que estava doente (fictício).' END,
           v_coord
      FROM generate_series(1, 28) AS n(i)
      JOIN public.youth y         ON y.id = pg_temp.sid(2, n.i)
      JOIN public.event_groups eg ON eg.event_id = v_ev[v_pos + 1] AND eg.group_id = y.group_id
     WHERE substr(v_pat[n.i], v_pos + 1, 1) IN ('0', '1')
    ON CONFLICT (event_id, youth_id) DO NOTHING;
  END LOOP;

  -- ---------------------------------------------------------------- tarefas (antes dos acompanhamentos: uma delas é concluída por um)
  SELECT a.id INTO v_al_valent FROM public.alerts a
   WHERE a.youth_id = pg_temp.sid(2, 21) AND a.type = 'consecutive_absences' ORDER BY a.created_at DESC LIMIT 1;
  SELECT a.id INTO v_al_bruno FROM public.alerts a
   WHERE a.youth_id = pg_temp.sid(2, 2) AND a.type = 'consecutive_absences' ORDER BY a.created_at DESC LIMIT 1;

  INSERT INTO public.tasks (id, title, description, status, priority, due_date, youth_id, group_id, alert_id, assigned_to, created_by, created_at)
  VALUES
    (pg_temp.sid(7, 1),  '[TESTE] Ligar para a família do Bruno',   'Entender o motivo das faltas.',          'pending',     'high',   v_today + 5,  pg_temp.sid(2, 2),  pg_temp.sid(1, 1), v_al_bruno,  v_coord, v_coord, now() - interval '5 days'),
    (pg_temp.sid(7, 2),  '[TESTE] Visitar o Nicolas',               'Visita combinada com o líder.',          'in_progress', 'medium', v_today - 3,  pg_temp.sid(2, 14), pg_temp.sid(1, 2), NULL,       v_lead,  v_coord, now() - interval '9 days'),
    (pg_temp.sid(7, 3),  '[TESTE] Mandar mensagem para a Sofia',    NULL,                                     'pending',     'low',    v_today - 6,  pg_temp.sid(2, 19), pg_temp.sid(1, 3), NULL,       v_coord, v_coord, now() - interval '12 days'),
    (pg_temp.sid(7, 4),  '[TESTE] Visita à família da Camila',      'Concluída pelo acompanhamento.',         'pending',     'medium', v_today - 8,  pg_temp.sid(2, 3),  pg_temp.sid(1, 1), NULL,       v_coord, v_coord, now() - interval '14 days'),
    (pg_temp.sid(7, 5),  '[TESTE] Convite para o retiro (Lucas)',   'Cancelada: o jovem não poderá ir.',      'cancelled',   'low',    v_today + 2,  pg_temp.sid(2, 12), pg_temp.sid(1, 2), NULL,       v_lead,  v_coord, now() - interval '6 days'),
    (pg_temp.sid(7, 6),  '[TESTE] Organizar lanche do próximo culto', 'Tarefa do grupo, sem jovem.',          'pending',     'medium', NULL,         NULL,               pg_temp.sid(1, 1), NULL,       v_coord, v_coord, now() - interval '3 days'),
    (pg_temp.sid(7, 7),  '[TESTE] Acompanhar a Valentina',          'Ligada ao alerta de faltas seguidas.',   'in_progress', 'high',   v_today + 1,  pg_temp.sid(2, 21), pg_temp.sid(1, 3), v_al_valent, v_lead, v_coord, now() - interval '4 days'),
    (pg_temp.sid(7, 8),  '[TESTE] Agradecer o Davi pela ajuda',     NULL,                                     'done',        'low',    v_today - 1,  pg_temp.sid(2, 4),  pg_temp.sid(1, 1), NULL,       v_coord, v_coord, now() - interval '7 days'),
    (pg_temp.sid(7, 9),  '[TESTE] Conversar com o Pedro Henrique',  'Prazo é hoje.',                          'pending',     'high',   v_today,      pg_temp.sid(2, 16), pg_temp.sid(1, 2), NULL,       v_lead,  v_coord, now() - interval '2 days'),
    (pg_temp.sid(7, 10), '[TESTE] Reservar o espaço do retiro',     'Sem jovem, só o grupo.',                 'pending',     'medium', v_today + 10, NULL,               pg_temp.sid(1, 2), NULL,       v_coord, v_coord, now() - interval '1 day'),
    (pg_temp.sid(7, 11), '[TESTE] Ligar para o Felipe',             'Frequência em queda.',                   'pending',     'high',   v_today - 1,  pg_temp.sid(2, 6),  pg_temp.sid(1, 1), NULL,       v_coord, v_coord, now() - interval '8 days')
  ON CONFLICT (id) DO NOTHING;

  -- ---------------------------------------------------------------- acompanhamentos
  -- follow_ups_guard preenche group_id a partir do jovem. O 3º (Camila) conclui a tarefa 4 (completes_task).
  INSERT INTO public.follow_ups (id, youth_id, alert_id, task_id, occurred_at, type, reason, notes, next_action, next_action_due,
                                 completes_task, responsible_id, created_by, created_at)
  VALUES
    (pg_temp.sid(5, 1), pg_temp.sid(2, 2),  v_al_bruno,  NULL,              v_today - 3,  'conversation', 'Conversa sobre as faltas recentes',          'Disse que está sobrecarregado na escola (fictício).', 'Ligar na semana que vem', v_today + 4,  false, v_coord, v_coord, ((v_today - 3)  + TIME '10:00')::timestamp AT TIME ZONE 'America/Sao_Paulo'),
    (pg_temp.sid(5, 2), pg_temp.sid(2, 3),  NULL,        NULL,              v_today - 5,  'call',         'Ligação para saber o motivo das ausências',  NULL,                                                  NULL,                      NULL,          false, v_lead,  v_coord, ((v_today - 5)  + TIME '14:00')::timestamp AT TIME ZONE 'America/Sao_Paulo'),
    (pg_temp.sid(5, 3), pg_temp.sid(2, 3),  NULL,        pg_temp.sid(7, 4), v_today - 2,  'in_person',    'Visita à família',                           'Foram receptivos (fictício).',                        'Convidar para o retiro',  v_today + 10,  true,  v_coord, v_coord, ((v_today - 2)  + TIME '16:00')::timestamp AT TIME ZONE 'America/Sao_Paulo'),
    (pg_temp.sid(5, 4), pg_temp.sid(2, 21), v_al_valent, NULL,              v_today - 6,  'guidance',     'Orientação sobre a rotina de estudos',       NULL,                                                  NULL,                      NULL,          false, v_lead,  v_coord, ((v_today - 6)  + TIME '19:30')::timestamp AT TIME ZONE 'America/Sao_Paulo'),
    (pg_temp.sid(5, 5), pg_temp.sid(2, 7),  NULL,        NULL,              v_today - 9,  'return',       'Retorno após semanas afastada',              'Voltou a participar dos cultos (fictício).',          'Convidar para o próximo culto', v_today - 1, false, v_coord, v_coord, ((v_today - 9)  + TIME '11:00')::timestamp AT TIME ZONE 'America/Sao_Paulo'),
    (pg_temp.sid(5, 6), pg_temp.sid(2, 9),  NULL,        NULL,              v_today - 1,  'other',        'Contato inicial de boas-vindas',             NULL,                                                  'Apresentar o grupo',      v_today + 7,   false, v_coord, v_coord, ((v_today - 1)  + TIME '18:00')::timestamp AT TIME ZONE 'America/Sao_Paulo'),
    (pg_temp.sid(5, 7), pg_temp.sid(2, 15), NULL,        NULL,              v_today - 4,  'conversation', 'Conversa sobre a frequência',                NULL,                                                  NULL,                      NULL,          false, v_lead,  v_coord, ((v_today - 4)  + TIME '20:00')::timestamp AT TIME ZONE 'America/Sao_Paulo'),
    (pg_temp.sid(5, 8), pg_temp.sid(2, 8),  NULL,        NULL,              v_today - 12, 'call',         'Ligação de apoio (viagem da família)',       NULL,                                                  NULL,                      NULL,          false, v_coord, v_coord, ((v_today - 12) + TIME '09:30')::timestamp AT TIME ZONE 'America/Sao_Paulo'),
    (pg_temp.sid(5, 9), pg_temp.sid(2, 12), NULL,        NULL,              v_today - 8,  'conversation', 'Conversa sobre desmotivação',                'Combinamos nova conversa com o líder (fictício).',    'Rever em duas semanas',   v_today + 6,   false, v_coord, v_coord, ((v_today - 8)  + TIME '17:00')::timestamp AT TIME ZONE 'America/Sao_Paulo')
  ON CONFLICT (id) DO NOTHING;

  -- Histórico de transferências: só com líder (a transferência exige duas pessoas diferentes).
  -- Escrita direta é permitida ao dono do banco (o trigger de imutabilidade só barra anon/authenticated).
  IF v_leader IS NOT NULL THEN
    INSERT INTO public.follow_up_transfers (id, follow_up_id, from_responsible_id, to_responsible_id, reason, transferred_by, transferred_at)
    VALUES
      (pg_temp.sid(6, 1), pg_temp.sid(5, 2), v_coord, v_leader, 'O líder do grupo acompanha de perto.',        v_coord,  now() - interval '4 days'),
      (pg_temp.sid(6, 2), pg_temp.sid(5, 9), v_coord, v_leader, 'Transferido ao líder do grupo.',              v_coord,  now() - interval '6 days'),
      (pg_temp.sid(6, 3), pg_temp.sid(5, 9), v_leader, v_coord, 'Volta à coordenação para decidir o próximo passo.', v_leader, now() - interval '3 days')
    ON CONFLICT (id) DO NOTHING;
  END IF;

  -- ---------------------------------------------------------------- alertas por tempo
  -- "Sem acompanhamento": o alerta de faltas do Nicolas (14) é recuado 12 dias (limite: 7) e ele não tem
  -- nenhum acompanhamento. Só recua um alerta recém-criado (idempotente).
  UPDATE public.alerts
     SET created_at = now() - interval '12 days'
   WHERE youth_id = pg_temp.sid(2, 14) AND type = 'consecutive_absences' AND status = 'open'
     AND created_at > now() - interval '1 day';
  PERFORM public.refresh_youth_time_alerts(pg_temp.sid(2, 14));

  -- Recalcula só os jovens do seed (rede de segurança; os triggers já mantêm tudo em dia).
  PERFORM public.refresh_youth_alert(pg_temp.sid(2, i)) FROM generate_series(1, 28) AS i;
  PERFORM public.refresh_youth_time_alerts(pg_temp.sid(2, i)) FROM generate_series(1, 28) AS i;

  -- ---------------------------------------------------------------- alertas encerrados por uma pessoa
  -- Estados "dispensado" e "resolvido": só mexe em alerta ainda aberto, então rodar de novo não repete nada.
  UPDATE public.alerts
     SET status = 'dismissed', resolved_by = v_coord, resolved_at = now() - interval '2 days',
         resolution_notes = 'Dispensado: a família avisou que o jovem estava viajando (fictício).'
   WHERE youth_id = pg_temp.sid(2, 12) AND type = 'consecutive_absences' AND status = 'open';

  UPDATE public.alerts
     SET status = 'dismissed', resolved_by = v_coord, resolved_at = now() - interval '1 day',
         resolution_notes = 'Dispensado: oscilação conhecida, jovem em acompanhamento (fictício).'
   WHERE youth_id = pg_temp.sid(2, 16) AND type = 'attendance_drop' AND status = 'open';

  UPDATE public.alerts
     SET status = 'resolved', resolved_by = v_coord, resolved_at = now() - interval '1 day',
         resolution_notes = 'Conversamos com a jovem e a frequência está sendo acompanhada (fictício).'
   WHERE youth_id = pg_temp.sid(2, 15) AND type = 'low_attendance' AND status = 'open';

  -- ---------------------------------------------------------------- e-mails (nenhum é enviado: só registros)
  -- Todos @example.com. O envio de verdade só acontece pela Edge Function; aqui são linhas de dados.
  -- 'sent' exige sent_at; 'failed' exige failure_reason; provider_message_id só existe em 'sent'.
  INSERT INTO public.communications (id, youth_id, alert_id, follow_up_id, recipient_email, recipient_name, recipient_kind,
                                     subject, body, status, failure_reason, created_by, created_at, sent_at, sent_by,
                                     provider, provider_message_id, attempts, last_attempt_at)
  VALUES
    (pg_temp.sid(8, 1), pg_temp.sid(2, 2),  v_al_bruno, NULL,
     'bruno.lima.teste@example.com', 'Bruno Teixeira Lima', 'youth',
     'Sentimos a sua falta (teste)',
     E'Oi, Bruno!\n\nNotamos que você não tem vindo aos encontros e queríamos saber como você está.\n\nUm abraço,\nEquipe de teste',
     'draft', NULL, v_coord, now() - interval '1 day', NULL, NULL, NULL, NULL, 0, NULL),
    (pg_temp.sid(8, 2), pg_temp.sid(2, 3),  NULL, pg_temp.sid(5, 2),
     'responsavel.camila.teste@example.com', 'Responsável de Camila (teste)', 'guardian',
     'Convite para o retiro de jovens (teste)',
     E'Olá!\n\nGostaríamos de convidar a Camila para o retiro de jovens.\n\nAtenciosamente,\nEquipe de teste',
     'sent', NULL, v_coord, now() - interval '3 days', now() - interval '3 days', v_coord,
     'resend', 'teste-fake-0002', 1, now() - interval '3 days'),
    (pg_temp.sid(8, 3), pg_temp.sid(2, 19), NULL, NULL,
     'sofia.arruda.teste@example.com', 'Sofia Vasconcelos Arruda', 'youth',
     'Estamos com saudade (teste)',
     E'Oi, Sofia!\n\nSentimos a sua falta nos últimos encontros. Está tudo bem?\n\nUm abraço,\nEquipe de teste',
     'failed', 'provider_rejected', v_coord, now() - interval '2 days', NULL, NULL,
     'resend', NULL, 1, now() - interval '2 days')
  ON CONFLICT (id) DO NOTHING;

  -- ---------------------------------------------------------------- Histórico (INSERT direto; veja as notas do cabeçalho)
  SELECT a.id INTO v_al_lucas FROM public.alerts a
   WHERE a.youth_id = pg_temp.sid(2, 12) AND a.type = 'consecutive_absences' AND a.status = 'dismissed' ORDER BY a.created_at DESC LIMIT 1;
  SELECT a.id INTO v_al_pedro FROM public.alerts a
   WHERE a.youth_id = pg_temp.sid(2, 16) AND a.type = 'attendance_drop' AND a.status = 'dismissed' ORDER BY a.created_at DESC LIMIT 1;
  SELECT a.id INTO v_al_olivia FROM public.alerts a
   WHERE a.youth_id = pg_temp.sid(2, 15) AND a.type = 'low_attendance' AND a.status = 'resolved' ORDER BY a.created_at DESC LIMIT 1;

  INSERT INTO public.activity_log (id, occurred_at, actor_id, actor_name, action, entity_type, entity_id, youth_id, group_id, summary, meta)
  VALUES
    (pg_temp.sid(9, 1), now() - interval '30 days', v_coord, v_coord_name, 'event_series_created', 'event_series', pg_temp.sid(4, 1), NULL, NULL,
       'Série de encontros criada.', '{"recurrence":"weekly","created":9}'::jsonb),
    (pg_temp.sid(9, 2), now() - interval '20 days', v_coord, v_coord_name, 'youth_deactivated', 'youth', pg_temp.sid(2, 11), pg_temp.sid(2, 11), pg_temp.sid(1, 2),
       'Jovem inativado.', '{}'::jsonb),
    (pg_temp.sid(9, 3), now() - interval '7 days', v_coord, v_coord_name, 'attendance_recorded', 'event', pg_temp.sid(3, 8), NULL, pg_temp.sid(1, 1),
       'Chamada registrada: 4 presentes e 5 ausentes.', '{"present":4,"absent":5}'::jsonb),
    (pg_temp.sid(9, 4), now() - interval '5 days', v_coord, v_coord_name, 'follow_up_created', 'follow_up', pg_temp.sid(5, 2), pg_temp.sid(2, 3), pg_temp.sid(1, 1),
       'Acompanhamento registrado.', '{"type":"call"}'::jsonb),
    (pg_temp.sid(9, 5), now() - interval '4 days', v_coord, v_coord_name, 'task_created', 'task', pg_temp.sid(7, 1), pg_temp.sid(2, 2), pg_temp.sid(1, 1),
       'Ação criada.', '{"priority":"high"}'::jsonb),
    (pg_temp.sid(9, 6), now() - interval '2 days', v_coord, v_coord_name, 'task_completed', 'task', pg_temp.sid(7, 4), pg_temp.sid(2, 3), pg_temp.sid(1, 1),
       'Ação concluída.', '{"priority":"medium"}'::jsonb),
    (pg_temp.sid(9, 7), now() - interval '2 days', v_coord, v_coord_name, 'alert_dismissed', 'alert', v_al_lucas, pg_temp.sid(2, 12), pg_temp.sid(1, 2),
       'Alerta dispensado.', '{"type":"consecutive_absences","severity":"attention"}'::jsonb),
    (pg_temp.sid(9, 8), now() - interval '1 day', v_coord, v_coord_name, 'alert_dismissed', 'alert', v_al_pedro, pg_temp.sid(2, 16), pg_temp.sid(1, 2),
       'Alerta dispensado.', '{"type":"attendance_drop","severity":"attention"}'::jsonb),
    (pg_temp.sid(9, 9), now() - interval '1 day', v_coord, v_coord_name, 'alert_resolved', 'alert', v_al_olivia, pg_temp.sid(2, 15), pg_temp.sid(1, 2),
       'Alerta resolvido.', '{"type":"low_attendance","severity":"attention"}'::jsonb)
  ON CONFLICT (id) DO NOTHING;
END
$seed$;

COMMIT;

-- ============================================================================
-- CONFERÊNCIA — o que existe agora (linhas do seed; alertas = dos jovens do seed)
-- ============================================================================
SELECT t.tabela, t.quantidade
FROM (
  SELECT  1 AS o, 'groups'                  AS tabela, count(*) AS quantidade FROM public.groups                  WHERE id::text LIKE '5eed5eed-%'
  UNION ALL SELECT  2, 'youth (total)',                count(*) FROM public.youth                   WHERE id::text LIKE '5eed5eed-%'
  UNION ALL SELECT  3, 'youth (inativos)',             count(*) FROM public.youth                   WHERE id::text LIKE '5eed5eed-%' AND NOT is_active
  UNION ALL SELECT  4, 'youth (sem grupo)',            count(*) FROM public.youth                   WHERE id::text LIKE '5eed5eed-%' AND group_id IS NULL
  UNION ALL SELECT  5, 'event_series',                 count(*) FROM public.event_series            WHERE id::text LIKE '5eed5eed-%'
  UNION ALL SELECT  6, 'event_series_groups',          count(*) FROM public.event_series_groups     WHERE series_id::text LIKE '5eed5eed-%'
  UNION ALL SELECT  7, 'events',                       count(*) FROM public.events                  WHERE id::text LIKE '5eed5eed-%'
  UNION ALL SELECT  8, 'event_groups',                 count(*) FROM public.event_groups            WHERE event_id::text LIKE '5eed5eed-%'
  UNION ALL SELECT  9, 'attendance',                   count(*) FROM public.attendance              WHERE event_id::text LIKE '5eed5eed-%'
  UNION ALL SELECT 10, 'alerts (total)',               count(*) FROM public.alerts                  WHERE youth_id::text LIKE '5eed5eed-%'
  UNION ALL SELECT 11, 'alerts (open)',                count(*) FROM public.alerts                  WHERE youth_id::text LIKE '5eed5eed-%' AND status = 'open'
  UNION ALL SELECT 12, 'alerts (resolved)',            count(*) FROM public.alerts                  WHERE youth_id::text LIKE '5eed5eed-%' AND status = 'resolved'
  UNION ALL SELECT 13, 'alerts (dismissed)',           count(*) FROM public.alerts                  WHERE youth_id::text LIKE '5eed5eed-%' AND status = 'dismissed'
  UNION ALL SELECT 14, 'alerts (críticos)',            count(*) FROM public.alerts                  WHERE youth_id::text LIKE '5eed5eed-%' AND severity = 'critical'
  UNION ALL SELECT 15, 'follow_ups',                   count(*) FROM public.follow_ups              WHERE id::text LIKE '5eed5eed-%'
  UNION ALL SELECT 16, 'follow_up_transfers',          count(*) FROM public.follow_up_transfers     WHERE id::text LIKE '5eed5eed-%'
  UNION ALL SELECT 17, 'tasks',                        count(*) FROM public.tasks                   WHERE id::text LIKE '5eed5eed-%'
  UNION ALL SELECT 18, 'communications',               count(*) FROM public.communications         WHERE id::text LIKE '5eed5eed-%'
  UNION ALL SELECT 19, 'activity_log',                 count(*) FROM public.activity_log            WHERE id::text LIKE '5eed5eed-%'
) t
ORDER BY t.o;
