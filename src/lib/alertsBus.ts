// Lógica pura (sem Supabase) de "alertas mudaram" e do intervalo de sincronização — testável em Node.

const bus = new EventTarget();
const CHANGED = 'alerts-changed';

/**
 * Avisa que alertas mudaram no banco (a Chamada, os acompanhamentos, as tarefas e a tela de Alertas
 * disparam triggers que criam/resolvem alertas). O contador do menu assina este aviso: atualiza na hora,
 * sem polling.
 */
export function notifyAlertsChanged(): void {
  bus.dispatchEvent(new Event(CHANGED));
}

/** Assina o aviso; devolve a função que cancela a assinatura. */
export function subscribeAlertsChanged(listener: () => void): () => void {
  bus.addEventListener(CHANGED, listener);
  return () => bus.removeEventListener(CHANGED, listener);
}

/** Intervalo mínimo entre duas sincronizações dos alertas por tempo. */
export const SYNC_MIN_INTERVAL_MS = 60_000;

/** Já passou tempo suficiente desde a última sincronização? (relógio que volta também libera) */
export function shouldSync(lastRunAt: number | null, now: number, minIntervalMs = SYNC_MIN_INTERVAL_MS): boolean {
  return lastRunAt === null || now < lastRunAt || now - lastRunAt >= minIntervalMs;
}
