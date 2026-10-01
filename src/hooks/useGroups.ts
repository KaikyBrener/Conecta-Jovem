import { useState, useEffect, useCallback } from 'react';
import { supabase } from '../lib/supabase';
import type { Group, GroupInsert, GroupUpdate, Youth, Profile } from '../types/database.types';
import { useAuth } from '../contexts/AuthContext';
import { errorMessage } from '../lib/format';

export interface GroupWithLeader extends Group {
  leader_name: string;
  member_count: number;
}

type RawGroup = Group & { profiles: { full_name: string } | null };

function withLeaderAndCount(groups: RawGroup[], countMap: Record<string, number>): GroupWithLeader[] {
  return groups.map((g) => ({
    ...g,
    leader_name: g.profiles?.full_name ?? '—',
    member_count: countMap[g.id] ?? 0,
  }));
}

// RLS filtra automaticamente:
// – coordinator: todos os grupos
// – leader: apenas seus grupos (leader_id = auth.uid())
async function loadGroups(): Promise<GroupWithLeader[]> {
  const [groupRes, youthRes] = await Promise.all([
    (supabase as any).from('groups').select('*, profiles:leader_id(full_name)').order('name', { ascending: true }),
    (supabase as any).from('youth').select('group_id').not('group_id', 'is', null),
  ]);
  if (groupRes.error) throw groupRes.error;
  if (youthRes.error) throw youthRes.error;

  const countMap: Record<string, number> = {};
  for (const y of (youthRes.data ?? []) as { group_id: string }[]) {
    countMap[y.group_id] = (countMap[y.group_id] ?? 0) + 1;
  }
  return withLeaderAndCount((groupRes.data ?? []) as RawGroup[], countMap);
}

export function useGroups() {
  const { user, role } = useAuth();
  const [groups, setGroups] = useState<GroupWithLeader[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Líderes disponíveis para atribuição (apenas coordenadores vêem todos)
  const [leaders, setLeaders] = useState<Profile[]>([]);

  const fetchGroups = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    setError(null);
    try {
      setGroups(await loadGroups());
    } catch (err: unknown) {
      setError(errorMessage(err, 'Erro ao carregar grupos.'));
    } finally {
      setLoading(false);
    }
  }, [user]);

  // Busca líderes (perfis com role='leader') — coordenador usa para o formulário.
  // user_roles.user_id referencia profiles(id) diretamente, então o embed resolve
  // em uma única consulta (sem precisar de uma subconsulta separada).
  const fetchLeaders = useCallback(async () => {
    if (role !== 'coordinator') return;
    const { data, error: e } = await (supabase as any)
      .from('user_roles')
      .select('profiles:user_id(id, full_name)')
      .eq('role', 'leader');
    if (e) { setError(errorMessage(e)); return; }
    const list = ((data ?? []) as { profiles: Profile | null }[])
      .map((r) => r.profiles)
      .filter((p): p is Profile => p !== null)
      .sort((a, b) => a.full_name.localeCompare(b.full_name, 'pt-BR'));
    setLeaders(list);
  }, [role]);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    loadGroups()
      .then((g) => { if (!cancelled) setGroups(g); })
      .catch((err: unknown) => { if (!cancelled) setError(errorMessage(err, 'Erro ao carregar grupos.')); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [user]);

  // Busca integrantes de um grupo específico
  const fetchMembers = useCallback(async (groupId: string): Promise<Youth[]> => {
    const { data, error: e } = await (supabase as any)
      .from('youth')
      .select('*')
      .eq('group_id', groupId)
      .order('full_name', { ascending: true });
    if (e) { setError(errorMessage(e)); return []; }
    return (data as Youth[]) ?? [];
  }, []);

  // Jovens sem grupo (apenas coordenador usa plenamente, líder vê os seus)
  const fetchUnassigned = useCallback(async (): Promise<Youth[]> => {
    const { data, error: e } = await (supabase as any)
      .from('youth')
      .select('*')
      .is('group_id', null)
      .eq('is_active', true)
      .order('full_name', { ascending: true });
    if (e) { setError(errorMessage(e)); return []; }
    return (data as Youth[]) ?? [];
  }, []);

  const createGroup = async (payload: GroupInsert): Promise<Group | null> => {
    setError(null);
    const { data, error: e } = await (supabase as any)
      .from('groups')
      .insert(payload)
      .select()
      .single();
    if (e) { setError(errorMessage(e)); return null; }
    await fetchGroups();
    return data as Group;
  };

  const updateGroup = async (id: string, payload: GroupUpdate): Promise<Group | null> => {
    setError(null);
    const { data, error: e } = await (supabase as any)
      .from('groups')
      .update(payload)
      .eq('id', id)
      .select()
      .single();
    if (e) { setError(errorMessage(e)); return null; }
    await fetchGroups();
    return data as Group;
  };

  // Atribui um jovem a um grupo (verifica permissão de líder no RLS)
  const assignYouth = async (youthId: string, groupId: string): Promise<boolean> => {
    setError(null);
    const { error: e } = await (supabase as any)
      .from('youth')
      .update({ group_id: groupId })
      .eq('id', youthId);
    if (e) { setError(errorMessage(e)); return false; }
    await fetchGroups();
    return true;
  };

  // Remove jovem do grupo
  const removeYouthFromGroup = async (youthId: string): Promise<boolean> => {
    setError(null);
    const { error: e } = await (supabase as any)
      .from('youth')
      .update({ group_id: null })
      .eq('id', youthId);
    if (e) { setError(errorMessage(e)); return false; }
    await fetchGroups();
    return true;
  };

  return {
    groups,
    leaders,
    loading,
    error,
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
