import { useState } from 'react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';
import { fetchAll } from '../lib/fetchAll';
import { errorMessage } from '../lib/format';
import { notifyAlertsChanged } from '../lib/alertsBus';
import {
  parseSeriesCancelResult,
  parseSeriesCreateResult,
  parseSeriesGroupsResult,
  type SeriesCancelResult,
  type SeriesCreateResult,
  type SeriesGroupsResult,
  type SeriesInput,
} from '../lib/series';
import type { EventSeries } from '../types/database.types';
import { useAsyncValue } from './useAsyncValue';

export interface SeriesRow extends EventSeries {
  events_count: number;
  group_ids: string[];
  group_names: string[];
}

type RawSeries = EventSeries & {
  events: { count: number }[] | null;
  event_series_groups: { group_id: string; groups: { name: string } | null }[] | null;
};

const NO_SERIES: SeriesRow[] = [];

async function loadSeries(): Promise<SeriesRow[]> {
  const rows = await fetchAll<RawSeries>(() =>
    (supabase as any)
      .from('event_series')
      .select('*, events(count), event_series_groups(group_id, groups:group_id(name))')
      .order('start_date', { ascending: false })
      .order('id'));
  return rows.map((s) => ({
    ...s,
    events_count: s.events?.[0]?.count ?? 0,
    group_ids: (s.event_series_groups ?? []).map((g) => g.group_id),
    group_names: (s.event_series_groups ?? []).map((g) => g.groups?.name ?? '—'),
  }));
}

/**
 * Séries de encontros (somente coordenador usa). Leitura pela tabela event_series (RLS); alterações pelas RPCs da
 * migration 014 (atômicas, idempotentes). Mutations devolvem null em erro e preenchem `error`.
 * `listEnabled` só liga a leitura quando a tela de gerenciamento está aberta.
 */
export function useEventSeries(listEnabled: boolean) {
  const { user, role } = useAuth();
  const [mutationError, setMutationError] = useState<string | null>(null);
  const canManage = role === 'coordinator';

  const list = useAsyncValue<SeriesRow[]>(
    user && canManage && listEnabled ? 'series' : null,
    loadSeries,
    NO_SERIES,
    'Erro ao carregar as séries de encontros.',
  );

  const call = async <T>(fn: string, args: Record<string, unknown>, parse: (d: unknown) => T, fallback: string): Promise<T | null> => {
    setMutationError(null);
    const { data, error } = await (supabase as any).rpc(fn, args);
    if (error) { setMutationError(errorMessage(error, fallback)); return null; }
    list.refetch();
    return parse(data);
  };

  const createSeries = (input: SeriesInput, description: string, groupIds: string[]): Promise<SeriesCreateResult | null> =>
    call('create_event_series', {
      p_name: input.name.trim(),
      p_weekday: input.weekday,
      p_start_time: input.startTime,
      p_recurrence: input.recurrence,
      p_start_date: input.startDate,
      p_end_date: input.endDate,
      p_description: description.trim() || null,
      p_group_ids: groupIds,
    }, parseSeriesCreateResult, 'Erro ao criar a série de encontros.');

  const setSeriesGroups = (seriesId: string, groupIds: string[]): Promise<SeriesGroupsResult | null> =>
    call('set_series_groups', { p_series_id: seriesId, p_group_ids: groupIds }, parseSeriesGroupsResult,
      'Erro ao definir os grupos da série.');

  const extendSeries = (seriesId: string, newEnd: string): Promise<SeriesCreateResult | null> =>
    call('extend_event_series', { p_series_id: seriesId, p_new_end_date: newEnd }, parseSeriesCreateResult,
      'Erro ao estender a série.');

  const cancelSeriesFuture = async (seriesId: string): Promise<SeriesCancelResult | null> => {
    const result = await call('cancel_event_series_future', { p_series_id: seriesId }, parseSeriesCancelResult,
      'Erro ao cancelar os próximos encontros da série.');
    if (result) notifyAlertsChanged(); // encontros cancelados são ignorados no cálculo de faltas
    return result;
  };

  return {
    series: list.data,
    loading: list.loading,
    error: mutationError ?? list.error,
    clearError: () => setMutationError(null),
    refetch: list.refetch,
    createSeries,
    setSeriesGroups,
    extendSeries,
    cancelSeriesFuture,
  };
}
