import { useEffect, useMemo, useState } from 'react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';
import { errorMessage } from '../lib/format';
import { logError } from '../lib/logger';
import { notifyAlertsChanged } from '../lib/alertsBus';
import { followUpPayload, type FollowUpFormValues } from '../lib/followups';
import { useAsyncValue } from './useAsyncValue';
import { usePagedList } from './usePagedList';
import type { Alert, FollowUp, FollowUpTransfer, Role, Task } from '../types/database.types';

export interface FollowUpWithRelations extends FollowUp {
  /** Histórico de transferências (somente leitura) */
  transfers: FollowUpTransfer[];
  alert: Pick<Alert, 'id' | 'type' | 'severity' | 'status' | 'consecutive_absences' | 'attendance_rate' | 'previous_rate' | 'sample_size'> | null;
  task: Pick<Task, 'id' | 'title' | 'status'> | null;
}

export interface AssignableResponsible {
  id: string;
  full_name: string | null;
  role: Role;
}

export interface PersonName {
  id: string;
  full_name: string | null;
}

export interface LinkOptions {
  /** Ações abertas do jovem (podem ser concluídas pelo acompanhamento) */
  tasks: Pick<Task, 'id' | 'title' | 'status' | 'due_date'>[];
  /** Alertas abertos do jovem */
  alerts: Pick<Alert, 'id' | 'type' | 'severity' | 'consecutive_absences' | 'attendance_rate' | 'previous_rate' | 'sample_size'>[];
}

const SELECT = `
  *,
  transfers:follow_up_transfers ( id, follow_up_id, from_responsible_id, to_responsible_id, reason, transferred_by, transferred_at ),
  alert:alert_id ( id, type, severity, status, consecutive_absences, attendance_rate, previous_rate, sample_size ),
  task:task_id ( id, title, status )
`;

const NO_RESPONSIBLES: AssignableResponsible[] = [];
const NO_LINKS: LinkOptions = { tasks: [], alerts: [] };

/** Nomes das pessoas de UM acompanhamento (responsável, criador e envolvidos nas transferências). */
export async function fetchFollowUpPeople(followUpId: string): Promise<PersonName[]> {
  const { data, error } = await (supabase as any).rpc('follow_up_people', { p_follow_up_id: followUpId });
  if (error) throw error;
  return (data ?? []) as PersonName[];
}

/** Coordenadores + líder do grupo atual do jovem: os únicos destinos válidos de responsável. */
export function useAssignableResponsibles(youthId: string | null) {
  return useAsyncValue<AssignableResponsible[]>(
    youthId,
    async () => {
      const { data, error } = await (supabase as any).rpc('assignable_responsibles', { p_youth_id: youthId });
      if (error) throw error;
      return (data ?? []) as AssignableResponsible[];
    },
    NO_RESPONSIBLES,
    'Não foi possível carregar os possíveis responsáveis.',
  );
}

/** Ações e alertas abertos do jovem, para vincular a um acompanhamento (RLS aplica o escopo). */
export function useFollowUpLinkOptions(youthId: string | null) {
  return useAsyncValue<LinkOptions>(
    youthId,
    async () => {
      const sb = supabase as any;
      const [tasks, alerts] = await Promise.all([
        sb.from('tasks').select('id, title, status, due_date').eq('youth_id', youthId)
          .in('status', ['pending', 'in_progress'])
          .order('due_date', { ascending: true, nullsFirst: false }).order('id').limit(50),
        sb.from('alerts').select('id, type, severity, consecutive_absences, attendance_rate, previous_rate, sample_size')
          .eq('youth_id', youthId).eq('status', 'open').order('created_at', { ascending: false }).order('id').limit(20),
      ]);
      if (tasks.error) throw tasks.error;
      if (alerts.error) throw alerts.error;
      return { tasks: tasks.data ?? [], alerts: alerts.data ?? [] } as LinkOptions;
    },
    NO_LINKS,
    'Não foi possível carregar as ações e alertas do jovem.',
  );
}

/**
 * Mutações de acompanhamento (criar, editar, excluir, transferir). Retornam null/false em erro e
 * preenchem `error`. Após sucesso: avisa o menu (alertas podem ter mudado) e chama `onChanged`.
 */
