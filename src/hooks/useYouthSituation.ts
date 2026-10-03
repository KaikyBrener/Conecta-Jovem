import { supabase } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';
import { indexSituations, parseSituation } from '../lib/situation';
import { useAsyncValue } from './useAsyncValue';
import type { YouthSituation } from '../types/database.types';

const NO_SITUATIONS: ReadonlyMap<string, YouthSituation> = new Map();

/**
 * Situação de UM jovem (RPC youth_situation, calculada no banco com a regra objetiva).
 * `situation` é null enquanto carrega, se a RPC falhar ou se o jovem estiver fora do escopo do usuário.
 */
export function useYouthSituation(youthId: string) {
  const { user } = useAuth();
  const result = useAsyncValue<YouthSituation | null>(
    user && youthId ? youthId : null,
    async () => {
      const { data, error } = await (supabase as any).rpc('youth_situation', { p_youth_id: youthId });
      if (error) throw error;
      return Array.isArray(data) && data.length > 0 ? parseSituation(data[0]) : null;
    },
    null,
    'Não foi possível carregar a situação do jovem.',
  );
  return { situation: result.data, loading: result.loading, error: result.error, refetch: result.refetch };
}

/**
 * Situação dos jovens de UMA página da listagem (1 chamada por página: youth_situations(ids)).
 * `salt` força nova consulta. Erro não quebra a lista: devolve o mapa vazio e `error` para um aviso discreto.
 */
export function useYouthSituations(ids: readonly string[], salt = '') {
  const { user } = useAuth();
  // `salt` muda quando algo que afeta a situação mudou (ex.: jovem desativado, acompanhamento registrado)
  const key = ids.length > 0 && user ? `${[...ids].sort().join(',')}#${salt}` : null;
  const result = useAsyncValue<ReadonlyMap<string, YouthSituation>>(
    key,
    async () => {
      const { data, error } = await (supabase as any).rpc('youth_situations', { p_ids: ids });
      if (error) throw error;
      return indexSituations(data);
    },
    NO_SITUATIONS,
    'Não foi possível carregar a situação dos jovens.',
  );
  return { situations: result.data, loading: result.loading, error: result.error };
}
