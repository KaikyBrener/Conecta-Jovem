# CLAUDE.md — ConectJovem

Sistema web **mobile-first** para gestão de ministério jovem: jovens, grupos, encontros,
chamada (presença), alertas de faltas, tarefas/ações de acompanhamento, relatórios e configurações.
Toda a interface e as mensagens são em **português (pt-BR)**.

## Stack

- React 19 + TypeScript (~6) + Vite 8 (Rolldown)
- Tailwind CSS v4 via `@tailwindcss/vite` (sem `tailwind.config`; tema em `src/index.css`)
- React Router v7 (API `react-router-dom`, `BrowserRouter` + `<Routes>`)
- Supabase (`@supabase/supabase-js` v2): Postgres + Auth + RLS. **Não há backend próprio.**
- Ícones: `lucide-react`. Utilitário de classes: `cn()` em `src/lib/utils.ts`
- Lint: `oxlint` (`.oxlintrc.json`). Testes: `vitest` (unitários + testes de banco com PGlite)

## Comandos

```bash
npm run dev        # servidor de desenvolvimento
npm run lint       # oxlint
npm run build      # tsc -b && vite build
npm test           # vitest run (unit + testes SQL/RLS em PGlite)
npm run test:e2e   # Playwright (desktop + mobile) contra um Supabase FALSO local; ver tests/e2e/README.md
```

Sempre rode `npm run lint`, `npm run build` e `npm test` antes de considerar uma tarefa concluída.

## Variáveis de ambiente

`.env` (não versionar): `VITE_SUPABASE_URL` e `VITE_SUPABASE_PUBLISHABLE_KEY`
(o cliente em `src/lib/supabase.ts` lança erro se faltarem). `Senha_BD.txt` contém credencial
do banco — **nunca** commitar nem ler/expor em logs.

## Regras do projeto

- **Não usar Lovable** nem geradores que sobrescrevam a estrutura.
- **Sem dados mockados**: toda tela lê do Supabase. Estados vazios devem ser tratados na UI.
- **Nunca remover/afrouxar RLS** para facilitar implementação. Toda tabela nova em `public`
  precisa de `ENABLE ROW LEVEL SECURITY` e políticas explícitas por papel.
- Alterações de schema **somente via nova migration** numerada em `supabase/migrations/`
  (`NNN_descricao.sql`). Nunca editar migration já aplicada; corrigir com uma nova.
- Migrations são aplicadas manualmente, em ordem, no SQL Editor do Supabase (ver README).
- Preservar o que funciona; trabalhar de forma incremental.
- Só considerar algo "testado" se o teste foi realmente executado.

## Arquitetura (frontend)

```
src/
  App.tsx              rotas (lazy) — tudo sob <ProtectedRoute><Layout/>
  contexts/AuthContext sessão, profile, role (coordinator | leader), signOut, refreshProfile
  lib/supabase.ts      cliente Supabase
  lib/format.ts        formatação de datas/percentuais (pt-BR)
  lib/reportExport.ts  documentos de exportação dos relatórios (CSV/PDF); agregação roda no banco (RPCs report_*)
  lib/csv.ts           exportação CSV
  lib/fetchAll.ts      busca TODAS as linhas (PostgREST limita 1000 por resposta) — use em agregações e em
                       listas que alimentam <select>; nunca para telas de listagem
  lib/pagination.ts    PAGE_SIZE (25), pageBounds, totalPages, searchPattern (puros, testados)
  hooks/usePagedList   listagem paginada NO SERVIDOR (range + count exact), com filtros na chave da consulta
  lib/labels.ts        rótulos pt-BR compartilhados (status/prioridade de tarefas)
  hooks/useX.ts        acesso a dados por módulo (useYouth, useGroups, useEvents,
                       useAttendance, useYouthHistory, useAlerts, useTasks,
                       useDashboard, useReports, useSettings)
  pages/               Dashboard, Jovens, Grupos, Encontros, Chamada, Alertas,
                       Tarefas, Relatorios, Configuracoes, Login
  components/          Layout, Modal, ProtectedRoute, ErrorBanner + subpastas por módulo
  types/database.types.ts  tipos das tabelas (escritos à mão)
```

