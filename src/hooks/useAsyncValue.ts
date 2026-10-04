import { useCallback, useEffect, useRef, useState } from 'react';
import { errorMessage } from '../lib/format';

/**
 * Carrega UM valor assíncrono por chave (ex.: id do jovem). Convenções do projeto: cancelamento por flag,
 * sem setState síncrono no effect e `loading` derivado (chave pedida ≠ chave carregada).
 * `key === null` desliga a busca. `refetch()` recarrega a mesma chave.
 * `load` e `initial` podem mudar a cada render: vale a versão mais recente, a busca só reinicia com a chave.
 */
export function useAsyncValue<T>(
  key: string | null,
  load: () => Promise<T>,
  initial: T,
  errorFallback: string,
) {
  const [version, setVersion] = useState(0);
  const [state, setState] = useState<{ key: string | null; requestKey: string | null; data: T; error: string | null }>({
    key: null,
    requestKey: null,
    data: initial,
    error: null,
  });
  const loadRef = useRef(load);
  const initialRef = useRef(initial);
  useEffect(() => {
    loadRef.current = load;
    initialRef.current = initial;
  });

  const requestKey = key === null ? null : `${key}|${version}`;

  useEffect(() => {
    if (requestKey === null) return;
    let cancelled = false;
    loadRef.current()
      .then((data) => { if (!cancelled) setState({ key, requestKey, data, error: null }); })
      .catch((err: unknown) => {
        if (!cancelled) setState({ key, requestKey, data: initialRef.current, error: errorMessage(err, errorFallback) });
      });
    return () => { cancelled = true; };
  }, [key, requestKey, errorFallback]);

  const refetch = useCallback(() => setVersion((v) => v + 1), []);
  const current = state.requestKey === requestKey;

  return {
    // Mantém o último dado enquanto recarrega a mesma chave (sem piscar); chave nova volta ao inicial
    data: key !== null && state.key === key ? state.data : initial,
    loading: requestKey !== null && !current,
    error: current ? state.error : null,
    refetch,
  };
}
