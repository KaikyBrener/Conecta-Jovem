# CLAUDE.md — Conecta Jovem

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
  lib/reports.ts       agregações puras de frequência (testadas em src/lib/*.test.ts)
  lib/csv.ts           exportação CSV
  lib/fetchAll.ts      paginação (PostgREST limita 1000 linhas por resposta) — use em agregações
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
- `recalculate_all_alerts()` — só coordenador; recalcula alertas de todos os jovens.
- Internas (sem EXECUTE para clientes): `youth_consecutive_absences`, `refresh_youth_alert`.

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

## Decisões importantes

- Alertas são calculados no banco (triggers) para funcionarem independentemente de quem
  salvou a chamada e para respeitar RLS sem expor dados de outros grupos.
- Relatórios agregam no cliente dados já filtrados pelo RLS (volume pequeno); a lógica
  fica em `src/lib/reports.ts` (pura e testada).
- Criação de usuários é feita no painel do Supabase (Auth); o app gerencia apenas papéis
  (via RPC) e o próprio perfil/senha.
- `/settings` é acessível a todos: seção "Meu perfil" para todos; parâmetros do sistema e
  gestão de papéis só para coordenador (e protegidos por RLS/RPC).
