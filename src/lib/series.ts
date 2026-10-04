// Encontros recorrentes (lógica PURA). Reproduz a regra de `series_dates()` da migration 014 para a PRÉVIA no
// formulário: o que o usuário vê antes de confirmar é exatamente o que o banco vai gerar.
// Datas são "YYYY-MM-DD" do calendário do produto (sem fuso); a aritmética é feita em UTC.
import { isValidDate, shiftDate } from './periods';

export type SeriesRecurrence = 'weekly' | 'biweekly' | 'monthly_nth_weekday';

/** Limites do servidor (CHECKs e create_event_series). */
export const SERIES_MAX_SPAN_DAYS = 731;
export const SERIES_MAX_EVENTS = 120;
export const SERIES_NAME_MAX = 120;

export const WEEKDAY_NAMES = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'];

/** Ordem de exibição no seletor: segunda a domingo, mas o valor continua 0 = domingo (como no banco). */
export const WEEKDAY_OPTIONS: { value: number; label: string }[] = [1, 2, 3, 4, 5, 6, 0].map((value) => ({
  value,
  label: WEEKDAY_NAMES[value].replace(/^./, (c) => c.toUpperCase()),
}));

export const RECURRENCE_LABEL: Record<SeriesRecurrence, string> = {
  weekly: 'Semanal',
  biweekly: 'Quinzenal',
  monthly_nth_weekday: 'Mensal (N-ésimo dia da semana)',
};

export const RECURRENCES: SeriesRecurrence[] = ['weekly', 'biweekly', 'monthly_nth_weekday'];

const DAY_MS = 86_400_000;

function utc(date: string): Date {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function fmt(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${String(d.getUTCFullYear()).padStart(4, '0')}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

/** Dia da semana (0 = domingo) de uma data YYYY-MM-DD. */
export function weekdayOf(date: string): number {
  return utc(date).getUTCDay();
}

/** Diferença em dias (b - a) entre duas datas YYYY-MM-DD. */
export function daysBetween(a: string, b: string): number {
  return Math.round((utc(b).getTime() - utc(a).getTime()) / DAY_MS);
}

/** Primeira data >= start que cai no dia da semana pedido. */
export function firstOccurrence(weekday: number, start: string): string {
  return shiftDate(start, (weekday - weekdayOf(start) + 7) % 7);
}

/** N (1..5) do "N-ésimo dia da semana do mês" da data. */
export function nthWeekdayOfMonth(date: string): number {
  return Math.floor((utc(date).getUTCDate() - 1) / 7) + 1;
}

/**
 * Datas de uma série, em ordem crescente. Mesma regra de `series_dates()` no banco:
 * - weekly / biweekly: a partir da primeira ocorrência, de 7 em 7 / 14 em 14 dias;
 * - monthly_nth_weekday: N vem da PRIMEIRA ocorrência (ex.: 2º sábado). N = 5 vale o ÚLTIMO dia da semana do mês
 *   (o 5º não existe em todo mês).
 * Entradas inválidas (data inexistente, dia da semana fora de 0..6) devolvem lista vazia.
 */
export function seriesDates(weekday: number, recurrence: SeriesRecurrence, start: string, end: string): string[] {
  if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) return [];
  if (!isValidDate(start) || !isValidDate(end)) return [];
  const first = firstOccurrence(weekday, start);
  if (first > end) return [];

  if (recurrence === 'weekly' || recurrence === 'biweekly') {
    const step = recurrence === 'weekly' ? 7 : 14;
    const out: string[] = [];
    for (let d = first; d <= end; d = shiftDate(d, step)) out.push(d);
    return out;
  }

  const n = nthWeekdayOfMonth(first);
  const firstDate = utc(first);
  let y = firstDate.getUTCFullYear();
  let m = firstDate.getUTCMonth();
  const out: string[] = [];
  for (;;) {
    const monthStart = fmt(new Date(Date.UTC(y, m, 1)));
    if (monthStart > end) break;
    const nextMonthStart = fmt(new Date(Date.UTC(y, m + 1, 1)));
    let cand = shiftDate(monthStart, (weekday - weekdayOf(monthStart) + 7) % 7 + 7 * (n - 1));
    if (cand >= nextMonthStart) cand = shiftDate(cand, -7); // 5º inexistente => o último
    if (cand >= first && cand <= end) out.push(cand);
    m += 1;
    if (m > 11) { m = 0; y += 1; }
  }
  return out;
}

const ORDINAL: Record<number, string> = { 1: '1º', 2: '2º', 3: '3º', 4: '4º' };

/** "toda semana (sábado)", "a cada 15 dias (sábado)", "2º sábado de cada mês", "último sábado de cada mês". */
export function describeRecurrence(weekday: number, recurrence: SeriesRecurrence, start: string): string {
  const day = WEEKDAY_NAMES[weekday] ?? '';
  if (recurrence === 'weekly') return `toda semana (${day})`;
  if (recurrence === 'biweekly') return `a cada 14 dias (${day})`;
  if (!isValidDate(start)) return `mensal (${day})`;
  const n = nthWeekdayOfMonth(firstOccurrence(weekday, start));
  return n >= 5 ? `último ${day} de cada mês` : `${ORDINAL[n]} ${day} de cada mês`;
}

export interface SeriesInput {
  name: string;
  weekday: number;
  /** HH:MM */
  startTime: string;
  recurrence: SeriesRecurrence;
  startDate: string;
  endDate: string;
}

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Primeira mensagem de erro (pt-BR) que impede criar a série, ou null se está tudo certo. */
export function validateSeriesInput(input: SeriesInput): string | null {
  const name = input.name.trim();
  if (!name) return 'Informe o nome da série.';
  if (name.length > SERIES_NAME_MAX) return `O nome da série pode ter no máximo ${SERIES_NAME_MAX} caracteres.`;
  if (!Number.isInteger(input.weekday) || input.weekday < 0 || input.weekday > 6) return 'Escolha o dia da semana.';
  if (!TIME_RE.test(input.startTime)) return 'Informe o horário do encontro.';
  if (!RECURRENCES.includes(input.recurrence)) return 'Escolha a recorrência.';
  if (!input.startDate || !input.endDate) return 'Informe a data inicial e a data final da série.';
  if (!isValidDate(input.startDate) || !isValidDate(input.endDate)) return 'Informe datas válidas.';
  if (input.endDate < input.startDate) return 'A data final não pode ser anterior à data inicial.';
  if (daysBetween(input.startDate, input.endDate) > SERIES_MAX_SPAN_DAYS) return 'O período da série não pode passar de 2 anos.';
  const count = seriesDates(input.weekday, input.recurrence, input.startDate, input.endDate).length;
  if (count === 0) return 'O período informado não contém nenhuma data para este dia da semana.';
  if (count > SERIES_MAX_EVENTS) return `A série geraria mais de ${SERIES_MAX_EVENTS} encontros. Reduza o período.`;
  return null;
}

/** Validação da nova data final ao estender: depois da atual e dentro dos 2 anos a partir do início. */
export function validateExtendEnd(series: { start_date: string; end_date: string }, newEnd: string): string | null {
  if (!newEnd || !isValidDate(newEnd)) return 'Informe uma data final válida.';
  if (newEnd <= series.end_date) return 'A nova data final precisa ser posterior à data final atual.';
  if (daysBetween(series.start_date, newEnd) > SERIES_MAX_SPAN_DAYS) return 'O período da série não pode passar de 2 anos.';
  return null;
}

/** Último dia permitido para a série, contando 2 anos a partir do início. */
export function maxSeriesEnd(start: string): string {
  return isValidDate(start) ? shiftDate(start, SERIES_MAX_SPAN_DAYS) : '';
}

/** Encontro de série, ainda não cancelado e sem nenhum grupo: mostra o aviso "Grupos pendentes". */
export function hasPendingGroups(e: { series_id?: string | null; group_ids: readonly string[]; status: string }): boolean {
  return !!e.series_id && e.group_ids.length === 0 && e.status !== 'cancelled';
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "Serão criados 12 encontros." / "Será criado 1 encontro." */
export function previewSentence(count: number): string {
  return count === 1 ? 'Será criado 1 encontro.' : `Serão criados ${count} encontros.`;
}

// ── Resultados das RPCs ──────────────────────────────────────────────────────

const toCount = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);

function asObject(data: unknown): Record<string, unknown> {
  return data && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, unknown>) : {};
}

