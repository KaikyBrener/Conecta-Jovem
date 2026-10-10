import { beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './harness';

// Migration 020: create_event_series idempotente + bloqueio de exclusão de encontro com chamada registrada.

let t: TestDb;
let coord: string, leader: string;
let g1: string;

interface Created { series_id: string; created: number; skipped: number }

function create(user: string | null, over: { name?: string; start?: string; end?: string; weekday?: number } = {}) {
  return t.as(user, async () =>
    (await t.q<{ r: Created }>(
      `SELECT public.create_event_series($1, $2::int, $3::time, $4, $5::date, $6::date, $7, $8::uuid[]) AS r`,
      [over.name ?? 'Culto 020', over.weekday ?? 0, '19:30', 'weekly', over.start ?? '2032-01-04',
        over.end ?? '2032-01-25', 'Descrição', `{${g1}}`],
    ))[0].r);
}

const countSeries = async (name: string) =>
  Number((await t.q<{ n: string }>(`SELECT count(*)::text AS n FROM public.event_series WHERE name = $1`, [name]))[0].n);

beforeAll(async () => {
  t = await createTestDb();
  coord = await t.createUser('Coordenadora', 'coordinator');
  leader = await t.createUser('Líder', 'leader');
  g1 = (await t.q<{ id: string }>(
    `INSERT INTO public.groups (name, leader_id) VALUES ('Grupo 020', $1) RETURNING id`, [leader]))[0].id;
}, 60_000);

describe('migration 020: create_event_series idempotente', () => {
  it('a 2ª chamada idêntica falha e não duplica série nem encontros', async () => {
    const first = await create(coord, { name: 'Série idempotente' });
    expect(first.created).toBeGreaterThan(0);
    await expect(create(coord, { name: 'Série idempotente' })).rejects.toThrow(/Já existe uma série ativa/);
    expect(await countSeries('Série idempotente')).toBe(1);
    const [{ n }] = await t.q<{ n: string }>(`SELECT count(*)::text AS n FROM public.events WHERE series_id = $1`, [first.series_id]);
    expect(Number(n)).toBe(first.created);
  });

  it('muda qualquer parâmetro-chave (período, dia, nome): é outra série e é permitida', async () => {
    await create(coord, { name: 'Série variações' });
    await expect(create(coord, { name: 'Série variações', end: '2032-02-01' })).resolves.toMatchObject({ created: expect.any(Number) });
    await expect(create(coord, { name: 'Série variações', weekday: 6 })).resolves.toMatchObject({ created: expect.any(Number) });
    await expect(create(coord, { name: 'Série variações 2' })).resolves.toMatchObject({ created: expect.any(Number) });
    expect(await countSeries('Série variações')).toBe(3);
  });

  it('série encerrada (active = false) não bloqueia recriar os mesmos dados', async () => {
    const r = await create(coord, { name: 'Série encerrada' });
    await t.q(`UPDATE public.event_series SET active = false WHERE id = $1`, [r.series_id]);
    await expect(create(coord, { name: 'Série encerrada' })).resolves.toMatchObject({ created: expect.any(Number) });
  });

  it('continua exigindo coordenador e sessão', async () => {
    await expect(create(leader, { name: 'Líder não cria' })).rejects.toThrow(/Apenas coordenadores/);
    await expect(create(null, { name: 'Anônimo não cria' })).rejects.toThrow(/permission denied/); // anon sem EXECUTE (grants da 014 preservados)
  });
});

describe('migration 020: exclusão de encontro com chamada', () => {
  async function mkEvent(title: string): Promise<string> {
    return (await t.q<{ id: string }>(
      `INSERT INTO public.events (title, event_date, status, created_by)
       VALUES ($1, now(), 'completed', $2) RETURNING id`, [title, coord]))[0].id;
  }
  async function mkYouthIn(group: string): Promise<string> {
    return (await t.q<{ id: string }>(
      `INSERT INTO public.youth (full_name, group_id, created_by) VALUES ('Jovem 020', $1, $2) RETURNING id`, [group, coord]))[0].id;
  }

  it('encontro sem chamada continua excluível pelo coordenador', async () => {
    const ev = await mkEvent('Sem chamada');
    const del = await t.as(coord, () => t.q(`DELETE FROM public.events WHERE id = $1 RETURNING id`, [ev]));
    expect(del).toHaveLength(1);
  });

  it('encontro com chamada NÃO pode ser excluído (mesmo pelo coordenador) e a presença permanece', async () => {
    const ev = await mkEvent('Com chamada');
    await t.q(`INSERT INTO public.event_groups (event_id, group_id) VALUES ($1, $2)`, [ev, g1]);
    const y = await mkYouthIn(g1);
    await t.q(`INSERT INTO public.attendance (event_id, youth_id, group_id, present, recorded_by)
               VALUES ($1, $2, $3, true, $4)`, [ev, y, g1, coord]);

    await expect(t.as(coord, () => t.q(`DELETE FROM public.events WHERE id = $1`, [ev])))
      .rejects.toThrow(/já tem chamada registrada/);
    const [{ n }] = await t.q<{ n: string }>(`SELECT count(*)::text AS n FROM public.attendance WHERE event_id = $1`, [ev]);
    expect(Number(n)).toBe(1);

    // caminho correto: cancelar preserva o histórico
    await t.as(coord, () => t.q(`UPDATE public.events SET status = 'cancelled' WHERE id = $1`, [ev]));
    const [{ st }] = await t.q<{ st: string }>(`SELECT status::text AS st FROM public.events WHERE id = $1`, [ev]);
    expect(st).toBe('cancelled');
  });
});
