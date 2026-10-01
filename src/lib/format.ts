// Helpers de formatação e datas (pt-BR, fuso local do navegador)

const pad = (n: number) => String(n).padStart(2, '0');

/** Data local no formato YYYY-MM-DD (valor de <input type="date">) */
export function toDateInput(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Início do dia local de uma data YYYY-MM-DD, em ISO (UTC) */
export function startOfDayISO(date: string): string {
  return new Date(`${date}T00:00:00`).toISOString();
}

/** Fim do dia local de uma data YYYY-MM-DD, em ISO (UTC) */
export function endOfDayISO(date: string): string {
  return new Date(`${date}T23:59:59.999`).toISOString();
}

export function addDays(d: Date, days: number): Date {
  const r = new Date(d);
  r.setDate(r.getDate() + days);
  return r;
}

export function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

export function endOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59, 999);
}

/** "12 de set. de 2026" */
export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('pt-BR', { day: '2-digit', month: 'short', year: 'numeric' });
}

/** "12/09/2026, 19:30" */
export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString('pt-BR', {
    day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

/** Formata uma data pura (YYYY-MM-DD) sem deslocamento de fuso */
export function formatDateOnly(date: string | null): string {
  if (!date) return '—';
  return new Date(`${date}T00:00:00`).toLocaleDateString('pt-BR');
}

export function formatPercent(rate: number | null): string {
  return rate === null ? '—' : `${Math.round(rate)}%`;
}

/** Tarefa vencida: tem prazo anterior a hoje e ainda está aberta */
export function isOverdue(dueDate: string | null, status: string, today: string = toDateInput(new Date())): boolean {
  return !!dueDate && dueDate < today && (status === 'pending' || status === 'in_progress');
}

/** Extrai a mensagem de erro de exceções/erros do Supabase */
export function errorMessage(err: unknown, fallback = 'Ocorreu um erro inesperado.'): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === 'object' && 'message' in err) {
    const msg = (err as { message: unknown }).message;
    if (typeof msg === 'string' && msg) return msg;
  }
  return fallback;
}

// Mensagens conhecidas do GoTrue (auth do Supabase), sempre em inglês na origem.
// Traduzidas para manter a interface consistente em pt-BR e para não expor
// textos internos do provedor de autenticação ao usuário final.
const AUTH_ERROR_MESSAGES: Record<string, string> = {
  'Invalid login credentials': 'E-mail ou senha inválidos.',
  'Email not confirmed': 'E-mail ainda não confirmado. Verifique sua caixa de entrada.',
  'Email rate limit exceeded': 'Muitas tentativas em sequência. Aguarde alguns minutos e tente novamente.',
  'User not found': 'E-mail ou senha inválidos.',
};

/** Traduz erros de autenticação (login) para pt-BR, sem vazar texto interno do provedor. */
export function translateAuthError(message: string): string {
  return AUTH_ERROR_MESSAGES[message] ?? 'Não foi possível entrar. Verifique seus dados e tente novamente.';
}
