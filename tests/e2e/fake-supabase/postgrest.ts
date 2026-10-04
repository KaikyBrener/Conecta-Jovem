// Subconjunto de PostgREST suficiente para o que o frontend do Conecta Jovem usa
// (supabase-js: select com embeds, filtros, order, limit/range, count, insert/upsert,
// update, delete, rpc). Roda sobre o PGlite com as migrations reais, então RLS,
// triggers e constraints são os de verdade — só o "tradutor HTTP" é simulado.
import type { PGlite } from '@electric-sql/pglite';

export interface HttpResult {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

export interface RestRequest {
  method: string;
  table: string; // nome da tabela, ou "rpc/<fn>"
  search: URLSearchParams;
  headers: Record<string, string | undefined>;
  body: unknown;
  /** id do usuário autenticado (null = anon) */
  userId: string | null;
}

interface Fk {
  table: string;
  column: string;
  refTable: string;
  refColumn: string;
}

interface Catalog {
  types: Map<string, string>; // "tabela.coluna" -> tipo
  pks: Map<string, string>; // tabela -> coluna da PK
  fks: Fk[];
}

const q = (ident: string) => `"${ident.replace(/"/g, '""')}"`;

class PgrstError extends Error {
  status: number;
  code: string;
  details: string | null;
  constructor(status: number, code: string, message: string, details: string | null = null) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export async function loadCatalog(db: PGlite): Promise<Catalog> {
  const cols = await db.query<{ t: string; c: string; ty: string }>(
    `SELECT c.relname AS t, a.attname AS c, format_type(a.atttypid, a.atttypmod) AS ty
       FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped`,
  );
  const pks = await db.query<{ t: string; c: string }>(
    `SELECT c.relname AS t, a.attname AS c
       FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.conkey[1]
      WHERE n.nspname = 'public' AND k.contype = 'p' AND array_length(k.conkey, 1) = 1`,
  );
  const fks = await db.query<{ t: string; c: string; rt: string; rc: string }>(
    `SELECT c.relname AS t, a.attname AS c, rc.relname AS rt, ra.attname AS rc
       FROM pg_constraint k
       JOIN pg_class c ON c.oid = k.conrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_class rc ON rc.oid = k.confrelid
       JOIN pg_namespace rn ON rn.oid = rc.relnamespace
       JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.conkey[1]
       JOIN pg_attribute ra ON ra.attrelid = rc.oid AND ra.attnum = k.confkey[1]
      WHERE n.nspname = 'public' AND rn.nspname = 'public' AND k.contype = 'f'
        AND array_length(k.conkey, 1) = 1`,
  );
  return {
    types: new Map(cols.rows.map((r) => [`${r.t}.${r.c}`, r.ty])),
    pks: new Map(pks.rows.map((r) => [r.t, r.c])),
    fks: fks.rows.map((r) => ({ table: r.t, column: r.c, refTable: r.rt, refColumn: r.rc })),
  };
}

// ---------------------------------------------------------------------------
// Parsing de select / filtros
// ---------------------------------------------------------------------------

interface SelectNode {
  kind: 'col' | 'star' | 'embed';
  name: string; // coluna ou nome do embed
  alias: string;
  inner?: boolean;
  children?: SelectNode[];
}

function splitTop(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out.map((p) => p.trim()).filter(Boolean);
}

export function parseSelect(s: string): SelectNode[] {
  return splitTop(s).map((item): SelectNode => {
    if (item === '*') return { kind: 'star', name: '*', alias: '*' };
    const paren = item.indexOf('(');
    if (paren === -1) {
      const [alias, name] = item.includes(':') ? item.split(':') : [item, item];
      return { kind: 'col', name: name.trim(), alias: alias.trim() };
    }
    const head = item.slice(0, paren).trim();
    const inner = item.slice(paren + 1, item.lastIndexOf(')'));
    const [aliasPart, rest] = head.includes(':') ? head.split(':') : [null, head];
    const [name, ...hints] = rest.split('!').map((p) => p.trim());
    return {
      kind: 'embed',
      name,
      alias: (aliasPart ?? name).trim(),
      inner: hints.includes('inner'),
      children: parseSelect(inner),
    };
  });
}

/** Filtros `embed.coluna=op.valor` que se aplicam ao embed `node` no nível `path`. */
function embedFilters(filters: Filter[], path: string[], node: SelectNode): Filter[] {
  return filters.filter(
    (f) =>
      f.path.length === path.length + 1 &&
      path.every((p, i) => f.path[i] === p) &&
      (f.path[path.length] === node.alias || f.path[path.length] === node.name),
  );
}

/** Teto de linhas por resposta do PostgREST (max-rows padrão do Supabase). */
export const MAX_ROWS = 1000;

const RESERVED = new Set(['select', 'order', 'limit', 'offset', 'on_conflict', 'columns']);

interface Filter {
  path: string[]; // [] = tabela raiz; ['events'] = embed
  column: string;
  negate: boolean;
  op: string;
  value: string;
  /** `or=(a.op.v,b.op.v)`: alternativas (qualquer uma satisfaz) */
  or?: Filter[];
}

const unquote = (v: string) => v.replace(/^"(.*)"$/, '$1');

function parseOr(raw: string, path: string[]): Filter {
  const inner = raw.replace(/^\(/, '').replace(/\)$/, '');
  const alternatives = splitTop(inner).map((item): Filter => {
    const [column, ...rest] = item.split('.');
    const negate = rest[0] === 'not';
    const [op, ...value] = negate ? rest.slice(1) : rest;
    return { path, column, negate, op, value: unquote(value.join('.')) };
  });
  return { path, column: '', negate: false, op: 'or', value: '', or: alternatives };
}

function parseFilters(search: URLSearchParams): Filter[] {
  const filters: Filter[] = [];
  for (const [key, raw] of search.entries()) {
    if (RESERVED.has(key)) continue;
    if (key === 'or') { filters.push(parseOr(raw, [])); continue; }
    const parts = key.split('.');
    const column = parts.pop()!;
    let rest = raw;
    let negate = false;
    if (rest.startsWith('not.')) {
      negate = true;
      rest = rest.slice(4);
    }
    const dot = rest.indexOf('.');
    filters.push({ path: parts, column, negate, op: rest.slice(0, dot), value: unquote(rest.slice(dot + 1)) });
  }
  return filters;
}

// ---------------------------------------------------------------------------
// Geração de SQL
// ---------------------------------------------------------------------------

class SqlBuilder {
  params: string[] = [];
  private n = 0;
  private cat: Catalog;
  constructor(cat: Catalog) {
    this.cat = cat;
  }

