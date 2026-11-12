# Redesign — pendências para a próxima fase

Contexto: as fases P0 a P2 (acessibilidade, componentes e tokens, refino das telas) estão na branch
`feat/frontend-ui-ux-pro-max`. Este arquivo lista o que ficou de fora de propósito, em ordem de prioridade, e o risco de
cada item para a suíte E2E (`npm run test:e2e`). Detalhes do design system em `docs/REDESIGN.md`.

Risco E2E: **baixo** = não mexe em nada que os testes localizem; **médio** = exige ajustar alguns testes no mesmo commit;
**alto** = vários testes dependem do comportamento ou da classe atual.

| # | Pendência | Por que importa | Risco E2E |
|---|---|---|---|
| 2 | **Validar em Safari, Firefox e iOS reais** (menu "Mais", folha inferior, teclado virtual, `dvh`, `scrollbar-gutter`, `accent-color`, SVG das barras). Hoje só o Chromium do Playwright foi usado. | Risco real de produção que os testes não cobrem. | **Baixo**: é validação manual; se for automatizar, entram projetos `firefox` e `webkit` no `playwright.config.ts`. |
| 3 | **Captura visual da visão de líder** (menu, Painel, Jovens, Chamada, Alertas com o escopo do líder), claro e escuro, desktop e celular. | Só a visão de coordenador foi capturada; o E2E cobre as regras do líder, mas não o visual. | **Baixo**: só captura. |
| 4 | **Tokens de cor cheia para sucesso e crítico** nos botões Presente/Ausente (`bg-green-600`, `bg-red-600`) e **trocar os seletores do E2E por `data-testid`**: `bg-blue-600` (item ativo do menu, `navigation.spec`), `bg-blue-50` (linha selecionada, `batch.spec`), `p.text-red-600` e `span.text-red-600` (`dashboard.spec`). Depois some a "ponte de legado" do modo escuro em `index.css`. | Fecha a migração para tokens e tira o acoplamento entre testes e classes de estilo. | **Alto**: 4 specs mudam no mesmo commit que o código. |
| 5 | **`Skeleton` e `DataTable` únicos**: carregamento em blocos no lugar do indicador giratório; uma tabela (desktop) + cartões (celular) para Jovens, Encontros, Grupos e Histórico. | Remove a repetição das tabelas escritas à mão e dá carregamento mais estável. | **Alto**: `groups.spec` espera `main .animate-spin`; vários testes usam `tbody tr`, `getByTitle` e o DOM dos cartões. |
| 6 | **Migrar os demais formulários para `Field`/`Select`/`Textarea`** (Tarefas, Série, Acompanhamento, Transferência, E-mail, Alertas, Configurações). Já têm rótulo ligado ao campo (`htmlFor`); a mudança é de uniformidade. | Consistência e menos CSS repetido. | **Médio**: muitos `getByLabel` e `getByPlaceholder`; os `id` têm de ser preservados. |
| 7 | **Encontros agrupados em "Próximos" e "Anteriores".** A lista é paginada no servidor: agrupar só a página atual confunde; o certo é ordenar/filtrar por futuro e passado na consulta. | Facilita achar o próximo encontro. | **Médio**: `pagination.spec`, `events-attendance.spec` e a ordem das linhas. |
| 8 | **Menu lateral agrupado** (Gestão, Cuidado, Análise) e **breadcrumb só quando houver profundidade**. | Menos itens soltos; o breadcrumb atual repete o título. | **Médio**: `w-64`/`w-16` na `aside`, `bg-blue-600` no item ativo e `nav.fixed` são usados como seletor (ver item 4). |
| 9 | **Menu "Mais ações" nos Alertas** (hoje as 5 ações ficam à vista, em dois grupos). | Cartão mais limpo no celular. | **Alto**: `alerts-lifecycle`, `alerts-tasks`, `alerts-pagination` e `communications` clicam as ações direto; cada clique ganharia um passo. Só vale se as ações principais continuarem à vista. |
| 10 | **Limite de workers em `vitest.concurrency.config.ts`** (o `vitest.config.ts` já usa `maxWorkers: 4`; o de concorrência tem configuração própria e pode ter o mesmo problema de memória com PGlite, cerca de 1 GB por worker). | `npm run test:concurrency` pode derrubar workers em máquinas com pouca RAM. | **Baixo**: não afeta o E2E. |

Já resolvido e que não deve voltar: proteção ao fechar formulário alterado (era o item 1: o `Modal` pergunta "Descartar alterações?" em Esc, clique fora e "Fechar janela"; ver o comentário do componente e `useUnsavedChanges`; teste em `modal-a11y.spec.ts`), nenhum atributo `style` no `src` (CSP `style-src 'self'`; barras de progresso em SVG, teste em
`p2-ui.spec.ts`), `Modal` com Esc/foco/rolagem, rótulos ligados aos campos nos formulários de Jovens, Grupos e Encontros.
