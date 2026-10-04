// Tradução de erros técnicos (PostgREST, Postgres, rede) em mensagens curtas em pt-BR para o usuário.
// REGRA: o texto cru de um erro técnico nunca vai para a tela — pode conter nomes de tabelas,
// constraints e políticas, ou estar em inglês. Só passam as mensagens escritas por nós
// (RAISE EXCEPTION em pt-BR com P0001/P0002 ou 42501 customizado).

const NETWORK = /failed to fetch|networkerror|network request failed|load failed|fetch failed|err_internet/i;
const PERMISSION = /row-level security|permission denied|insufficient privilege|must be owner/i;

export const MESSAGES = {
  network: 'Sem conexão com o servidor. Verifique sua internet e tente novamente.',
  permission: 'Você não tem permissão para realizar esta ação.',
  session: 'Sua sessão expirou. Entre novamente.',
  duplicate: 'Já existe um registro com esses dados.',
  relatedMissing: 'Um dos itens relacionados não existe mais ou está em uso. Atualize a página e tente novamente.',
  invalid: 'Algum valor informado é inválido. Confira os campos e tente novamente.',
  notFound: 'Registro não encontrado ou sem permissão.',
  server: 'O servidor encontrou um problema. Tente novamente em instantes.',
  outdated: 'Este recurso ainda não está disponível no banco de dados. Avise o administrador do sistema.',
} as const;

interface ErrorShape {
  code?: unknown;
  status?: unknown;
  message?: unknown;
  name?: unknown;
}

/**
 * Falha de rede (sem internet, DNS, servidor inalcançável). Inclui o AuthRetryableFetchError do GoTrue
 * ("Failed to fetch", status 0), que NÃO é problema de credencial.
 */
export function isNetworkError(err: unknown): boolean {
  const e: ErrorShape = err && typeof err === 'object' ? (err as ErrorShape) : {};
  const message = typeof e.message === 'string' ? e.message : typeof err === 'string' ? err : '';
  const name = typeof e.name === 'string' ? e.name : '';
  const status = typeof e.status === 'number' ? e.status : -1;
  return (name === 'AuthRetryableFetchError' && status < 500) || NETWORK.test(message);
}

/**
 * Mensagem segura para exibir ao usuário. `fallback` descreve a operação ("Erro ao carregar grupos.")
 * e é usado sempre que o erro não for reconhecido.
 */
export function friendlyErrorMessage(err: unknown, fallback: string): string {
  const e: ErrorShape = err && typeof err === 'object' ? (err as ErrorShape) : {};
  const code = typeof e.code === 'string' ? e.code : '';
  const status = typeof e.status === 'number' ? e.status : 0;
  const message = typeof e.message === 'string' ? e.message : typeof err === 'string' ? err : '';

  // Rede (inclui o PostgrestError "TypeError: Failed to fetch" e o AuthRetryableFetchError do GoTrue
  // com status < 500; com status >= 500 é erro do servidor e cai no ramo `server` abaixo)
  if (isNetworkError(err)) return MESSAGES.network;

  // Sessão / JWT
  if (code === 'PGRST301' || code === 'PGRST303' || /jwt|invalid claim/i.test(message) || status === 401) {
    return MESSAGES.session;
  }

  // Mensagens que nós mesmos escrevemos no banco (funções com RAISE EXCEPTION em pt-BR)
  if (code === 'P0001' || code === 'P0002') return message || fallback;
  if (code === '42501') return PERMISSION.test(message) ? MESSAGES.permission : message || MESSAGES.permission;
  if (status === 403) return MESSAGES.permission;

  switch (code) {
    case '23505': return MESSAGES.duplicate;
    case '23503': return MESSAGES.relatedMissing;
    case '23502':
    case '23514':
    case '22P02':
    case '22007':
    case '22003': return MESSAGES.invalid;
    case 'PGRST116': return MESSAGES.notFound;
    // schema cache / função / tabela / coluna ausentes: normalmente uma migration não aplicada
    case 'PGRST200':
    case 'PGRST202':
    case 'PGRST204':
    case '42P01':
    case '42703':
    case '42883': return MESSAGES.outdated;
    default:
  }
  if (PERMISSION.test(message)) return MESSAGES.permission;
  if (status >= 500 || /^5\d\d$/.test(code)) return MESSAGES.server;

  return fallback;
}