  param(v: string): string {
    this.params.push(v);
    return `$${this.params.length}::text`;
  }

  alias(): string {
    return `t${++this.n}`;
  }

  typed(table: string, column: string, v: string): string {
    const ty = this.cat.types.get(`${table}.${column}`);
    if (!ty) throw new PgrstError(400, '42703', `column ${table}.${column} does not exist`);
    return `(${this.param(v)})::${ty}`;
  }

  condition(table: string, ref: string, f: Filter): string {
    if (f.or) {
      const alts = f.or.map((a) => this.condition(table, ref, a));
      return `(${alts.join(' OR ')})`;
    }
    const col = `${ref}.${q(f.column)}`;
    let sql: string;
    switch (f.op) {
      case 'eq': sql = `${col} = ${this.typed(table, f.column, f.value)}`; break;
      case 'neq': sql = `${col} <> ${this.typed(table, f.column, f.value)}`; break;
      case 'gt': sql = `${col} > ${this.typed(table, f.column, f.value)}`; break;
      case 'gte': sql = `${col} >= ${this.typed(table, f.column, f.value)}`; break;
      case 'lt': sql = `${col} < ${this.typed(table, f.column, f.value)}`; break;
      case 'lte': sql = `${col} <= ${this.typed(table, f.column, f.value)}`; break;
      case 'like': sql = `${col}::text LIKE ${this.param(f.value.replace(/\*/g, '%'))}`; break;
      case 'ilike': sql = `${col}::text ILIKE ${this.param(f.value.replace(/\*/g, '%'))}`; break;
      case 'is': sql = `${col} IS ${f.value === 'null' ? 'NULL' : f.value === 'true' ? 'TRUE' : 'FALSE'}`; break;
      case 'in': {
        const list = splitTop(f.value.replace(/^\(/, '').replace(/\)$/, '')).map((v) => v.replace(/^"|"$/g, ''));
        sql = list.length ? `${col} IN (${list.map((v) => this.typed(table, f.column, v)).join(', ')})` : 'FALSE';
        break;
      }
      default:
        throw new PgrstError(400, 'PGRST100', `operador não suportado: ${f.op}`);
    }
    return f.negate ? `NOT (${sql})` : sql;
  }