Convenções observadas:
- **Listagens que podem crescer (Jovens, Encontros, Tarefas, Grupos, Usuários) são paginadas no servidor**
  com `usePagedList` + `<Pagination/>`: busca (`ilike`), filtros, ordenação (sempre com desempate por `id`)
  e `range` rodam no PostgREST; contadores de cabeçalho vêm de consultas `head` + `count: 'exact'`.
  Busca em outra tabela (ex.: nome do líder/jovem) resolve os ids antes e usa `.or(...)`. Texto de busca
  passa por `searchPattern()` (remove `, ( ) "  * %` — nunca interpole texto cru em `.or`).
  Mudar filtro volta à página 1 sozinho; se a página atual esvaziar (ex.: concluiu a última tarefa), vai
  para a última existente. Não filtre/pagine listas grandes no cliente.
- Hooks retornam `{ dados, loading, error, refetch, ...mutations }`; mutations retornam
  `null`/`false` em erro e preenchem `error`.
- As consultas usam `(supabase as any).from(...)` porque `Database` em `database.types.ts`
  não segue o formato gerado pelo Supabase CLI. Mantenha o padrão ou gere tipos com o CLI
  (`supabase gen types`) e migre tudo de uma vez.
- **A autorização real é o RLS**. Checagens de `role` no frontend só escondem botões.
- Hooks novos carregam dados em `useEffect` com flag `cancelled` e sem setState síncrono
  no effect (regra `react(set-state-in-effect)` do oxlint). Não exporte constantes de arquivos de componente.
- Integração por URL: `/tarefas?novo=1&jovem=<id>` ou `&alerta=<id>` abre nova tarefa pré-preenchida.
- Formulários em `Modal` (bottom-sheet no mobile). `window.confirm` para exclusões.
- Layout: sidebar no desktop; bottom-nav no mobile com itens principais + menu "Mais".
- **Design system** (`src/index.css`, `docs/REDESIGN.md`): as escalas do Tailwind (gray/blue/red/amber/green) são redefinidas com a
  paleta aprovada, então classes de paleta caem nas cores certas; código novo usa as utilities semânticas (`bg-canvas`,
  `bg-surface`, `border-line`, `text-ink`/`-soft`/`-muted`/`-faint`, `bg-action`, `bg-brand`, `*-success|warning|danger-soft|line|ink`,
  `text-title`/`text-heading`/`text-label`/`text-caption`, `rounded-tag`/`rounded-control`/`rounded-card`/`rounded-sheet`), que
  trocam sozinhas no modo escuro (classe `.dark`; classes de paleta dependem da "ponte de legado" do mesmo arquivo).
  Componentes compartilhados em `components/ui`: `Button`, `Field`/`Select`/`Textarea`, `Badge` (= `Tag`), `Card`/`Panel`/
  `SectionCard`/`Stat`/`StatGrid`/`Tabs`, `Banner` (em `components/ErrorBanner`); classes em `lib/formStyles.ts` (botões, campos,
  tabelas). Não use `rounded-lg/xl` nem `font-bold`: os raios são por papel e a fonte só tem 400/500/600.
  Fonte: IBM Plex Sans auto-hospedada (`@fontsource/ibm-plex-sans`; a CSP só aceita `font-src 'self'`).

## Banco de dados (Supabase / Postgres)

Enums: `user_role (coordinator, leader)`, `gender_type`, `event_status (scheduled, completed,
cancelled)`, `alert_type (consecutive_absences)`, `alert_status (open, resolved, dismissed)`,
`task_status (pending, in_progress, done, cancelled)`, `task_priority (low, medium, high)`.

