import type { YouthSituation, YouthSituationLevel } from '../types/database.types';

// Lógica pura da "situação do jovem" (selos, rótulos, critério). A regra em si é calculada no banco
// (RPC youth_situation / youth_situations, migration 011); aqui só se interpreta e apresenta o resultado.

export type SituationTone = 'green' | 'amber' | 'red' | 'gray';

export interface SituationDisplay {
  level: YouthSituationLevel;
  /** Texto do selo (o selo nunca depende só de cor: sempre há texto e ícone) */
  label: string;
  tone: SituationTone;
  /** Frase curta para leitores de tela / tooltip */
  description: string;
}

const LABEL: Record<YouthSituationLevel, string> = {
  normal: 'Normal',
  attention: 'Atenção',
  critical: 'Crítico',
};

const TONE: Record<YouthSituationLevel, SituationTone> = {
  normal: 'green',
  attention: 'amber',
  critical: 'red',
};

const LEVELS: readonly string[] = ['normal', 'attention', 'critical'];

/** Valor desconhecido (ex.: banco mais novo que o app) vira 'normal' só na apresentação, nunca "crítico". */
export function toSituationLevel(value: unknown): YouthSituationLevel {
  return typeof value === 'string' && LEVELS.includes(value) ? (value as YouthSituationLevel) : 'normal';
}

/** Jovem inativo não é avaliado: mostra "Inativo" em vez de um "Normal" enganoso. */
export function situationDisplay(s: Pick<YouthSituation, 'situation' | 'inactive'>): SituationDisplay {
  if (s.inactive) {
    return { level: 'normal', label: 'Inativo', tone: 'gray', description: 'Jovem inativo: situação não avaliada.' };
  }
  const level = toSituationLevel(s.situation);
  return { level, label: LABEL[level], tone: TONE[level], description: `Situação: ${LABEL[level]}.` };
}

const num = (v: unknown, fallback = 0): number => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : fallback;
};
const numOrNull = (v: unknown): number | null => {
  if (v === null || v === undefined) return null;
  const n = num(v, NaN);
  return Number.isFinite(n) ? n : null;
};
const strOrNull = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

/** Normaliza uma linha crua da RPC (tipos numéricos, arrays nulos, valores desconhecidos). */
export function parseSituation(raw: unknown): YouthSituation | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.youth_id !== 'string') return null;
  return {
    youth_id: r.youth_id,
    full_name: typeof r.full_name === 'string' ? r.full_name : '',
    inactive: r.inactive === true,
    group_id: strOrNull(r.group_id),
    group_name: strOrNull(r.group_name),
    leader_name: strOrNull(r.leader_name),
    attendance_rate: numOrNull(r.attendance_rate),
    consecutive_absences: num(r.consecutive_absences),
    events_total: num(r.events_total),
    last_event: strOrNull(r.last_event),
    open_actions: num(r.open_actions),
    overdue_actions: num(r.overdue_actions),
    last_follow_up: strOrNull(r.last_follow_up),
    situation: toSituationLevel(r.situation),
    reasons: Array.isArray(r.reasons) ? r.reasons.filter((x): x is string => typeof x === 'string') : [],
  };
}

/** Índice por jovem de uma lista de linhas da RPC `youth_situations`. */
export function indexSituations(rows: unknown): Map<string, YouthSituation> {
  const map = new Map<string, YouthSituation>();
  if (!Array.isArray(rows)) return map;
  for (const raw of rows) {
    const s = parseSituation(raw);
    if (s) map.set(s.youth_id, s);
  }
  return map;
}

/**
 * Texto da regra objetiva exibido no rodapé do painel. Os limites vêm das configurações do sistema;
 * sem eles, descreve a regra sem números.
 */
export function situationCriteriaText(limits?: { attention?: number | null; critical?: number | null }): string {
  const att = limits?.attention ?? null;
  const critRaw = limits?.critical ?? null;
  const crit = att !== null && critRaw !== null ? Math.max(critRaw, att) : null;
  const attentionAbsences = att !== null ? `${att} ou mais faltas seguidas` : 'faltas seguidas acima do limite de alerta';
  const criticalAbsences = crit !== null ? `${crit} ou mais faltas seguidas` : 'faltas seguidas acima do limite crítico';
  return (
    `Critério: Crítico = ${criticalAbsences}. ` +
    `Atenção = ${attentionAbsences}, alerta aberto de frequência baixa, queda de frequência ou falta de acompanhamento, ` +
    'ou ao menos uma ação atrasada. Normal = nenhum desses sinais. Jovem inativo não é avaliado. ' +
    'Isto é um apoio ao cuidado pastoral, não um diagnóstico.'
  );
}