  /**
   * Resolve o embed `name` a partir de `table`.
   * to-one: FK local (ou FK de outra tabela cuja coluna é a PK dela → relação 1:1, como no PostgREST);
   * to-many: FK de outra tabela. `target` é a coluna da tabela embutida, `source` a da tabela pai.
   */
  relation(table: string, name: string): { kind: 'one' | 'many'; refTable: string; target: string; source: string } {
    const forward = this.cat.fks.filter((f) => f.table === table);
    const byColumn = forward.find((f) => f.column === name);
    if (byColumn) return { kind: 'one', refTable: byColumn.refTable, target: byColumn.refColumn, source: byColumn.column };
    const byTable = forward.filter((f) => f.refTable === name);
    if (byTable.length === 1) {
      return { kind: 'one', refTable: byTable[0].refTable, target: byTable[0].refColumn, source: byTable[0].column };
    }
    const reverse = this.cat.fks.filter((f) => f.refTable === table && f.table === name);
    if (reverse.length === 1) {
      const fk = reverse[0];
      const oneToOne = this.cat.pks.get(fk.table) === fk.column;
      return { kind: oneToOne ? 'one' : 'many', refTable: fk.table, target: fk.column, source: fk.refColumn };
    }
    throw new PgrstError(
      400,
      'PGRST200',
      `Could not find a relationship between '${table}' and '${name}' in the schema cache`,
    );
  }

  /** Lista de colunas de um nó select, aplicada sobre `ref` (alias SQL da tabela). */
  selectList(table: string, ref: string, nodes: SelectNode[], filters: Filter[], path: string[]): string {
    const parts: string[] = [];
    for (const node of nodes) {
      if (node.kind === 'star') parts.push(`${ref}.*`);
      else if (node.kind === 'col') parts.push(`${ref}.${q(node.name)} AS ${q(node.alias)}`);
      else parts.push(`${this.embed(table, ref, node, filters, path)} AS ${q(node.alias)}`);
    }
    return parts.join(', ') || `${ref}.*`;
  }

  embed(table: string, ref: string, node: SelectNode, filters: Filter[], path: string[]): string {
    const rel = this.relation(table, node.name);
    const e = this.alias();
    const own = embedFilters(filters, path, node);
    const where = [
      `${e}.${q(rel.target)} = ${ref}.${q(rel.source)}`,
      ...own.map((f) => this.condition(rel.refTable, e, f)),
    ].join(' AND ');
    // embed(count): contagem agregada, formato do PostgREST: [{"count": n}]
    const kids = node.children ?? [];
    if (kids.length === 1 && kids[0].kind === 'col' && kids[0].name === 'count') {
      return `(SELECT jsonb_build_array(jsonb_build_object('count', count(*))) FROM public.${q(rel.refTable)} AS ${e} WHERE ${where})`;
    }
    const cols = this.selectList(rel.refTable, e, node.children ?? [], filters, [...path, node.alias]);
    const sub = `SELECT ${cols} FROM public.${q(rel.refTable)} AS ${e} WHERE ${where}`;
    return rel.kind === 'one'
      ? `(SELECT to_jsonb(s) FROM (${sub}) s LIMIT 1)`
      : `(SELECT COALESCE(jsonb_agg(to_jsonb(s)), '[]'::jsonb) FROM (${sub}) s)`;
  }

