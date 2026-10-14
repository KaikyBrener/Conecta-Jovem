// Classes das telas de autenticação (Login, recuperação e definição de senha): campos e botão de 44px.
// formStyles.ts é compartilhado com as páginas internas; estas são locais ao fluxo de auth. Mesmos tokens.
// O sufixo "!" (important) em border/ring do estado inválido é necessário porque o
// override `.dark input` de index.css (sem layer) venceria as utilities normais.
export const fieldCls =
  'block w-full h-11 rounded-control border border-line-strong bg-surface px-3 text-sm text-ink placeholder:text-ink-faint transition-colors focus-visible:outline-hidden focus-visible:border-action! focus-visible:ring-[3px] focus-visible:ring-action/20 read-only:opacity-70';
/** Campo com ícone à esquerda (use junto de fieldIconCls no ícone). */
export const fieldWithIconCls = 'pl-9';
export const fieldIconCls = 'pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-faint';
export const fieldInvalidCls = 'border-danger! focus-visible:border-danger! focus-visible:ring-danger/20!';
export const labelCls = 'block text-label font-medium text-ink';
export const authPrimaryBtnCls =
  'inline-flex h-11 w-full items-center justify-center gap-2 rounded-control border border-action bg-action px-4 text-sm font-medium text-on-action transition-colors hover:border-action-hover hover:bg-action-hover disabled:cursor-not-allowed disabled:opacity-70';
export const authLinkCls = 'rounded-tag text-sm font-medium text-action hover:text-action-hover hover:underline';
