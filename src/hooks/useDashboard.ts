import { supabase } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';
import { syncTimeAlerts } from '../lib/alertsSync';
import { parseDashboard } from '../lib/overview';
import type { DashboardOverview } from '../lib/reportTypes';
import { useAsyncValue } from './useAsyncValue';

/**
 * Painel inicial: UMA chamada à RPC dashboard_overview (migration 012) devolve tudo, já no escopo do papel
 * (coordenador: ministério inteiro; líder: só os grupos dele). Alertas por tempo dependem do relógio, então
 * sincroniza antes de contar (nunca lança; erro só é registrado).
 */
export function useDashboard() {
  const { user } = useAuth();
  const res = useAsyncValue<DashboardOverview | null>(
    user ? user.id : null,
    async () => {
      await syncTimeAlerts();
      const { data, error } = await (supabase as any).rpc('dashboard_overview');
      if (error) throw error;
      return parseDashboard(data);
    },
    null,
    'Erro ao carregar o painel.',
  );
  return { data: res.data, loading: res.loading, error: res.error };
}
