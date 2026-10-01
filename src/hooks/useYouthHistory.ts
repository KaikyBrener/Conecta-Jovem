import { useState, useEffect, useCallback } from 'react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';
import { errorMessage } from '../lib/format';
import type { Alert } from '../types/database.types';

export interface AttendanceHistory {
  id: string;
  present: boolean;
  events: {
    title: string;
    event_date: string;
    status: string;
  };
}

export interface YouthHistoryStats {
  total: number;
  present: number;
  absent: number;
  percentage: number;
  history: AttendanceHistory[];
}

interface HistoryResult {
  stats: YouthHistoryStats;
  openAlert: Alert | null;
}

async function loadHistory(youthId: string): Promise<HistoryResult> {
  // Regra: manter todo o histórico daquele jovem (mesmo de grupos anteriores, se o RLS permitir)
  const [attRes, alertRes] = await Promise.all([
    (supabase as any)
      .from('attendance')
      .select(`
        id,
        present,
        events!inner (
          title,
          event_date,
          status
        )
      `)
      .eq('youth_id', youthId),
    (supabase as any)
      .from('alerts')
      .select('*')
      .eq('youth_id', youthId)
      .eq('status', 'open')
      .maybeSingle(),
  ]);

  if (attRes.error) throw attRes.error;

  // Encontros cancelados não contam na frequência (mesma regra dos alertas)
  const history = ((attRes.data as AttendanceHistory[]) || [])
    .filter((h) => h.events.status !== 'cancelled')
    .sort((a, b) => new Date(b.events.event_date).getTime() - new Date(a.events.event_date).getTime());

  const total = history.length;
  const present = history.filter((h) => h.present).length;
  return {
    stats: {
      total,
      present,
      absent: total - present,
      percentage: total === 0 ? 0 : Math.round((present / total) * 100),
      history,
    },
    openAlert: (alertRes.data as Alert | null) ?? null,
  };
}

export function useYouthHistory(youthId: string) {
  const { user } = useAuth();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState<YouthHistoryStats | null>(null);
  const [openAlert, setOpenAlert] = useState<Alert | null>(null);

  useEffect(() => {
    if (!user || !youthId) return;
    let cancelled = false;
    loadHistory(youthId)
      .then((r) => {
        if (cancelled) return;
        setStats(r.stats);
        setOpenAlert(r.openAlert);
        setError(null);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(errorMessage(err, 'Erro ao carregar histórico.'));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [youthId, user]);

  const refetch = useCallback(async () => {
    if (!user || !youthId) return;
    setLoading(true);
    try {
      const r = await loadHistory(youthId);
      setStats(r.stats);
      setOpenAlert(r.openAlert);
      setError(null);
    } catch (err: unknown) {
      setError(errorMessage(err, 'Erro ao carregar histórico.'));
    } finally {
      setLoading(false);
    }
  }, [youthId, user]);

  return { loading, error, stats, openAlert, refetch };
}