| Tabela | Descrição |
|---|---|
| `profiles` | 1:1 com `auth.users` (criado pelo trigger `handle_new_user`) |
| `user_roles` | papel do usuário (default `leader`). Alterado só via RPC `set_user_role` |
| `groups` | grupos, com `leader_id` → **`public.profiles(id)`** (não `auth.users`; ver nota abaixo) |
| `youth` | jovens; `group_id` opcional; `is_active` (desativação lógica, sem delete) |
| `events` | encontros; `event_groups` liga encontro ↔ grupos participantes |
| `attendance` | presença por (event, youth), `group_id` desnormalizado para RLS, `recorded_by` |
| `app_settings` | linha única (`id = true`): `absence_alert_threshold` (3), `low_attendance_threshold` (70%) |
| `alerts` | alertas gerados **pelo banco** (faltas consecutivas); 1 aberto por jovem/tipo |
| `tasks` | tarefas/ações; podem referenciar jovem, grupo e alerta; `assigned_to` → profiles |

### Funções / RPCs

- `get_my_role()` — SECURITY DEFINER, evita recursão de RLS em `user_roles`. Use-a nas policies.
- `set_user_role(p_user_id, p_role)` — só coordenador; impede remover o último coordenador;
  serializado com `pg_advisory_xact_lock` (migration 008) contra corrida entre chamadas concorrentes.
- `save_event(p_event_id, p_title, p_description, p_event_date, p_status, p_group_ids)` — SECURITY INVOKER (RLS vale);
  cria (id NULL) ou edita o encontro e sincroniza `event_groups` atomicamente (migration 009). `useEvents`
  usa só ela; não volte a fazer DELETE/INSERT de `event_groups` em chamadas separadas.
- `recalculate_all_alerts()` — só coordenador; recalcula alertas de todos os jovens.
- Internas (sem EXECUTE para clientes): `youth_consecutive_absences`, `refresh_youth_alert`.

### Fase 7 — produto (migrations 010-017; detalhes no cabeçalho de cada migration)

- **Chamada**: 3 estados. "Não registrado" = **sem linha** em `attendance` (nunca é falta). Salvar = RPC `save_attendance`
  (só as linhas editadas; `group_id` derivado no banco). O histórico de presença **segue o jovem** ao mudar de grupo (012).
- **Alertas** (`alert_type`): `consecutive_absences`, `low_attendance`, `attendance_drop`, `no_followup`, `overdue_action`; `severity`
  attention/critical. Resolver/dispensar **nunca** altera presença; só uma presença quebra a sequência; encerrado manualmente não
  é recriado na mesma sequência. Os de tempo vêm de `sync_time_alerts()` (chamada ao abrir Alertas/Dashboard; throttle 60 s no banco).
- **Acompanhamento** (`follow_ups`): só o responsável atual é "ativo"; transferência = RPC `transfer_follow_up` + histórico imutável.
  **Situação do jovem** = `youth_situation(s)` (regra objetiva em comentário no SQL; não é diagnóstico).
- **Dashboard/Grupos/Relatórios**: agregação no SERVIDOR (`dashboard_overview`, `group_indicators`, `report_*`) respeitando o escopo;
  nada de "ranking". Exportação CSV/PDF no cliente (`lib/reportExport.ts`, `reportPdf.ts` com `jspdf` carregado sob demanda;
  `neutralizeFormula` contra injeção de fórmula). Períodos puros em `lib/periods.ts` (fuso America/Sao_Paulo).
- **Encontros recorrentes** (`event_series`, RPCs de série; sem duplicidade por `(series_id, series_date)`), **busca global**
  (`global_search`, Ctrl/⌘+K), **lote** (`batch_set_youth_*`, máx 200), **Histórico** (`activity_log`, só escrita por trigger).
- **E-mail**: único canal; **envio real server-side** (Edge Function `send-communication`, migrations 018/019; `begin/finish_communication_send` só `service_role`). Status draft/sending/sent/failed/cancelled; `sent` só após sucesso do provedor; o cliente nunca define `sending`/`sent`. Líder envia só ao e-mail cadastrado do jovem. Nenhum segredo no frontend. Config do provedor: docs/EMAIL.md.
- Líder desassocia jovem via `batch_set_youth_group([id], null)` (UPDATE direto falha no RLS porque a linha nova não passa no SELECT).
- Layout: o documento rola (não o `<main>`); `Modal` usa `z-[60]` acima da bottom-nav.
- CSP: meta injetada só no **build** (`vite.config.ts`); headers HTTP em `public/_headers`. Hospedagem: Cloudflare Workers (assets) via `wrangler.jsonc`; o fallback de SPA é `not_found_handling: "single-page-application"` (não existe `public/_redirects`; ver README).
- **020**: `create_event_series` recusa série ativa idêntica; trigger bloqueia excluir encontro com chamada (cancelar é o caminho). **021**: `anonymize_youth(id)` (coordenador, irreversível; mantém id/grupo/presença).

