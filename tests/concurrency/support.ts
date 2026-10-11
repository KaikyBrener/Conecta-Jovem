// Suporte dos testes de concorrência (Postgres real, várias conexões). Não é arquivo de teste.
import { randomBytes, randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { inject } from 'vitest';
import { SUPABASE_STUB } from '../db/harness';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../supabase/migrations/', import.meta.url));

export const concurrencyEnabled = () => inject('pgSource') !== 'disabled';

export type Settled<T> = { ok: true; value: T } | { ok: false; code: string; message: string };

export async function settle<T>(p: Promise<T>): Promise<Settled<T>> {
  try {
    return { ok: true, value: await p };
  } catch (err) {
    const e = err as { code?: string; message?: string };
    return { ok: false, code: e.code ?? '', message: e.message ?? String(err) };
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class Session {
  constructor(readonly client: pg.Client, readonly pid: number) {}
  query<T extends pg.QueryResultRow = Record<string, unknown>>(sql: string, params: unknown[] = []) {
    return this.client.query<T>(sql, params);
  }
  begin() { return this.client.query('BEGIN'); }
  commit() { return this.client.query('COMMIT'); }
  rollback() { return this.client.query('ROLLBACK'); }
  close() { return this.client.end(); }
}

export interface Scratch {
  name: string;
  /** Superusuário (sem RLS): preparação e inspeção. */
  admin: pg.Client;
  /** Nova conexão com papel e identidade (request.jwt.claim.sub) como no PostgREST. */
  session(opts?: { role?: 'authenticated' | 'service_role' | 'anon'; userId?: string | null }): Promise<Session>;
  createUser(name: string, role: 'coordinator' | 'leader'): Promise<string>;
  /** Substitui uma função por uma versão editada (controle negativo). Devolve a definição original para restaurar. */
  replaceFunction(signature: string, edit: (def: string) => string): Promise<string>;
  drop(): Promise<void>;
}

function urlFor(adminUrl: string, database: string) {
  const u = new URL(adminUrl);
  u.pathname = `/${database}`;
  return u.toString();
}

export async function createScratch(): Promise<Scratch> {
  const adminUrl = inject('pgAdminUrl');
  const name = `conc_${randomBytes(6).toString('hex')}`;
  const root = new pg.Client({ connectionString: adminUrl });
  await root.connect();
  await root.query(`CREATE DATABASE ${name}`);

  const url = urlFor(adminUrl, name);
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  const sessions: Session[] = [];

  // Papéis são do cluster (não do banco): criação idempotente; o resto do stub é igual ao do harness PGlite.
  const roleLines = SUPABASE_STUB.split('\n').filter((l) => /^\s*CREATE ROLE /.test(l));
  for (const line of roleLines) {
    const m = /CREATE ROLE (\w+)\s+([^;]*);/.exec(line)!;
    await admin.query(
      `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${m[1]}') THEN CREATE ROLE ${m[1]} ${m[2]}; END IF; END $$`);
  }
  await admin.query(SUPABASE_STUB.split('\n').filter((l) => !/^\s*CREATE ROLE /.test(l)).join('\n'));
  for (const file of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()) {
    try {
      await admin.query(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'));
    } catch (err) {
      throw new Error(`Falha ao aplicar ${file}: ${(err as Error).message}`);
    }
  }

  return {
    name,
    admin,
    async session(opts = {}) {
      const client = new pg.Client({ connectionString: url });
      await client.connect();
      const role = opts.role ?? 'authenticated';
      await client.query(`SELECT set_config('request.jwt.claim.sub', $1, false)`, [opts.userId ?? '']);
      await client.query(`SET ROLE ${role}`);
      const pid = (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      const s = new Session(client, pid);
      sessions.push(s);
      return s;
    },
    async createUser(fullName, role) {
      const id = randomUUID();
      await admin.query(
        `INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES ($1, $2, jsonb_build_object('full_name', $3::text))`,
        [id, `${id}@teste.local`, fullName]);
      await admin.query(`UPDATE public.user_roles SET role = $2 WHERE user_id = $1`, [id, role]);
      return id;
    },
    async replaceFunction(signature, edit) {
      const def = (await admin.query<{ def: string }>(`SELECT pg_get_functiondef($1::regprocedure) AS def`, [signature])).rows[0].def;
      const edited = edit(def);
      if (edited === def) {
        throw new Error(`Controle negativo inválido: a edição não alterou ${signature} (o teste não provaria nada).`);
      }
      await admin.query(edited);
      return def;
    },
    async drop() {
      for (const s of sessions) await s.close().catch(() => {});
      await admin.end().catch(() => {});
      await root.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`).catch(() => {});
      await root.end().catch(() => {});
    },
  };
}

export interface RaceResult<H, C> {
  /** O contendor chegou a esperar um lock (pg_stat_activity.wait_event_type = 'Lock') enquanto o holder não confirmou. */
  blocked: boolean;
  waitEvent: string | null;
  holder: Settled<H>;
  contender: Settled<C>;
}

/**
 * 1) o holder abre uma transação e executa a chamada SEM confirmar (segura os locks);
 * 2) o contendor dispara a sua chamada; observa-se, sem sleeps cegos, se ele fica esperando um lock;
 * 3) o holder confirma e o contendor termina. Sem lock o contendor termina sozinho (blocked = false).
 */
export async function raceBehindHeldTransaction<H, C>(a: {
  observer: pg.Client;
  holder: Session;
  holderCall: () => Promise<H>;
  contender: Session;
  contenderCall: () => Promise<C>;
  waitMs?: number;
}): Promise<RaceResult<H, C>> {
  await a.holder.begin();
  const holder = await settle(a.holderCall());
  if (!holder.ok) {
    await a.holder.rollback();
    return { blocked: false, waitEvent: null, holder, contender: { ok: false, code: '', message: 'holder falhou antes' } };
  }

  let done = false;
  const contenderP = settle(a.contenderCall()).then((r) => { done = true; return r; });

  let blocked = false;
  let waitEvent: string | null = null;
  const deadline = Date.now() + (a.waitMs ?? 4000);
  while (!done && Date.now() < deadline) {
    const { rows } = await a.observer.query<{ wait_event_type: string | null; wait_event: string | null }>(
      `SELECT wait_event_type, wait_event FROM pg_stat_activity WHERE pid = $1`, [a.contender.pid]);
    if (rows[0]?.wait_event_type === 'Lock') {
      blocked = true;
      waitEvent = rows[0].wait_event;
      break;
    }
    await sleep(20);
  }
  if (!blocked && !done) {
    await a.holder.rollback();
    throw new Error('Corrida inconclusiva: o contendor nem terminou nem esperou lock no prazo.');
  }

  await a.holder.commit();
  return { blocked, waitEvent, holder, contender: await contenderP };
}
