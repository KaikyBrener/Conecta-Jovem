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
| `009_save_event_atomic.sql` | RPC `save_event` (SECURITY INVOKER): cria/edita o encontro **e** sincroniza `event_groups` numa única transação, evitando encontro sem grupos quando o INSERT dos vínculos falha. RLS e policies inalteradas; EXECUTE só para `authenticated` |

| `010_attendance_states_alerts.sql` | Chamada com 3 estados (RPC `save_attendance`: "não registrado" = sem linha, não conta como falta); alertas objetivos com severidade (`attention`/`critical`) e novos tipos `low_attendance` e `attendance_drop`; regra "resolver/dispensar nunca apaga faltas, só uma presença quebra a sequência" |
| `011_followups_actions_situation.sql` | Acompanhamentos (`follow_ups`) com transferência de responsável e histórico (`follow_up_transfers`, RPC `transfer_follow_up`); alertas por tempo `no_followup` e `overdue_action` (RPC `sync_time_alerts`); situação do jovem (`youth_situation(s)`: normal/atenção/crítico por regra objetiva); RPCs de apoio `assignable_responsibles` e `follow_up_people` |
| `012_attendance_group_sync_dashboard.sql` | O histórico de presença acompanha o jovem quando ele muda de grupo (trigger + backfill); RPCs `dashboard_overview` e `group_indicators` |
| `013_reports.sql` | Relatórios agregados no servidor: `report_general`, `report_attendance`, `report_followups`, `report_alerts`, `report_youth`, `report_groups` (respeitam o escopo do chamador) |
| `014_series_search_batch_activity.sql` | Encontros recorrentes (`event_series`, RPCs `create_event_series`/`set_series_groups`/`extend_event_series`/`cancel_event_series_future`), busca global (`global_search`), ações em lote (`batch_set_youth_group`/`batch_set_youth_active`) e histórico operacional imutável (`activity_log`) |
| `015_communications_email.sql` | Comunicações por e-mail **assistidas** (`communications`, RPC `mark_communication`, `suggest_communication_recipients`): o sistema registra o que o usuário confirma ter enviado; não envia e-mail sozinho |
| `016_security_hardening.sql` | Throttle de `sync_time_alerts` no banco, relatórios do líder sem título de encontro alheio, histórico de transferências protegido contra exclusão, e-mail sem `%`, REVOKE de TRUNCATE/REFERENCES/TRIGGER e de qualquer acesso do `anon`, `pg_temp` no `search_path` das funções DEFINER |
| `017_final_fixes.sql` | Grupo com jovens ou histórico de chamada não pode ser excluído (e o log de atividade nunca grava grupo inexistente); nota correta ao resolver `no_followup`; funções-trigger sem EXECUTE para clientes. O cabeçalho traz a checagem de e-mails legados com `%` a rodar **antes** da 016 |

A 006 termina calculando os alertas para o histórico de chamadas já existente.

> **Depois de aplicar as migrations 010+ no Supabase:** as migrations 010 e 011 adicionam valores a `alert_type`
> (`ALTER TYPE … ADD VALUE`), que não podem ser usados na mesma transação — por isso **não** geram alertas
> sozinhas. Entre como coordenador e use **Configurações → Recalcular alertas** uma vez. Rode também
> `NOTIFY pgrst, 'reload schema';`. A 016 traz no cabeçalho uma consulta para conferir os grants.
> **Alertas por tempo** (`no_followup`, `overdue_action`) são calculados quando alguém abre Alertas ou o Dashboard
> (`sync_time_alerts`, com throttle de 60 s); não há `pg_cron`. Opcional: agendar `pg_cron` chamando essa função.

### E-mail (envio assistido) e dependências externas

O app **não** envia e-mail e **não** guarda nenhum segredo/`service_role`. Fluxo: alerta/acompanhamento → rascunho →
revisão → "Abrir no aplicativo de e-mail" (`mailto:`) → o usuário confirma "Enviei" / "Não consegui" → histórico.
O sistema só registra como enviado o que o usuário confirmar. Envio automático exigiria uma **Edge Function com segredo
no servidor** (provedor de e-mail/SMTP, domínio com SPF/DKIM) — dependência externa **não implementada**.
Dados de menores: `communications` retém destinatário e corpo (o histórico sobrevive à exclusão do jovem) e
`activity_log` não tem teto — **retenção/expurgo (LGPD) ainda não implementado**.

