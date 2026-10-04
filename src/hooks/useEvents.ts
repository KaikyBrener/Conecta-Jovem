import { useState, useEffect, useCallback } from 'react';
import { supabase } from '../lib/supabase';
import type { Event, EventInsert, EventUpdate, EventStatus, Group } from '../types/database.types';
import { useAuth } from '../contexts/AuthContext';
import { errorMessage } from '../lib/format';
import { logError } from '../lib/logger';
import { notifyAlertsChanged } from '../lib/alertsBus';
import { fetchAll } from '../lib/fetchAll';
import { searchPattern } from '../lib/pagination';
import { usePagedList } from './usePagedList';

export interface EventWithGroups extends Event {
  group_ids: string[];
  group_names: string[];
  /** Nome da série de origem (null = encontro avulso ou série não visível) */
  series_name: string | null;
}

type EgRow = { event_id: string; group_id: string; groups: { name: string } | null };

function attachGroups(events: Event[], egRows: EgRow[], seriesNames: Map<string, string> = new Map()): EventWithGroups[] {
  const groupMap: Record<string, { ids: string[]; names: string[] }> = {};
  for (const row of egRows) {
    if (!groupMap[row.event_id]) groupMap[row.event_id] = { ids: [], names: [] };
    groupMap[row.event_id].ids.push(row.group_id);
    groupMap[row.event_id].names.push(row.groups?.name ?? '—');
  }
  return events.map((ev) => ({
    ...ev,
    group_ids: groupMap[ev.id]?.ids ?? [],
    group_names: groupMap[ev.id]?.names ?? [],
    series_name: ev.series_id ? seriesNames.get(ev.series_id) ?? null : null,
  }));
}

/**
 * Nomes das séries dos encontros recebidos (uma consulta só se houver encontro de série). Falha aqui não derruba
 * a lista: o selo "Série: nome" simplesmente não aparece.
 */
async function fetchSeriesNames(events: Event[]): Promise<Map<string, string>> {
  const ids = [...new Set(events.map((e) => e.series_id).filter((id): id is string => !!id))];
  const names = new Map<string, string>();
  if (ids.length === 0) return names;
  const { data, error } = await (supabase as any).from('event_series').select('id, name').in('id', ids);
  if (error) { logError('Erro ao carregar nomes das séries', error); return names; }
  for (const s of (data ?? []) as { id: string; name: string }[]) names.set(s.id, s.name);
  return names;
}

/**
 * Busca um encontro por id, independente da página/filtros da lista (deep link `?evento=`). O RLS decide a
 * visibilidade: inexistente e sem permissão são indistinguíveis (null). Falhas de rede/servidor lançam erro.
 */
export async function fetchEventById(id: string): Promise<EventWithGroups | null> {
  const sb = supabase as any;
  const { data, error } = await sb.from('events').select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const event = data as Event;
  const eg = await sb.from('event_groups').select('event_id, group_id, groups:group_id(name)').eq('event_id', id);
  if (eg.error) throw eg.error;
  const names = await fetchSeriesNames([event]);
  return attachGroups([event], (eg.data ?? []) as EgRow[], names)[0];
}

export type EventStatusFilter = 'all' | EventStatus;

export interface EventFilters {
  search: string;
  status: EventStatusFilter;
}