  /** Condições que um embed !inner impõe sobre a linha pai. */
  innerConditions(table: string, ref: string, nodes: SelectNode[], filters: Filter[], path: string[]): string[] {
    const out: string[] = [];
    for (const node of nodes) {
      if (node.kind !== 'embed' || !node.inner) continue;
      const rel = this.relation(table, node.name);
      const e = this.alias();
      const own = embedFilters(filters, path, node);
      const where = [
        `${e}.${q(rel.target)} = ${ref}.${q(rel.source)}`,
        ...own.map((f) => this.condition(rel.refTable, e, f)),
      ].join(' AND ');
      out.push(`EXISTS (SELECT 1 FROM public.${q(rel.refTable)} AS ${e} WHERE ${where})`);
    }
    return out;
  }
}

function orderBy(search: URLSearchParams, ref: string): string {
  const raw = search.get('order');
  if (!raw) return '';
  const items = raw.split(',').map((item) => {
    const [col, ...mods] = item.split('.');
    const dir = mods.includes('desc') ? 'DESC' : 'ASC';
    const nulls = mods.includes('nullsfirst') ? ' NULLS FIRST' : mods.includes('nullslast') ? ' NULLS LAST' : '';
    return `${ref}.${q(col)} ${dir}${nulls}`;
  });
  return `ORDER BY ${items.join(', ')}`;
}

function parseRange(headers: RestRequest['headers'], search: URLSearchParams): { limit?: number; offset: number } {
  const limitParam = search.get('limit');
  const offsetParam = search.get('offset');
  const range = headers['range'];
  let limit = limitParam ? Number(limitParam) : undefined;
  let offset = offsetParam ? Number(offsetParam) : 0;
  if (range && /^\d+-\d*$/.test(range)) {
    const [from, to] = range.split('-');
    offset = Number(from);
    if (to) limit = Number(to) - Number(from) + 1;
  }
  return { limit, offset };
}

const STATUS_BY_PG_CODE: Record<string, number> = {
  '23505': 409, // unique_violation
  '23503': 409, // foreign_key_violation
  '42501': 403, // insufficient_privilege (inclui violação de RLS)
};

function pgError(err: unknown): HttpResult {
  if (err instanceof PgrstError) {
    return { status: err.status, body: { code: err.code, message: err.message, details: err.details, hint: null } };
  }
  const e = err as { code?: string; message?: string; detail?: string; hint?: string };
  const code = e.code ?? 'XX000';
  return {
    status: STATUS_BY_PG_CODE[code] ?? 400,
    body: { code, message: e.message ?? 'erro', details: e.detail ?? null, hint: e.hint ?? null },
  };
}

// ---------------------------------------------------------------------------
// Execução
// ---------------------------------------------------------------------------

export async function handleRest(db: PGlite, cat: Catalog, req: RestRequest): Promise<HttpResult> {
  // PGlite tem uma única conexão: toda requisição roda numa transação com o papel
  // e as claims do usuário (SET LOCAL), exatamente como o PostgREST faz.
  await db.exec('BEGIN');
  try {
    await db.exec(req.userId ? 'SET LOCAL ROLE authenticated' : 'SET LOCAL ROLE anon');
    await db.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [req.userId ?? '']);
    const result = req.table.startsWith('rpc/') ? await runRpc(db, cat, req) : await runTable(db, cat, req);
    if (result.status >= 400) await db.exec('ROLLBACK');
    else await db.exec('COMMIT');
    return result;
  } catch (err) {
    await db.exec('ROLLBACK').catch(() => {});
    return pgError(err);
  }
}

async function runRpc(db: PGlite, cat: Catalog, req: RestRequest): Promise<HttpResult> {
  const fn = req.table.slice('rpc/'.length);
  const args = (req.method === 'GET' ? Object.fromEntries(req.search.entries()) : (req.body ?? {})) as Record<string, unknown>;
  const meta = await db.query<{ names: string[] | null; types: string[] | null; is_set: boolean }>(
    `SELECT p.proargnames AS names, p.proretset AS is_set,
            (SELECT array_agg(format_type(t, NULL) ORDER BY o) FROM unnest(p.proargtypes::oid[]) WITH ORDINALITY AS u(t, o)) AS types
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = $1`,
    [fn],
  );
  if (!meta.rows[0]) {
    throw new PgrstError(404, 'PGRST202', `Could not find the function public.${fn} in the schema cache`);
  }
  const { names, types, is_set: isSet } = meta.rows[0];
  const b = new SqlBuilder(cat);
  const named = Object.entries(args).map(([k, v]) => {
    const idx = (names ?? []).indexOf(k);
    if (idx === -1) throw new PgrstError(404, 'PGRST202', `Could not find the function public.${fn}(${k})`);
    // JSON → literal do Postgres: arrays viram '{a,b}', null vira NULL
    // parâmetros json/jsonb (ex.: save_attendance.p_entries) vão como JSON, não como array do Postgres
    const isJson = types![idx] === 'jsonb' || types![idx] === 'json';
    const literal = v === null ? null
      : isJson ? JSON.stringify(v)
      : Array.isArray(v) ? `{${v.map((x) => (x === null ? 'NULL' : `"${String(x).replace(/(["\\])/g, '\\$1')}"`)).join(',')}}`
      : String(v);
    return `${q(k)} => (${literal === null ? 'NULL::text' : b.param(literal)})::${types![idx]}`;
  });
  // funções que retornam SETOF/TABLE viram um array JSON (como no PostgREST), mesmo com 0 ou 1 linha
  const call = `public.${q(fn)}(${named.join(', ')})`;
  const res = await db.query<{ r: unknown }>(
    isSet
      ? `SELECT COALESCE(jsonb_agg(to_jsonb(t)), '[]'::jsonb) AS r FROM ${call} AS t`
      : `SELECT to_jsonb(${call}) AS r`,
    b.params);
  const value = res.rows[0]?.r ?? null;
  return value === null ? { status: 204 } : { status: 200, body: value };
}

