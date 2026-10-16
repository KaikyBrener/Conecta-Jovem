/** Classes Tailwind compartilhadas por formulários, botões e tabelas das páginas internas (design system do
 * ConectJovem; ver docs/REDESIGN.md). Usam os tokens semânticos de index.css: trocam sozinhas no modo escuro.
 * Componentes novos preferem `<Button>`, `<Field>`, `<Select>` e `<Textarea>` (components/ui), que usam estas
 * mesmas classes. As telas de autenticação têm as suas em authStyles.ts. */

/* O contorno de foco dos botões é global (index.css, 2px azul); aqui ficam cor, tamanho e estados. */
const btnBaseCls =
  'inline-flex items-center justify-center font-medium rounded-control border transition-colors ' +
  'disabled:cursor-not-allowed disabled:border-disabled disabled:bg-disabled disabled:text-on-disabled';

/* Tamanhos: padrão 36px no desktop e 44px no celular (alvo de toque); pequeno 30px */
const btnSizeCls = 'min-h-11 gap-2 px-4 py-1.5 text-sm md:min-h-9';
const smallBtnSizeCls = 'min-h-[30px] gap-1.5 px-3 py-1 text-label';

const primaryToneCls = 'border-action bg-action text-on-action hover:border-action-hover hover:bg-action-hover';
const secondaryToneCls = 'border-line-strong bg-surface text-ink hover:bg-surface-hover';
const dangerToneCls = 'border-danger bg-danger text-white hover:border-danger-hover hover:bg-danger-hover';
const dangerOutlineToneCls = 'border-danger-line bg-surface text-danger hover:bg-danger-soft';
const ghostToneCls = 'border-transparent bg-transparent text-action-ink hover:bg-action-soft';

export const primaryBtnCls = `${btnBaseCls} ${btnSizeCls} ${primaryToneCls}`;
export const secondaryBtnCls = `${btnBaseCls} ${btnSizeCls} ${secondaryToneCls}`;
/** Ação destrutiva: só em confirmações, com o verbo da ação (Excluir, Anonimizar). */
export const dangerBtnCls = `${btnBaseCls} ${btnSizeCls} ${dangerToneCls}`;
export const dangerOutlineBtnCls = `${btnBaseCls} ${btnSizeCls} ${dangerOutlineToneCls}`;
export const ghostBtnCls = `${btnBaseCls} ${btnSizeCls} ${ghostToneCls}`;

/* Botões compactos (30px): ações dentro de uma seção ou de uma linha de lista */
export const smallPrimaryBtnCls = `${btnBaseCls} ${smallBtnSizeCls} ${primaryToneCls}`;
export const smallBtnCls = `${btnBaseCls} ${smallBtnSizeCls} ${secondaryToneCls}`;
export const smallDangerBtnCls = `${btnBaseCls} ${smallBtnSizeCls} ${dangerOutlineToneCls}`;
export const smallGhostBtnCls = `${btnBaseCls} ${smallBtnSizeCls} ${ghostToneCls}`;

/** Botão só com ícone (sempre com aria-label): 44px no celular, 34px no desktop. */
export const iconBtnCls =
  'inline-flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-control text-ink-muted transition-colors ' +
  'hover:bg-surface-muted hover:text-ink md:h-[34px] md:w-[34px]';

/** Campo sem margem: buscas e filtros fora de um par rótulo + campo. 38px no desktop, 44px no celular.
 * Foco: borda azul e anel de 3px. */
export const controlCls =
  'min-h-11 rounded-control border border-line-strong bg-surface px-3 py-2 text-sm text-ink placeholder:text-ink-faint ' +
  'transition-colors focus:outline-none focus:border-action focus:ring-[3px] focus:ring-action/20 ' +
  'disabled:cursor-not-allowed disabled:bg-surface-muted disabled:text-ink-muted md:min-h-[38px]';

/** Campo de formulário (input, select, textarea), logo abaixo do rótulo. */
export const inputCls = `mt-1.5 block w-full ${controlCls}`;

/** Estado de erro do campo (junto de inputCls/controlCls). */
export const invalidCls = 'border-danger! focus:border-danger! focus:ring-danger/20!';

/** Rótulo: sempre visível acima do campo, 13px / 500. */
export const labelCls = 'block text-label font-medium text-ink';

/** Ajuda abaixo do campo. */
export const helpCls = 'mt-1.5 text-caption text-ink-muted';

export const formErrorCls =
  'flex items-start gap-2 rounded-control border border-danger-line bg-danger-soft px-3.5 py-2.5 text-table text-danger-ink';

/* ---- Tabelas (desktop). O cabeçalho em caixa-alta sobre fundo de apoio vem de index.css (`thead th`). ---- */

/** Contêiner da tabela: painel com borda e rolagem horizontal dentro do próprio bloco. */
export const tableWrapCls = 'overflow-x-auto rounded-card border border-line bg-surface';
export const tableCls = 'w-full border-collapse text-table';
export const thCls = 'px-4 py-2 text-left';
export const tdCls = 'px-4 py-2.5 text-ink-soft';
export const trCls = 'border-t border-line-soft transition-colors hover:bg-surface-hover';