> **Nota sobre FKs e PostgREST:** qualquer coluna que precise ser "embedada" via
> PostgREST (`.select('*, alias:coluna(campo)')`) deve referenciar uma tabela do
> schema `public` — nunca `auth.users` diretamente, pois `auth` não é exposto à
> API. Prefira sempre `REFERENCES public.profiles(id)` quando a coluna representa
> um usuário do app (como já é feito em `tasks.assigned_to`).

### Autenticação: recuperação de senha e convites

O app usa **e-mail + senha** do Supabase Auth. Não há cadastro aberto; usuários são criados pela coordenação.

| Fluxo | Como funciona |
|---|---|
| Entrar / sair / sessão | `/login`; a sessão persiste no navegador e é renovada sozinha. Se acabar sem o usuário pedir (expirou, saiu em outra aba), o login avisa o motivo |
| **Esqueci minha senha** | `/recuperar-senha` pede o e-mail; o Supabase envia um link que abre `/redefinir-senha`. A resposta é sempre a mesma exista ou não a conta |
| **Convite** | *Authentication → Users → Invite user* (painel do Supabase). O link abre o app já autenticado e o leva a "Defina sua senha" |
| Trocar a senha logado | Configurações → Meu perfil |

**Convites não são feitos pelo app** de propósito: enviar convite exige a chave `service_role`, que nunca pode ir para o
frontend, e criar um backend/Edge Function só para isso foge da arquitetura (sem backend próprio). Papéis continuam sendo
atribuídos em Configurações depois do primeiro acesso.

**Configuração obrigatória no painel do Supabase** (*Authentication → URL Configuration*), senão os links de e-mail falham:
- **Site URL**: a URL de produção do app (ex.: `https://conectajovem.exemplo.com`). É para onde o link de convite aponta.
- **Redirect URLs**: inclua `https://<seu-dominio>/redefinir-senha` (e `http://localhost:5173/redefinir-senha` em desenvolvimento).
- *Authentication → Email Templates*: revise os textos de "Invite user" e "Reset password" (podem ser traduzidos para pt-BR).
- *Authentication → Providers → Email*: ajuste o tamanho mínimo da senha (o app valida 6 no cliente; o Supabase aplica a política do projeto).
- O envio padrão do Supabase tem limite de e-mails por hora; para uso real configure um SMTP próprio (*Project Settings → Auth → SMTP*).

Quem chega por um link de recuperação/convite fica autenticado pela sessão do link (comportamento padrão do Supabase) e o
app o mantém em "Defina sua senha" até concluir. Isso é guia de experiência: a autorização continua sendo o RLS.

**Por que não PKCE:** o link de e-mail costuma abrir em outro dispositivo ou webview (leitor de e-mail), onde o
*code verifier* guardado no navegador de origem não existe, e o fluxo quebraria; além disso o convite não usa PKCE.

### CSP e headers

- **Aplicado pelo app (só no `npm run build`)**: um plugin em `vite.config.ts` injeta no `dist/index.html` uma
  `<meta http-equiv="Content-Security-Policy">`: `default-src 'self'`; scripts só `'self'` + o hash SHA-256 do script
  inline de tema (calculado no build); `style-src`/`font-src`/`manifest-src` `'self'`; `img-src 'self' data:`;
  `connect-src 'self'` + a origem de `VITE_SUPABASE_URL`; `object-src 'none'`; `base-uri`/`form-action` `'self'`.
  O build **falha** se `VITE_SUPABASE_URL` não estiver definida. `npm run dev` e o E2E não recebem CSP.
- **Depende do host (ainda não definido)**, pois não funciona via `<meta>`: `frame-ancestors` (ou `X-Frame-Options`),
  `Strict-Transport-Security` (HSTS), `X-Content-Type-Options: nosniff` e `Referrer-Policy`. Configure-os como
  headers HTTP no host/CDN quando ele for escolhido. Se mudar o script inline do `index.html`, rebuild (o hash é recalculado).

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