### FKs e embeds do PostgREST

Colunas que o frontend embeda via `.select('*, alias:coluna(campo)')` **precisam**
de uma FK apontando para uma tabela do schema `public` — `auth` não é exposto à
API, então uma FK para `auth.users` nunca gera relacionamento visível ao
PostgREST. Toda coluna que representa "um usuário do app" deve referenciar
`public.profiles(id)` (ex.: `tasks.assigned_to`, e desde a migration 007,
`groups.leader_id`). Bug já corrigido: `groups.leader_id` apontava para
`auth.users`, causando `Could not find a relationship between 'groups' and
'leader_id' in the schema cache` no embed `profiles:leader_id(full_name)` de
`useGroups.ts`. Após qualquer `ALTER TABLE`/`ADD CONSTRAINT` manual no SQL
Editor, rode `NOTIFY pgrst, 'reload schema';` para garantir que o cache do
PostgREST reflita a mudança imediatamente.

### Lógica de alertas (no banco, via triggers)

- Após INSERT/UPDATE/DELETE em `attendance`, mudança de `status`/`event_date` em `events`,
  mudança de `is_active`/`group_id` em `youth` e mudança do limite em `app_settings`,
  o banco chama `refresh_youth_alert(youth_id)`.
- Faltas consecutivas = registros de chamada mais recentes com `present = false`
  (encontros `cancelled` são ignorados) até a última presença.
- Se `>= absence_alert_threshold` e jovem ativo → cria (ou atualiza) alerta `open`.
  Se cair abaixo do limite ou o jovem for inativado → alerta aberto vira `resolved` automaticamente.
- Um alerta fechado manualmente não é recriado enquanto não houver nova falta (compara `last_event_id`).
- Ao concluir (`done`) uma tarefa com `alert_id`, o alerta aberto é resolvido automaticamente.
- Clientes não inserem alertas; podem apenas mudar `status`/`resolution_notes`
  (trigger `alerts_guard` bloqueia alteração dos demais campos e preenche `resolved_by/at`).

### RLS — resumo por papel

- **Coordenador** (`get_my_role() = 'coordinator'`): acesso total a groups, youth, events,
  event_groups, attendance, alerts (sem INSERT), tasks; lê todos profiles/user_roles;
  atualiza `app_settings`.
- **Líder**:
  - `groups`: lê/edita apenas onde `leader_id = auth.uid()` (não pode trocar o líder).
  - `youth`: lê/edita jovens dos seus grupos; pode desassociar (`group_id = NULL`), não mover
    para grupo alheio; **não cadastra** jovens.
  - `events`/`event_groups`: lê apenas encontros vinculados aos seus grupos.
  - `attendance`: lê/insere/atualiza só dos seus grupos, com jovem do grupo, encontro do grupo
    e `recorded_by = auth.uid()`.
  - `alerts`: lê/atualiza status de alertas de jovens dos seus grupos.
  - `tasks`: lê tarefas atribuídas a ele, criadas por ele ou dos seus grupos/jovens; cria
    tarefas para si mesmo (ou sem responsável) só com jovens/grupos seus; exclui só as que criou.
    Trigger `tasks_guard` impede líder de reatribuir para terceiros ou apontar para grupo/jovem alheio.
  - `profiles`: lê/edita apenas o próprio. `app_settings`: somente leitura.
- `anon`: nenhum acesso a dados.

### Testes de banco

