import { useState, useEffect } from 'react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';
import { appToday, errorMessage } from '../lib/format';
import { suggestedTaskTitle } from '../lib/labels';
import { notifyAlertsChanged } from '../lib/alertsBus';
import { logError } from '../lib/logger';
import { fetchAll } from '../lib/fetchAll';
import { searchPattern } from '../lib/pagination';
import { usePagedList, type PagedResult } from './usePagedList';
import type { Task, TaskInsert, TaskUpdate, AlertStatus, GroupRef } from '../types/database.types';

/** Monta o pré-preenchimento de uma nova tarefa a partir de um alerta (vindo de /alertas) */
export async function prefillTaskFromAlert(alertId: string): Promise<Partial<Task> | null> {
  const { data } = await (supabase as any)
    .from('alerts')
    .select('id, youth_id, group_id, type, consecutive_absences, youth:youth_id(full_name)')
    .eq('id', alertId)
    .maybeSingle();
  if (!data) return null;
  return {
    alert_id: data.id,
    youth_id: data.youth_id,
    group_id: data.group_id,
    priority: 'high',
    title: suggestedTaskTitle(data.type, data.youth?.full_name ?? 'jovem', data.consecutive_absences),
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

/** 'overdue' = abertas com prazo anterior a hoje (mesma regra do banco, is_task_overdue) */
export type TaskListFilter = 'open' | 'overdue' | 'done' | 'all';

export interface TaskFilters {
  status: TaskListFilter;
  onlyMine: boolean;
  search: string;
}

const SELECT = `
  *,
  youth:youth_id ( full_name ),
  groups:group_id ( name ),
  assignee:assigned_to ( full_name ),
  alert:alert_id ( status, consecutive_absences )
`;

const OPEN_STATUSES = ['pending', 'in_progress'];
const CLOSED_STATUSES = ['done', 'cancelled'];

async function loadOptions(isCoordinator: boolean, userId: string, userName: string | null): Promise<TaskOptions> {
  const sb = supabase as any;
  // fetchAll: o PostgREST corta em 1000 linhas e estas listas alimentam <select>
  const [youth, groups, assignees] = await Promise.all([
    fetchAll<TaskOptions['youth'][number]>(() =>
      sb.from('youth').select('id, full_name, group_id').eq('is_active', true).order('full_name').order('id')),
    fetchAll<GroupRef>(() => sb.from('groups').select('id, name').order('name').order('id')),
    isCoordinator
      ? fetchAll<TaskOptions['assignees'][number]>(() =>
          sb.from('profiles').select('id, full_name').order('full_name').order('id'))
      : Promise.resolve([{ id: userId, full_name: userName }]),
  ]);
  return { youth, groups, assignees };
}

export function useTasks(filters: TaskFilters) {
  const { user, role, profile } = useAuth();
  const isCoordinator = role === 'coordinator';
  const [options, setOptions] = useState<TaskOptions>({ youth: [], groups: [], assignees: [] });
  const [mutationError, setMutationError] = useState<string | null>(null);
  // Falha ao carregar as opções do formulário (sem elas o formulário abriria com listas vazias, sem explicação)
  const [optionsError, setOptionsError] = useState<string | null>(null);
  // Cabeçalho: sempre sobre todas as tarefas visíveis (RLS), independente de filtros e página
  const [counts, setCounts] = useState({ open: 0, overdue: 0 });
  const userId = user?.id;

  // RLS filtra: coordenador vê todas; líder as atribuídas/criadas/dos seus grupos
  const list = usePagedList<TaskWithRelations>({
    enabled: !!user,
    filters: [filters.status, filters.onlyMine, filters.search],
    errorFallback: 'Erro ao carregar tarefas.',
    fetchPage: async ({ from, to }) => {
      const sb = supabase as any;
      const pattern = searchPattern(filters.search);

      // Título OU nome do jovem. O PostgREST não faz OR entre tabelas: ids dos jovens que
      // combinam são resolvidos antes (youth respeita o RLS do usuário).
      let orFilter: string | null = null;
      if (pattern) {
        const lookup = await sb.from('youth').select('id').ilike('full_name', pattern).limit(500);
        if (lookup.error) throw lookup.error;
        const ids = ((lookup.data ?? []) as { id: string }[]).map((y) => y.id);
        orFilter = `title.ilike."${pattern}"${ids.length ? `,youth_id.in.(${ids.join(',')})` : ''}`;
      }

      const build = (statuses: string[] | null, head = false) => {
        let q = head
          ? sb.from('tasks').select('id', { count: 'exact', head: true })
          : sb.from('tasks').select(SELECT, { count: 'exact' });
        if (statuses) q = q.in('status', statuses);
        if (filters.status === 'overdue') q = q.lt('due_date', appToday());
        if (filters.onlyMine && userId) q = q.eq('assigned_to', userId);
        if (orFilter) q = q.or(orFilter);
        return q;
      };
      // Abertas: prazo mais próximo primeiro (sem prazo por último), depois prioridade (alta→baixa),
      // depois a mais recente. Encerradas: prioridade, depois a mais recente. `id` desempata
      // para a paginação ser estável.
      const openPage = (a: number, b: number) =>
        build(OPEN_STATUSES)
          .order('due_date', { ascending: true, nullsFirst: false })
          .order('priority', { ascending: false })
          .order('created_at', { ascending: false })
          .order('id')
          .range(a, b);
      const closedPage = (a: number, b: number) =>
        build(CLOSED_STATUSES)
          .order('priority', { ascending: false })
          .order('created_at', { ascending: false })
          .order('id')
          .range(a, b);

      if (filters.status === 'open' || filters.status === 'overdue') {
        const { data, count, error } = await openPage(from, to);
        if (error) throw error;
        return { rows: (data ?? []) as TaskWithRelations[], total: count ?? 0 };
      }
      if (filters.status === 'done') {
        const { data, count, error } = await closedPage(from, to);
        if (error) throw error;
        return { rows: (data ?? []) as TaskWithRelations[], total: count ?? 0 };
      }

      // "Todas": abertas primeiro, depois encerradas, como uma única lista contínua.
      // A janela [from, to] cruza as duas partes: pede cada parte só no trecho que lhe cabe.
      const open = await openPage(from, to);
      if (open.error) throw open.error;
      const nOpen: number = open.count ?? 0;
      const rows = [...((open.data ?? []) as TaskWithRelations[])];
      const missing = to - from + 1 - rows.length;
      let nClosed: number;
      if (missing > 0) {
        const start = Math.max(0, from - nOpen);
        const closed = await closedPage(start, start + missing - 1);
        if (closed.error) throw closed.error;
        rows.push(...((closed.data ?? []) as TaskWithRelations[]));
        nClosed = closed.count ?? 0;
      } else {
        const closed = await build(CLOSED_STATUSES, true);
        if (closed.error) throw closed.error;
        nClosed = closed.count ?? 0;
      }
      const result: PagedResult<TaskWithRelations> = { rows, total: nOpen + nClosed };
      return result;
    },
  });
  const { refetch } = list;

  // Opções dos formulários (jovens/grupos/responsáveis): carregadas uma vez, completas
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    loadOptions(isCoordinator, user.id, profile?.full_name ?? null)
      .then((o) => { if (!cancelled) { setOptions(o); setOptionsError(null); } })
      .catch((err: unknown) => {
        if (!cancelled) setOptionsError(errorMessage(err, 'Não foi possível carregar jovens, grupos e responsáveis para o formulário.'));
      });
    return () => { cancelled = true; };
  }, [user, isCoordinator, profile?.full_name]);

  // Contadores do cabeçalho (abertas / atrasadas) — por consulta de contagem, não pela lista
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    const sb = supabase as any;
    const open = () => sb.from('tasks').select('id', { count: 'exact', head: true }).in('status', OPEN_STATUSES);
    Promise.all([open(), open().lt('due_date', appToday())])
      .then(([o, late]) => {
        if (o.error || late.error) { logError('Erro ao contar tarefas abertas/atrasadas', o.error ?? late.error); return; }
        if (!cancelled) setCounts({ open: o.count ?? 0, overdue: late.count ?? 0 });
      })
      .catch((err: unknown) => logError('Erro ao contar tarefas abertas/atrasadas', err));
    return () => { cancelled = true; };
  }, [user, list.version]);

  const createTask = async (payload: Omit<TaskInsert, 'created_by'>): Promise<boolean> => {
    if (!user) return false;
    setMutationError(null);
    const { error: e } = await (supabase as any)
      .from('tasks')
      .insert({ ...payload, created_by: user.id });
    if (e) { setMutationError(errorMessage(e, 'Erro ao criar tarefa.')); return false; }
    notifyAlertsChanged(); // tarefa atrasada/concluída pode abrir ou resolver alertas
    refetch();
    return true;
  };

  const updateTask = async (id: string, payload: TaskUpdate): Promise<boolean> => {
    setMutationError(null);
    const { data, error: e } = await (supabase as any)
      .from('tasks')
      .update(payload)
      .eq('id', id)
      .select('id')
      .maybeSingle();
    if (e) { setMutationError(errorMessage(e, 'Erro ao atualizar tarefa.')); return false; }
    if (!data) { setMutationError('Sem permissão para alterar esta tarefa.'); return false; }
    notifyAlertsChanged();
    refetch();
    return true;
  };

  const deleteTask = async (id: string): Promise<boolean> => {
    setMutationError(null);
    const { data, error: e } = await (supabase as any)
      .from('tasks')
      .delete()
      .eq('id', id)
      .select('id');
    if (e) { setMutationError(errorMessage(e, 'Erro ao excluir tarefa.')); return false; }
    if (!data || data.length === 0) { setMutationError('Você só pode excluir tarefas criadas por você.'); return false; }
    notifyAlertsChanged();
    refetch();
    return true;
  };

  return {
    tasks: list.rows,
    total: list.total,
    page: list.page,
    setPage: list.setPage,
    pageSize: list.pageSize,
    totalPages: list.totalPages,
    openCount: counts.open,
    overdueCount: counts.overdue,
    options,
    loading: list.loading,
    error: mutationError ?? list.error ?? optionsError,
    isCoordinator,
    user,
    refetch,
    createTask,
    updateTask,
    deleteTask,
  };
}
