# Conecta Jovem

Sistema web mobile-first para gestão de ministério jovem: jovens, grupos, encontros,
chamada (presença), histórico, alertas de faltas, tarefas de acompanhamento, relatórios e configurações.

Fluxo principal: **Jovens → Grupos → Encontros → Chamada → Histórico → Alertas → Tarefas**.
Ao salvar uma chamada, o banco recalcula as faltas consecutivas de cada jovem e abre um alerta
quando o limite configurado é atingido. A partir do alerta cria-se uma tarefa (ex.: “Ligar para o jovem”);
concluir a tarefa resolve o alerta.

## Stack
- React 19 + TypeScript + Vite 8
- Tailwind CSS v4
- Supabase (Postgres, Auth e Row Level Security)
- Vitest + PGlite (testes unitários e de banco)

## Rodando localmente

1. Copie `.env.example` para `.env` e preencha `VITE_SUPABASE_URL` e `VITE_SUPABASE_PUBLISHABLE_KEY`
   (a chave *publishable*/*anon* do projeto — nunca a `service_role`).
2. `npm install`
3. `npm run dev`

Outros comandos: `npm run lint`, `npm run build`, `npm test`.

## Banco de dados (migrations)

As migrations em `supabase/migrations/` são a **fonte da verdade** do schema. Execute-as **em ordem**
no SQL Editor do Supabase:

| Arquivo | Descrição |
|---|---|
| `001_base.sql` | Schema base: profiles, user_roles, groups, youth, RLS iniciais e triggers |
| `002_fix_rls_coordinator_profiles_and_leader_youth_update.sql` | Coordenador lê profiles/roles; líder pode desassociar jovem do grupo |
| `003_events_and_attendance.sql` | Encontros: events, event_groups e attendance |
| `004_fix_rls_attendance.sql` | Valida chaves estrangeiras no RLS de attendance para líderes |
| `005_fix_rls_attendance_recorded_by.sql` | Impede que líderes falsifiquem `recorded_by` |
| `006_settings_alerts_tasks.sql` | Configurações (`app_settings`), alertas automáticos de faltas, tarefas, RPCs `set_user_role` e `recalculate_all_alerts`, hardening de funções e índices |
| `007_fix_groups_leader_profiles_fk.sql` | Corrige `groups.leader_id` para referenciar `public.profiles(id)` (antes apontava para `auth.users`, schema não exposto ao PostgREST — quebrava o embed `profiles:leader_id(...)` usado em `/grupos`) e força o reload do cache de schema do PostgREST |
| `008_set_user_role_race_fix.sql` | Corrige uma condição de corrida (TOCTOU) em `set_user_role()`: serializa chamadas concorrentes com `pg_advisory_xact_lock` para impedir que dois rebaixamentos simultâneos resultem em 0 coordenadores |

A 006 termina calculando os alertas para o histórico de chamadas já existente.

> **Nota sobre FKs e PostgREST:** qualquer coluna que precise ser "embedada" via
> PostgREST (`.select('*, alias:coluna(campo)')`) deve referenciar uma tabela do
> schema `public` — nunca `auth.users` diretamente, pois `auth` não é exposto à
> API. Prefira sempre `REFERENCES public.profiles(id)` quando a coluna representa
> um usuário do app (como já é feito em `tasks.assigned_to`).

### Papéis

- **Coordenador**: acesso total; cadastra jovens, grupos e encontros; define parâmetros e papéis em Configurações.
- **Líder**: vê e gerencia apenas seus grupos, jovens, encontros, chamadas, alertas e tarefas.

Novos usuários são criados no painel do Supabase (*Authentication → Users*). O trigger
`handle_new_user` cria o perfil com papel **líder** (o nome vem de `full_name` nos metadados).
Para o **primeiro coordenador**, rode uma vez no SQL Editor:

```sql
UPDATE public.user_roles SET role = 'coordinator'
WHERE user_id = (SELECT id FROM auth.users WHERE email = 'seu-email@exemplo.com');
```

Depois disso, os papéis são geridos pela tela **Configurações**.

### Parâmetros (Configurações)

| Parâmetro | Padrão | Uso |
|---|---|---|
| Faltas consecutivas para alerta | 3 | Gera alerta automático |
| Frequência mínima esperada | 70% | Destaque no Dashboard e em Relatórios |

## Testes

`npm test` roda:
- `src/lib/*.test.ts` — agregações de relatórios, formatação e CSV;
- `tests/db/*.test.ts` — sobe um Postgres em memória (PGlite) com stubs do Supabase, aplica **todas**
  as migrations e verifica RLS, triggers de alertas, tarefas e RPCs simulando coordenador, líderes e anônimo.

Os testes de banco não substituem um teste no Supabase real (PostgREST/Auth não são simulados).
