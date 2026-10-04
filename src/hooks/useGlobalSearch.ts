import { supabase } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';
import {
  EMPTY_SEARCH_RESULTS,
  isSearchable,
  normalizeSearchTerm,
  parseGlobalSearch,
  type SearchResults,
} from '../lib/globalSearch';
import { useAsyncValue } from './useAsyncValue';

/**
 * Busca global (RPC `global_search`, SECURITY INVOKER: o RLS decide o que cada papel vê).
 * Passe o texto JÁ com debounce. Menos de 2 caracteres não consulta nada.
 */
export function useGlobalSearch(debouncedTerm: string) {
  const { user } = useAuth();
  const term = normalizeSearchTerm(debouncedTerm);
  const key = user && isSearchable(term) ? term : null;
  return useAsyncValue<SearchResults>(
    key,
    async () => {
      const { data, error } = await (supabase as any).rpc('global_search', { p_query: term, p_limit: 8 });
      if (error) throw error;
      return parseGlobalSearch(data);
    },
    EMPTY_SEARCH_RESULTS,
    'Não foi possível realizar a busca.',
  );
}
