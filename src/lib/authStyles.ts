// Classes das telas de autenticação (Login, recuperação e definição de senha).
// formStyles.ts é compartilhado com as páginas internas; estas são locais ao fluxo de auth.
// O sufixo "!" (important) em border/ring do estado inválido é necessário porque o
// override `.dark input` de index.css (sem layer) venceria as utilities normais.
export const fieldCls =
  'block w-full h-11 rounded-lg border border-gray-300 px-3 text-base text-gray-900 placeholder:text-gray-400 transition-colors focus-visible:outline-hidden focus-visible:border-blue-500! focus-visible:ring-2 focus-visible:ring-blue-500/50 read-only:opacity-70';
export const fieldInvalidCls = 'border-red-500! focus-visible:border-red-500! focus-visible:ring-red-500/30!';
export const labelCls = 'block text-sm font-medium text-gray-700';
export const authPrimaryBtnCls =
  'inline-flex h-11 w-full items-center justify-center gap-2 rounded-lg bg-blue-600 px-4 text-base font-medium text-white shadow-sm transition-colors hover:bg-blue-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 disabled:cursor-not-allowed disabled:opacity-70';
export const authLinkCls =
  'text-sm font-medium text-blue-700 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 rounded';
