/** Classes Tailwind compartilhadas por todos os formulários (GroupForm, YouthForm,
 * EventForm, TaskForm, Configuracoes) para manter o mesmo acabamento visual. */
export const inputCls =
  'mt-1.5 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500 transition-colors';

export const labelCls = 'block text-sm font-medium text-gray-700';

export const primaryBtnCls =
  'inline-flex items-center justify-center gap-2 px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors shadow-sm';

export const secondaryBtnCls =
  'inline-flex items-center justify-center gap-2 px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50 transition-colors';

export const formErrorCls = 'text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg';
