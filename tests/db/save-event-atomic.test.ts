import { beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './harness';

// Migration 009: salvar encontro + grupos vinculados é uma única transação (RPC save_event).
// Antes, o frontend fazia UPDATE events → DELETE event_groups → INSERT event_groups em chamadas
// separadas; se o INSERT falhasse, o encontro ficava sem grupos.

let t: TestDb;
let coord: string, leader: string;
let g1: string, g2: string, g3: string;
const MISSING_GROUP = '00000000-0000-4000-8000-000000000001';

const pgArray = (ids: (string | null)[]) => `{${ids.map((i) => (i === null ? 'NULL' : i)).join(',')}}`;

interface SaveArgs {
  id?: string | null;
  title?: string | null;
  description?: string | null;
  date?: string | null;
  status?: string | null;
  groups?: (string | null)[] | null;
}

/** Chama a RPC como `user` (mesmo caminho do PostgREST: papel authenticated + claims). */
function saveEvent(user: string | null, a: SaveArgs) {
  return t.as(user, () =>
    t.q<{ id: string; title: string; description: string | null; status: string; created_by: string }>(
      `SELECT * FROM public.save_event($1::uuid, $2, $3, $4::timestamptz, $5::event_status, $6::uuid[])`,
      [
        a.id ?? null,
        a.title === undefined ? 'Culto' : a.title,
        a.description === undefined ? null : a.description,
        a.date === undefined ? '2030-01-10T19:00:00Z' : a.date,
        a.status === undefined ? 'scheduled' : a.status,
        a.groups === null || a.groups === undefined ? null : pgArray(a.groups),
      ],
    ),
  );
}

async function linkedGroups(eventId: string): Promise<string[]> {
  const rows = await t.q<{ group_id: string }>(
    `SELECT group_id FROM public.event_groups WHERE event_id = $1 ORDER BY group_id`, [eventId]);
  return rows.map((r) => r.group_id);
}

async function seedEvent(groups: string[], title = 'Original'): Promise<string> {
  const [ev] = await t.q<{ id: string }>(
    `INSERT INTO public.events (title, description, event_date, status, created_by)
     VALUES ($1, 'descrição original', '2030-02-01T19:00:00Z', 'scheduled', $2) RETURNING id`, [title, coord]);
  for (const g of groups) {
    await t.q(`INSERT INTO public.event_groups (event_id, group_id) VALUES ($1, $2)`, [ev.id, g]);
  }
  return ev.id;
}

const sorted = (ids: string[]) => [...ids].sort();

beforeAll(async () => {
  t = await createTestDb();
  coord = await t.createUser('Coordenadora', 'coordinator');
  leader = await t.createUser('Líder', 'leader');
  const mk = async (name: string, owner: string) =>
    (await t.q<{ id: string }>(
      `INSERT INTO public.groups (name, leader_id) VALUES ($1, $2) RETURNING id`, [name, owner]))[0].id;
  g1 = await mk('Grupo 1', leader);
  g2 = await mk('Grupo 2', coord);
  g3 = await mk('Grupo 3', coord);
}, 60_000);

describe('o problema original (fluxo antigo, passos separados)', () => {
  it('REPRODUZ: DELETE dos vínculos + INSERT inválido deixa o encontro sem grupos', async () => {
    const ev = await seedEvent([g1, g2]);

    // exatamente o que useEvents fazia: cada chamada do PostgREST é um commit próprio
    await t.as(coord, () => t.q(`DELETE FROM public.event_groups WHERE event_id = $1`, [ev]));
    await expect(
      t.as(coord, () =>
        t.q(`INSERT INTO public.event_groups (event_id, group_id) VALUES ($1, $2)`, [ev, MISSING_GROUP])),
    ).rejects.toThrow(/foreign key/i);

    expect(await linkedGroups(ev)).toEqual([]); // estado corrompido: perdeu g1 e g2
  });
});

describe('save_event — atomicidade', () => {
  it('editar com um grupo inválido NÃO altera nada: título e vínculos permanecem', async () => {
    const ev = await seedEvent([g1, g2]);

    await expect(saveEvent(coord, { id: ev, title: 'Novo título', groups: [g3, MISSING_GROUP] }))
      .rejects.toThrow(/foreign key/i);

    const [row] = await t.q<{ title: string }>(`SELECT title FROM public.events WHERE id = $1`, [ev]);
    expect(row.title).toBe('Original'); // o UPDATE do encontro também foi desfeito
    expect(await linkedGroups(ev)).toEqual(sorted([g1, g2])); // vínculos antigos intactos
  });

  it('criar com um grupo inválido NÃO cria o encontro', async () => {
    const before = await t.q(`SELECT 1 FROM public.events`);

    await expect(saveEvent(coord, { title: 'Fantasma', groups: [g1, MISSING_GROUP] }))
      .rejects.toThrow(/foreign key/i);

    expect(await t.q(`SELECT 1 FROM public.events`)).toHaveLength(before.length);
    expect(await t.q(`SELECT 1 FROM public.events WHERE title = 'Fantasma'`)).toHaveLength(0);
  });

  it('encontro inexistente: erro claro e nenhum vínculo é tocado', async () => {
    const other = await seedEvent([g1]);

    await expect(saveEvent(coord, { id: MISSING_GROUP, groups: [g2] }))
      .rejects.toThrow(/não encontrado ou sem permissão/i);

    expect(await linkedGroups(other)).toEqual([g1]);
  });
});

describe('save_event — comportamento funcional', () => {
  it('cria o encontro com os grupos, registrando o autor', async () => {
    const [ev] = await saveEvent(coord, { title: 'Culto de Jovens', description: 'Noite de louvor', groups: [g1, g2] });

    expect(ev).toMatchObject({ title: 'Culto de Jovens', description: 'Noite de louvor', status: 'scheduled', created_by: coord });
    expect(await linkedGroups(ev.id)).toEqual(sorted([g1, g2]));
  });

  it('editar substitui o conjunto de grupos (remove, mantém e adiciona)', async () => {
    const ev = await seedEvent([g1, g2]);

    const [saved] = await saveEvent(coord, { id: ev, title: 'Editado', status: 'completed', groups: [g2, g3] });

    expect(saved).toMatchObject({ id: ev, title: 'Editado', status: 'completed' });
    expect(await linkedGroups(ev)).toEqual(sorted([g2, g3]));
  });

  it('lista vazia (ou nula) remove todos os vínculos', async () => {
    const a = await seedEvent([g1, g2]);
    const b = await seedEvent([g1]);

    await saveEvent(coord, { id: a, groups: [] });
    await saveEvent(coord, { id: b, groups: null });

    expect(await linkedGroups(a)).toEqual([]);
    expect(await linkedGroups(b)).toEqual([]);
  });

  it('ignora grupos repetidos e nulos na lista', async () => {
    const [ev] = await saveEvent(coord, { title: 'Dedup', groups: [g1, g1, null, g2] });
    expect(await linkedGroups(ev.id)).toEqual(sorted([g1, g2]));
  });

  it('descrição nula limpa; título/data/status nulos mantêm o valor atual', async () => {
    const ev = await seedEvent([g1]);

    const [saved] = await saveEvent(coord, { id: ev, title: null, description: null, date: null, status: null, groups: [g1] });

    expect(saved.title).toBe('Original');
    expect(saved.description).toBeNull();
    expect(saved.status).toBe('scheduled');
    const [row] = await t.q<{ d: string }>(`SELECT event_date::text AS d FROM public.events WHERE id = $1`, [ev]);
    expect(row.d).toContain('2030-02-01');
  });

  it('salvar de novo com o mesmo conjunto é idempotente', async () => {
    const ev = await seedEvent([g1, g2]);
    await saveEvent(coord, { id: ev, groups: [g1, g2] });
    await saveEvent(coord, { id: ev, groups: [g1, g2] });
    expect(await linkedGroups(ev)).toEqual(sorted([g1, g2]));
  });

  it('mudar o status via save_event continua acionando os triggers de alerta do banco', async () => {
    // smoke: o trigger de events (status/data) roda dentro da mesma transação sem erro
    const ev = await seedEvent([g1]);
    await expect(saveEvent(coord, { id: ev, status: 'cancelled', groups: [g1] })).resolves.toHaveLength(1);
  });
});

describe('save_event — RLS e grants preservados', () => {
  it('líder não consegue criar encontro (RLS), e nada é criado', async () => {
    await expect(saveEvent(leader, { title: 'Hack', groups: [g1] })).rejects.toThrow(/row-level security/);
    expect(await t.q(`SELECT 1 FROM public.events WHERE title = 'Hack'`)).toHaveLength(0);
  });

  it('líder não consegue editar encontro do próprio grupo nem mexer nos vínculos', async () => {
    const ev = await seedEvent([g1, g2]);

    await expect(saveEvent(leader, { id: ev, title: 'hackeado', groups: [g1] }))
      .rejects.toThrow(/não encontrado ou sem permissão/i);

    const [row] = await t.q<{ title: string }>(`SELECT title FROM public.events WHERE id = $1`, [ev]);
    expect(row.title).toBe('Original');
    expect(await linkedGroups(ev)).toEqual(sorted([g1, g2]));
  });

  it('anon não executa a função (bloqueado por GRANT, antes de qualquer lógica)', async () => {
    await expect(saveEvent(null, { title: 'Anon', groups: [g1] })).rejects.toThrow(/permission denied/i);
  });

  it('a função é SECURITY INVOKER (não escala privilégios) e só authenticated tem EXECUTE', async () => {
    const [fn] = await t.q<{ definer: boolean; anon: boolean; authed: boolean; public_: boolean }>(
      `SELECT p.prosecdef AS definer,
              has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
              has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authed,
              has_function_privilege('public', p.oid, 'EXECUTE') AS public_
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = 'save_event'`);
    expect(fn).toEqual({ definer: false, anon: false, authed: true, public_: false });
  });

  it('as policies de events/event_groups não foram alteradas (continua sem INSERT direto para líder)', async () => {
    const ev = await seedEvent([]);
    await expect(t.as(leader, () =>
      t.q(`INSERT INTO public.event_groups (event_id, group_id) VALUES ($1, $2)`, [ev, g1]),
    )).rejects.toThrow(/row-level security/);
  });
});