export interface SeriesCreateResult { seriesId: string | null; created: number; skipped: number }
export interface SeriesGroupsResult { updated: number; skipped: number }
export interface SeriesCancelResult { cancelled: number; skipped: number }

export function parseSeriesCreateResult(data: unknown): SeriesCreateResult {
  const o = asObject(data);
  return { seriesId: typeof o.series_id === 'string' ? o.series_id : null, created: toCount(o.created), skipped: toCount(o.skipped) };
}

export function parseSeriesGroupsResult(data: unknown): SeriesGroupsResult {
  const o = asObject(data);
  return { updated: toCount(o.updated), skipped: toCount(o.skipped) };
}

export function parseSeriesCancelResult(data: unknown): SeriesCancelResult {
  const o = asObject(data);
  return { cancelled: toCount(o.cancelled), skipped: toCount(o.skipped) };
}

/** create_event_series e extend_event_series devolvem {created, skipped}. */
export function createdMessage(r: { created: number; skipped: number }, verb: 'criada' | 'estendida'): string {
  const base = `Série ${verb}: ${plural(r.created, 'encontro criado', 'encontros criados')}.`;
  if (r.skipped === 0) return base;
  return r.skipped === 1
    ? `${base} 1 data já existia e foi ignorada.`
    : `${base} ${r.skipped} datas já existiam e foram ignoradas.`;
}

export function groupsMessage(r: SeriesGroupsResult): string {
  const base = `Grupos aplicados a ${plural(r.updated, 'próximo encontro', 'próximos encontros')}.`;
  return r.skipped > 0
    ? `${base} ${plural(r.skipped, 'encontro foi editado individualmente e não foi alterado', 'encontros foram editados individualmente e não foram alterados')}.`
    : base;
}

export function cancelMessage(r: SeriesCancelResult): string {
  const base = `${plural(r.cancelled, 'encontro futuro cancelado', 'encontros futuros cancelados')}. Série encerrada.`;
  return r.skipped > 0
    ? `${base} ${plural(r.skipped, 'encontro futuro já tem chamada e foi mantido', 'encontros futuros já têm chamada e foram mantidos')}.`
    : base;
}
