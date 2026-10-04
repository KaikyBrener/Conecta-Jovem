import { beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './harness';

// Migration 014 (parte B): encontros recorrentes — event_series, create_event_series, set_series_groups,
// extend_event_series, cancel_event_series_future. Fuso America/Sao_Paulo; chave (series_id, series_date).

let t: TestDb;
let coord: string, leader: string, leader2: string;
let g1: string, g2: string, g3: string;

const pgArray = (ids: string[]) => `{${ids.join(',')}}`;

interface CreateArgs {
  name?: string | null;
  weekday?: number | null;
  time?: string | null;
  rec?: string | null;
  start?: string | null;
  end?: string | null;
  desc?: string | null;
  groups?: string[] | null;
}
interface Created { series_id: string; created: number; skipped: number }

function create(user: string | null, a: CreateArgs = {}) {
  const d = <T,>(v: T | null | undefined, def: T) => (v === undefined ? def : v);
  return t.as(user, async () =>
    (await t.q<{ r: Created }>(
      `SELECT public.create_event_series($1, $2::int, $3::time, $4, $5::date, $6::date, $7, $8::uuid[]) AS r`,
      [d(a.name, 'Culto de jovens'), d(a.weekday, 0), d(a.time, '19:30'), d(a.rec, 'weekly'),
        d(a.start, '2030-01-01'), d(a.end, '2030-02-03'), d(a.desc, 'Culto semanal'),
        a.groups === null ? null : pgArray(a.groups ?? [])],
    ))[0].r);
}

const seriesDates = async (series: string) =>
  (await t.q<{ d: string }>(
    `SELECT series_date::text AS d FROM public.events WHERE series_id = $1 ORDER BY series_date`, [series]))
    .map((r) => r.d);

const linked = async (event: string) =>
  (await t.q<{ group_id: string }>(
    `SELECT group_id FROM public.event_groups WHERE event_id = $1 ORDER BY group_id`, [event])).map((r) => r.group_id).sort();

const eventsOf = (series: string) =>
  t.q<{ id: string; series_date: string; status: string; customized: boolean }>(
    `SELECT id, series_date::text, status::text, series_customized AS customized
       FROM public.events WHERE series_id = $1 ORDER BY series_date`, [series]);

const setGroups = (user: string | null, series: string, groups: string[], from?: string) =>
  t.as(user, async () =>
    (await t.q<{ r: { series_id: string; updated: number; skipped: number } }>(
      from === undefined
        ? `SELECT public.set_series_groups($1::uuid, $2::uuid[]) AS r`
        : `SELECT public.set_series_groups($1::uuid, $2::uuid[], $3::date) AS r`,
      from === undefined ? [series, pgArray(groups)] : [series, pgArray(groups), from]))[0].r);

const extend = (user: string | null, series: string, end: string | null) =>
  t.as(user, async () =>
    (await t.q<{ r: Created }>(`SELECT public.extend_event_series($1::uuid, $2::date) AS r`, [series, end]))[0].r);

const cancelFuture = (user: string | null, series: string) =>
  t.as(user, async () =>
    (await t.q<{ r: { series_id: string; cancelled: number; skipped: number } }>(
      `SELECT public.cancel_event_series_future($1::uuid) AS r`, [series]))[0].r);

const saveEvent = (user: string, id: string, patch: { title?: string; groups?: string[] }) =>
  t.as(user, async () => {
    const [e] = await t.q<{ title: string; description: string | null; event_date: string; status: string }>(
      `SELECT title, description, event_date::text, status::text FROM public.events WHERE id = $1`, [id]);
    const cur = await linked(id);
    return t.q(
      `SELECT * FROM public.save_event($1::uuid, $2, $3, $4::timestamptz, $5::event_status, $6::uuid[])`,
      [id, patch.title ?? e.title, e.description, e.event_date, e.status, pgArray(patch.groups ?? cur)]);
  });

let seqYouth = 0;
async function mkYouth(group: string | null): Promise<string> {
  seqYouth += 1;
  return (await t.q<{ id: string }>(
    `INSERT INTO public.youth (full_name, group_id, created_by) VALUES ($1, $2, $3) RETURNING id`,
    [`Jovem S${seqYouth}`, group, coord]))[0].id;
}

beforeAll(async () => {
  t = await createTestDb();
  coord = await t.createUser('Coordenadora', 'coordinator');
  leader = await t.createUser('Líder 1', 'leader');
  leader2 = await t.createUser('Líder 2', 'leader');
  const mk = async (name: string, owner: string) =>
    (await t.q<{ id: string }>(`INSERT INTO public.groups (name, leader_id) VALUES ($1, $2) RETURNING id`, [name, owner]))[0].id;
  g1 = await mk('Grupo 1', leader);
  g2 = await mk('Grupo 2', leader2);
  g3 = await mk('Grupo 3', coord);
}, 60_000);

describe('geração', () => {
  it('semanal: todas as semanas dentro do período, no horário local, status scheduled', async () => {
    const r = await create(coord, { start: '2030-01-01', end: '2030-02-03' });
    expect(r).toMatchObject({ created: 5, skipped: 0 });
    expect(Object.keys(r).sort()).toEqual(['created', 'series_id', 'skipped']);
    expect(await seriesDates(r.series_id)).toEqual(
      ['2030-01-06', '2030-01-13', '2030-01-20', '2030-01-27', '2030-02-03']);

    const evs = await t.q<{ title: string; description: string; status: string; local: string; dow: number; by: string }>(
      `SELECT title, description, status::text, to_char(event_date AT TIME ZONE 'America/Sao_Paulo', 'HH24:MI') AS local,
              extract(dow FROM event_date AT TIME ZONE 'America/Sao_Paulo')::int AS dow, created_by AS by
         FROM public.events WHERE series_id = $1`, [r.series_id]);
    expect(evs).toHaveLength(5);
    for (const e of evs) {
      expect(e).toMatchObject({ title: 'Culto de jovens', description: 'Culto semanal', status: 'scheduled',
        local: '19:30', dow: 0, by: coord });
    }
    const [s] = await t.q(`SELECT name, weekday, recurrence, start_date::text AS sd, end_date::text AS ed, active, created_by
                             FROM public.event_series WHERE id = $1`, [r.series_id]);
    expect(s).toEqual({ name: 'Culto de jovens', weekday: 0, recurrence: 'weekly', sd: '2030-01-01', ed: '2030-02-03',
      active: true, created_by: coord });
  });

  it('quinzenal: a cada 14 dias a partir da primeira ocorrência', async () => {
    const r = await create(coord, { rec: 'biweekly', start: '2030-01-01', end: '2030-02-03' });
    expect(r.created).toBe(3);
    expect(await seriesDates(r.series_id)).toEqual(['2030-01-06', '2030-01-20', '2030-02-03']);
  });

  it('mensal (N-ésimo dia da semana): N derivado da primeira ocorrência', async () => {
    // 12/01/2030 é o 2º sábado
    const r = await create(coord, { rec: 'monthly_nth_weekday', weekday: 6, start: '2030-01-12', end: '2030-04-30' });
    expect(await seriesDates(r.series_id)).toEqual(['2030-01-12', '2030-02-09', '2030-03-09', '2030-04-13']);
  });

  it('mensal com 5º dia da semana => sempre o último do mês', async () => {
    // 30/03/2030 é o 5º sábado de março
    const r = await create(coord, { rec: 'monthly_nth_weekday', weekday: 6, start: '2030-03-30', end: '2030-05-31' });
    expect(await seriesDates(r.series_id)).toEqual(['2030-03-30', '2030-04-27', '2030-05-25']);
  });

  it('início no próprio dia da semana conta a data inicial; fim inclusivo; início fora do dia avança', async () => {
    const r1 = await create(coord, { start: '2030-01-06', end: '2030-01-06' });
    expect(await seriesDates(r1.series_id)).toEqual(['2030-01-06']);
    const r2 = await create(coord, { start: '2030-01-07', end: '2030-01-14' }); // segunda..segunda => domingo 13
    expect(await seriesDates(r2.series_id)).toEqual(['2030-01-13']);
  });

  it('horário em 22h local cai no dia seguinte em UTC, mas a data da ocorrência é a LOCAL', async () => {
    const r = await create(coord, { time: '22:00', start: '2030-01-01', end: '2030-01-14' });
    const rows = await t.q<{ sd: string; utc_date: string; local: string; dow: number }>(
      `SELECT series_date::text AS sd, (event_date AT TIME ZONE 'UTC')::date::text AS utc_date,
              to_char(event_date AT TIME ZONE 'America/Sao_Paulo', 'HH24:MI') AS local,
              extract(dow FROM event_date AT TIME ZONE 'America/Sao_Paulo')::int AS dow
         FROM public.events WHERE series_id = $1 ORDER BY series_date`, [r.series_id]);
    expect(rows.map((x) => x.sd)).toEqual(['2030-01-06', '2030-01-13']);
    expect(rows.map((x) => x.utc_date)).toEqual(['2030-01-07', '2030-01-14']); // UTC já é segunda
    expect(rows.every((x) => x.local === '22:00' && x.dow === 0)).toBe(true);
  });

  it('DST (Brasil 2018/2019): horário local e data da ocorrência se mantêm na virada do horário de verão', async () => {
    // 04/11/2018 (domingo): o relógio pulou de 00:00 para 01:00 -> 00:30 não existe nesse dia
    const a = await create(coord, { time: '00:30', start: '2018-10-28', end: '2018-11-11' });
    expect(a.created).toBe(3);
    const rowsA = await t.q<{ sd: string; local_date: string }>(
      `SELECT series_date::text AS sd, (event_date AT TIME ZONE 'America/Sao_Paulo')::date::text AS local_date
         FROM public.events WHERE series_id = $1 ORDER BY series_date`, [a.series_id]);
    expect(rowsA.map((x) => x.sd)).toEqual(['2018-10-28', '2018-11-04', '2018-11-11']);
    expect(rowsA.every((x) => x.sd === x.local_date)).toBe(true);

    // 16-17/02/2019: fim do horário de verão (23:30 de sábado) — offset muda de -02 para -03
    const b = await create(coord, { time: '23:30', weekday: 6, start: '2019-02-02', end: '2019-02-23' });
    const rowsB = await t.q<{ sd: string; local: string; local_date: string; utc_hour: number }>(
      `SELECT series_date::text AS sd, to_char(event_date AT TIME ZONE 'America/Sao_Paulo', 'HH24:MI') AS local,
              (event_date AT TIME ZONE 'America/Sao_Paulo')::date::text AS local_date,
              extract(hour FROM event_date AT TIME ZONE 'UTC')::int AS utc_hour
         FROM public.events WHERE series_id = $1 ORDER BY series_date`, [b.series_id]);
    expect(rowsB.map((x) => x.sd)).toEqual(['2019-02-02', '2019-02-09', '2019-02-16', '2019-02-23']);
    expect(rowsB.every((x) => x.local === '23:30' && x.sd === x.local_date)).toBe(true);
    // antes da virada 23:30 local = 01:30 UTC (offset -02); depois = 02:30 UTC (offset -03)
    expect(rowsB.map((x) => x.utc_hour)).toEqual([1, 1, expect.any(Number), 2]);
  });
});

describe('duplicidade e extensão', () => {
  it('chave (series_id, data local): não é possível ter dois encontros da série na mesma data local', async () => {
    const r = await create(coord, { start: '2030-03-03', end: '2030-03-10' }); // domingos 03 e 10
    await expect(t.q(
      `INSERT INTO public.events (title, event_date, created_by, series_id, series_date)
       VALUES ('dup', '2030-03-03T20:00:00Z', $1, $2, '2030-03-03')`, [coord, r.series_id])).rejects.toThrow(/duplicate key|unique/i);
    // sem series_date: derivado da data LOCAL (03/03 23:30 local = 04/03 02:30 UTC)
    await expect(t.q(
      `INSERT INTO public.events (title, event_date, created_by, series_id)
       VALUES ('dup2', '2030-03-04T02:30:00Z', $1, $2)`, [coord, r.series_id])).rejects.toThrow(/duplicate key|unique/i);
    expect(await seriesDates(r.series_id)).toEqual(['2030-03-03', '2030-03-10']);
  });

  it('extend_event_series é idempotente e só gera datas posteriores à data final atual', async () => {
    const r = await create(coord, { start: '2030-04-01', end: '2030-04-14', groups: [g1] }); // 07 e 14
    expect(r.created).toBe(2);

    const e1 = await extend(coord, r.series_id, '2030-04-28');
    expect(e1).toEqual({ series_id: r.series_id, created: 2, skipped: 0 });
    expect(await seriesDates(r.series_id)).toEqual(['2030-04-07', '2030-04-14', '2030-04-21', '2030-04-28']);

    const e2 = await extend(coord, r.series_id, '2030-04-28'); // repetir: nada a fazer
    expect(e2).toEqual({ series_id: r.series_id, created: 0, skipped: 0 });
    expect(await seriesDates(r.series_id)).toHaveLength(4);

    const [s] = await t.q(`SELECT end_date::text AS ed FROM public.event_series WHERE id = $1`, [r.series_id]);
    expect(s).toEqual({ ed: '2030-04-28' });

    // encontros novos herdam os grupos padrão da série
    const evs = await eventsOf(r.series_id);
    for (const e of evs) expect(await linked(e.id)).toEqual([g1]);
  });

  it('extensão não recria ocorrência excluída no período antigo', async () => {
    const r = await create(coord, { start: '2030-05-05', end: '2030-05-19' }); // 05, 12, 19
    const evs = await eventsOf(r.series_id);
    await t.as(coord, () => t.q(`DELETE FROM public.events WHERE id = $1`, [evs[1].id]));
    await extend(coord, r.series_id, '2030-06-02');
    expect(await seriesDates(r.series_id)).toEqual(['2030-05-05', '2030-05-19', '2030-05-26', '2030-06-02']);
  });

  it('extensão: validações (encurtar, passar de 2 anos, série encerrada, inexistente, papel)', async () => {
    const r = await create(coord, { start: '2030-07-01', end: '2030-07-14' });
    await expect(extend(coord, r.series_id, '2030-07-07')).rejects.toThrow(/anterior à data final atual/);
    await expect(extend(coord, r.series_id, null)).rejects.toThrow(/Informe a nova data final/);
    await expect(extend(coord, r.series_id, '2033-01-01')).rejects.toThrow(/2 anos/);
    await expect(extend(coord, crypto.randomUUID(), '2030-08-01')).rejects.toThrow(/Série não encontrada/);
    await expect(extend(leader, r.series_id, '2030-08-01')).rejects.toThrow(/Apenas coordenadores/);
    await expect(extend(null, r.series_id, '2030-08-01')).rejects.toThrow(/permission denied/);
    await cancelFuture(coord, r.series_id);
    await expect(extend(coord, r.series_id, '2030-08-01')).rejects.toThrow(/encerrada/);
  });
});

describe('validações (pt-BR) e permissões', () => {
  it('mensagens de validação', async () => {
    await expect(create(coord, { name: '   ' })).rejects.toThrow(/Informe o nome da série/);
    await expect(create(coord, { name: 'x'.repeat(121) })).rejects.toThrow(/120 caracteres/);
    await expect(create(coord, { weekday: 7 })).rejects.toThrow(/Dia da semana inválido/);
    await expect(create(coord, { weekday: -1 })).rejects.toThrow(/Dia da semana inválido/);
    await expect(create(coord, { weekday: null })).rejects.toThrow(/Dia da semana inválido/);
    await expect(create(coord, { time: null })).rejects.toThrow(/horário/);
    await expect(create(coord, { rec: 'daily' })).rejects.toThrow(/Recorrência inválida/);
    await expect(create(coord, { rec: null })).rejects.toThrow(/Recorrência inválida/);
    await expect(create(coord, { start: null })).rejects.toThrow(/data inicial e a data final/);
    await expect(create(coord, { end: null })).rejects.toThrow(/data inicial e a data final/);
    await expect(create(coord, { start: '2030-02-10', end: '2030-02-01' })).rejects.toThrow(/data final não pode ser anterior/);
    await expect(create(coord, { start: '2030-01-01', end: '2032-01-03' })).rejects.toThrow(/2 anos/); // 732 dias
    await expect(create(coord, { start: '2030-01-07', end: '2030-01-12' })).rejects.toThrow(/nenhuma data/);
    await expect(create(coord, { groups: [crypto.randomUUID()] })).rejects.toThrow(/grupos inexistentes/);
  });

  it('limite de 2 anos: 731 dias passa e gera no máximo 105 semanais (<= 120)', async () => {
    const r = await create(coord, { start: '2030-01-01', end: '2032-01-02' }); // 731 dias
    expect(r.created).toBeGreaterThan(100);
    expect(r.created).toBeLessThanOrEqual(120);
    const [{ n }] = await t.q<{ n: string }>(`SELECT count(*)::text AS n FROM public.events WHERE series_id = $1`, [r.series_id]);
    expect(Number(n)).toBe(r.created);
  });

  it('falha no meio não deixa nada para trás (atômico)', async () => {
    const before = await t.q<{ n: string }>(`SELECT (SELECT count(*) FROM public.event_series)::text AS n`);
    const evBefore = await t.q<{ n: string }>(`SELECT count(*)::text AS n FROM public.events`);
    await expect(create(coord, { groups: [g1, crypto.randomUUID()] })).rejects.toThrow(/grupos inexistentes/);
    expect(await t.q<{ n: string }>(`SELECT (SELECT count(*) FROM public.event_series)::text AS n`)).toEqual(before);
    expect(await t.q<{ n: string }>(`SELECT count(*)::text AS n FROM public.events`)).toEqual(evBefore);
  });

  it('líder não cria nem altera séries; anon não executa; sem escrita direta', async () => {
    await expect(create(leader)).rejects.toThrow(/Apenas coordenadores/);
    await expect(create(null)).rejects.toThrow(/permission denied/);
    const r = await create(coord, { start: '2030-09-01', end: '2030-09-08', groups: [g1] });
    await expect(setGroups(leader, r.series_id, [g1])).rejects.toThrow(/Apenas coordenadores/);
    await expect(cancelFuture(leader, r.series_id)).rejects.toThrow(/Apenas coordenadores/);
    await expect(t.as(null, () => t.q(`SELECT * FROM public.event_series`))).rejects.toThrow(/permission denied/);

    await expect(t.as(leader, () => t.q(
      `INSERT INTO public.event_series (name, weekday, start_time, recurrence, start_date, end_date)
       VALUES ('x', 0, '10:00', 'weekly', '2030-01-01', '2030-01-31')`))).rejects.toThrow(/row-level security/i);
    const upd = await t.as(leader, () => t.q(`UPDATE public.event_series SET name = 'hack' WHERE id = $1 RETURNING id`, [r.series_id]));
    expect(upd).toHaveLength(0);
    const del = await t.as(leader, () => t.q(`DELETE FROM public.event_series WHERE id = $1 RETURNING id`, [r.series_id]));
    expect(del).toHaveLength(0);
    await expect(t.as(leader, () => t.q(
      `INSERT INTO public.event_series_groups (series_id, group_id) VALUES ($1, $2)`, [r.series_id, g1]))).rejects.toThrow(/row-level security/i);
  });

  it('constraints da tabela (defesa em profundidade contra escrita direta do coordenador)', async () => {
    const ins = (cols: string) => t.as(coord, () => t.q(
      `INSERT INTO public.event_series (name, weekday, start_time, recurrence, start_date, end_date) VALUES ${cols}`));
    await expect(ins(`('x', 7, '10:00', 'weekly', '2030-01-01', '2030-01-31')`)).rejects.toThrow(/check/i);
    await expect(ins(`('x', 0, '10:00', 'daily', '2030-01-01', '2030-01-31')`)).rejects.toThrow(/check/i);
    await expect(ins(`('x', 0, '10:00', 'weekly', '2030-01-01', '2033-01-31')`)).rejects.toThrow(/check/i);
    await expect(ins(`('x', 0, '10:00', 'weekly', '2030-02-01', '2030-01-31')`)).rejects.toThrow(/check/i);
    await expect(ins(`(' ', 0, '10:00', 'weekly', '2030-01-01', '2030-01-31')`)).rejects.toThrow(/check/i);
  });
});

describe('grupos pendentes -> set_series_groups', () => {
  it('sem grupos: encontros ficam sem vínculo; chamada recusa; depois de definir os grupos funciona', async () => {
    const r = await create(coord, { start: '2031-01-01', end: '2031-01-31', groups: [] });
    const evs = await eventsOf(r.series_id);
    expect(evs.length).toBeGreaterThan(0);
    for (const e of evs) expect(await linked(e.id)).toEqual([]);

    const y = await mkYouth(g1);
    const entries = JSON.stringify([{ youth_id: y, present: true }]);
    // pendente: nenhum grupo no encontro => o jovem "não pertence a um grupo deste encontro"
    await expect(t.as(coord, () => t.q(`SELECT public.save_attendance($1::uuid, $2::jsonb)`, [evs[0].id, entries])))
      .rejects.toThrow(/não pertencem a um grupo deste encontro/);
    // líder nem enxerga encontro nem série pendentes
    expect(await t.as(leader, () => t.q(`SELECT id FROM public.events WHERE series_id = $1`, [r.series_id]))).toHaveLength(0);
    expect(await t.as(leader, () => t.q(`SELECT id FROM public.event_series WHERE id = $1`, [r.series_id]))).toHaveLength(0);

    const res = await setGroups(coord, r.series_id, [g1], '2031-01-01');
    expect(res).toEqual({ series_id: r.series_id, updated: evs.length, skipped: 0 });
    for (const e of evs) expect(await linked(e.id)).toEqual([g1]);

    // agora a chamada funciona, e o líder do grupo enxerga os encontros e a série
    const saved = await t.as(leader, async () =>
      (await t.q<{ r: { saved: number } }>(`SELECT public.save_attendance($1::uuid, $2::jsonb) AS r`, [evs[0].id, entries]))[0].r);
    expect(saved.saved).toBe(1);
    expect((await t.as(leader, () => t.q(`SELECT id FROM public.events WHERE series_id = $1`, [r.series_id]))).length).toBe(evs.length);
    expect(await t.as(leader, () => t.q(`SELECT id FROM public.event_series WHERE id = $1`, [r.series_id]))).toHaveLength(1);
    // outro líder não enxerga
    expect(await t.as(leader2, () => t.q(`SELECT id FROM public.event_series WHERE id = $1`, [r.series_id]))).toHaveLength(0);
  });

  it('substitui os grupos (remove os que saíram) e vira o padrão dos encontros gerados depois', async () => {
    const r = await create(coord, { start: '2031-02-01', end: '2031-02-14', groups: [g1, g2] });
    const evs = await eventsOf(r.series_id);
    await setGroups(coord, r.series_id, [g2, g3], '2031-01-01');
    for (const e of evs) expect(await linked(e.id)).toEqual([g2, g3].sort());
    await extend(coord, r.series_id, '2031-02-28');
    const all = await eventsOf(r.series_id);
    expect(all.length).toBeGreaterThan(evs.length);
    for (const e of all) expect(await linked(e.id)).toEqual([g2, g3].sort());
    // grupos vazios limpam tudo
    await setGroups(coord, r.series_id, [], '2031-01-01');
    for (const e of all) expect(await linked(e.id)).toEqual([]);
  });

  it('NÃO toca em passados, realizados, cancelados nem em encontros editados individualmente', async () => {
    const r = await create(coord, { start: '2031-03-02', end: '2031-04-06', groups: [g3] }); // 02,09,16,23,30/03 e 06/04
    const evs = await eventsOf(r.series_id);
    expect(evs.map((e) => e.series_date)).toEqual(
      ['2031-03-02', '2031-03-09', '2031-03-16', '2031-03-23', '2031-03-30', '2031-04-06']);
    const [past, completed, cancelled, editedTitle, editedGroups, normal] = evs;

    await t.q(`UPDATE public.events SET status = 'completed' WHERE id = $1`, [completed.id]);
    await t.q(`UPDATE public.events SET status = 'cancelled' WHERE id = $1`, [cancelled.id]);
    // edição individual pelo caminho do app (save_event, coordenador): título e grupos
    await saveEvent(coord, editedTitle.id, { title: 'Culto especial' });
    await saveEvent(coord, editedGroups.id, { groups: [g1] });

    const flags = await eventsOf(r.series_id);
    expect(flags.map((e) => e.customized)).toEqual([false, false, false, true, true, false]);

    // corte em 09/03: o primeiro (02/03) fica de fora por ser anterior ao corte
    const res = await setGroups(coord, r.series_id, [g2], '2031-03-09');
    // elegíveis: só 'normal' (06/04) e... o 'completed'/'cancelled' não; 'editados' são ignorados
    expect(res).toEqual({ series_id: r.series_id, updated: 1, skipped: 2 });

    expect(await linked(past.id)).toEqual([g3]);
    expect(await linked(completed.id)).toEqual([g3]);
    expect(await linked(cancelled.id)).toEqual([g3]);
    expect(await linked(editedTitle.id)).toEqual([g3]);
    expect(await linked(editedGroups.id)).toEqual([g1]);
    expect(await linked(normal.id)).toEqual([g2]);
    const [titleRow] = await t.q(`SELECT title FROM public.events WHERE id = $1`, [editedTitle.id]);
    expect(titleRow).toEqual({ title: 'Culto especial' });
  });

  it('p_from padrão = hoje: encontros passados da série não são tocados', async () => {
    const r = await create(coord, { start: '2018-03-04', end: '2018-03-18', groups: [g3] }); // todos no passado
    const res = await setGroups(coord, r.series_id, [g1]);
    expect(res).toMatchObject({ updated: 0, skipped: 0 });
    for (const e of await eventsOf(r.series_id)) expect(await linked(e.id)).toEqual([g3]);

    const f = await create(coord, { start: '2035-03-04', end: '2035-03-18', groups: [g3] }); // todos no futuro
    const res2 = await setGroups(coord, f.series_id, [g1]);
    expect(res2.updated).toBe(3);
  });

  it('validações de set_series_groups', async () => {
    const r = await create(coord, { start: '2031-05-04', end: '2031-05-11' });
    await expect(setGroups(coord, crypto.randomUUID(), [g1])).rejects.toThrow(/Série não encontrada/);
    await expect(setGroups(coord, r.series_id, [crypto.randomUUID()])).rejects.toThrow(/grupos inexistentes/);
    await expect(setGroups(null, r.series_id, [g1])).rejects.toThrow(/permission denied/);
  });
});

describe('edição individual, cancelamento e exclusão', () => {
  it('editar data de um encontro: marca como editado e mantém a vaga (series_date)', async () => {
    const r = await create(coord, { start: '2031-06-01', end: '2031-06-15', groups: [g3] }); // domingos: 01, 08 e 15
    const [e1] = await eventsOf(r.series_id);
    await t.as(coord, () => t.q(`UPDATE public.events SET event_date = event_date + interval '1 day' WHERE id = $1`, [e1.id]));
    const [row] = await t.q<{ sd: string; c: boolean }>(
      `SELECT series_date::text AS sd, series_customized AS c FROM public.events WHERE id = $1`, [e1.id]);
    expect(row).toEqual({ sd: e1.series_date, c: true });
    // a extensão não recria a vaga do encontro remarcado
    await extend(coord, r.series_id, '2031-06-22');
    const dates = await seriesDates(r.series_id);
    expect(dates).toEqual([...new Set(dates)]);
    expect(dates.filter((d) => d === e1.series_date)).toHaveLength(1);
  });

  it('cliente não consegue trocar series_date de um encontro de série', async () => {
    const r = await create(coord, { start: '2031-07-06', end: '2031-07-13' });
    const [e1] = await eventsOf(r.series_id);
    await t.as(coord, () => t.q(`UPDATE public.events SET series_date = '2031-12-25' WHERE id = $1`, [e1.id]));
    const [row] = await t.q<{ sd: string }>(`SELECT series_date::text AS sd FROM public.events WHERE id = $1`, [e1.id]);
    expect(row.sd).toBe(e1.series_date);
  });

  it('cancel_event_series_future: cancela futuros scheduled sem chamada; preserva passados, realizados e chamada', async () => {
    const y = await mkYouth(g3);
    // série totalmente no passado: nada a cancelar
    const past = await create(coord, { start: '2018-05-06', end: '2018-05-20', groups: [g3] });
    const pastRes = await cancelFuture(coord, past.series_id);
    expect(pastRes).toEqual({ series_id: past.series_id, cancelled: 0, skipped: 0 });

    const r = await create(coord, { start: '2036-01-01', end: '2036-02-03', groups: [g3] });
    const evs = await eventsOf(r.series_id);
    expect(evs.length).toBe(5);
    // um futuro já tem chamada; outro foi marcado como realizado
    await t.q(`INSERT INTO public.attendance (event_id, youth_id, group_id, present, recorded_by) VALUES ($1, $2, $3, true, $4)`,
      [evs[0].id, y, g3, coord]);
    await t.q(`UPDATE public.events SET status = 'completed' WHERE id = $1`, [evs[1].id]);

    const res = await cancelFuture(coord, r.series_id);
    expect(res).toEqual({ series_id: r.series_id, cancelled: 3, skipped: 1 });
    const after = await eventsOf(r.series_id);
    expect(after.map((e) => e.status)).toEqual(['scheduled', 'completed', 'cancelled', 'cancelled', 'cancelled']);
    // chamada preservada
    const [{ n }] = await t.q<{ n: string }>(`SELECT count(*)::text AS n FROM public.attendance WHERE event_id = $1`, [evs[0].id]);
    expect(Number(n)).toBe(1);
    const [s] = await t.q(`SELECT active FROM public.event_series WHERE id = $1`, [r.series_id]);
    expect(s).toEqual({ active: false });
    // repetir é inofensivo
    expect(await cancelFuture(coord, r.series_id)).toMatchObject({ cancelled: 0, skipped: 1 });
    await expect(cancelFuture(coord, crypto.randomUUID())).rejects.toThrow(/Série não encontrada/);
  });

  it('excluir encontro individual continua possível; excluir a série desvincula os encontros (SET NULL)', async () => {
    const r = await create(coord, { start: '2031-08-03', end: '2031-08-17' });
    const evs = await eventsOf(r.series_id);
    const del = await t.as(coord, () => t.q(`DELETE FROM public.events WHERE id = $1 RETURNING id`, [evs[0].id]));
    expect(del).toHaveLength(1);
    await t.as(coord, () => t.q(`DELETE FROM public.event_series WHERE id = $1`, [r.series_id]));
    const left = await t.q<{ series_id: string | null }>(
      `SELECT series_id FROM public.events WHERE id = ANY($1::uuid[])`, [pgArray(evs.slice(1).map((e) => e.id))]);
    expect(left).toHaveLength(2);
    expect(left.every((e) => e.series_id === null)).toBe(true);
  });
});

describe('histórico e grants', () => {
  it('create_event_series gera UMA entrada event_series_created, visível só ao coordenador', async () => {
    const r = await create(coord, { start: '2031-09-07', end: '2031-09-28' });
    const rows = await t.q<{ action: string; actor_id: string; entity_id: string; summary: string; meta: { created: number } }>(
      `SELECT action, actor_id, entity_id, summary, meta FROM public.activity_log WHERE entity_id = $1`, [r.series_id]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: 'event_series_created', actor_id: coord, summary: 'Série de encontros criada.' });
    expect(rows[0].meta.created).toBe(4);
    expect(await t.as(leader, () => t.q(`SELECT id FROM public.activity_log WHERE entity_id = $1`, [r.series_id]))).toHaveLength(0);
  });

  it('grants: RPCs só para authenticated (DEFINER com search_path); internas sem EXECUTE', async () => {
    const privs = await t.q<{ proname: string; anon: boolean; authed: boolean; definer: boolean; cfg: string | null }>(
      `SELECT p.proname, p.prosecdef AS definer, p.proconfig::text AS cfg,
              has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
              has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authed
         FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
          AND p.proname IN ('create_event_series', 'set_series_groups', 'extend_event_series', 'cancel_event_series_future',
                            'series_dates', 'events_series_guard', 'event_groups_series_customize')`);
    const by = Object.fromEntries(privs.map((p) => [p.proname, p]));
    for (const n of ['create_event_series', 'set_series_groups', 'extend_event_series', 'cancel_event_series_future']) {
      expect(by[n], n).toMatchObject({ anon: false, authed: true, definer: true });
      expect(by[n].cfg, n).toContain('search_path=public');
    }
    for (const n of ['series_dates', 'events_series_guard', 'event_groups_series_customize']) {
      expect(by[n], n).toMatchObject({ anon: false, authed: false });
    }
    await expect(t.as(coord, () => t.q(`SELECT * FROM public.series_dates(0, 'weekly', '2030-01-01', '2030-02-01')`)))
      .rejects.toThrow(/permission denied/);
  });
});