// RLS filtra automaticamente por role. Filtros, ordenação e paginação rodam no servidor;
// os vínculos (event_groups) são buscados só para os encontros da página atual.
export function useEvents(filters: EventFilters) {
  const { user, role } = useAuth();
  const [mutationError, setMutationError] = useState<string | null>(null);
  // Só usado pelo formulário de criação/edição; carregado sob demanda (fetchAllGroups),
  // não precisa fazer parte da consulta inicial da lista de encontros.
  const [allGroups, setAllGroups] = useState<Group[]>([]);
  // Total de encontros visíveis, sem filtros (subtítulo da página)
  const [totalAll, setTotalAll] = useState(0);

  const list = usePagedList<EventWithGroups>({
    enabled: !!user,
    filters: [filters.search, filters.status],
    errorFallback: 'Erro ao carregar encontros.',
    fetchPage: async ({ from, to }) => {
      const sb = supabase as any;
      let q = sb.from('events').select('*', { count: 'exact' });
      const pattern = searchPattern(filters.search);
      if (pattern) q = q.ilike('title', pattern);
      if (filters.status !== 'all') q = q.eq('status', filters.status);
      const { data, count, error } = await q.order('event_date', { ascending: false }).order('id').range(from, to);
      if (error) throw error;
      const events = (data ?? []) as Event[];
      let egRows: EgRow[] = [];
      if (events.length > 0) {
        const eg = await sb.from('event_groups')
          .select('event_id, group_id, groups:group_id(name)')
          .in('event_id', events.map((e) => e.id));
        if (eg.error) throw eg.error;
        egRows = (eg.data ?? []) as EgRow[];
      }
      const seriesNames = await fetchSeriesNames(events);
      return { rows: attachGroups(events, egRows, seriesNames), total: count ?? 0 };
    },
  });
  const { refetch } = list;

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    (supabase as any).from('events').select('id', { count: 'exact', head: true })
      .then(({ count, error }: { count: number | null; error: unknown }) => {
        if (error) { logError('Erro ao contar encontros', error); return; }
        if (!cancelled) setTotalAll(count ?? 0);
      });
    return () => { cancelled = true; };
  }, [user, list.version]);

  // Carrega grupos disponíveis para seleção no formulário (todos: fetchAll evita o corte de 1000)
  const fetchAllGroups = useCallback(async () => {
    try {
      const rows = await fetchAll<Group>(() =>
        (supabase as any).from('groups').select('id, name, leader_id').order('name', { ascending: true }).order('id'));
      setAllGroups(rows);
    } catch (e) { setMutationError(errorMessage(e)); }
  }, []);

  // Salva o encontro e seus grupos numa única transação (RPC save_event, migration 009):
  // se algo falhar, nada é gravado — nunca sobra um encontro sem os grupos pretendidos.
  // A RPC é SECURITY INVOKER: o RLS de events/event_groups continua sendo a barreira.
  const saveEvent = async (
    id: string | null,
    payload: EventUpdate,
    groupIds: string[]
  ): Promise<Event | null> => {
    setMutationError(null);
    const { data, error: e } = await (supabase as any).rpc('save_event', {
      p_event_id: id,
      p_title: payload.title ?? null,
      p_description: payload.description ?? null,
      p_event_date: payload.event_date ?? null,
      p_status: payload.status ?? null,
      p_group_ids: groupIds,
    });
    if (e) { setMutationError(errorMessage(e)); return null; }
    // Cancelar (ou remarcar/reabrir) um encontro muda as faltas consecutivas: o banco recalcula os alertas
    if (id !== null || payload.status === 'cancelled') notifyAlertsChanged();
    refetch();
    return data as Event;
  };

  const createEvent = async (
    payload: Omit<EventInsert, 'created_by'>,
    groupIds: string[]
  ): Promise<Event | null> => {
    if (!user) return null;
    return saveEvent(null, payload, groupIds);
  };

  const updateEvent = async (
    id: string,
    payload: EventUpdate,
    groupIds: string[]
  ): Promise<Event | null> => saveEvent(id, payload, groupIds);

  const deleteEvent = async (id: string): Promise<boolean> => {
    if (role !== 'coordinator') return false;
    setMutationError(null);
    const { error: e } = await (supabase as any).from('events').delete().eq('id', id);
    if (e) { setMutationError(errorMessage(e)); return false; }
    notifyAlertsChanged(); // a chamada do encontro some junto: alertas são recalculados
    refetch();
    return true;
  };

  return {
    events: list.rows,
    total: list.total,
    totalAll,
    page: list.page,
    setPage: list.setPage,
    pageSize: list.pageSize,
    totalPages: list.totalPages,
    allGroups,
    loading: list.loading,
    error: mutationError ?? list.error,
    role,
    user,
    refetch,
    fetchAllGroups,
    createEvent,
    updateEvent,
    deleteEvent,
  };
}
