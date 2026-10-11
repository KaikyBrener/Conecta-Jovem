import { useState, useEffect } from 'react';
import { supabase } from '../lib/supabase';
import type { Youth, YouthInsert, YouthUpdate, GroupRef } from '../types/database.types';
import { useAuth } from '../contexts/AuthContext';
import { errorMessage } from '../lib/format';
import { logError } from '../lib/logger';
import { fetchAll } from '../lib/fetchAll';
import { searchPattern } from '../lib/pagination';
import { parseBatchResult, type BatchResult } from '../lib/batch';
import { notifyAlertsChanged } from '../lib/alertsBus';
import type { AnonymizeResult } from '../lib/anonymize';
import { usePagedList } from './usePagedList';

export type YouthStatusFilter = 'all' | 'active' | 'inactive';

export interface YouthFilters {
  search: string;
  status: YouthStatusFilter;
  /** 'all' | 'none' (sem grupo) | id do grupo */
  groupId: string;
}

/**
 * Busca um jovem por id, independente da página/filtros da listagem (deep link `?ficha=`).
 * O RLS decide a visibilidade: inexistente e sem permissão são indistinguíveis (retorna null).
 * Falhas de rede/servidor lançam erro.
 */
export async function fetchYouthById(id: string): Promise<Youth | null> {
  const { data, error } = await (supabase as any).from('youth').select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  return (data as Youth | null) ?? null;
}

// RLS no banco filtra automaticamente:
// – coordinator: vê todos
// – leader: vê apenas jovens do seu grupo (via policy)
// Filtros, ordenação e paginação são aplicados no servidor (a lista pode passar de 1000 linhas).
export function useYouth(filters: YouthFilters) {
  const { user, role } = useAuth();
  const [mutationError, setMutationError] = useState<string | null>(null);
  // Grupos visíveis (RLS): coordenador vê todos, líder os seus — alimentam o filtro e os nomes
  const [groups, setGroups] = useState<GroupRef[]>([]);
  const [counts, setCounts] = useState({ active: 0, inactive: 0 });
  const [auxError, setAuxError] = useState<string | null>(null);

  const list = usePagedList<Youth>({
    enabled: !!user,
    filters: [filters.search, filters.status, filters.groupId],
    errorFallback: 'Erro ao carregar jovens.',
    fetchPage: async ({ from, to }) => {
      let q = (supabase as any).from('youth').select('*', { count: 'exact' });
      const pattern = searchPattern(filters.search);
      if (pattern) q = q.ilike('full_name', pattern);
      if (filters.status !== 'all') q = q.eq('is_active', filters.status === 'active');
      if (filters.groupId === 'none') q = q.is('group_id', null);
      else if (filters.groupId !== 'all') q = q.eq('group_id', filters.groupId);
      const { data, count, error } = await q.order('full_name', { ascending: true }).order('id').range(from, to);
      if (error) throw error;
      return { rows: (data ?? []) as Youth[], total: count ?? 0 };
    },
  });

  // Dados auxiliares: grupos (para filtro/nome) e totais de ativos/inativos do cabeçalho
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    const sb = supabase as any;
    const head = (active: boolean) =>
      sb.from('youth').select('id', { count: 'exact', head: true }).eq('is_active', active);
    Promise.all([
      fetchAll<GroupRef>(() => sb.from('groups').select('id, name').order('name', { ascending: true }).order('id')),
      head(true),
      head(false),
    ])
      .then(([g, a, i]) => {
        if (cancelled) return;
        setGroups(g);
        setAuxError(null);
        if (a.error || i.error) { logError('Erro ao contar jovens ativos/inativos', a.error ?? i.error); return; }
        setCounts({ active: a.count ?? 0, inactive: i.count ?? 0 });
      })
      .catch((err: unknown) => {
        // sem a lista de grupos o filtro e a coluna "Grupo" ficariam vazios sem explicação
        if (!cancelled) setAuxError(errorMessage(err, 'Não foi possível carregar a lista de grupos.'));
      });
    return () => { cancelled = true; };
  }, [user, list.version]);

  const { refetch } = list;

  const createYouth = async (payload: Omit<YouthInsert, 'created_by'>): Promise<Youth | null> => {
    if (!user) return null;
    setMutationError(null);
    const insert: YouthInsert = { ...payload, created_by: user.id };
    const { data, error: insertError } = await (supabase as any)
      .from('youth')
      .insert(insert)
      .select()
      .single();
    if (insertError) { setMutationError(errorMessage(insertError)); return null; }
    refetch();
    return data as Youth;
  };

  const updateYouth = async (id: string, payload: YouthUpdate): Promise<Youth | null> => {
    setMutationError(null);
    const { data, error: updateError } = await (supabase as any)
      .from('youth')
      .update(payload)
      .eq('id', id)
      .select()
      .single();
    if (updateError) { setMutationError(errorMessage(updateError)); return null; }
    refetch();
    return data as Youth;
  };

  // Ações em lote (RPCs batch_set_youth_*, migration 014): atômicas, no máximo BATCH_MAX jovens por chamada.
  // Devolvem o resultado {requested, updated, unchanged, skipped} ou null em erro (mensagem em `error`).
  const runBatch = async (fn: string, args: Record<string, unknown>, fallback: string): Promise<BatchResult | null> => {
    setMutationError(null);
    const { data, error: rpcError } = await (supabase as any).rpc(fn, args);
    if (rpcError) { setMutationError(errorMessage(rpcError, fallback)); return null; }
    refetch();
    return parseBatchResult(data);
  };

  const batchSetGroup = (ids: string[], groupId: string | null) =>
    runBatch('batch_set_youth_group', { p_youth_ids: ids, p_group_id: groupId }, 'Erro ao alterar o grupo dos jovens.');

  const batchSetActive = (ids: string[], active: boolean) =>
    runBatch('batch_set_youth_active', { p_youth_ids: ids, p_active: active },
      active ? 'Erro ao ativar os jovens.' : 'Erro ao desativar os jovens.');

  // Irreversível (migration 021). Só coordenador: a RPC também recusa outros papéis (42501).
  // "Há um e-mail em envio..." é P0001 do banco e chega como está (errorMessage deixa passar).
  const anonymizeYouth = async (id: string): Promise<AnonymizeResult | null> => {
    if (role !== 'coordinator') { setMutationError('Apenas coordenadores podem anonimizar jovens.'); return null; }
    setMutationError(null);
    const { data, error: rpcError } = await (supabase as any).rpc('anonymize_youth', { p_youth_id: id });
    if (rpcError) { setMutationError(errorMessage(rpcError, 'Erro ao anonimizar os dados do jovem.')); return null; }
    refetch();
    notifyAlertsChanged(); // o jovem fica inativo: alertas abertos são resolvidos pelo banco
    return data as AnonymizeResult;
  };

  const deactivateYouth = async (id: string): Promise<boolean> => (await updateYouth(id, { is_active: false })) !== null;
  const activateYouth = async (id: string): Promise<boolean> => (await updateYouth(id, { is_active: true })) !== null;

  return {
    youth: list.rows,
    total: list.total,
    page: list.page,
    setPage: list.setPage,
    pageSize: list.pageSize,
    totalPages: list.totalPages,
    groups,
    activeCount: counts.active,
    inactiveCount: counts.inactive,
    loading: list.loading,
    error: mutationError ?? list.error ?? auxError,
    role,
    refetch,
    createYouth,
    updateYouth,
    deactivateYouth,
    activateYouth,
    batchSetGroup,
    batchSetActive,
    anonymizeYouth,
    clearError: () => setMutationError(null),
  };
}