`tests/db/` sobe um Postgres real em memória (PGlite), cria stubs do Supabase
(`auth.users`, `auth.uid()`, roles `anon`/`authenticated`, privilégios default), aplica
**todas** as migrations em ordem e verifica RLS e triggers simulando usuários
(`set role authenticated` + `request.jwt.claim.sub`). Ao criar migration, adicione testes lá.
`security-audit.test.ts` cobre especificamente adulteração de IDs/payload (attendance,
alerts, tasks, groups, youth), bypass de RPC (grant-level, não só a checagem interna) e
funções-trigger não chamáveis via RPC. **Limitação conhecida:** o harness roda em uma única
conexão lógica sequencial — não reproduz corrida real entre duas transações concorrentes
(ex.: dois `set_user_role()` simultâneos); isso está documentado no próprio teste em vez de
ser fingido. A condição de corrida de `set_user_role()` é mitigada no SQL via
`pg_advisory_xact_lock` (migration 008), não validada por teste de concorrência real.

## Erros e observabilidade (frontend)

Detalhes e justificativas: `docs/OBSERVABILIDADE.md`.
- **Mensagem na tela**: sempre `errorMessage(err, 'Erro ao <fazer X>.')` (lib/format.ts). Ela traduz códigos conhecidos
  (RLS, FK, duplicado, rede, sessão, migration ausente…) para pt-BR e **nunca** devolve o texto cru do servidor
  (nomes de tabela/constraint, inglês). Só passam mensagens escritas por nós no banco (`P0001`/`P0002`/`42501`
  customizado). Nunca exiba `error.message` diretamente.
- **Registro**: `errorMessage` também chama `logError` (lib/logger.ts): uma linha sanitizada no console
  (`[conectjovem] <id> contexto (código): msg`), sem stack, `details`/`hint`, tokens, e-mails ou UUIDs.
  Para plugar um serviço de monitoramento no futuro: `setErrorReporter(fn)` em `main.tsx` — nenhum call-site muda.
- **Rede de segurança**: `ErrorBoundary` na raiz e dentro do Layout (`key={rota}`), mais captura global de
  `error`/`unhandledrejection` (lib/globalErrors.ts). A tela mostra só o *código do incidente*.
- **Sem erro silencioso**: não escreva `.catch(() => {})`; mostre (`setError`) ou ao menos `logError`.
- **Sucesso de mutação**: `useToast().success('...')` (contexts/ToastContext.tsx).

## Autenticação (frontend)

- E-mail + senha (Supabase Auth). `AuthContext` expõe `sessionLost` (sessão acabou sem o usuário pedir),
  `profileError` (perfil/papel não carregaram) e `passwordSetupPending` (veio de link de recuperação/convite).
- `src/lib/supabase.ts` lê o fragmento da URL (`#...type=recovery|invite`) **antes** de criar o cliente, porque o
  supabase-js o consome e apaga; `lib/authLink.ts` faz o parse (puro, testado).
- Rotas públicas: `/login`, `/recuperar-senha`, `/redefinir-senha` (destino dos links de e-mail; título "Defina sua senha"
  para convite). `PasswordSetupGate` (App.tsx) mantém quem veio de link na tela de senha até concluir.
- `ProtectedRoute`: sem usuário → login (com aviso se a sessão acabou sozinha); usuário sem papel carregado →
  `ProfileLoadError` (fail-closed, tentar de novo/sair); `allowedRoles` segue fail-closed.
- Erros do GoTrue são sempre traduzidos por `translateAuthError(msg, fallback)`; nunca exiba `error.message` cru.
- **Convite não é feito pelo app** (exigiria `service_role` ou backend novo): usar o painel do Supabase. Configuração de
  Site URL/Redirect URLs: ver README.

## Decisões importantes

- Alertas são calculados no banco (triggers) para funcionarem independentemente de quem
  salvou a chamada e para respeitar RLS sem expor dados de outros grupos.
- Relatórios são agregados no banco (RPCs `report_*`, escopo por papel); o cliente só formata e exporta
  (`src/lib/reportExport.ts`, puro e testado).
- Criação de usuários é feita no painel do Supabase (Auth); o app gerencia apenas papéis
  (via RPC) e o próprio perfil/senha.
- `/settings` é acessível a todos: seção "Meu perfil" para todos; parâmetros do sistema e
  gestão de papéis só para coordenador (e protegidos por RLS/RPC).
