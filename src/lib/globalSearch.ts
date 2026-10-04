// Busca global (paleta Ctrl/⌘+K): tratamento PURO do retorno da RPC `global_search` (migration 014), destinos de
// navegação e navegação por teclado. O RLS já filtra o que cada papel enxerga; aqui só se organiza o resultado.

export const SEARCH_MIN_CHARS = 2;

export type SearchKind = 'youth' | 'group' | 'event';

export interface YouthHit { kind: 'youth'; id: string; title: string; subtitle: string; inactive: boolean }
export interface GroupHit { kind: 'group'; id: string; title: string; subtitle: string }
export interface EventHit { kind: 'event'; id: string; title: string; date: string | null; status: string | null }
export type SearchHit = YouthHit | GroupHit | EventHit;

export interface SearchResults {
  youth: YouthHit[];
  groups: GroupHit[];
  events: EventHit[];
}

export const EMPTY_SEARCH_RESULTS: SearchResults = { youth: [], groups: [], events: [] };

export const SEARCH_SECTIONS: { kind: SearchKind; label: string }[] = [
  { kind: 'youth', label: 'Jovens' },
  { kind: 'group', label: 'Grupos' },
  { kind: 'event', label: 'Encontros' },
];

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

function rows(v: unknown): Record<string, unknown>[] {
  return Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object') : [];
}

/** Texto digitado normalizado para a consulta: espaços colapsados e aparado. */
export function normalizeSearchTerm(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim();
}

/** A consulta só é feita com pelo menos 2 caracteres (o banco também devolve vazio abaixo disso). */
export function isSearchable(raw: string): boolean {
  return normalizeSearchTerm(raw).length >= SEARCH_MIN_CHARS;
}

/** Converte o jsonb da RPC (formato desconhecido/parcial é tolerado: itens sem id são descartados). */
export function parseGlobalSearch(data: unknown): SearchResults {
  const o = data && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, unknown>) : {};
  const youth: YouthHit[] = [];
  for (const r of rows(o.youth)) {
    const id = str(r.id);
    const name = str(r.full_name);
    if (!id || !name) continue;
    youth.push({ kind: 'youth', id, title: name, subtitle: str(r.group_name) ?? 'Sem grupo', inactive: r.is_active === false });
  }
  const groups: GroupHit[] = [];
  for (const r of rows(o.groups)) {
    const id = str(r.id);
    const name = str(r.name);
    if (!id || !name) continue;
    const leader = str(r.leader_name);
    groups.push({ kind: 'group', id, title: name, subtitle: leader ? `Líder: ${leader}` : 'Sem líder' });
  }
  const events: EventHit[] = [];
  for (const r of rows(o.events)) {
    const id = str(r.id);
    const title = str(r.title);
    if (!id || !title) continue;
    events.push({ kind: 'event', id, title, date: str(r.event_date), status: str(r.status) });
  }
  return { youth, groups, events };
}

/** Lista única na ordem em que aparece na tela (Jovens, Grupos, Encontros): base da navegação por setas. */
export function flattenResults(r: SearchResults): SearchHit[] {
  return [...r.youth, ...r.groups, ...r.events];
}

/**
 * Termo de busca de um grupo na página Grupos. A busca remove `% * , ( ) " \` (ver searchPattern); para um nome como
 * "Jovens (A)" o termo precisa ser a maior parte sem esses caracteres, senão a lista ficaria vazia.
 */
export function groupSearchTerm(name: string): string {
  const parts = name.split(/[%*,()"\\]+/).map((p) => p.replace(/\s+/g, ' ').trim()).filter(Boolean);
  return parts.reduce((best, p) => (p.length > best.length ? p : best), '') || name.trim();
}

/** Destino de cada tipo de resultado (deep links tratados por Jovens, Grupos e Encontros). */
export function hitHref(hit: SearchHit): string {
  switch (hit.kind) {
    case 'youth':
      return `/jovens?ficha=${encodeURIComponent(hit.id)}`;
    case 'group':
      return `/grupos?busca=${encodeURIComponent(groupSearchTerm(hit.title))}`;
    case 'event':
      return `/encontros?evento=${encodeURIComponent(hit.id)}`;
  }
}

/** Próximo índice ativo com setas (circular). Lista vazia → -1. */
export function moveActive(current: number, delta: 1 | -1, length: number): number {
  if (length <= 0) return -1;
  if (current < 0) return delta === 1 ? 0 : length - 1;
  return (current + delta + length) % length;
}

/** Atalho de abertura: Ctrl+K (Windows/Linux) ou ⌘+K (macOS), sem Shift/Alt. */
export function isSearchShortcut(e: { key: string; ctrlKey: boolean; metaKey: boolean; shiftKey?: boolean; altKey?: boolean }): boolean {
  return e.key.toLowerCase() === 'k' && (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey;
}
