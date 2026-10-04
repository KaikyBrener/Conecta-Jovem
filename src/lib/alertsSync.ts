import { supabase } from './supabase';
import { logError } from './logger';
import { notifyAlertsChanged, shouldSync } from './alertsBus';

// Alertas como "sem acompanhamento há 9 dias" e "ação atrasada" dependem do relógio: nada acontece no
// banco quando o prazo vence. A RPC sync_time_alerts() (idempotente) é chamada ao abrir Alertas e Dashboard.

let lastRunAt: number | null = null;
let inFlight: Promise<boolean> | null = null;

/**
 * Pede ao banco para recalcular os alertas por tempo. NUNCA lança: erro vira registro (logError) e a
 * tela segue normalmente. Chamadas simultâneas compartilham a mesma requisição e, após uma execução
 * bem-sucedida, repetições em menos de 1 minuto são ignoradas. Devolve true quando a RPC foi executada
 * com sucesso (e avisa o menu para recontar os alertas).
 */
export function syncTimeAlerts(): Promise<boolean> {
  if (inFlight) return inFlight;
  if (!shouldSync(lastRunAt, Date.now())) return Promise.resolve(false);
  inFlight = (async () => {
    try {
      const { error } = await (supabase as any).rpc('sync_time_alerts');
      if (error) {
        logError('Erro ao sincronizar alertas por tempo', error);
        return false;
      }
      lastRunAt = Date.now();
      notifyAlertsChanged();
      return true;
    } catch (err: unknown) {
      logError('Erro ao sincronizar alertas por tempo', err);
      return false;
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}
