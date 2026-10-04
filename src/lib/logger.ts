// Registro de erros do frontend: estruturado, sanitizado e com UM ponto de extensão.
//
// Princípios (ver docs/OBSERVABILIDADE.md):
// - nunca registra stack, `details`/`hint` do banco, tokens, e-mails ou ids de usuário;
// - uma linha por erro no console (nada de objetos crus que o usuário possa ler/copiar);
// - `setErrorReporter(fn)` troca o destino (ex.: um serviço de monitoramento no futuro)
//   sem mudar nenhum ponto de chamada.

export interface ErrorRecord {
  /** identificador curto do incidente (8 caracteres): o usuário pode informá-lo ao suporte */
  id: string;
  at: string;
  /** onde/o que falhou — normalmente a mensagem de fallback do ponto de chamada */
  context: string;
  code: string | null;
  status: number | null;
  /** mensagem técnica já sanitizada e truncada */
  message: string;
}

export type ErrorReporter = (record: ErrorRecord) => void;

const MAX_MESSAGE = 300;

/** Remove do texto o que não deve ir para logs: JWTs, e-mails e UUIDs. */
export function sanitizeMessage(text: string): string {
  return text
    .replace(/eyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]*/g, '[token]')
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '[e-mail]')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '[id]')
    .slice(0, MAX_MESSAGE);
}

/** Extrai só code/status/message de qualquer erro (Error, PostgrestError, AuthError, objeto, string). */
export function describeError(err: unknown): { code: string | null; status: number | null; message: string } {
  if (typeof err === 'string') return { code: null, status: null, message: sanitizeMessage(err) };
  if (err && typeof err === 'object') {
    const e = err as { code?: unknown; status?: unknown; message?: unknown; name?: unknown };
    const message = typeof e.message === 'string' && e.message ? e.message : typeof e.name === 'string' ? e.name : 'erro desconhecido';
    return {
      code: typeof e.code === 'string' && e.code ? e.code : null,
      status: typeof e.status === 'number' ? e.status : null,
      message: sanitizeMessage(message),
    };
  }
  return { code: null, status: null, message: 'erro desconhecido' };
}

function incidentId(): string {
  try {
    return crypto.randomUUID().slice(0, 8);
  } catch {
    return Math.random().toString(16).slice(2, 10).padEnd(8, '0');
  }
}

const consoleReporter: ErrorReporter = (r) => {
  console.error(
    `[conecta-jovem] ${r.id} ${r.context}${r.code ? ` (${r.code})` : ''}${r.status ? ` [${r.status}]` : ''}: ${r.message}`,
  );
};

let reporter: ErrorReporter = consoleReporter;

/** Troca o destino dos registros. `null` volta ao console. */
export function setErrorReporter(fn: ErrorReporter | null): void {
  reporter = fn ?? consoleReporter;
}

/** Registra um erro (sanitizado) e devolve o id do incidente. Nunca lança. */
export function logError(context: string, err: unknown): string {
  const record: ErrorRecord = {
    id: incidentId(),
    at: new Date().toISOString(),
    context: sanitizeMessage(context),
    ...describeError(err),
  };
  try {
    reporter(record);
  } catch {
    // um reporter com defeito não pode derrubar o app
  }
  return record.id;
}
