import { useCallback, useEffect, useRef, useState } from 'react';
import { PAGE_SIZE, pageBounds, totalPages as countPages } from '../lib/pagination';
import { errorMessage } from '../lib/format';

export interface PagedResult<T> {
  rows: T[];
  /** Total de linhas que atendem aos filtros (count exato do PostgREST), não só da página */
  total: number;
}

interface Options<T> {
  /** false enquanto o usuário/sessão não está pronto */
  enabled: boolean;
  /** Busca UMA página. Deve aplicar filtros e ordenação estável (com desempate por id) no servidor. */
  fetchPage: (range: { from: number; to: number }) => Promise<PagedResult<T>>;
  /**
   * Filtros que definem a consulta (strings/números/booleanos). Quando mudam, a lista volta
   * para a página 1 — sem efeito colateral: a página é derivada da chave dos filtros.
   */
  filters: readonly unknown[];
  errorFallback: string;
  pageSize?: number;
}

/**
 * Lista paginada no servidor. Convenções do projeto: sem setState síncrono dentro do effect
 * e cancelamento por flag. `loading` é derivado (chave pedida ≠ chave carregada).
 * Se a página atual ficar vazia por causa de uma exclusão/filtro (ex.: apagou o último item
 * da última página), vai sozinho para a última página existente.
 */
export function usePagedList<T>({ enabled, fetchPage, filters, errorFallback, pageSize = PAGE_SIZE }: Options<T>) {
  const filterKey = JSON.stringify(filters);
  const [pageState, setPageState] = useState({ page: 1, filterKey });
  const page = pageState.filterKey === filterKey ? pageState.page : 1;
  const setPage = useCallback((p: number) => setPageState({ page: p, filterKey }), [filterKey]);

  const [version, setVersion] = useState(0);
  const [data, setData] = useState<PagedResult<T>>({ rows: [], total: 0 });
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // sempre a versão mais recente de fetchPage (closures com role/user/filtros atuais)
  const fetchRef = useRef(fetchPage);
  useEffect(() => { fetchRef.current = fetchPage; });

  const requestKey = `${filterKey}|${page}|${pageSize}|${version}`;

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const run = async () => {
      try {
        const res = await fetchRef.current(pageBounds(page, pageSize));
        if (cancelled) return;
        const last = countPages(res.total, pageSize);
        if (res.rows.length === 0 && res.total > 0 && page > last) {
          setPage(last); // página sumiu: reconsulta na última existente
          return;
        }
        setData(res);
        setError(null);
        setLoadedKey(requestKey);
      } catch (err: unknown) {
        if (cancelled) return;
        setError(errorMessage(err, errorFallback));
        setLoadedKey(requestKey);
      }
    };
    void run();
    return () => { cancelled = true; };
  }, [enabled, page, pageSize, requestKey, errorFallback, setPage]);

  const refetch = useCallback(() => setVersion((v) => v + 1), []);

  return {
    rows: data.rows,
    total: data.total,
    page,
    setPage,
    pageSize,
    totalPages: countPages(data.total, pageSize),
    loading: enabled && loadedKey !== requestKey,
    error,
    refetch,
    /** Muda a cada refetch(): use para recarregar dados auxiliares (contadores) junto */
    version,
  };
}
