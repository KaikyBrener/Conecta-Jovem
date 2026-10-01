import { useState, useEffect, useCallback } from 'react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';
import { errorMessage } from '../lib/format';
import type { Task, TaskInsert, TaskUpdate, AlertStatus, GroupRef } from '../types/database.types';

/** Monta o pré-preenchimento de uma nova tarefa a partir de um alerta (vindo de /alertas) */
export async function prefillTaskFromAlert(alertId: string): Promise<Partial<Task> | null> {
  const { data } = await (supabase as any)
    .from('alerts')
    .select('id, youth_id, group_id, consecutive_absences, youth:youth_id(full_name)')
    .eq('id', alertId)
    .maybeSingle();
  if (!data) return null;
  return {
    alert_id: data.id,
    youth_id: data.youth_id,
    group_id: data.group_id,
    priority: 'high',
    title: `Contatar ${data.youth?.full_name ?? 'jovem'} (${data.consecutive_absences} faltas)`,
  };
}

/** Monta o pré-preenchimento de uma nova tarefa a partir de um jovem (vindo de /jovens) */
export async function prefillTaskFromYouth(youthId: string): Promise<Partial<Task> | null> {
  const { data } = await (supabase as any)
    .from('youth')
    .select('id, full_name, group_id')
    .eq('id', youthId)
    .maybeSingle();
  if (!data) return null;
  return { youth_id: data.id, group_id: data.group_id, title: `Acompanhar ${data.full_name}` };
}

export interface TaskWithRelations extends Task {
  youth: { full_name: string } | null;
  groups: { name: string } | null;
  assignee: { full_name: string | null } | null;
  alert: { status: AlertStatus; consecutive_absences: number } | null;
}

export interface TaskOptions {
  youth: { id: string; full_name: string; group_id: string | null }[];
  groups: GroupRef[];
  /** Usuários a quem se pode atribuir: coordenador vê todos, líder só a si */
  assignees: { id: string; full_name: string | null }[];
}

const SELECT = `
  *,
  youth:youth_id ( full_name ),
  groups:group_id ( name ),
  assignee:assigned_to ( full_name ),
  alert:alert_id ( status, consecutive_absences )
`;

async function loadTasks(): Promise<TaskWithRelations[]> {
  // RLS filtra: coordenador vê todas; líder as atribuídas/criadas/dos seus grupos
  const { data, error } = await (supabase as any)
    .from('tasks')
    .select(SELECT)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data ?? []) as TaskWithRelations[];
}

async function loadOptions(isCoordinator: boolean, userId: string, userName: string | null): Promise<TaskOptions> {
  const [yRes, gRes, pRes]: [any, any, any] = await Promise.all([
    (supabase as any).from('youth').select('id, full_name, group_id').eq('is_active', true).order('full_name'),
    (supabase as any).from('groups').select('id, name').order('name'),
    isCoordinator
      ? (supabase as any).from('profiles').select('id, full_name').order('full_name')
      : Promise.resolve({ data: [{ id: userId, full_name: userName }] }),
  ]);
  return {
    youth: yRes.data ?? [],
    groups: gRes.data ?? [],
    assignees: pRes.data ?? [],
  };
}

export function useTasks() {
  const { user, role, profile } = useAuth();
  const isCoordinator = role === 'coordinator';
  const [tasks, setTasks] = useState<TaskWithRelations[]>([]);
  const [options, setOptions] = useState<TaskOptions>({ youth: [], groups: [], assignees: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    Promise.all([loadTasks(), loadOptions(isCoordinator, user.id, profile?.full_name ?? null)])
      .then(([t, o]) => { if (!cancelled) { setTasks(t); setOptions(o); } })
      .catch((err: unknown) => { if (!cancelled) setError(errorMessage(err, 'Erro ao carregar tarefas.')); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [user, isCoordinator, profile?.full_name]);

  const refetch = useCallback(async () => {
    try {
      setTasks(await loadTasks());
      setError(null);
    } catch (err: unknown) {
      setError(errorMessage(err, 'Erro ao carregar tarefas.'));
    }
  }, []);

  const createTask = async (payload: Omit<TaskInsert, 'created_by'>): Promise<boolean> => {
    if (!user) return false;
    setError(null);
    const { error: e } = await (supabase as any)
      .from('tasks')
      .insert({ ...payload, created_by: user.id });
    if (e) { setError(errorMessage(e, 'Erro ao criar tarefa.')); return false; }
    await refetch();
    return true;
  };

  const updateTask = async (id: string, payload: TaskUpdate): Promise<boolean> => {
    setError(null);
    const { data, error: e } = await (supabase as any)
      .from('tasks')
      .update(payload)
      .eq('id', id)
      .select('id')
      .maybeSingle();
    if (e) { setError(errorMessage(e, 'Erro ao atualizar tarefa.')); return false; }
    if (!data) { setError('Sem permissão para alterar esta tarefa.'); return false; }
    await refetch();
    return true;
  };

  const deleteTask = async (id: string): Promise<boolean> => {
    setError(null);
    const { data, error: e } = await (supabase as any)
      .from('tasks')
      .delete()
      .eq('id', id)
      .select('id');
    if (e) { setError(errorMessage(e, 'Erro ao excluir tarefa.')); return false; }
    if (!data || data.length === 0) { setError('Você só pode excluir tarefas criadas por você.'); return false; }
    await refetch();
    return true;
  };

  return { tasks, options, loading, error, isCoordinator, user, refetch, createTask, updateTask, deleteTask };
}