async function runTable(db: PGlite, cat: Catalog, req: RestRequest): Promise<HttpResult> {
  const { table, search, headers, method } = req;
  if (!cat.pks.has(table) && !cat.types.has(`${table}.id`) && ![...cat.types.keys()].some((k) => k.startsWith(`${table}.`))) {
    throw new PgrstError(404, '42P01', `relation "public.${table}" does not exist`);
  }
  const prefer = (headers['prefer'] ?? '').split(',').map((p) => p.trim());
  const wantsRows = prefer.includes('return=representation');
  const countExact = prefer.includes('count=exact');
  const asObject = (headers['accept'] ?? '').includes('application/vnd.pgrst.object+json');
  const nodes = parseSelect(search.get('select') ?? '*');
  const filters = parseFilters(search);
  const b = new SqlBuilder(cat);
  const root = 'r';

  const rootWhere = (ref: string) =>
    [
      ...filters.filter((f) => f.path.length === 0).map((f) => b.condition(table, ref, f)),
      ...b.innerConditions(table, ref, nodes, filters, []),
    ].join(' AND ') || 'TRUE';

  // Monta a projeção final sobre uma fonte (tabela ou CTE de retorno).
  const projection = (source: string, extra = '') =>
    `SELECT ${b.selectList(table, root, nodes, filters, [])} FROM ${source} AS ${root} ${extra}`;

  const aggregate = (inner: string) =>
    `SELECT COALESCE(jsonb_agg(to_jsonb(t)), '[]'::jsonb) AS rows, count(*)::int AS n FROM (${inner}) t`;

  const finish = async (sql: string, status: number, mutation: boolean): Promise<HttpResult> => {
    const res = await db.query<{ rows: Record<string, unknown>[]; n: number }>(sql, b.params);
    const rows = res.rows[0].rows;
    if (asObject && rows.length !== 1) {
      throw new PgrstError(406, 'PGRST116', 'JSON object requested, multiple (or no) rows returned',
        `The result contains ${rows.length} rows`);
    }
    if (mutation && !wantsRows) return { status: status === 201 ? 201 : 204 };
    return { status, body: asObject ? rows[0] : rows };
  };

  if (method === 'GET' || method === 'HEAD') {
    const { limit, offset } = parseRange(headers, search);
    const where = rootWhere(root);
    const order = orderBy(search, root);
    // como o PostgREST real: nunca devolve mais que MAX_ROWS linhas, mesmo sem LIMIT explícito
    const page = `${order} LIMIT ${Math.min(limit ?? MAX_ROWS, MAX_ROWS)} OFFSET ${offset}`;
    const sql = aggregate(projection(`public.${q(table)}`, `WHERE ${where} ${page}`));
    const res = await db.query<{ rows: Record<string, unknown>[]; n: number }>(sql, b.params);
    const rows = res.rows[0].rows;
    const headersOut: Record<string, string> = {};
    let total: number | null = null;
    if (countExact) {
      // Builder próprio: parâmetros não referenciados fariam o Postgres rejeitar a query
      const cb = new SqlBuilder(cat);
      const countWhere = [
        ...filters.filter((f) => f.path.length === 0).map((f) => cb.condition(table, root, f)),
        ...cb.innerConditions(table, root, nodes, filters, []),
      ].join(' AND ') || 'TRUE';
      const c = await db.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM public.${q(table)} AS ${root} WHERE ${countWhere}`,
        cb.params,
      );
      total = c.rows[0].n;
    }
    const first = rows.length ? offset : '*';
    headersOut['content-range'] =
      rows.length ? `${offset}-${offset + rows.length - 1}/${total ?? '*'}` : `${first === '*' ? '*' : first}/${total ?? '*'}`;
    if (asObject && rows.length !== 1) {
      throw new PgrstError(406, 'PGRST116', 'JSON object requested, multiple (or no) rows returned',
        `The result contains ${rows.length} rows`);
    }
    if (method === 'HEAD') return { status: 200, headers: headersOut };
    return { status: 200, headers: headersOut, body: asObject ? rows[0] : rows };
  }

  if (method === 'POST') {
    const records = Array.isArray(req.body) ? req.body : [req.body];
    const columns = [...new Set(records.flatMap((r) => Object.keys(r as object)))];
    const colSql = columns.map(q).join(', ');
    const bodyParam = b.param(JSON.stringify(records));
    let conflict = '';
    if (search.get('on_conflict') && (prefer.includes('resolution=merge-duplicates') || prefer.includes('resolution=ignore-duplicates'))) {
      const target = search.get('on_conflict')!.split(',').map(q).join(', ');
      conflict = prefer.includes('resolution=ignore-duplicates')
        ? `ON CONFLICT (${target}) DO NOTHING`
        : `ON CONFLICT (${target}) DO UPDATE SET ${columns.map((c) => `${q(c)} = EXCLUDED.${q(c)}`).join(', ')}`;
    }
    const insert = `INSERT INTO public.${q(table)} (${colSql})
      SELECT ${colSql} FROM jsonb_populate_recordset(NULL::public.${q(table)}, ${bodyParam}::jsonb) ${conflict} RETURNING *`;
    const sql = `WITH ret AS (${insert}) ${aggregate(projection('ret'))}`;
    return finish(sql, 201, true);
  }

  if (method === 'PATCH') {
    const patch = (req.body ?? {}) as Record<string, unknown>;
    const columns = Object.keys(patch);
    if (!columns.length) return { status: 204 };
    const bodyParam = b.param(JSON.stringify(patch));
    const sets = columns.map((c) => `${q(c)} = x.${q(c)}`).join(', ');
    const where = rootWhere('u');
    const update = `UPDATE public.${q(table)} AS u SET ${sets}
      FROM jsonb_populate_record(NULL::public.${q(table)}, ${bodyParam}::jsonb) AS x
      WHERE ${where} RETURNING u.*`;
    const sql = `WITH ret AS (${update}) ${aggregate(projection('ret'))}`;
    return finish(sql, 200, true);
  }

  if (method === 'DELETE') {
    const where = rootWhere('d');
    const del = `DELETE FROM public.${q(table)} AS d WHERE ${where} RETURNING d.*`;
    const sql = `WITH ret AS (${del}) ${aggregate(projection('ret'))}`;
    return finish(sql, 200, true);
  }

  throw new PgrstError(405, 'PGRST117', `Unsupported HTTP method: ${method}`);
}
