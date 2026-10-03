// Paginação server-side das listagens (PostgREST: `.range(from, to)` + `count: 'exact'`).
// O PostgREST corta respostas em 1000 linhas (max-rows) — listas que podem crescer devem
// ser paginadas no servidor, nunca carregadas inteiras e filtradas no cliente.

export const PAGE_SIZE = 25;

/** Intervalo (inclusivo, 0-based) a pedir ao PostgREST para a página `page` (1-based). */
export function pageBounds(page: number, pageSize: number = PAGE_SIZE): { from: number; to: number } {
  const from = (Math.max(1, page) - 1) * pageSize;
  return { from, to: from + pageSize - 1 };
}

export function totalPages(total: number, pageSize: number = PAGE_SIZE): number {
  return Math.max(1, Math.ceil(total / pageSize));
}

/** Posições (1-based) do primeiro e do último item exibidos: "26–50 de 120". */
export function pageSummary(page: number, total: number, pageSize: number = PAGE_SIZE): { first: number; last: number } {
  if (total === 0) return { first: 0, last: 0 };
  const { from } = pageBounds(page, pageSize);
  return { first: from + 1, last: Math.min(from + pageSize, total) };
}

/**
 * Padrão para `ilike` a partir do texto digitado. Remove caracteres que têm significado na
 * sintaxe de filtros do PostgREST (`, ( ) " \ *`) e os curingas do LIKE (`%`), em vez de tentar
 * escapá-los: assim o termo nunca quebra nem injeta outros filtros em `.or(...)`.
 * Retorna null quando não há o que buscar.
 */
export function searchPattern(term: string): string | null {
  const clean = term.replace(/[%*,()"\\]/g, ' ').replace(/\s+/g, ' ').trim();
  return clean ? `%${clean}%` : null;
}
