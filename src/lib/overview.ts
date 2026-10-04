import { toSituationLevel } from './situation';
import type {
  DashboardEvent,
  DashboardFollowUp,
  DashboardOverview,
  GroupIndicator,
  SituationLevel,
  TrendKind,
} from './reportTypes';

// Normalização (pura) das respostas das RPCs dashboard_overview e group_indicators, e apresentação da
// tendência dos grupos. O banco calcula tudo; aqui só se protege a tela de campos ausentes/nulos.

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function num(v: unknown, fallback = 0): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = num(v, NaN);
  return Number.isFinite(n) ? n : null;
}

const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);
const strOrNull = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

function parseAttention(raw: unknown): DashboardOverview['attention'][number] | null {
  if (!isObj(raw) || typeof raw.youth_id !== 'string') return null;
  const level: SituationLevel = toSituationLevel(raw.situation) === 'critical' ? 'critical' : 'attention';
  return {
    youth_id: raw.youth_id,
    full_name: str(raw.full_name),
    group_name: strOrNull(raw.group_name),
    situation: level,
    reasons: list(raw.reasons).filter((r): r is string => typeof r === 'string'),
  };
}

function parseFollowUp(raw: unknown): DashboardFollowUp | null {
  if (!isObj(raw) || typeof raw.follow_up_id !== 'string' || typeof raw.next_action_due !== 'string') return null;
  return {
    follow_up_id: raw.follow_up_id,
    youth_id: str(raw.youth_id),
    youth_name: str(raw.youth_name),
    next_action: strOrNull(raw.next_action),
    next_action_due: raw.next_action_due,
    responsible_name: strOrNull(raw.responsible_name),
  };
}

function parseEvent(raw: unknown): DashboardEvent | null {
  if (!isObj(raw) || typeof raw.id !== 'string') return null;
  return {
    id: raw.id,
    title: str(raw.title),
    event_date: str(raw.event_date),
    groups: list(raw.groups)
      .filter(isObj)
      .map((g) => ({ id: str(g.id), name: str(g.name) })),
  };
}

function notNull<T>(v: T | null): v is T {
  return v !== null;
}

/** Resposta crua de `dashboard_overview()` -> estrutura tipada, com padrões seguros. */
export function parseDashboard(raw: unknown): DashboardOverview {
  const r = isObj(raw) ? raw : {};
  const alerts = isObj(r.open_alerts) ? r.open_alerts : {};
  return {
    attention: list(r.attention).map(parseAttention).filter(notNull),
    attention_total: num(r.attention_total),
    open_alerts: { total: num(alerts.total), critical: num(alerts.critical), attention: num(alerts.attention) },
    overdue_actions: num(r.overdue_actions),
    upcoming_follow_ups: list(r.upcoming_follow_ups).map(parseFollowUp).filter(notNull),
    youth_without_group: num(r.youth_without_group),
    upcoming_events: list(r.upcoming_events).map(parseEvent).filter(notNull),
    avg_attendance: numOrNull(r.avg_attendance),
    avg_attendance_records: num(r.avg_attendance_records),
    active_youth: num(r.active_youth),
  };
}

const TRENDS: readonly string[] = ['up', 'down', 'stable'];

/** Linhas cruas de `group_indicators(ids)` -> índice por grupo. */
export function parseGroupIndicators(rows: unknown): Map<string, GroupIndicator> {
  const map = new Map<string, GroupIndicator>();
  for (const raw of list(rows)) {
    if (!isObj(raw) || typeof raw.group_id !== 'string') continue;
    const trend = typeof raw.trend === 'string' && TRENDS.includes(raw.trend) ? (raw.trend as TrendKind) : null;
    map.set(raw.group_id, {
      group_id: raw.group_id,
      name: str(raw.name),
      leader_name: strOrNull(raw.leader_name),
      active_youth: num(raw.active_youth),
      attendance_rate: numOrNull(raw.attendance_rate),
      trend,
      // sem tendência não há diferença para mostrar
      trend_delta: trend ? numOrNull(raw.trend_delta) : null,
      youth_in_attention: num(raw.youth_in_attention),
      overdue_actions: num(raw.overdue_actions),
    });
  }
  return map;
}

export interface TrendDisplay {
  kind: TrendKind | 'insufficient';
  /** Texto principal (sempre presente: o sinal nunca depende só de seta/cor) */
  label: string;
  /** Diferença em pontos percentuais, ex.: "+12 pp" / "-12 pp"; null sem dado */
  delta: string | null;
}

/** Texto da tendência: "em alta", "em queda", "estável" ou "dados insuficientes" (menos de 8 encontros com chamada). */
export function trendDisplay(trend: TrendKind | null, delta: number | null): TrendDisplay {
  if (!trend) return { kind: 'insufficient', label: 'dados insuficientes', delta: null };
  const d = delta === null ? null : `${delta > 0 ? '+' : delta < 0 ? '-' : ''}${Math.abs(Math.round(delta))} pp`;
  if (trend === 'up') return { kind: 'up', label: 'em alta', delta: d };
  if (trend === 'down') return { kind: 'down', label: 'em queda', delta: d };
  return { kind: 'stable', label: 'estável', delta: d };
}

/** Tendência em uma linha, para exportação: "em queda (-12 pp)". */
export function trendText(trend: TrendKind | null, delta: number | null): string {
  const t = trendDisplay(trend, delta);
  return t.delta ? `${t.label} (${t.delta})` : t.label;
}
