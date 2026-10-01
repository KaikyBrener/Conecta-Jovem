import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';
import { endOfDayISO, errorMessage, startOfDayISO } from '../lib/format';
import { fetchAll } from '../lib/fetchAll';
import type { AttendanceRecord, Named, ReportEvent, YouthRef } from '../lib/reports';
import type { AlertStatus, TaskStatus } from '../types/database.types';

export interface ReportFilters {
  start: string;   // YYYY-MM-DD
  end: string;     // YYYY-MM-DD
  groupId: string; // 'all' ou id
}

export interface ReportData {
  events: ReportEvent[];
  records: AttendanceRecord[];
  youth: YouthRef[];
  groups: Named[];
  alerts: { status: AlertStatus }[];
  tasks: { status: TaskStatus }[];
}

async function loadReport(f: ReportFilters): Promise<ReportData> {
  const from = startOfDayISO(f.start);
  const to = endOfDayISO(f.end);

  // Encontros do período (RLS: líder só vê os dos seus grupos)
  let eventIdsForGroup: Set<string> | null = null;
  if (f.groupId !== 'all') {
    const eg = await fetchAll<{ event_id: string }>(() =>
      (supabase as any).from('event_groups').select('event_id').eq('group_id', f.groupId).order('event_id'));
    eventIdsForGroup = new Set(eg.map((r) => r.event_id));
  }

  const [events, records, youthRes, groupRes, alertRows, taskRows] = await Promise.all([
    fetchAll<ReportEvent>(() =>
      (supabase as any)
        .from('events')
        .select('id, title, event_date, status')
        .gte('event_date', from)
        .lte('event_date', to)
        .order('event_date', { ascending: false })
        .order('id')),
    fetchAll<AttendanceRecord>(() => {
      let q = (supabase as any)
        .from('attendance')
        .select('event_id, youth_id, group_id, present, events!inner(event_date)')
        .gte('events.event_date', from)
        .lte('events.event_date', to);
      if (f.groupId !== 'all') q = q.eq('group_id', f.groupId);
      return q.order('id');
    }),
    (supabase as any).from('youth').select('id, full_name, group_id, is_active').order('full_name'),
    (supabase as any).from('groups').select('id, name').order('name'),
    // group_id só é usado para filtrar no banco (.eq abaixo); não é lido depois, então não é selecionado.
    fetchAll<{ status: AlertStatus }>(() => {
      let q = (supabase as any).from('alerts').select('status').gte('created_at', from).lte('created_at', to);
      if (f.groupId !== 'all') q = q.eq('group_id', f.groupId);
      return q.order('id');
    }),
    fetchAll<{ status: TaskStatus }>(() => {
      let q = (supabase as any).from('tasks').select('status').gte('created_at', from).lte('created_at', to);
      if (f.groupId !== 'all') q = q.eq('group_id', f.groupId);
      return q.order('id');
    }),
  ]);

  if (youthRes.error) throw youthRes.error;
  if (groupRes.error) throw groupRes.error;

  return {
    events: eventIdsForGroup ? events.filter((e) => eventIdsForGroup!.has(e.id)) : events,
    records: records.map(({ event_id, youth_id, group_id, present }) => ({ event_id, youth_id, group_id, present })),
    youth: (youthRes.data ?? []) as YouthRef[],
    groups: (groupRes.data ?? []) as Named[],
    alerts: alertRows,
    tasks: taskRows,
  };
}

export function useReports(filters: ReportFilters) {
  const { user } = useAuth();
  const [data, setData] = useState<ReportData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { start, end, groupId } = filters;
  // Carregando enquanto o último resultado não corresponde aos filtros atuais
  const key = `${start}|${end}|${groupId}`;
  const [loadedKey, setLoadedKey] = useState<string | null>(null);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    loadReport({ start, end, groupId })
      .then((d) => { if (!cancelled) { setData(d); setError(null); } })
      .catch((err: unknown) => { if (!cancelled) setError(errorMessage(err, 'Erro ao gerar relatório.')); })
      .finally(() => { if (!cancelled) setLoadedKey(`${start}|${end}|${groupId}`); });
    return () => { cancelled = true; };
  }, [user, start, end, groupId]);

  return { data, loading: loadedKey !== key, error };
}
