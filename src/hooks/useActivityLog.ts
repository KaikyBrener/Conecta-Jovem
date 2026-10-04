import { supabase } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';
import { searchPattern } from '../lib/pagination';
import type { ActivityAction, ActivityEntry } from '../types/database.types';
import { usePagedList } from './usePagedList';
import { useAsyncValue } from './useAsyncValue';

const COLUMNS = 'id, occurred_at, actor_name, action, entity_type, entity_id, youth_id, group_id, summary';

export interface ActivityFilters {
  action: ActivityAction | 'all';
  /** occurred_at >= from (ISO) */
  from: string | null;
  /** occurred_at < toExclusive (ISO) */
  toExclusive: string | null;
  /** filtro por jovem selecionado (deep link) */
  youthId: string | null;
  /** texto: nome do jovem */
  search: string;
}

/**
 * Histórico operacional (tabela activity_log, migration 014), paginado NO SERVIDOR. O RLS decide o que cada papel
 * vê (coordenador tudo; líder só o que é dos seus grupos). Busca por nome de jovem: embed
 * `youth:youth_id!inner` filtrado no servidor (`youth.full_name ilike`), sem listas de ids.
 */
export function useActivityLog(filters: ActivityFilters, enabled = true) {
  const { user } = useAuth();
  return usePagedList<ActivityEntry>({
    enabled: !!user && enabled,
    filters: [filters.action, filters.from, filters.toExclusive, filters.youthId, filters.search],
    errorFallback: 'Erro ao carregar o histórico.',
    fetchPage: async ({ from, to }) => {
      const sb = supabase as any;
      const pattern = searchPattern(filters.search);
      // Com busca, o embed vira INNER JOIN filtrado no servidor (só registros de jovens cujo nome combina);
      // sem busca, continua LEFT: registros sem jovem aparecem normalmente.
      let q = sb.from('activity_log').select(`${COLUMNS}, youth:youth_id${pattern ? '!inner' : ''}(full_name)`, { count: 'exact' });
      if (pattern) q = q.ilike('youth.full_name', pattern);
      if (filters.action !== 'all') q = q.eq('action', filters.action);
      if (filters.from) q = q.gte('occurred_at', filters.from);
      if (filters.toExclusive) q = q.lt('occurred_at', filters.toExclusive);
      if (filters.youthId) q = q.eq('youth_id', filters.youthId);
      const { data, count, error } = await q
        .order('occurred_at', { ascending: false })
        .order('id', { ascending: false })
        .range(from, to);
      if (error) throw error;
      return { rows: (data ?? []) as ActivityEntry[], total: count ?? 0 };
    },
  });
}

const NO_ENTRIES: ActivityEntry[] = [];

/** Últimas `limit` atividades de um jovem (seção "Histórico recente" da ficha). `version` força recarregar. */
export function useRecentActivity(youthId: string, version = 0, limit = 10) {
  const { user } = useAuth();
  return useAsyncValue<ActivityEntry[]>(
    user && youthId ? `${youthId}|${version}` : null,
    async () => {
      const { data, error } = await (supabase as any)
        .from('activity_log')
        .select(COLUMNS)
        .eq('youth_id', youthId)
        .order('occurred_at', { ascending: false })
        .order('id', { ascending: false })
        .limit(limit);
      if (error) throw error;
      return (data ?? []) as ActivityEntry[];
    },
    NO_ENTRIES,
    'Erro ao carregar o histórico recente.',
  );
}
