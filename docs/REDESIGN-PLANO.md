# Redesign — levantamento (fase 1)

Data: 16/10/2026 · Branch: `redesign-conectjovem` (criada a partir de `redesign-frontend`, sem commits)
Fonte: canvas "ConectJovem — projeto visual completo" (154 telas, 10 páginas), lido direto do claude.ai.
A pasta `design/` não existe e não foi necessária.

## Conclusão

**A maior parte do redesign já está no código.** O commit `b50df99` ("aplica o projeto visual aprovado em todo o
front-end") aplicou tokens, fonte, componentes base, menu, barras e os 10 módulos. O que este levantamento
encontrou:

- **Tokens:** os valores do DS-1 já estão em `src/index.css`, inclusive o modo escuro. Os tokens `.dark` são
  idênticos à prancha "Modo escuro · Proposta de cores" (`#0B1220`, `#111C2E`, `#182438`, `#202F47`, `#2F6FE0`,
  `#93C5FD`, `#FCA5A5`, `#FCD34D`, `#86EFAC`).
- **Textos:** 6.110 textos visíveis das 154 telas foram procurados em `src/`. Quase todos os que não foram
  encontrados são dados de exemplo, títulos das pranchas, anotações do próprio design ou textos montados por
  template (contagens, datas).
- **Tabelas:** as colunas de Jovens, Grupos, Encontros, Histórico e Relatórios são as mesmas do design.

O que falta é **acabamento**: algumas telas e estados pontuais, confirmações em janela própria e migração das
classes de legado para os tokens. Não é preciso refazer tokens nem layout. Refazer o que a fase 2 descreve
(passos 1 a 3 do pedido) seria retrabalho, com risco para o E2E e sem ganho visual.

## Linha de base (antes de qualquer mudança)

| Verificação | Resultado |
|---|---|
| `npm run lint` | ok: 0 erros, 7 avisos `no-unused-vars` em `tests/db/` (já existiam) |
| `npx tsc --noEmit -p tsconfig.app.json` | ok |
| `npm test` (vitest) | ok: 45 arquivos, 789 testes passaram, 6 pulados |
| `npm run build` | ok |
| E2E (Playwright, Edge do sistema via `E2E_CHANNEL=msedge`) | ok: 375 passaram (desktop + mobile), 0 falhas, 15,1 min |

O Chromium do Playwright não está instalado nesta máquina. Por isso o E2E rodou no Edge, opção que o
`tests/e2e/README.md` prevê.

## Módulo × status

Legenda de status: **Conforme** = igual ao design; **Ajuste pequeno** = diferenças de acabamento; **Falta** =
tela ou estado do design que não existe. Esforço: P (< 2 h), M (meio dia), G (1 dia ou mais). Risco = chance de
quebrar o E2E.

| # | Módulo | Status | O que difere do design | Arquivos | Esforço | Risco |
|---|---|---|---|---|---|---|
| 1 | Design system (DS-1 a DS-6) | Conforme, com 3 ajustes pequenos | **DS-5:** o estado vazio não tem o círculo de 44 px atrás do ícone nem a linha de ajuda. **DS-5:** falta o estado "Atualizando…" (as listas só esmaecem com `opacity-60`, sem o indicador e o texto). **DS-2:** `Button`/`Field`/`Select`/`Textarea` existem, mas têm 0 usos fora de `components/ui`; as telas usam `inputCls`/`labelCls` (mesmo visual). | `ui/EmptyState.tsx`, novo `ui/Refreshing` (ou prop em `LoadingBlock`), `lib/formStyles.ts` | P | Baixo |
| 1 | Visão geral | Ajuste pequeno | "Precisam de atenção" é uma lista; o design mostra uma tabela com Faltas seguidas, Frequência, Acompanhamento e Prioridade, dados que o servidor não devolve (pergunta 3c). Os demais painéis, o subtítulo, o gráfico e as versões líder e celular batem. | `pages/Dashboard.tsx` | P (lista) / G (tabela) | Baixo |
| 1 | Menu, barra inferior, "Mais" | Conforme | Item ativo, selo 99+, recolher/expandir, folha "Mais" e cabeçalho do celular batem com DS-6 e Navegação-variações. | `components/Layout.tsx` | — | — |
| 2 | Autenticação | Conforme | Entrar, recuperar, definir/redefinir (convite, link inválido, verificando) e perfil não carregado batem em texto e estados. Diferença única: o design desenha um monograma "J" provisório; o app usa o `Logo` real (preservado). | `components/auth/*`, `pages/Login.tsx`, `RecuperarSenha.tsx`, `RedefinirSenha.tsx` | — | — |
| 3 | Jovens | Ajuste pequeno | Lista, lote, ficha, formulários e anonimizar batem. As confirmações de lote ("Desativar 2 jovens?", "Ativar 2 jovens?") são `window.confirm`; o design usa janela própria. Muitas classes de legado: 53 em `Jovens.tsx` e 46 em `YouthDetail.tsx`. | `pages/Jovens.tsx`, `components/youth/*` | M | Médio (confirmações) |
| 4 | Grupos | Ajuste pequeno | O avatar do grupo é um círculo de 36 px em índigo; o design pede um quadrado de 32 px com raio 8, fundo `#E8F0FD` e texto `#174AA6`. Tabela, tendência em pp, estados e integrantes batem. | `pages/Grupos.tsx`, `components/groups/*` | P | Baixo |
| 5 | Encontros e séries | Ajuste pequeno | As confirmações para excluir encontro e cancelar os próximos da série são `window.confirm`; o design propõe janela própria. No celular, os filtros do design são abreviados ("Agend.", "Realiz.", "Cancel."). Lista, detalhe, formulários, série em 2 passos e avisos batem. | `pages/Encontros.tsx`, `components/events/*` | M | Médio (confirmações) |
| 6 | Chamada e histórico | Conforme | 3 estados, contadores "Todos (n)", "n jovens ficarão sem registro", "n alterações serão salvas", resumo com novos alertas e filtros do histórico batem. Só a migração de classes: 76 de legado em `Chamada.tsx`. | `pages/Chamada.tsx`, `pages/Historico.tsx` | P | Baixo |
| 7 | Alertas, acompanhamento e e-mail | Conforme | Janelas de resolver/dispensar, transferência, histórico do acompanhamento e os 3 passos do e-mail batem. Falta o rótulo "Reabrindo…" no botão. | `pages/Alertas.tsx`, `components/followups/*`, `components/communications/*` | P | Baixo |
| 8 | Tarefas e relatórios | Ajuste pequeno | A exclusão de tarefa usa `window.confirm` (o design propõe janela própria). Falta o estado "Atualizando…". As 6 abas de relatório, colunas, exportação e estados batem. | `pages/Tarefas.tsx`, `components/reports/*` | P/M | Médio (confirmação) |
| 9 | Configurações | Ajuste pequeno | Falta a ajuda "Mínimo de 10 caracteres. Ao alterar a senha, as outras sessões abertas são encerradas; esta continua." Os botões não trocam o rótulo durante a operação ("Alterando…", "Recalculando…"); hoje só o ícone vira spinner. Os formulários usam `inputCls` e poderiam usar `Field`. | `pages/Configuracoes.tsx` | P | Baixo |
| 10 | Busca global, erros, carregamentos, recolhido, tablet 820, escuro | Conforme | Textos da busca (mínimo de 2 caracteres, nenhum resultado, inativo), erro de página e de raiz (código do incidente, "Tentar novamente", "Recarregar a página"), menu recolhido e tokens do escuro batem. Tablet 820: o design mantém o menu lateral (igual ao app, a partir de 768 px). O app mostra cartões em vez de tabela entre 768 e 1023 px em Jovens, Encontros e Histórico, decisão registrada em `docs/REDESIGN.md`; a prancha de 820 px só desenha Configurações, então não há desenho que contradiga isso. | `components/Layout.tsx`, `search/GlobalSearch.tsx`, `ErrorBoundary.tsx` | — | — |
| — | Transversal: classes de legado | Ajuste (sem efeito visual hoje) | 715 usos de `bg-white`, `text-gray-*` e similares. Funcionam no escuro pela "ponte de legado" de `index.css`. Migrar para tokens só reduz o risco de uma classe nova escapar da ponte. | 44 arquivos (os maiores: Chamada, Jovens, CommunicationModal, YouthDetail, Grupos) | G | Médio (classes usadas como seletor no E2E) |

## Ordem de implementação sugerida

1. **Componentes base (P):** `EmptyState` com círculo e linha de ajuda; indicador "Atualizando…" nas listas
   paginadas; rótulos de carregamento nos botões (`Alterando…`, `Recalculando…`, `Reabrindo…`).
2. **Confirmação em janela própria (M, se aprovada):** um `ConfirmDialog` sobre o `Modal` atual, aplicado a
   excluir encontro, cancelar próximos da série, excluir tarefa, excluir acompanhamento, excluir/descartar
   e-mail e ativar/desativar em lote. Ajustar os testes E2E correspondentes no mesmo passo.
3. **Acabamentos por módulo (P cada):** avatar de Grupos, ajuda de senha em Configurações, filtros abreviados de
   Encontros no celular, tabela ou lista na Visão geral (conforme a pergunta 3c).
4. **Migração de classes de legado (G, opcional):** página por página, mantendo as classes que o E2E usa como
   seletor (lista em `docs/REDESIGN.md`).
5. **Verificação:** lint, tsc, vitest e build a cada passo; E2E completo e prints (1440, 820, 390; claro e escuro)
   no fim.

Não há motivo para mexer em tokens, fonte, Layout ou telas de autenticação. Elas já estão conformes.

## Perguntas abertas

**3a. Paleta × logotipo.** A interface já usa a paleta do design (`#1F5FD1`, `#0F1B3D`, `#4FC3DC`); o `#111c2e`
é a superfície do modo escuro do próprio design, não um conflito. O conflito real fica só nos SVGs do logotipo
(`src/assets/logo/`): índigo `#4F46E5`, ciano `#06B6D4`/`#22D3EE` e amarelo `#FDE047`. O design não redesenha o
logotipo; usa um "J" provisório com `#4FC3DC`.
- (A, recomendada) manter o logotipo como está. O pedido manda preservar o `Logo`, e ele já convive bem com o
  marinho.
- (B) recolorir os SVGs para marinho/azul/ciano mantendo a forma. O `Logo.test.tsx`, o favicon e os ícones do
  manifest mudariam juntos.

**3b. Fonte.** Já resolvido: IBM Plex Sans auto-hospedada (`@fontsource/ibm-plex-sans`, subconjunto latino,
400/500/600) em `src/index.css`, compatível com `font-src 'self'`. Nada a decidir, a menos que você queira
incluir `latin-ext`, que só faz falta para nomes com caracteres fora do português.

**3c. Dado que o app não tem.** A tabela "Jovens que precisam de atenção" da Visão geral pede Faltas seguidas,
Frequência, Acompanhamento e Prioridade. O `dashboard_overview` devolve só nome, grupo, situação e motivos (texto).
- (A, recomendada) manter a lista atual, com motivos e situação.
- (B) tabela com Jovem, Grupo, Motivos e Situação, só com os dados que existem.
- (C) colunas completas, o que exige uma nova migration no RPC. Isso está fora do escopo desta tarefa (proibido
  mexer em `supabase/migrations`).

Os demais "dados que não existem" estão marcados no próprio design (ex.: "Hoje o sistema não tem ação
atrasada"; "Informação não disponível no mockup") e não pedem implementação.

**3d. Confirmações nativas (nova).** O design propõe janela própria para as exclusões e para o lote. Hoje são
`window.confirm`, e os testes E2E dependem disso.
- (A) implementar a janela própria e ajustar os testes (ver estimativa abaixo).
- (B) manter `window.confirm` nesta etapa.

## Impacto nos testes

- `data-testid`: 141 únicos em 36 arquivos de `src/`; o E2E referencia 162. **Nenhum precisa mudar** nos passos 1,
  3 e 4. No passo 2 (janela própria), os botões novos ganham `data-testid`, e os atuais continuam.
- Seletores por classe no E2E: `div.fixed.inset-0` (6), `nav.fixed` (2), `span.text-red-600`, `p.text-red-600`,
  `span.font-mono`, `main .animate-spin`, `td:first-child span.font-medium`, e `toHaveClass` com `bg-blue-600`,
  `bg-blue-50`, `w-16`/`w-64` e `dark`. A migração de legado (passo 4) precisa manter essas classes nesses pontos.
- Confirmação em janela própria (passo 2, se aprovado): **24 tratadores de `dialog` nativo em 8 specs**
  (`alerts-tasks`, `batch`, `communications`, `communications-send`, `events-attendance`, `followups`, `history`,
  `series`), cerca de 20 testes de um total de 371.
- Textos: nenhum texto conferido pelos testes muda nos passos propostos. As novidades são textos adicionais
  (ajuda de senha, "Atualizando…", rótulos de carregamento).

## Fase 2 — resultado

Decisões: logotipo mantido (3a-A); Visão geral continua em lista (3c-A); confirmação em janela própria (3d-A),
feita por último. Migração das 715 classes de legado fora do escopo. Ordem executada: passo 1, passo 3, passo 2.

| Passo | O que mudou |
|---|---|
| 1. Componentes base | `EmptyState` com ícone num círculo de 44px e `hint` opcional. Novo `RefreshingNote` ("Atualizando…") em Jovens, Grupos, Encontros, Tarefas, Histórico e Relatórios. Rótulos durante a operação: "Salvando…", "Alterando…", "Recalculando…" (Configurações) e "Reabrindo…" (Alertas). |
| 3. Acabamentos | Grupos: avatar quadrado azul (32px na tabela, 40px nos cartões). Encontros no celular: filtros em controle segmentado de 44px com rótulos abreviados ("Agend.", "Realiz.", "Cancel."); o nome acessível continua completo. Configurações: ajuda da senha com o mínimo de caracteres e o encerramento das outras sessões. |
| 2. Confirmação | `ConfirmProvider` / `useConfirm` (`contexts/ConfirmContext.tsx`) sobre o `Modal`: título, texto, Cancelar e a ação (vermelha quando destrutiva). Foco inicial em Cancelar, Esc cancela, Tab preso na janela, foco devolvido a quem abriu; recusa sozinha se a rota mudar. Substitui os 9 `window.confirm`. |
| Contraste | Modo escuro: `--color-danger` passou de `#d9483d` para `#d0413a` (texto branco: 4.25 → 4.67) e `.text-danger` usa o tom claro (`#fca5a5`) no escuro, porque como texto o vermelho anterior dava 4.02 sobre a superfície. |

Verificação final: lint ok (sem erros novos); `tsc` do app e do E2E ok; vitest 795/795; build ok; E2E completo
376/376 (Edge do sistema); CSP do build sem violações e IBM Plex Sans carregada do próprio app. Na rodada do fim do
passo 2, `auth.spec.ts` › "mostra estado de carregamento enquanto autentica" falhou uma vez (servidor do Vite ainda
frio no início da suíte); rodou 3/3 isolado e passou na rodada final.

Testes ajustados (E2E): `fixtures.ts` (helpers `confirmation` e `answerConfirmation`), `alerts-tasks`, `batch`,
`communications`, `communications-send`, `events-attendance`, `followups`, `history`, `series`, todos só onde
tratavam o diálogo nativo. Teste novo: `alerts-tasks` › janela de confirmação (foco, Esc, foco devolvido).

Divergências conhecidas que ficaram:
- Visão geral: lista em vez da tabela com Faltas seguidas, Frequência e Acompanhamento (decisão 3c, depende de
  migration).
- Visão geral: "0 crítico(s)" aparece em vermelho mesmo com zero; o design usa selos "n crítico" / "n em atenção".
- Logotipo real no lugar do monograma provisório "J" do design (decisão 3a).
- Textos de busca sem resultado usam aspas retas ("zzz"); o design usa aspas curvas. Os testes conferem o texto.
- 715 classes de paleta seguem dependendo da ponte de legado no modo escuro.
- Nos prints de página inteira, o menu lateral (sticky, altura da tela) aparece cortado no fim; é efeito da captura.
