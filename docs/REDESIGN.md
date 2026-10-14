# Design system e refatoração visual

Referência: projeto visual aprovado ("ConectJovem — projeto visual completo", PDFs em `Front-end - Claud/` e o canvas
de origem). Este arquivo registra como o projeto foi levado ao código, o que ficou diferente do desenho e o que os
testes exigem que seja mantido.

A refatoração é só visual: hooks, rotas, permissões, RLS, autenticação, regras de negócio, textos e `data-testid` não
mudaram.

## Fundamentos (`src/index.css`)

| Item | Valor |
|---|---|
| Marca | azul-marinho `#0F1B3D`, divisores `#22305A`, ciano do logotipo `#4FC3DC` |
| Ação | azul institucional `#1F5FD1`, hover `#174AA6` |
| Neutros | fundo `#F4F6F9`, superfície `#FFFFFF`, cabeçalho de tabela `#F1F4F8`, borda `#DDE2EA`, borda de controle `#C9D1DE`, texto secundário `#5A6478` |
| Estados | crítico `#B42318`, atenção `#C7791A`, sucesso `#1E7A4C`, informação `#1F5FD1` (cada um com fundo, borda e texto próprios) |
| Fonte | IBM Plex Sans 400/500/600, auto-hospedada (`@fontsource/ibm-plex-sans`, subconjunto latino); numerais tabulares |
| Tipos | título de página 24/600, seção 15/600, janela 16/600, corpo 14, tabela 13.5, legenda 12.5, cabeçalho de tabela 11.5/600 em caixa-alta, numeral 30/600 |
| Raios | tag 4, controle 6, painel 8, janela 12 |
| Sombras | nenhuma em painéis; só em janelas e avisos flutuantes |
| Foco | botões e links: contorno de 2px; campos: borda azul e anel de 3px |

Como funciona:

- As escalas do Tailwind (`gray`, `blue`, `red`, `amber`, `green`) são **redefinidas** com a paleta aprovada. As
  páginas, que usam classes de paleta (`bg-white`, `text-gray-700`, `bg-blue-600`...), caem nas cores certas sem
  reescrever cada tela.
- Os tokens semânticos (`bg-surface`, `text-ink-muted`, `border-line`, `bg-action`, `bg-brand`...) trocam de valor no
  modo escuro (`.dark`). Código novo usa esses tokens.
- A "ponte de legado" no fim do arquivo redireciona as classes de paleta para os tokens no modo escuro.
- Os raios são por papel (`rounded-tag`, `rounded-control`, `rounded-card`, `rounded-sheet`). `rounded-lg`/`rounded-xl`
  não são mais usados em `src/`.

## Componentes compartilhados

| Componente | Onde | Observação |
|---|---|---|
| `Button` | `components/ui/Button.tsx` | primário, secundário, destrutivo, destrutivo em contorno, fantasma; `md` (36px desktop, 44px celular) e `sm` (30px) |
| `Field`, `Select`, `Textarea` | `components/ui/Field.tsx` | rótulo sempre visível, ajuda, erro com ícone; preserva o `id` informado |
| `Banner`, `ErrorBanner`, `SuccessBanner` | `components/ErrorBanner.tsx` | erro (`role="alert"`), aviso, informação e sucesso |
| `Badge` (= `Tag`) | `components/ui/Badge.tsx` | 20px, raio 4, ponto de cor + texto; `muted` para Cancelado/Não registrado |
| `Card`, `SectionCard`, `Panel`, `PanelEmpty`, `PanelNote`, `PanelLink` | `components/ui/Card.tsx` | painel com borda de 1px e sem sombra |
| `Stat` (= `StatCard`), `StatGrid` | `components/ui/Card.tsx` | faixa única de indicadores com divisórias de 1px |
| `Tabs` | `components/ui/Card.tsx` | abas dos relatórios |
| `DataTable` | `components/reports/ReportParts.tsx` | tabela no desktop, cartões no celular |
| `Modal` | `components/Modal.tsx` | janela no desktop, folha inferior no celular; `size="lg"` para a ficha do jovem |
| `PageHeader`, `EmptyState`, `LoadingBlock`, `SearchInput`, `FilterChips`, `Pagination` | `components/ui/` | já existiam; passaram aos tokens |
| Classes de botão, campo e tabela | `lib/formStyles.ts`, `lib/authStyles.ts` | usadas pelos componentes acima e pelas telas antigas |

`Button` e `Field` são novos e estão disponíveis; as telas existentes continuam usando as classes de `formStyles.ts`
(mesmo visual), para não trocar o DOM que os testes conhecem. Migre para os componentes ao mexer em cada formulário.

## Decisões de compatibilidade (o código prevalece sobre o desenho)

- **Visão geral:** a lista "Precisam de atenção" continua sendo uma lista com o que o servidor devolve
  (`dashboard_overview`): nome, grupo, motivos e situação. O desenho mostra uma tabela com colunas que o servidor não
  fornece; nenhuma mudança de banco foi feita.
- **Tendência de grupos:** "Em queda" usa âmbar, não vermelho. Os textos existentes foram mantidos.
- **Confirmações:** `window.confirm` foi mantido (os testes esperam o diálogo nativo). A confirmação destrutiva em
  janela própria do desenho fica para outra etapa.
- **Ações em lote:** continuam disponíveis para coordenador e líder.
- **Textos:** rótulos, títulos e mensagens não mudaram (inclusive "nenhum alerta aberto" em minúsculas, que os testes
  conferem).
- **Jovens, Encontros e Histórico entre 768 e 1023px:** usam a lista em cartões (a do celular), porque a tabela não
  cabe ao lado do menu. A tabela aparece a partir de 1024px.
- **Página 404:** não existe; rota desconhecida continua indo para a tela inicial.

## Dependências dos testes em classes CSS

O Playwright localiza alguns elementos por classe. Ao mexer nesses pontos, mantenha a classe:
`bg-blue-600` no item ativo da sidebar, `w-64`/`w-16` na `aside`, `nav.fixed` (bottom-nav),
`div.fixed.inset-0` (overlay do `Modal` e da ficha), `p.text-red-600` no indicador de ações atrasadas,
`span.text-red-600` no prazo vencido do painel, `bg-blue-50` na linha selecionada da tabela de Jovens,
`.animate-spin` dentro de `main` (carregamento), `span.font-mono` no código do incidente.

## Pendências

- Substituir `window.confirm` por confirmação em janela (exige reescrever os pontos de E2E que usam o diálogo nativo).
- Migrar os formulários antigos de `inputCls`/`labelCls` para `Field`/`Select`/`Textarea`, um por vez.
- Mover `DataTable` para `components/ui` e usá-la nas tabelas escritas à mão (Jovens, Encontros, Grupos, Histórico).
- Conferir em Safari, Firefox e iOS reais (a validação visual foi feita no Chromium do Playwright).
