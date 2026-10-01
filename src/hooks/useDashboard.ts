import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';
import { addDays, endOfMonth, errorMessage, startOfMonth, toDateInput } from '../lib/format';
import { fetchAll } from '../lib/fetchAll';
import { belowThreshold, overallRate, summarizeByYouth, type AttendanceRecord, type YouthSummary } from '../lib/reports';
import type { AlertStatus, EventStatus, TaskPriority, TaskStatus } from '../types/database.types';

export interface DashboardData {
  activeYouth: number;
  eventsThisMonth: number;
  openAlerts: number;
  myOpenTasks: number;
  myOverdueTasks: number;
  rate30: number | null;
  rate30Records: number;
  upcoming: { id: string; title: string; event_date: string; status: EventStatus }[];
  pendingCalls: { id: string; title: string; event_date: string }[];
  recentAlerts: { id: string; consecutive_absences: number; status: AlertStatus; youth: { full_name: string } | null; groups: { name: string } | null }[];
  myTasks: { id: string; title: string; due_date: string | null; status: TaskStatus; priority: TaskPriority; youth: { full_name: string } | null }[];
  lowAttendance: YouthSummary[];
  lowThreshold: number;
}

type AttRow = AttendanceRecord & { events: { event_date: string; status: EventStatus } };

interface DashboardCounts {
  activeYouth: number;
  eventsThisMonth: number;
  openAlerts: number;
  myOpenTasks: number;
  myOverdueTasks: number;
}

/** Contadores (consultas "head" — sem trazer linhas, só o total) */
async function loadCounts(userId: string, now: Date, today: string): Promise<DashboardCounts> {
  const sb = supabase as any;
  const head = { count: 'exact' as const, head: true };

  const [youthCount, monthEvents, alertCount, myTasksCount, overdueCount] = await Promise.all([
    sb.from('youth').select('id', head).eq('is_active', true),
    sb.from('events').select('id', head).neq('status', 'cancelled')
      .gte('event_date', startOfMonth(now).toISOString()).lte('event_date', endOfMonth(now).toISOString()),
    sb.from('alerts').select('id', head).eq('status', 'open'),
    sb.from('tasks').select('id', head).eq('assigned_to', userId).in('status', ['pending', 'in_progress']),
    sb.from('tasks').select('id', head).eq('assigned_to', userId).in('status', ['pending', 'in_progress']).lt('due_date', today),
  ]);
  for (const r of [youthCount, monthEvents, alertCount, myTasksCount, overdueCount]) {
    if (r.error) throw r.error;
  }

  return {
    activeYouth: youthCount.count ?? 0,
    eventsThisMonth: monthEvents.count ?? 0,
    openAlerts: alertCount.count ?? 0,
    myOpenTasks: myTasksCount.count ?? 0,
    myOverdueTasks: overdueCount.count ?? 0,
  };
}

interface DashboardLists {
  upcoming: DashboardData['upcoming'];
  pendingCalls: DashboardData['pendingCalls'];
  recentAlerts: DashboardData['recentAlerts'];
  myTasks: DashboardData['myTasks'];
}

/** Listas curtas exibidas nos painéis do Dashboard (próximos encontros, alertas, tarefas) */
async function loadLists(userId: string, nowISO: string): Promise<DashboardLists> {
  const sb = supabase as any;

  const [upcomingRes, pastScheduledRes, alertsRes, tasksRes] = await Promise.all([
    sb.from('events').select('id, title, event_date, status').eq('status', 'scheduled').gte('event_date', nowISO)
      .order('event_date', { ascending: true }).limit(5),
    // Encontros já passados que continuam "agendados" (chamada/fechamento pendente)
    sb.from('events').select('id, title, event_date').eq('status', 'scheduled').lt('event_date', nowISO)
      .order('event_date', { ascending: false }).limit(5),
    sb.from('alerts').select('id, consecutive_absences, status, youth:youth_id(full_name), groups:group_id(name)')
      .eq('status', 'open').order('consecutive_absences', { ascending: false }).limit(5),
    sb.from('tasks').select('id, title, due_date, status, priority, youth:youth_id(full_name)')
      .eq('assigned_to', userId).in('status', ['pending', 'in_progress'])
      .order('due_date', { ascending: true, nullsFirst: false }).limit(5),
  ]);
  for (const r of [upcomingRes, pastScheduledRes, alertsRes, tasksRes]) {
    if (r.error) throw r.error;
  }

  return {
    upcoming: upcomingRes.data ?? [],
    pendingCalls: pastScheduledRes.data ?? [],
    recentAlerts: alertsRes.data ?? [],
    myTasks: tasksRes.data ?? [],
  };
}

interface AttendanceSummary {
  rate30: number | null;
  rate30Records: number;
  lowAttendance: YouthSummary[];
  lowThreshold: number;
}

/** Frequência dos últimos 90 dias (para a janela de 30 dias e para "abaixo do limite") */
async function loadAttendanceSummary(d30: string, d90: string): Promise<AttendanceSummary> {
  const sb = supabase as any;

  const [youthRes, groupsRes, settingsRes, att90] = await Promise.all([
    sb.from('youth').select('id, full_name, group_id, is_active').eq('is_active', true),
    sb.from('groups').select('id, name'),
    sb.from('app_settings').select('low_attendance_threshold').maybeSingle(),
    fetchAll<AttRow>(() =>
      sb.from('attendance')
        .select('event_id, youth_id, group_id, present, events!inner(event_date, status)')
        .gte('events.event_date', d90)
        .neq('events.status', 'cancelled')
        .order('id')),
  ]);
  if (youthRes.error) throw youthRes.error;
  if (groupsRes.error) throw groupsRes.error;

  const lowThreshold: number = settingsRes.data?.low_attendance_threshold ?? 70;
  const records90: AttendanceRecord[] = (att90 as AttRow[]).map(({ event_id, youth_id, group_id, present }) => ({ event_id, youth_id, group_id, present }));
  const records30 = (att90 as AttRow[]).filter((r) => r.events.event_date >= d30);
  const byYouth = summarizeByYouth(records90, youthRes.data ?? [], groupsRes.data ?? []);

  return {
    rate30: overallRate(records30),
    rate30Records: records30.length,
    // Considera só quem tem pelo menos 2 registros nos últimos 90 dias
    lowAttendance: belowThreshold(byYouth.filter((y) => y.total >= 2), lowThreshold).slice(0, 5),
    lowThreshold,
  };
}

async function loadDashboard(userId: string): Promise<DashboardData> {
  const now = new Date();
  const nowISO = now.toISOString();
  const d30 = addDays(now, -30).toISOString();
  const d90 = addDays(now, -90).toISOString();
  const today = toDateInput(now);

  const [counts, lists, attendance] = await Promise.all([
    loadCounts(userId, now, today),
    loadLists(userId, nowISO),
    loadAttendanceSummary(d30, d90),
  ]);

  return { ...counts, ...lists, ...attendance };
}

export function useDashboard() {
  const { user } = useAuth();
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    loadDashboard(user.id)
      .then((d) => { if (!cancelled) setData(d); })
      .catch((err: unknown) => { if (!cancelled) setError(errorMessage(err, 'Erro ao carregar o painel.')); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [user]);

  return { data, loading, error };
}
