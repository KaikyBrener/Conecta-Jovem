import { friendlyErrorMessage, isNetworkError, MESSAGES } from './errors';
import { logError } from './logger';

// Helpers de formatação e datas (pt-BR, fuso local do navegador)

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

/** "03/10/2026" a partir de YYYY-MM-DD, só com texto (sem fuso: serve para exportação e testes). */
export function formatDay(date: string | null | undefined): string {
  const m = date ? /^(\d{4})-(\d{2})-(\d{2})/.exec(date) : null;
  return m ? `${m[3]}/${m[2]}/${m[1]}` : '—';
}

/** "03/10/2026 19:30" no fuso do produto (America/Sao_Paulo), independente do fuso do navegador. */
export function formatTimestampSP(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const parts = new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(d);
  const p = (t: string) => parts.find((x) => x.type === t)?.value ?? '';
  return `${p('day')}/${p('month')}/${p('year')} ${p('hour')}:${p('minute')}`;
}

export function formatPercent(rate: number | null): string {
  return rate === null ? '—' : `${Math.round(rate)}%`;
}

const APP_TIME_ZONE = 'America/Sao_Paulo';

/** "Hoje" (YYYY-MM-DD) no fuso do produto — o mesmo critério de `app_today()` no banco (atraso, alertas). */
export function appToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: APP_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
}

/**
 * Ação atrasada: aberta (pendente/em andamento) com prazo anterior a hoje; sem prazo nunca atrasa.
 * Mesma regra de `is_task_overdue()` no banco (migration 011).
 */
export function isOverdue(dueDate: string | null, status: string, today: string = appToday()): boolean {
  return !!dueDate && dueDate < today && (status === 'pending' || status === 'in_progress');
}

/**
 * Mensagem de erro para a TELA, em pt-BR e sem detalhes internos (ver lib/errors.ts), e registro do
 * erro (sanitizado) para diagnóstico (lib/logger.ts). `fallback` descreve a operação que falhou.
 * Use em todo catch/{ error }; nunca exiba `error.message` diretamente.
 */
export function errorMessage(err: unknown, fallback = 'Ocorreu um erro inesperado.'): string {
  logError(fallback, err);
  return friendlyErrorMessage(err, fallback);
}

// Mensagens conhecidas do GoTrue (auth do Supabase), sempre em inglês na origem.
// Traduzidas para manter a interface consistente em pt-BR e para não expor
// textos internos do provedor de autenticação ao usuário final.
const RATE_LIMIT_MESSAGE = 'Muitas tentativas. Aguarde alguns minutos e tente novamente.';

// A MESMA mensagem para e-mail inexistente e para senha errada: não revela quem tem conta.
const INVALID_CREDENTIALS_MESSAGE = 'E-mail ou senha incorretos.';

const AUTH_ERROR_MESSAGES: Record<string, string> = {
  'Invalid login credentials': INVALID_CREDENTIALS_MESSAGE,
  'Email not confirmed': 'E-mail ainda não confirmado. Verifique sua caixa de entrada.',
  'Email rate limit exceeded': RATE_LIMIT_MESSAGE,
  'User not found': INVALID_CREDENTIALS_MESSAGE,
  'New password should be different from the old password.': 'A nova senha deve ser diferente da senha atual.',
  'Auth session missing!': 'Sua sessão expirou. Entre novamente.',
  'Password is known to be weak and easy to guess, please choose a different one.':
    'Essa senha é muito fraca ou comum. Escolha outra.',
  'Unable to validate email address: invalid format': 'Informe um e-mail válido.',
};

// O GoTrue varia a caixa das mensagens entre versões: a busca ignora maiúsculas/minúsculas.
const AUTH_ERROR_LOOKUP = new Map(Object.entries(AUTH_ERROR_MESSAGES).map(([k, v]) => [k.toLowerCase(), v]));

const LOGIN_FALLBACK = 'Não foi possível entrar. Verifique seus dados e tente novamente.';

