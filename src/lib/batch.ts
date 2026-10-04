// Ações em lote sobre jovens (lógica PURA): limite, resultado das RPCs batch_set_youth_* (migration 014),
// seleção e exportação CSV. Só entram campos que a lista já mostra ao usuário.
import { toCsv } from './csv';
import type { Youth } from '../types/database.types';

/** Máximo de jovens distintos por chamada (o banco recusa acima disso). */
export const BATCH_MAX = 200;

export interface BatchResult {
  requested: number;
  updated: number;
  unchanged: number;
  /** ids inexistentes ou fora do escopo do usuário (RLS) */
  skipped: number;
}

const toCount = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);

/** Converte o jsonb da RPC; `skipped` chega como lista de ids e vira a quantidade. */
export function parseBatchResult(data: unknown): BatchResult {
  const o = data && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, unknown>) : {};
  return {
    requested: toCount(o.requested),
    updated: toCount(o.updated),
    unchanged: toCount(o.unchanged),
    skipped: Array.isArray(o.skipped) ? o.skipped.length : toCount(o.skipped),
  };
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * Resumo em uma frase: "12 atualizados, 3 já estavam assim, 2 sem permissão."
 * Nada atualizado e nenhum ignorado: "Nenhuma alteração: os jovens já estavam nesse estado."
 */
export function batchSummary(r: BatchResult): string {
  const parts: string[] = [];
  if (r.updated > 0) parts.push(plural(r.updated, 'atualizado', 'atualizados'));
  if (r.unchanged > 0) parts.push(plural(r.unchanged, 'já estava assim', 'já estavam assim'));
  if (r.skipped > 0) parts.push(`${r.skipped} sem permissão`);
  if (parts.length === 0) return 'Nenhuma alteração.';
  if (r.updated === 0 && r.skipped === 0) return 'Nenhuma alteração: os jovens selecionados já estavam nesse estado.';
  return `${parts.join(', ')}.`;
}

/** Houve algum efeito? (decide entre aviso de sucesso e de erro) */
export function batchHadEffect(r: BatchResult): boolean {
  return r.updated > 0 || r.skipped === 0;
}

/**
 * Soma jovens à seleção respeitando o limite. Devolve a nova seleção e quantos ficaram de fora.
 * Não altera o Map recebido (estado do React).
 */
export function addToSelection(
  current: ReadonlyMap<string, Youth>,
  toAdd: readonly Youth[],
  max: number = BATCH_MAX,
): { selection: Map<string, Youth>; rejected: number } {
  const selection = new Map(current);
  let rejected = 0;
  for (const y of toAdd) {
    if (selection.has(y.id)) continue;
    if (selection.size >= max) { rejected += 1; continue; }
    selection.set(y.id, y);
  }
  return { selection, rejected };
}

export const YOUTH_CSV_HEADERS = ['Nome', 'Grupo', 'Telefone', 'E-mail', 'Status'];

/** CSV dos jovens selecionados (texto com neutralização de fórmulas e separador `;`, ver lib/csv). */
export function buildYouthCsv(youth: readonly Youth[], groupName: (groupId: string | null) => string): string {
  return toCsv(
    YOUTH_CSV_HEADERS,
    youth.map((y) => [y.full_name, groupName(y.group_id), y.phone, y.email, y.is_active ? 'Ativo' : 'Inativo']),
  );
}
