import { useState, useEffect, useCallback } from 'react';
import { supabase } from '../lib/supabase';
import type { Youth, Attendance, EventStatus, GroupRef } from '../types/database.types';
import { useAuth } from '../contexts/AuthContext';
import { errorMessage } from '../lib/format';

export interface AttendanceState {
  youth_id: string;
  group_id: string;
  full_name: string;
  present: boolean;
}

export interface AttendanceEvent {
  id: string;
  title: string;
  event_date: string;
  status: EventStatus;
}

interface AttendanceData {
  event: AttendanceEvent;
  groups: GroupRef[];
  attendanceMap: Record<string, AttendanceState>;
  /** Quantos jovens já tinham registro salvo neste encontro */
  savedCount: number;
}

async function loadAttendance(eventId: string): Promise<AttendanceData> {
  // 0. Encontro
  const { data: evData, error: evErr } = await (supabase as any)
    .from('events')
    .select('id, title, event_date, status')
    .eq('id', eventId)
    .single();
  if (evErr) throw evErr;

  // 1. Grupos participantes (RLS: líder só recebe os seus)
  const { data: egData, error: egErr } = await (supabase as any)
    .from('event_groups')
    .select('group_id, groups(name)')
    .eq('event_id', eventId);
  if (egErr) throw egErr;

  const groupIds = (egData ?? []).map((eg: any) => eg.group_id);
  const groups = (egData ?? []).map((eg: any) => ({ id: eg.group_id, name: eg.groups?.name ?? '—' }));

  if (groupIds.length === 0) {
    return { event: evData as AttendanceEvent, groups, attendanceMap: {}, savedCount: 0 };
  }

  // 2. Jovens ativos desses grupos + 3. registros existentes
  const [youthRes, attRes]: [any, any] = await Promise.all([
    (supabase as any)
      .from('youth')
      .select('id, full_name, group_id')
      .eq('is_active', true)
      .in('group_id', groupIds)
      .order('full_name', { ascending: true }),
    (supabase as any).from('attendance').select('*').eq('event_id', eventId),
  ]);
  if (youthRes.error) throw youthRes.error;
  if (attRes.error) throw attRes.error;

  const attRecord: Record<string, Attendance> = {};
  for (const a of (attRes.data ?? []) as Attendance[]) attRecord[a.youth_id] = a;

  const attendanceMap: Record<string, AttendanceState> = {};
  for (const y of (youthRes.data ?? []) as Youth[]) {
    attendanceMap[y.id] = {
      youth_id: y.id,
      group_id: y.group_id!,
      full_name: y.full_name,
      present: attRecord[y.id]?.present ?? false,
    };
  }

  const savedCount = Object.keys(attendanceMap).filter((id) => attRecord[id]).length;
  return { event: evData as AttendanceEvent, groups, attendanceMap, savedCount };
}

export function useAttendance(eventId: string) {
  const { user } = useAuth();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<AttendanceData | null>(null);

  useEffect(() => {
    if (!user || !eventId) return;
    let cancelled = false;
    loadAttendance(eventId)
      .then((d) => { if (!cancelled) { setData(d); setError(null); } })
      .catch((err: unknown) => { if (!cancelled) setError(errorMessage(err, 'Erro ao carregar dados da chamada.')); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [eventId, user]);

  const refetch = useCallback(async () => {
    if (!eventId) return;
    setLoading(true);
    try {
      setData(await loadAttendance(eventId));
      setError(null);
    } catch (err: unknown) {
      setError(errorMessage(err, 'Erro ao carregar dados da chamada.'));
    } finally {
      setLoading(false);
    }
  }, [eventId]);

  const saveAttendance = async (states: AttendanceState[]): Promise<boolean> => {
    if (!user) return false;
    setError(null);

    const payload = states.map((s) => ({
      event_id: eventId,
      youth_id: s.youth_id,
      group_id: s.group_id,
      present: s.present,
      recorded_by: user.id,
    }));

    if (payload.length === 0) return true;

    // Os alertas de faltas são recalculados pelo banco (trigger em attendance)
    const { error: upsertErr } = await (supabase as any)
      .from('attendance')
      .upsert(payload, { onConflict: 'event_id,youth_id' });
    if (upsertErr) {
      setError(errorMessage(upsertErr, 'Erro ao salvar chamada.'));
      return false;
    }
    return true;
  };

  /** Coordenador: marca o encontro como realizado após a chamada */
  const markEventCompleted = async (): Promise<boolean> => {
    const { error: e } = await (supabase as any)
      .from('events')
      .update({ status: 'completed' })
      .eq('id', eventId);
    if (e) { setError(errorMessage(e, 'Erro ao atualizar o encontro.')); return false; }
    return true;
  };

  return {
    loading,
    error,
    event: data?.event ?? null,
    attendanceMap: data?.attendanceMap ?? {},
    groups: data?.groups ?? [],
    savedCount: data?.savedCount ?? 0,
    saveAttendance,
    markEventCompleted,
    refetch,
  };
}