/** Aceita a `message` crua ou o próprio objeto de erro do supabase-js (usa name/status/code também). */
type AuthErrorInput = string | { message?: string; name?: string; status?: number; code?: string } | null | undefined;

/**
 * Traduz erros de autenticação para pt-BR, sem vazar texto interno do provedor.
 * Prefira passar o objeto de erro inteiro: assim falha de rede (AuthRetryableFetchError) e limite de
 * requisições (429 / `over_*_rate_limit`) são distinguidos de credencial inválida.
 * `fallback` é a mensagem para erros desconhecidos (o padrão serve para o login).
 */
export function translateAuthError(input: AuthErrorInput, fallback: string = LOGIN_FALLBACK): string {
  const obj = input && typeof input === 'object' ? input : null;
  const message = (typeof input === 'string' ? input : obj?.message) ?? '';
  const status = typeof obj?.status === 'number' ? obj.status : 0;
  const code = typeof obj?.code === 'string' ? obj.code : '';

  if (isNetworkError(input)) return MESSAGES.network;
  const exact = AUTH_ERROR_LOOKUP.get(message.trim().toLowerCase());
  if (exact) return exact;
  // "For security purposes, you can only request this after 52 seconds."
  const wait = /after (\d+) seconds?/i.exec(message);
  if (wait) return `Por segurança, aguarde ${wait[1]} segundos antes de tentar novamente.`;
  if (status === 429 || /^over_.+_rate_limit$/.test(code) || /rate limit/i.test(message)) return RATE_LIMIT_MESSAGE;
  if (status >= 500) return MESSAGES.server;
  const minLength = /password should be at least (\d+)/i.exec(message);
  if (minLength) return `A senha deve ter pelo menos ${minLength[1]} caracteres.`;
  return fallback;
}

// ---- Pedido de redefinição de senha ("Esqueci minha senha") ----

/** Resposta única do pedido de redefinição: igual exista ou não a conta (não revela quem tem cadastro). */
export const RECOVER_NEUTRAL_MESSAGE = 'Se o e-mail estiver cadastrado, você receberá um link em instantes.';

const RECOVER_SEND_FAILED_MESSAGE = 'Não foi possível enviar o e-mail agora. Aguarde um minuto e tente novamente.';
const RECOVER_RATE_LIMIT_MESSAGE = 'Muitas tentativas. Aguarde um pouco.';

/**
 * Mensagem de erro do pedido de redefinição, ou `null` quando a tela deve mostrar a resposta neutra
 * (`RECOVER_NEUTRAL_MESSAGE`): sucesso OU "usuário não encontrado". Nunca devolve o texto do servidor.
 */
export function recoverErrorMessage(input: AuthErrorInput): string | null {
  if (!input) return null;
  const obj = typeof input === 'object' ? input : null;
  const message = (typeof input === 'string' ? input : obj?.message) ?? '';
  const status = typeof obj?.status === 'number' ? obj.status : 0;
  const code = typeof obj?.code === 'string' ? obj.code : '';

  if (isNetworkError(input)) return MESSAGES.network;
  // conta inexistente não pode ser distinguida de sucesso
  if (code === 'user_not_found' || /user not found/i.test(message)) return null;
  if (code === 'email_address_invalid' || /unable to validate email address/i.test(message)) return 'Informe um e-mail válido.';
  // "For security purposes, you can only request this after 52 seconds."
  const wait = /after (\d+) seconds?/i.exec(message);
  if (wait) return `Por segurança, aguarde ${wait[1]} segundos antes de tentar novamente.`;
  if (status === 429 || /^over_.+_rate_limit$/.test(code) || /rate limit/i.test(message)) return RECOVER_RATE_LIMIT_MESSAGE;
  // 500 do /recover (o servidor de autenticação não conseguiu enviar) e qualquer erro desconhecido
  return RECOVER_SEND_FAILED_MESSAGE;
}
