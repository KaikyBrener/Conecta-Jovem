import { useState, useEffect, useCallback } from 'react';
import { supabase } from '../lib/supabase';
import type { Group, GroupInsert, GroupUpdate, Youth, Profile } from '../types/database.types';
import { useAuth } from '../contexts/AuthContext';
import { errorMessage } from '../lib/format';
import { logError } from '../lib/logger';
import { fetchAll } from '../lib/fetchAll';
import { searchPattern } from '../lib/pagination';
import { usePagedList } from './usePagedList';

export interface GroupWithLeader extends Group {
  leader_name: string;
  member_count: number;
}

type RawGroup = Group & { profiles: { full_name: string } | null; youth: { count: number }[] | null };

function withLeaderAndCount(groups: RawGroup[]): GroupWithLeader[] {
  return groups.map((g) => ({
    ...g,
    leader_name: g.profiles?.full_name ?? '—',
    // embed youth(count): contagem feita pelo banco, só para os grupos da página
    member_count: g.youth?.[0]?.count ?? 0,
  }));
}

export interface GroupFilters {
  search: string;
}

// RLS filtra automaticamente:
// – coordinator: todos os grupos
// – leader: apenas seus grupos (leader_id = auth.uid())
// Busca, ordenação e paginação rodam no servidor.
export function useGroups(filters: GroupFilters) {
  const { user, role } = useAuth();
  const [mutationError, setMutationError] = useState<string | null>(null);
  // Total de grupos visíveis, sem filtro (subtítulo da página)
  const [totalAll, setTotalAll] = useState(0);

  // Líderes disponíveis para atribuição (apenas coordenadores vêem todos)
  const [leaders, setLeaders] = useState<Profile[]>([]);

  const list = usePagedList<GroupWithLeader>({
    enabled: !!user,
    filters: [filters.search],
    errorFallback: 'Erro ao carregar grupos.',
    fetchPage: async ({ from, to }) => {
      const sb = supabase as any;
      let q = sb.from('groups').select('*, profiles:leader_id(full_name), youth(count)', { count: 'exact' });
      const pattern = searchPattern(filters.search);
      if (pattern) {
        // Nome do grupo OU nome do líder. O PostgREST não faz OR entre tabelas, então os ids
        // dos líderes que combinam são resolvidos antes (profiles respeita o RLS do usuário).
        const lookup = await sb.from('profiles').select('id').ilike('full_name', pattern).limit(500);
        if (lookup.error) throw lookup.error;
        const ids = ((lookup.data ?? []) as { id: string }[]).map((p) => p.id);
        const byLeader = ids.length ? `,leader_id.in.(${ids.join(',')})` : '';
        q = q.or(`name.ilike."${pattern}"${byLeader}`);
      }
      const { data, count, error } = await q.order('name', { ascending: true }).order('id').range(from, to);
      if (error) throw error;
      return { rows: withLeaderAndCount((data ?? []) as RawGroup[]), total: count ?? 0 };
    },
  });
  const fetchGroups = list.refetch;

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    (supabase as any).from('groups').select('id', { count: 'exact', head: true })
      .then(({ count, error }: { count: number | null; error: unknown }) => {
        if (error) { logError('Erro ao contar grupos', error); return; }
        if (!cancelled) setTotalAll(count ?? 0);
      });
    return () => { cancelled = true; };
  }, [user, list.version]);

  // Busca líderes (perfis com role='leader') — coordenador usa para o formulário.
  // user_roles.user_id referencia profiles(id) diretamente, então o embed resolve
  // em uma única consulta (sem precisar de uma subconsulta separada).
  const fetchLeaders = useCallback(async () => {
    if (role !== 'coordinator') return;
    try {
      const rows = await fetchAll<{ profiles: Profile | null }>(() =>
        (supabase as any)
          .from('user_roles')
          .select('profiles:user_id(id, full_name)')
          .eq('role', 'leader')
          .order('user_id'));
      const sorted = rows
        .map((r) => r.profiles)
        .filter((p): p is Profile => p !== null)
        .sort((a, b) => a.full_name.localeCompare(b.full_name, 'pt-BR'));
      setLeaders(sorted);
    } catch (e) {
      setMutationError(errorMessage(e));
    }
  }, [role]);

  // Busca integrantes de um grupo específico
  const fetchMembers = useCallback(async (groupId: string): Promise<Youth[]> => {
    try {
      return await fetchAll<Youth>(() =>
        (supabase as any)
          .from('youth')
          .select('*')
          .eq('group_id', groupId)
          .order('full_name', { ascending: true })
          .order('id'));
    } catch (e) {
      setMutationError(errorMessage(e));
      return [];
    }
  }, []);

  // Jovens sem grupo (apenas coordenador usa plenamente, líder vê os seus)
  const fetchUnassigned = useCallback(async (): Promise<Youth[]> => {
    try {
      return await fetchAll<Youth>(() =>
        (supabase as any)
          .from('youth')
          .select('*')
          .is('group_id', null)
          .eq('is_active', true)
          .order('full_name', { ascending: true })
          .order('id'));
    } catch (e) {
      setMutationError(errorMessage(e));
      return [];
    }
  }, []);

  const createGroup = async (payload: GroupInsert): Promise<Group | null> => {
    setMutationError(null);
    const { data, error: e } = await (supabase as any)
      .from('groups')
      .insert(payload)
      .select()
      .single();
    if (e) { setMutationError(errorMessage(e)); return null; }
    fetchGroups();
    return data as Group;
  };

  const updateGroup = async (id: string, payload: GroupUpdate): Promise<Group | null> => {
    setMutationError(null);
    const { data, error: e } = await (supabase as any)
      .from('groups')
      .update(payload)
      .eq('id', id)
      .select()
      .single();
    if (e) { setMutationError(errorMessage(e)); return null; }
    fetchGroups();
    return data as Group;
  };

  // Atribui um jovem a um grupo (verifica permissão de líder no RLS)
  const assignYouth = async (youthId: string, groupId: string): Promise<boolean> => {
    setMutationError(null);
    const { error: e } = await (supabase as any)
      .from('youth')
      .update({ group_id: groupId })
      .eq('id', youthId);
    if (e) { setMutationError(errorMessage(e)); return false; }
    fetchGroups();
    return true;
  };

  // Remove jovem do grupo
  const removeYouthFromGroup = async (youthId: string): Promise<boolean> => {
    setMutationError(null);
    const { error: e } = await (supabase as any)
      .from('youth')
      .update({ group_id: null })
      .eq('id', youthId);
    if (e) { setMutationError(errorMessage(e)); return false; }
    fetchGroups();
    return true;
  };

  return {
    groups: list.rows,
    total: list.total,
    totalAll,
    page: list.page,
    setPage: list.setPage,
    pageSize: list.pageSize,
    totalPages: list.totalPages,
    leaders,
    loading: list.loading,
    error: mutationError ?? list.error,
    role,
    user,
    refetch: fetchGroups,
    fetchLeaders,
    fetchMembers,
    fetchUnassigned,
    createGroup,
    updateGroup,
    assignYouth,
    removeYouthFromGroup,
  };
}
