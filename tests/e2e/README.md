# Testes E2E (Playwright)

Validam o comportamento real do Conecta Jovem no navegador. **Nenhum dado real é usado** e o
Supabase de produção/desenvolvimento nunca é tocado.

```bash
npx playwright install chromium   # uma vez
npm run test:e2e                  # sobe tudo sozinho (servidor falso + Vite) e roda desktop + mobile
npx playwright test auth          # só um arquivo
npx playwright test --ui          # modo interativo
E2E_CHANNEL=msedge npm run test:e2e   # usa o Edge/Chrome instalado em vez do Chromium do Playwright
```

`npm test` (Vitest) continua independente e **não** roda estes testes.

## Como funciona

```
Playwright ──▶ Vite dev (127.0.0.1:5174)  ──▶  Supabase FALSO (127.0.0.1:54321)
                 VITE_SUPABASE_URL/KEY              GoTrue (/auth/v1) + PostgREST (/rest/v1)
                 vêm do webServer.env,              sobre PGlite com TODAS as migrations
                 não do .env                        (RLS, triggers de alerta e constraints reais)
```

- `fake-supabase/server.ts` — API HTTP compatível com o supabase-js (login/refresh/logout/updateUser)
  e endpoints de controle `/__test/{reset,users,sql}`. Reusa `tests/db/harness.ts`.
- `fake-supabase/postgrest.ts` — tradutor do subconjunto de PostgREST que o app usa (select com embeds
  e `!inner`, filtros, order, range/count, insert/upsert/update/delete, rpc, inclusive funções SETOF/TABLE que devolvem array). Cada requisição roda
  numa transação com `SET LOCAL ROLE authenticated` + `request.jwt.claim.sub`, como o PostgREST faz.
  Isso significa que **a autorização testada é o RLS de verdade**, e que alertas são gerados pelos
  triggers do banco ao salvar a chamada.
- `fixtures.ts` — banco limpo a cada teste (`db`), login por sessão injetada (`loginAs`), seed
  (`createGroup`, `createYouth`, `createEvent`, `recordAttendance`) e helpers de UI.
- Os dois servidores são sempre iniciados do zero (`reuseExistingServer: false`) para garantir que
  um dev server já aberto, apontando para o Supabase real do `.env`, nunca seja reaproveitado.
  Se as portas 5174/54321 estiverem ocupadas, ajuste `E2E_APP_PORT` / `E2E_SUPABASE_PORT`.
- O PostgREST falso aplica o teto de **1000 linhas** (max-rows) como o real, então consultas sem paginação/`fetchAll` aparecem como falhas nos testes de volume.
- O banco falso é único: os testes rodam em série (`workers: 1`).
- `/__test/reset` trunca as tabelas de `public`, **exceto** `app_settings` e `time_alerts_sync_state` (linhas únicas criadas pelas migrations; a
  segunda guarda o throttle de 60 s de `sync_time_alerts()` e volta a `-infinity` a cada teste). Dentro de um teste, reabrir `/alertas` em
  menos de 60 s **não** varre de novo: depois de "envelhecer" alertas (`db.ageAlerts`) chame `db.resetSyncThrottle()`.

## Cobertura

  Arquivo   Fluxos |
