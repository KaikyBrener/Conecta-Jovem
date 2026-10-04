// Histórico operacional (lógica PURA): converte o período escolhido nos limites de `occurred_at` da consulta.
// Os dias são do calendário do produto (America/Sao_Paulo, UTC-3 o ano todo desde 2019).
import { resolvePeriod, shiftDate, validateRange, type DateRange, type PeriodPreset } from './periods';

export type HistoryPeriod = 'all' | PeriodPreset;

export const HISTORY_PERIODS: { value: HistoryPeriod; label: string }[] = [
  { value: 'all', label: 'Todo o período' },
  { value: 'today', label: 'Hoje' },
  { value: 'week', label: 'Semana' },
  { value: 'month', label: 'Mês' },
  { value: 'last30', label: 'Últimos 30 dias' },
  { value: 'last90', label: 'Últimos 90 dias' },
  { value: 'custom', label: 'Personalizado' },
];

/** Instante (ISO/UTC) em que o dia YYYY-MM-DD começa em America/Sao_Paulo. */
export function startOfDaySP(date: string): string {
  return new Date(`${date}T00:00:00-03:00`).toISOString();
}

export interface ActivityBounds {
  /** occurred_at >= from (inclusivo); null = sem limite */
  from: string | null;
  /** occurred_at < toExclusive; null = sem limite */
  toExclusive: string | null;
  /** Mensagem pt-BR quando o período personalizado é inválido (nesse caso não há limites) */
  error: string | null;
}

export function activityBounds(period: HistoryPeriod, today: string, custom: DateRange): ActivityBounds {
  if (period === 'all') return { from: null, toExclusive: null, error: null };
  if (period === 'custom') {
    const error = validateRange(custom);
    if (error) return { from: null, toExclusive: null, error };
  }
  const range = resolvePeriod(period, today, custom);
  return { from: startOfDaySP(range.from), toExclusive: startOfDaySP(shiftDate(range.to, 1)), error: null };
}
