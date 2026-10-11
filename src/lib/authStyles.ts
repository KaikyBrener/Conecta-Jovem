// Classes das telas de autenticação (Login, recuperação e definição de senha).
// formStyles.ts é compartilhado com as páginas internas; estas são locais ao fluxo de auth.
// O sufixo "!" (important) em border/ring do estado inválido é necessário porque o
// override `.dark input` de index.css (sem layer) venceria as utilities normais.
export const fieldCls =
  'block w-full h-12 rounded-xl border border-gray-300 bg-white px-4 text-base text-gray-900 shadow-sm placeholder:text-gray-400 transition-colors hover:border-gray-400 focus-visible:outline-hidden focus-visible:border-blue-500! focus-visible:ring-4 focus-visible:ring-blue-500/20 read-only:opacity-70';
/** Campo com ícone à esquerda (use junto de fieldIconCls no ícone). */
export const fieldWithIconCls = 'pl-11';
export const fieldIconCls = 'pointer-events-none absolute left-3.5 top-1/2 h-5 w-5 -translate-y-1/2 text-gray-400';
export const fieldInvalidCls = 'border-red-500! focus-visible:border-red-500! focus-visible:ring-red-500/20!';
export const labelCls = 'block text-sm font-semibold text-gray-800';
export const authPrimaryBtnCls =
  'inline-flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-blue-600 px-4 text-base font-semibold text-white shadow-md shadow-blue-600/20 transition-colors hover:bg-blue-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 disabled:cursor-not-allowed disabled:opacity-70';
export const authLinkCls =
  'text-sm font-medium text-blue-700 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 rounded';