|---|---|
| `auth.spec.ts` | login (ok, senha errada, vazio, e-mail inválido, loading, rede, teclado, mostrar senha), redirects, rota protegida, refresh da página, logout |
| `navigation.spec.ts` / `.mobile.spec.ts` | navegação entre páginas, sidebar recolher/expandir (persiste), dark mode (persiste), bottom-nav e "Mais" no mobile, sem scroll horizontal no login |
| `groups.spec.ts` | criar/editar grupo, validações, busca, loading, erro de servidor, restrições do líder |
| `events-attendance.spec.ts` | criar/editar/excluir encontro, filtros, abrir chamada, salvar/corrigir presença, loading/erro, restrições do líder |
| `attendance-states.spec.ts` / `.mobile.spec.ts` | chamada com 3 estados (não registrado/presente/ausente), busca, filtros e contagens, ação em lote, salvar só marcados (RPC `save_attendance`), resumo pós-salvar e novos alertas, cancelado somente leitura, líder, erro de servidor, 390px |
| `alerts-tasks.spec.ts` | alerta gerado pelo banco ao salvar chamada, dispensar/reabrir, alerta → tarefa → concluir resolve o alerta, CRUD de tarefas, restrições do líder |
| `alerts-lifecycle.spec.ts` | tipos/severidade/filtros de alertas, resolver e dispensar sem apagar faltas, histórico (Resolvidos/Dispensados), sem duplicidade, nova sequência de faltas, alertas por tempo (sem acompanhamento, ação atrasada) |
| `followups.spec.ts` / `.mobile.spec.ts` | acompanhamento (criar, validar, editar, vincular alerta/ação, concluir por acompanhamento, excluir), transferência de responsável e histórico, líder só nos seus jovens (RLS por API), situação Normal/Atenção/Crítico/Inativo, ações atrasadas, ficha em 390px |
| `communications.spec.ts` / `.mobile.spec.ts` | e-mail ASSISTIDO (migration 015): alerta/ficha/acompanhamento -> destinatário sugerido -> modelo -> revisão -> `mailto:` interceptado (Navigation API em `communications-helpers.ts`; nenhum cliente de e-mail abre) -> Enviei / Não consegui (4 motivos) / cancelar / decidir depois, selo no alerta, histórico sem dados do e-mail, validações e injeção de cabeçalho (UI e API), enviada imutável, permissões coordenador x líder, jovem excluído preserva histórico, erro 500, vazamento no console, 390px |
| `password.spec.ts` / `.mobile.spec.ts` | esqueci minha senha (genérico, 429, rede), link de recuperação e de convite (definir senha, validações, link expirado), sessão encerrada em outra aba, perfil não carregado, troca de senha traduzida |
| `pagination.spec.ts` / `.mobile.spec.ts` | paginação server-side de Jovens, Encontros, Grupos, Tarefas e Usuários: 1ª/próxima/última página, filtro + paginação, estado vazio, RLS do líder, >1000 linhas, dropdowns completos, mobile |
| `access.spec.ts` | Configurações por papel, RLS por chamadas diretas à API (anônimo, líder), renovação e queda de sessão |
| `alerts-pagination.spec.ts` | alertas paginados no servidor (45 alertas inseridos no banco): 1ª/próxima/última página, filtros de status/tipo/severidade + paginação, mudar filtro volta à página 1, estado vazio, página que esvazia volta à última, líder (RLS), contador "Abertos" = selo do menu, selo atualiza ao desativar jovem / cancelar encontro / salvar chamada |
| `settings.spec.ts` | Configurações: faltas para alerta crítico (`#crit`) e carência do acompanhamento (`#grace`): validação (crítico >= limite, carência 1..90, nativa e do app), persistência, efeito real na severidade/situação e no alerta "sem acompanhamento" |
| `hardening.spec.ts` | migration 016: throttle de 60 s de `sync_time_alerts()` (UI e API), tabela de estado fechada para clientes, anon sem privilégio em TODAS as tabelas, relatórios do líder com "Encontro de outro grupo" e `event_id` nulo (API e telas) |
| `session.spec.ts` | troca de usuário no mesmo navegador sem recarregar (coordenadora <-> líder: papel, menu, dados, selo), voltar após sair, sessão que expira durante o uso (refresh recusado, falha de rede, renovação automática) |
| `history.spec.ts` | histórico operacional: o que é registrado, filtros, busca por jovem com > 200 jovens (embed `!inner`, sem truncar), paginação, líder, imutabilidade |

## Limitações

- O PostgREST/GoTrue são **simulados** (só o subconjunto usado pelo app). Diferenças sutis de formato de
  erro/headers em relação ao Supabase real podem existir; teste manual contra o Supabase real continua
  necessário antes de um release.
- Mudou uma consulta do app para algo que o tradutor não suporta (novo operador, embed, etc.)? O servidor
  responde `400 PGRST100/PGRST200` — estenda `postgrest.ts`.

## Bugs encontrados e corrigidos

| Bug | Correção | Regressão |
|---|---|---|
| Salvar **Configurações → Parâmetros de acompanhamento** gravava o valor, mas a mensagem "Configurações salvas." nunca aparecia: `<SettingsForm key={settings.updated_at}>` era remontado quando `updated_at` mudava e perdia o estado `ok`. | Removido o `key` em `src/pages/Configuracoes.tsx` (os campos já contêm o valor salvo). | `access.spec.ts` › "salvar parâmetros mostra a confirmação…" |
