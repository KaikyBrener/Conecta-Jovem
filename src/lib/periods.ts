// Períodos dos relatórios (lógica PURA). Todas as datas são "YYYY-MM-DD" do calendário do produto
// (America/Sao_Paulo); "hoje" é sempre recebido de fora (appToday()) para o código ser testável.
// Os intervalos são INCLUSIVOS nas duas pontas, como as RPCs report_* do servidor (migration 013).

export type PeriodPreset = 'today' | 'week' | 'month' | 'last30' | 'last90' | 'custom';

export interface DateRange {
  from: string;
  to: string;
}

/** Limite do servidor (report_check): no máximo 400 dias, contando os dois extremos. */
export const MAX_PERIOD_DAYS = 400;

export const PERIOD_PRESETS: { value: PeriodPreset; label: string }[] = [
  { value: 'today', label: 'Hoje' },
  { value: 'week', label: 'Semana' },
  { value: 'month', label: 'Mês' },
  { value: 'last30', label: 'Últimos 30 dias' },
  { value: 'last90', label: 'Últimos 90 dias' },
  { value: 'custom', label: 'Personalizado' },
];

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;

/** Interpreta YYYY-MM-DD como UTC (sem fuso/horário de verão); null se não for uma data real. */
function parse(date: string): number | null {
  const m = DATE_RE.exec(date);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = Date.UTC(y, mo - 1, d);
  const back = new Date(t);
  // rejeita 2026-02-30 etc. (Date.UTC "rola" o dia)
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null;
  return t;
}

function format(t: number): string {
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${String(d.getUTCFullYear()).padStart(4, '0')}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

export function isValidDate(date: string): boolean {
  return parse(date) !== null;
}

/** Soma `days` dias (pode ser negativo) a uma data YYYY-MM-DD. */
export function shiftDate(date: string, days: number): string {
  const t = parse(date);
  if (t === null) throw new Error(`Data inválida: ${date}`);
  return format(t + days * DAY_MS);
}

/** Quantidade de dias do intervalo, contando as duas pontas ("hoje a hoje" = 1). */
export function periodDays(range: DateRange): number {
  const a = parse(range.from);
  const b = parse(range.to);
  if (a === null || b === null) return 0;
  return Math.round((b - a) / DAY_MS) + 1;
}

/** Dia da semana com segunda = 0 ... domingo = 6. */
function weekdayMon0(date: string): number {
  const t = parse(date);
  if (t === null) throw new Error(`Data inválida: ${date}`);
  return (new Date(t).getUTCDay() + 6) % 7;
}

/** Último dia do mês de uma data YYYY-MM-DD. */
function lastDayOfMonth(date: string): string {
  const t = parse(date);
  if (t === null) throw new Error(`Data inválida: ${date}`);
  const d = new Date(t);
  return format(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));
}

/**
 * Resolve um período pronto para o intervalo de datas.
 * - today: hoje
 * - week: semana ATUAL, segunda a domingo (inclui os dias que ainda virão)
 * - month: mês ATUAL, do dia 1 ao último dia
 * - last30 / last90: termina hoje e inclui hoje (30 / 90 dias no total)
 * - custom: devolve `custom` como veio (a validação é feita por validateRange)
 */
export function resolvePeriod(preset: PeriodPreset, today: string, custom?: DateRange): DateRange {
  switch (preset) {
    case 'today':
      return { from: today, to: today };
    case 'week': {
      const monday = shiftDate(today, -weekdayMon0(today));
      return { from: monday, to: shiftDate(monday, 6) };
    }
    case 'month':
      return { from: `${today.slice(0, 8)}01`, to: lastDayOfMonth(today) };
    case 'last30':
      return { from: shiftDate(today, -29), to: today };
    case 'last90':
      return { from: shiftDate(today, -89), to: today };
    case 'custom':
      return custom ?? { from: today, to: today };
  }
}

/** Mensagem em pt-BR quando o intervalo não pode ser consultado; null se está válido. */
export function validateRange(range: DateRange): string | null {
  if (!range.from || !range.to) return 'Informe a data inicial e a data final.';
  if (!isValidDate(range.from) || !isValidDate(range.to)) return 'Informe datas válidas.';
  if (range.from > range.to) return 'A data inicial não pode ser posterior à data final.';
  if (periodDays(range) > MAX_PERIOD_DAYS) return `O período pode ter no máximo ${MAX_PERIOD_DAYS} dias.`;
  return null;
}
