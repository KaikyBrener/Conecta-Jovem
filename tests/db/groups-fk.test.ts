import { beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './harness';

// Regressão do bug: "Could not find a relationship between 'groups' and
// 'leader_id' in the schema cache" (PostgREST). A causa era a FK de
// groups.leader_id apontar para auth.users (schema não exposto ao PostgREST)
// em vez de public.profiles. Estes testes validam exatamente o que o
// PostgREST introspecta para resolver o embed `profiles:leader_id(...)`.

let t: TestDb;

beforeAll(async () => {
  t = await createTestDb();
}, 60_000);

describe('FK groups.leader_id -> public.profiles (migration 007)', () => {
  it('existe exatamente uma FK em groups.leader_id, apontando para public.profiles(id)', async () => {
    const rows = await t.q<{ target_schema: string; target_table: string; target_column: string }>(`
      SELECT
        tns.nspname AS target_schema,
        trel.relname AS target_table,
        tatt.attname AS target_column
      FROM pg_constraint con
      JOIN pg_class rel   ON rel.oid = con.conrelid
      JOIN pg_namespace n ON n.oid = rel.relnamespace
      JOIN pg_class trel  ON trel.oid = con.confrelid
      JOIN pg_namespace tns ON tns.oid = trel.relnamespace
      JOIN pg_attribute tatt ON tatt.attrelid = trel.oid AND tatt.attnum = con.confkey[1]
      WHERE n.nspname = 'public'
        AND rel.relname = 'groups'
        AND con.contype = 'f'
        AND con.conkey = (
          SELECT array_agg(attnum ORDER BY attnum)
          FROM pg_attribute
          WHERE attrelid = rel.oid AND attname = 'leader_id'
        )
    `);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ target_schema: 'public', target_table: 'profiles', target_column: 'id' });
  });

  it('nenhuma FK de groups.leader_id aponta mais para auth.users', async () => {
    const rows = await t.q(`
      SELECT 1
      FROM pg_constraint con
      JOIN pg_class rel   ON rel.oid = con.conrelid
      JOIN pg_namespace n ON n.oid = rel.relnamespace
      JOIN pg_class trel  ON trel.oid = con.confrelid
      JOIN pg_namespace tns ON tns.oid = trel.relnamespace
      WHERE n.nspname = 'public' AND rel.relname = 'groups' AND con.contype = 'f'
        AND tns.nspname = 'auth' AND trel.relname = 'users'
        AND con.conkey = (
          SELECT array_agg(attnum ORDER BY attnum)
          FROM pg_attribute WHERE attrelid = rel.oid AND attname = 'leader_id'
        )
    `);
    expect(rows).toHaveLength(0);
  });

  it('a query do app (embed profiles:leader_id) retorna o nome do líder', async () => {
    const coord = await t.createUser('Coordenadora', 'coordinator');
    const leader = await t.createUser('Líder Teste', 'leader');
    const [{ id: groupId }] = await t.q<{ id: string }>(
      `INSERT INTO public.groups (name, leader_id) VALUES ('Grupo Teste', $1) RETURNING id`, [leader]);

    // Mesmo shape de select usado em useGroups.ts, resolvido via SQL equivalente
    // ao embed (join pela FK): confirma que o dado está correto e acessível.
    const rows = await t.as(coord, () =>
      t.q<{ id: string; leader_name: string }>(
        `SELECT g.id, p.full_name AS leader_name
         FROM public.groups g
         LEFT JOIN public.profiles p ON p.id = g.leader_id
         WHERE g.id = $1`,
        [groupId],
      ));
    expect(rows[0].leader_name).toBe('Líder Teste');
  });

  it('remover o líder (leader_id = NULL) funciona para o coordenador', async () => {
    const coord = await t.createUser('Coordenadora2', 'coordinator');
    const leader = await t.createUser('Líder Removível', 'leader');
    const [{ id: groupId }] = await t.q<{ id: string }>(
      `INSERT INTO public.groups (name, leader_id) VALUES ('Grupo Sem Líder', $1) RETURNING id`, [leader]);

    const updated = await t.as(coord, () =>
      t.q<{ leader_id: string | null }>(
        `UPDATE public.groups SET leader_id = NULL WHERE id = $1 RETURNING leader_id`, [groupId]));
    expect(updated[0].leader_id).toBeNull();
  });
});
