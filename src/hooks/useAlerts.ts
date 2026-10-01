import { useState, useEffect, useCallback } from 'react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';
import { errorMessage } from '../lib/format';
import type { Alert, AlertStatus, TaskStatus } from '../types/database.types';

export interface AlertWithRelations extends Alert {
  youth: { full_name: string; phone: string | null; group_id: string | null } | null;
  groups: { name: string } | null;
  last_event: { title: string; event_date: string } | null;
  tasks: { id: string; title: string; status: TaskStatus }[];
}

const SELECT = `
  *,
  youth:youth_id ( full_name, phone, group_id ),
  groups:group_id ( name ),
  last_event:last_event_id ( title, event_date ),
  tasks ( id, title, status )
`;

async function loadAlerts(): Promise<AlertWithRelations[]> {
  // RLS: coordenador vê todos; líder só os de jovens dos seus grupos
  const { data, error } = await (supabase as any)
    .from('alerts')
    .select(SELECT)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return ((data ?? []) as AlertWithRelations[]).map((a) => ({ ...a, tasks: a.tasks ?? [] }));
}

export function useAlerts() {
  const { user } = useAuth();
  const [alerts, setAlerts] = useState<AlertWithRelations[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    loadAlerts()
      .then((a) => { if (!cancelled) setAlerts(a); })
      .catch((err: unknown) => { if (!cancelled) setError(errorMessage(err, 'Erro ao carregar alertas.')); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [user]);

  const refetch = useCallback(async () => {
    try {
      setAlerts(await loadAlerts());
      setError(null);
    } catch (err: unknown) {
      setError(errorMessage(err, 'Erro ao carregar alertas.'));
    }
  }, []);

  /** Muda o status (resolved/dismissed/open). resolved_by/at são preenchidos pelo banco. */
  const updateStatus = async (id: string, status: AlertStatus, notes?: string | null): Promise<boolean> => {
    setError(null);
    const payload: { status: AlertStatus; resolution_notes?: string | null } = { status };
    if (notes !== undefined) payload.resolution_notes = notes;
    const { data, error: e } = await (supabase as any)
      .from('alerts')
      .update(payload)
      .eq('id', id)
      .select('id')
      .maybeSingle();
    if (e) {
      // Violação do índice único: já existe outro alerta aberto para o jovem
      setError(e.code === '23505' ? 'Já existe um alerta aberto para este jovem.' : errorMessage(e));
      return false;
    }
    if (!data) { setError('Sem permissão para alterar este alerta.'); return false; }
    await refetch();
    return true;
  };

  return { alerts, loading, error, refetch, updateStatus };
}

/** Contador leve de alertas abertos (RLS aplica o escopo do usuário) — usado no menu/navegação. */
export function useOpenAlertsCount(refreshKey?: unknown) {
  const { user } = useAuth();
  const [count, setCount] = useState(0);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    (supabase as any)
      .from('alerts')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'open')
      .then(({ count: c, error: e }: { count: number | null; error: unknown }) => {
        if (cancelled || e) return;
        setCount(c ?? 0);
      });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, refreshKey]);

  return count;
}
