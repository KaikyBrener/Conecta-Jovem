import { useState, useEffect, useCallback } from 'react';
import { supabase } from '../lib/supabase';
import type { Youth, YouthInsert, YouthUpdate, GroupRef } from '../types/database.types';
import { useAuth } from '../contexts/AuthContext';
import { errorMessage } from '../lib/format';

interface YouthData {
  youth: Youth[];
  groups: GroupRef[];
}

// RLS no banco filtra automaticamente:
// – coordinator: vê todos
// – leader: vê apenas jovens do seu grupo (via policy)
async function loadYouth(): Promise<YouthData> {
  const [youthRes, groupRes] = await Promise.all([
    (supabase as any).from('youth').select('*').order('full_name', { ascending: true }),
    (supabase as any).from('groups').select('id, name').order('name', { ascending: true }),
  ]);
  if (youthRes.error) throw youthRes.error;
  return { youth: (youthRes.data as Youth[]) ?? [], groups: groupRes.data ?? [] };
}

export function useYouth() {
  const { user, role } = useAuth();
  const [youth, setYouth] = useState<Youth[]>([]);
  // Grupos visíveis (RLS): coordenador vê todos, líder os seus
  const [groups, setGroups] = useState<GroupRef[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    loadYouth()
      .then((d) => { if (!cancelled) { setYouth(d.youth); setGroups(d.groups); } })
      .catch((err: unknown) => { if (!cancelled) setError(errorMessage(err, 'Erro ao carregar jovens.')); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [user]);

  const refetch = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    setError(null);
    try {
      const d = await loadYouth();
      setYouth(d.youth);
      setGroups(d.groups);
    } catch (err: unknown) {
      setError(errorMessage(err, 'Erro ao carregar jovens.'));
    } finally {
      setLoading(false);
    }
  }, [user]);

  const createYouth = async (payload: Omit<YouthInsert, 'created_by'>): Promise<Youth | null> => {
    if (!user) return null;
    setError(null);
    const insert: YouthInsert = { ...payload, created_by: user.id };
    const { data, error: insertError } = await (supabase as any)
      .from('youth')
      .insert(insert)
      .select()
      .single();
    if (insertError) { setError(errorMessage(insertError)); return null; }
    await refetch();
    return data as Youth;
  };

  const updateYouth = async (id: string, payload: YouthUpdate): Promise<Youth | null> => {
    setError(null);
    const { data, error: updateError } = await (supabase as any)
      .from('youth')
      .update(payload)
      .eq('id', id)
      .select()
      .single();
    if (updateError) { setError(errorMessage(updateError)); return null; }
    await refetch();
    return data as Youth;
  };

  const deactivateYouth = async (id: string): Promise<boolean> => (await updateYouth(id, { is_active: false })) !== null;
  const activateYouth = async (id: string): Promise<boolean> => (await updateYouth(id, { is_active: true })) !== null;

  return {
    youth,
    groups,
    loading,
    error,
    role,
    refetch,
    createYouth,
    updateYouth,
    deactivateYouth,
    activateYouth,
  };
}
