import { useState, useEffect, useCallback } from 'react';
import { supabase } from '../lib/supabase';
import type { Youth, Attendance, EventStatus, GroupRef, AlertType, AlertSeverity } from '../types/database.types';
import { useAuth } from '../contexts/AuthContext';
import { errorMessage } from '../lib/format';
import { fetchAll } from '../lib/fetchAll';
import { notifyAlertsChanged } from '../lib/alertsBus';

export interface AttendanceState {
  youth_id: string;
  group_id: string;
  full_name: string;
  /** true = presente, false = ausente, null = não registrado (sem linha; não é falta) */
  present: boolean | null;
  /** Já existe linha no banco para este jovem neste encontro */
  saved: boolean;
}

export interface NewAttendanceAlert {
  id: string;
  youth_id: string;
  youth_name: string;
  type: AlertType;
  severity: AlertSeverity;
  consecutive_absences: number | null;
}

/** Retorno da RPC save_attendance (contagens do encontro inteiro visíveis ao usuário) */
export interface SaveAttendanceResult {
  saved: number;
  present: number;
  absent: number;
  total_registered: number;
  /** 0-100 */
  rate: number;
  new_alerts: NewAttendanceAlert[];
}

function parseSaveResult(raw: unknown): SaveAttendanceResult {
  const r = (raw ?? {}) as Partial<SaveAttendanceResult>;
  return {
    saved: Number(r.saved ?? 0),
    present: Number(r.present ?? 0),
    absent: Number(r.absent ?? 0),
    total_registered: Number(r.total_registered ?? 0),
    rate: Number(r.rate ?? 0),
    new_alerts: Array.isArray(r.new_alerts) ? r.new_alerts : [],
  };
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
  // fetchAll: a chamada precisa de TODOS os jovens; o PostgREST corta respostas em 1000 linhas
  const sb = supabase as any;
  const [youthRows, attRows] = await Promise.all([
    fetchAll<Pick<Youth, 'id' | 'full_name' | 'group_id'>>(() =>
      sb.from('youth')
        .select('id, full_name, group_id')
        .eq('is_active', true)
        .in('group_id', groupIds)
        .order('full_name', { ascending: true })
        .order('id')),
    fetchAll<Attendance>(() => sb.from('attendance').select('*').eq('event_id', eventId).order('id')),
  ]);

  const attRecord: Record<string, Attendance> = {};
  for (const a of attRows) attRecord[a.youth_id] = a;

  // Sem linha no banco = "não registrado" (null) — nunca vira falta
  const attendanceMap: Record<string, AttendanceState> = {};
  for (const y of youthRows) {
    const rec = attRecord[y.id];
    attendanceMap[y.id] = {
      youth_id: y.id,
      group_id: y.group_id!,
      full_name: y.full_name,
      present: rec ? rec.present : null,
      saved: !!rec,
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

  /**
   * Grava via RPC `save_attendance` (atômica, RLS vale) SOMENTE as linhas recebidas, que devem ser as
   * editadas na sessão (ver `editedRowsToSave` em lib/attendance.ts) — nunca reenvie linhas intactas.
   * Não registrado = sem linha; null é ignorado pelo banco e nunca apaga um registro existente.
   * Os alertas são recalculados pelo banco. Devolve o resumo do encontro ou null em erro.
   */
  const saveAttendance = async (states: AttendanceState[]): Promise<SaveAttendanceResult | null> => {
    if (!user) return null;
    setError(null);

    const marked = states.filter((s) => s.present !== null);
    if (marked.length === 0) {
      setError('Nenhuma alteração para salvar.');
      return null;
    }

    const { data: res, error: rpcErr } = await (supabase as any).rpc('save_attendance', {
      p_event_id: eventId,
      p_entries: marked.map((s) => ({ youth_id: s.youth_id, present: s.present })),
    });
    if (rpcErr) {
      setError(errorMessage(rpcErr, 'Erro ao salvar chamada.'));
      return null;
    }

    const result = parseSaveResult(res);
    // Os triggers do banco podem ter criado/resolvido alertas: o contador do menu recarrega
    notifyAlertsChanged();
    // Reflete o que foi gravado sem recarregar a tela (linhas marcadas passam a "salvas")
    setData((prev) => {
      if (!prev) return prev;
      const attendanceMap = { ...prev.attendanceMap };
      for (const s of marked) {
        const cur = attendanceMap[s.youth_id];
        if (cur) attendanceMap[s.youth_id] = { ...cur, present: s.present, saved: true };
      }
      const savedCount = Object.values(attendanceMap).filter((a) => a.saved).length;
      return { ...prev, attendanceMap, savedCount };
    });
    return result;
  };

  /** Coordenador: marca o encontro como realizado após a chamada */
  const markEventCompleted = async (): Promise<boolean> => {
    const { error: e } = await (supabase as any)
      .from('events')
      .update({ status: 'completed' })
      .eq('id', eventId);
    if (e) { setError(errorMessage(e, 'Erro ao atualizar o encontro.')); return false; }
    setData((prev) => (prev ? { ...prev, event: { ...prev.event, status: 'completed' } } : prev));
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
