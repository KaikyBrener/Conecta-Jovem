import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { parseSearchParam } from '../lib/deepLinks';

/**
 * Campo de busca que pode ser preenchido por link (`?busca=texto`, usado pela busca global). O valor entra no campo e
 * o parâmetro é removido da URL (replace), então digitar/limpar depois não briga com o link e um novo link com o
 * mesmo texto volta a preencher. Sem effect com setState: o ajuste acontece na renderização, quando a URL muda.
 */
export function useSearchParamPrefill(param = 'busca') {
  const [searchParams, setSearchParams] = useSearchParams();
  const fromUrl = parseSearchParam(searchParams.get(param));
  const hasParam = searchParams.has(param);
  const [search, setSearch] = useState(fromUrl);
  const [applied, setApplied] = useState(fromUrl);

  if (fromUrl !== applied) {
    setApplied(fromUrl);
    if (fromUrl) setSearch(fromUrl);
  }

  useEffect(() => {
    if (!hasParam) return;
    setSearchParams((p) => { const n = new URLSearchParams(p); n.delete(param); return n; }, { replace: true });
  }, [hasParam, param, setSearchParams]);

  return [search, setSearch] as const;
}