export function useFollowUpMutations(onChanged?: () => void) {
  const { user } = useAuth();
  const [error, setError] = useState<string | null>(null);

  const done = () => {
    notifyAlertsChanged();
    onChanged?.();
  };

  const createFollowUp = async (youthId: string, values: FollowUpFormValues): Promise<boolean> => {
    if (!user) return false;
    setError(null);
    const { error: e } = await (supabase as any)
      .from('follow_ups')
      .insert({
        ...followUpPayload(values),
        youth_id: youthId,
        responsible_id: values.responsible_id || user.id,
        created_by: user.id,
      });
    if (e) { setError(errorMessage(e, 'Erro ao registrar o acompanhamento.')); return false; }
    done();
    return true;
  };

  const updateFollowUp = async (id: string, values: FollowUpFormValues): Promise<boolean> => {
    setError(null);
    const { data, error: e } = await (supabase as any)
      .from('follow_ups')
      .update(followUpPayload(values))
      .eq('id', id)
      .select('id')
      .maybeSingle();
    if (e) { setError(errorMessage(e, 'Erro ao salvar o acompanhamento.')); return false; }
    if (!data) { setError('Sem permissão para alterar este acompanhamento.'); return false; }
    done();
    return true;
  };

  const deleteFollowUp = async (id: string): Promise<boolean> => {
    setError(null);
    const { data, error: e } = await (supabase as any)
      .from('follow_ups')
      .delete()
      .eq('id', id)
      .select('id');
    if (e) { setError(errorMessage(e, 'Erro ao excluir o acompanhamento.')); return false; }
    if (!data || data.length === 0) { setError('Somente coordenadores podem excluir acompanhamentos.'); return false; }
    done();
    return true;
  };

  /** Troca o responsável pela RPC (grava o histórico e o novo responsável de forma atômica). */
  const transferFollowUp = async (id: string, newResponsibleId: string, reason: string): Promise<boolean> => {
    setError(null);
    const { error: e } = await (supabase as any).rpc('transfer_follow_up', {
      p_follow_up_id: id,
      p_new_responsible_id: newResponsibleId,
      p_reason: reason.trim(),
    });
    if (e) { setError(errorMessage(e, 'Erro ao transferir o responsável.')); return false; }
    done();
    return true;
  };

  return { error, clearError: () => setError(null), createFollowUp, updateFollowUp, deleteFollowUp, transferFollowUp };
}

/** Linha do tempo de acompanhamentos de um jovem: paginada no servidor (25 por página) + nomes + mutações. */
export function useFollowUps(youthId: string) {
  const { user, profile, role } = useAuth();
  const isCoordinator = role === 'coordinator';

  const list = usePagedList<FollowUpWithRelations>({
    enabled: !!user && !!youthId,
    filters: [youthId],
    errorFallback: 'Erro ao carregar os acompanhamentos.',
    fetchPage: async ({ from, to }) => {
      const { data, count, error } = await (supabase as any)
        .from('follow_ups')
        .select(SELECT, { count: 'exact' })
        .eq('youth_id', youthId)
        .order('occurred_at', { ascending: false })
        .order('created_at', { ascending: false })
        .order('id')
        .range(from, to);
      if (error) throw error;
      const rows = ((data ?? []) as FollowUpWithRelations[]).map((r) => ({ ...r, transfers: r.transfers ?? [] }));
      return { rows, total: count ?? 0 };
    },
  });
  const { refetch } = list;

  const mutations = useFollowUpMutations(refetch);

  // Nomes: o líder não lê perfis de terceiros (RLS), então vêm das RPCs assignable_responsibles e follow_up_people
  const responsibles = useAssignableResponsibles(youthId || null);
  const [extraNames, setExtraNames] = useState<ReadonlyMap<string, string>>(new Map());

  const baseNames = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of responsibles.data) m.set(r.id, r.full_name ?? 'Sem nome');
    return m;
  }, [responsibles.data]);

  // Responsável atual que não é candidato hoje (ex.: líder de um grupo anterior): busca o nome só desses
  const missingKey = useMemo(() => {
    if (responsibles.loading) return '';
    return list.rows
      .filter((r) => r.responsible_id && r.responsible_id !== user?.id
        && !baseNames.has(r.responsible_id) && !extraNames.has(r.responsible_id))
      .map((r) => r.id)
      .join(',');
  }, [responsibles.loading, list.rows, user?.id, baseNames, extraNames]);

  useEffect(() => {
    if (!missingKey) return;
    let cancelled = false;
    Promise.all(missingKey.split(',').map((id) => fetchFollowUpPeople(id)))
      .then((lists) => {
        if (cancelled) return;
        setExtraNames((prev) => {
          const next = new Map(prev);
          for (const p of lists.flat()) next.set(p.id, p.full_name ?? 'Sem nome');
          return next;
        });
      })
      .catch((err: unknown) => logError('Erro ao carregar nomes dos responsáveis', err));
    return () => { cancelled = true; };
  }, [missingKey]);

  const myId = user?.id;
  const myName = profile?.full_name;
  const names = useMemo(() => {
    const m = new Map<string, string>(extraNames);
    for (const [id, n] of baseNames) m.set(id, n);
    if (myId && myName) m.set(myId, myName);
    return m as ReadonlyMap<string, string>;
  }, [extraNames, baseNames, myId, myName]);

  return {
    followUps: list.rows,
    total: list.total,
    page: list.page,
    setPage: list.setPage,
    pageSize: list.pageSize,
    totalPages: list.totalPages,
    loading: list.loading,
    error: mutations.error ?? list.error,
    names,
    isCoordinator,
    userId: user?.id ?? null,
    refetch,
    deleteFollowUp: mutations.deleteFollowUp,
    clearError: mutations.clearError,
  };
}
