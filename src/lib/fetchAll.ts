// O PostgREST limita cada resposta (padrão: 1000 linhas). Busca todas as páginas.
const PAGE_SIZE = 1000;

type RangeQuery = { range: (from: number, to: number) => PromiseLike<{ data: unknown[] | null; error: unknown }> };

/** `build` deve criar uma nova query (com ordenação estável) a cada chamada */
export async function fetchAll<T>(build: () => RangeQuery): Promise<T[]> {
  const all: T[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await build().range(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    const rows = (data ?? []) as T[];
    all.push(...rows);
    if (rows.length < PAGE_SIZE) return all;
  }
}
