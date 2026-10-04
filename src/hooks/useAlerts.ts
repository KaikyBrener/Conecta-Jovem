import { useState, useEffect, useRef } from 'react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';
import { errorMessage } from '../lib/format';
import { logError } from '../lib/logger';
import { notifyAlertsChanged, subscribeAlertsChanged } from '../lib/alertsBus';
import { syncTimeAlerts } from '../lib/alertsSync';
import { usePagedList } from './usePagedList';
import type { Alert, AlertSeverity, AlertStatus, AlertType, FollowUpType, TaskStatus } from '../types/database.types';

export interface AlertWithRelations extends Alert {
  youth: { full_name: string; phone: string | null; group_id: string | null } | null;
  groups: { name: string } | null;
  last_event: { title: string; event_date: string } | null;
  /** Ações (tarefas) criadas a partir deste alerta */
  tasks: { id: string; title: string; status: TaskStatus; due_date: string | null; completed_by_follow_up_id: string | null }[];
  /** Acompanhamentos registrados a partir deste alerta */
  follow_ups: { id: string; occurred_at: string; type: FollowUpType; reason: string }[];
}

const SELECT = `
  *,
  youth:youth_id ( full_name, phone, group_id ),
  groups:group_id ( name ),
  last_event:last_event_id ( title, event_date ),
  tasks ( id, title, status, due_date, completed_by_follow_up_id ),
  follow_ups ( id, occurred_at, type, reason )
`;

export type AlertStatusFilter = AlertStatus | 'all';

export interface AlertFilters {
  status: AlertStatusFilter;
  type: AlertType | 'all';
  severity: AlertSeverity | 'all';
}

function normalize(a: AlertWithRelations): AlertWithRelations {
  return {
    ...a,
    tasks: a.tasks ?? [],
    follow_ups: [...(a.follow_ups ?? [])].sort((x, y) => y.occurred_at.localeCompare(x.occurred_at)),
  };
}

export function useAlerts(filters: AlertFilters) {
  const { user } = useAuth();
  const [mutationError, setMutationError] = useState<string | null>(null);
  // Alertas por tempo (sem acompanhamento / ação atrasada) dependem do relógio: sincroniza ao abrir a tela,
  // antes da primeira listagem. syncTimeAlerts nunca lança nem bloqueia a tela em caso de erro (só registra).
  const syncRef = useRef<Promise<boolean> | null>(null);

  // Filtros, ordenação e paginação rodam no servidor. RLS: coordenador vê todos; líder só os de jovens dos seus grupos.
  const list = usePagedList<AlertWithRelations>({
    enabled: !!user,
    filters: [filters.status, filters.type, filters.severity],
    errorFallback: 'Erro ao carregar alertas.',
    fetchPage: async ({ from, to }) => {
      syncRef.current ??= syncTimeAlerts();
      await syncRef.current;
      let q = (supabase as any).from('alerts').select(SELECT, { count: 'exact' });
      if (filters.status !== 'all') q = q.eq('status', filters.status);
      if (filters.type !== 'all') q = q.eq('type', filters.type);
      if (filters.severity !== 'all') q = q.eq('severity', filters.severity);
      const { data, count, error } = await q
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
        .range(from, to);
      if (error) throw error;
      return { rows: ((data ?? []) as AlertWithRelations[]).map(normalize), total: count ?? 0 };
    },
  });
  const { refetch } = list;
  // Mesmo contador do menu (todos os alertas abertos visíveis, sem os filtros de tipo/severidade),
  // recontado a cada recarga da lista.
  const openCount = useOpenAlertsCount(list.version);

  /** Muda o status (resolved/dismissed/open). resolved_by/at são preenchidos pelo banco. */
  const updateStatus = async (id: string, status: AlertStatus, notes?: string | null): Promise<boolean> => {
    setMutationError(null);
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
      setMutationError(e.code === '23505' ? 'Já existe um alerta aberto para este jovem.' : errorMessage(e, 'Erro ao atualizar o alerta.'));
      return false;
    }
    if (!data) { setMutationError('Sem permissão para alterar este alerta.'); return false; }
    notifyAlertsChanged();
    refetch();
    return true;
  };

  return {
    alerts: list.rows,
    total: list.total,
    page: list.page,
    setPage: list.setPage,
    pageSize: list.pageSize,
    totalPages: list.totalPages,
    openCount,
    loading: list.loading,
    error: mutationError ?? list.error,
    refetch,
    updateStatus,
  };
}

/** Contador leve de alertas abertos (RLS aplica o escopo do usuário) — usado no menu/navegação. */
export function useOpenAlertsCount(refreshKey?: unknown) {
  const { user } = useAuth();
  const [count, setCount] = useState(0);
  // Sobe quando algo muda alertas no banco (chamada salva, alerta resolvido, acompanhamento...)
  const [changes, setChanges] = useState(0);

  useEffect(() => subscribeAlertsChanged(() => setChanges((n) => n + 1)), []);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    (supabase as any)
      .from('alerts')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'open')
      .then(({ count: c, error: e }: { count: number | null; error: unknown }) => {
        if (e) { logError('Erro ao contar alertas abertos', e); return; }
        if (cancelled) return;
        setCount(c ?? 0);
      });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, refreshKey, changes]);

  return count;
}
