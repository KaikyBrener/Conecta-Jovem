// Harness de testes de banco: Postgres real em memória (PGlite) com stubs mínimos
// do Supabase (schema auth, roles anon/authenticated e privilégios default) e
// todas as migrations de supabase/migrations aplicadas em ordem.
import { PGlite } from '@electric-sql/pglite';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../supabase/migrations/', import.meta.url));

const SUPABASE_STUB = `
  CREATE ROLE anon NOLOGIN;
  CREATE ROLE authenticated NOLOGIN;
  CREATE ROLE service_role NOLOGIN BYPASSRLS;

  CREATE SCHEMA auth;
  CREATE TABLE auth.users (
    id uuid PRIMARY KEY,
    email text,
    raw_user_meta_data jsonb DEFAULT '{}'::jsonb
  );

  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
    SELECT COALESCE(
      NULLIF(current_setting('request.jwt.claim.sub', true), ''),
      (NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
    )::uuid
  $$;

  GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
  GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated, service_role;
  GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

  -- Mesmo comportamento do Supabase: tudo que for criado em public é concedido
  -- a anon/authenticated; a proteção real vem do RLS e de REVOKEs explícitos.
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES    TO anon, authenticated, service_role;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
`;

export type Role = 'coordinator' | 'leader';

export interface TestDb {
  db: PGlite;
  createUser: (name: string, role: Role) => Promise<string>;
  as: <T>(userId: string | null, fn: () => Promise<T>) => Promise<T>;
  q: <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<T[]>;
}

export function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
}

export async function createTestDb(): Promise<TestDb> {
  const db = new PGlite();
  await db.exec(SUPABASE_STUB);
  for (const file of migrationFiles()) {
    try {
      await db.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'));
    } catch (err) {
      throw new Error(`Falha ao aplicar ${file}: ${(err as Error).message}`);
    }
  }

  const q = async <T,>(sql: string, params: unknown[] = []) =>
    (await db.query<T>(sql, params)).rows;

  const createUser = async (name: string, role: Role) => {
    const id = crypto.randomUUID();
    await db.query(
      `INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES ($1, $2, jsonb_build_object('full_name', $3::text))`,
      [id, `${id}@teste.local`, name],
    );
    await db.query(`UPDATE public.user_roles SET role = $2 WHERE user_id = $1`, [id, role]);
    return id;
  };

  // Executa fn como um usuário autenticado (ou anon quando userId = null)
  const as = async <T,>(userId: string | null, fn: () => Promise<T>) => {
    await db.exec(`RESET ROLE`);
    await db.query(`SELECT set_config('request.jwt.claim.sub', $1, false)`, [userId ?? '']);
    await db.exec(userId ? `SET ROLE authenticated` : `SET ROLE anon`);
    try {
      return await fn();
    } finally {
      await db.exec(`RESET ROLE`);
      await db.query(`SELECT set_config('request.jwt.claim.sub', '', false)`);
    }
  };

  return { db, createUser, as, q };
}
