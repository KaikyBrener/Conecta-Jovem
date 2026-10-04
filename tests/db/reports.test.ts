import { beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './harness';

// Migration 013: relatórios agregados no servidor (report_general / attendance / followups / alerts / youth /
// groups). Escopo: coordenador tudo; líder só jovens do grupo ATUAL dele; anon nada.
//
// Dados de frequência usam datas ABSOLUTAS de março/2024 (fuso America/Sao_Paulo), períodos P = 01..15/03/2024.
// Alertas, ações e acompanhamentos "de agora" usam datas relativas a app_today() (janela W).
// Limitação do harness: relógio real, uma conexão lógica sequencial (sem concorrência real).

let t: TestDb;
let coord: string, leaderA: string, leaderB: string, leaderC: string, leaderE: string;
let g1: string, g2: string;
let y1: string, y2: string, y3: string, y4: string, z1: string, z2: string, n1: string;
let fuY1a: string; // acompanhamento de y1 em 05/03/2024 (responsável: coordenadora)

const P = { from: '2024-03-01', to: '2024-03-15' };

async function today(offset = 0): Promise<string> {
  return (await t.q<{ d: string }>(`SELECT (public.app_today() + $1::int)::text AS d`, [offset]))[0].d;
}

async function mkYouth(name: string, group: string | null, active = true): Promise<string> {
  const [y] = await t.q<{ id: string }>(
    `INSERT INTO public.youth (full_name, group_id, is_active, created_by) VALUES ($1, $2, $3, $4) RETURNING id`,
    [name, group, active, coord]);
  return y.id;
}

/** Encontro em data/hora LOCAL (America/Sao_Paulo) */
async function mkEvent(groups: string[], local: string, title: string, status = 'completed'): Promise<string> {
  const [ev] = await t.q<{ id: string }>(
    `INSERT INTO public.events (title, event_date, status, created_by)
     VALUES ($1, $2::timestamp AT TIME ZONE 'America/Sao_Paulo', $3::event_status, $4) RETURNING id`,
    [title, local, status, coord]);
  for (const g of groups) await t.q(`INSERT INTO public.event_groups (event_id, group_id) VALUES ($1, $2)`, [ev.id, g]);
  return ev.id;
}

async function rec(ev: string, youth: string, present: boolean) {
  await t.q(
    `INSERT INTO public.attendance (event_id, youth_id, group_id, present, recorded_by)
     SELECT $1, y.id, y.group_id, $3, NULL FROM public.youth y WHERE y.id = $2
     ON CONFLICT (event_id, youth_id) DO UPDATE SET present = EXCLUDED.present`,
    [ev, youth, present]);
}

async function addFu(youth: string, occurred: string, type: string, responsible: string,
                     nextDue: string | null = null, nextAction: string | null = null) {
  const [r] = await t.q<{ id: string }>(
    `INSERT INTO public.follow_ups (youth_id, reason, occurred_at, type, responsible_id, next_action_due, next_action)
     VALUES ($1, 'Conversa', $2::date, $3::follow_up_type, $4, $5::date, $6) RETURNING id`,
    [youth, occurred, type, responsible, nextDue, nextAction]);
  return r.id;
}

async function addTask(youth: string | null, due: string | null, status: string) {
  const [r] = await t.q<{ id: string }>(
    `INSERT INTO public.tasks (title, youth_id, due_date, status, created_by)
     VALUES ('Ação', $1, $2::date, $3::task_status, $4) RETURNING id`, [youth, due, status, coord]);
  return r.id;
}

type Rep = Record<string, any>;
const call = (user: string | null, sql: string, params: unknown[]) =>
  t.as(user, async () => (await t.q<{ r: Rep }>(sql, params))[0].r);
const general = (u: string | null, from: string, to: string, g: string | null = null) =>
  call(u, `SELECT public.report_general($1::date, $2::date, $3::uuid) AS r`, [from, to, g]);
const attendance = (u: string | null, from: string, to: string, g: string | null = null, min = 3) =>
  call(u, `SELECT public.report_attendance($1::date, $2::date, $3::uuid, $4::int) AS r`, [from, to, g, min]);
const followups = (u: string | null, from: string, to: string, g: string | null = null) =>
  call(u, `SELECT public.report_followups($1::date, $2::date, $3::uuid) AS r`, [from, to, g]);
const alerts = (u: string | null, from: string, to: string, g: string | null = null) =>
  call(u, `SELECT public.report_alerts($1::date, $2::date, $3::uuid) AS r`, [from, to, g]);
const youthRep = (u: string | null, y: string | null, from: string, to: string) =>
  call(u, `SELECT public.report_youth($1::uuid, $2::date, $3::date) AS r`, [y, from, to]);
const groupsRep = (u: string | null, from: string, to: string) =>
  call(u, `SELECT public.report_groups($1::date, $2::date) AS r`, [from, to]);

beforeAll(async () => {
  t = await createTestDb();
  // alerts_guard grava resolved_at com timezone('utc', now()) (timestamp sem fuso): no Supabase a sessão é UTC.
  await t.db.exec(`SET timezone = 'UTC'`);
  coord = await t.createUser('Coordenadora', 'coordinator');
  leaderA = await t.createUser('Líder A', 'leader');
  leaderB = await t.createUser('Líder B', 'leader');
  leaderC = await t.createUser('Líder C', 'leader');
  leaderE = await t.createUser('Líder E', 'leader');
  const mkGroup = async (name: string, leader: string) =>
    (await t.q<{ id: string }>(`INSERT INTO public.groups (name, leader_id) VALUES ($1, $2) RETURNING id`, [name, leader]))[0].id;
  g1 = await mkGroup('Grupo 1', leaderA);
  g2 = await mkGroup('Grupo 2', leaderB);
  await mkGroup('Grupo E', leaderE);

  y1 = await mkYouth('Ana Um', g1);
  y2 = await mkYouth('Bia Dois', g1);
  y3 = await mkYouth('Caio Três', g1);
  y4 = await mkYouth('Davi Inativo', g1, false);
  z1 = await mkYouth('Eva Zeta', g2);
  z2 = await mkYouth('Fábio Zeta', g2);
  n1 = await mkYouth('Gil Sem Grupo', g2); // vai ficar sem grupo depois de registrar presença (attendance.group_id é NOT NULL)

  const eStart = await mkEvent([g1], '2024-03-01 00:00:00', 'E-start');
  const eMid = await mkEvent([g1, g2], '2024-03-10 19:00:00', 'E-mid');
  const eEnd = await mkEvent([g1], '2024-03-15 23:59:59', 'E-end');
  const eAfter = await mkEvent([g1], '2024-03-16 00:00:00', 'E-after');
  const eBefore = await mkEvent([g1], '2024-02-29 23:59:59', 'E-before');
  const eCancel = await mkEvent([g1], '2024-03-12 12:00:00', 'E-cancel', 'cancelled');
  await mkEvent([g1], '2024-03-13 12:00:00', 'E-vazio');

  await rec(eBefore, y1, false);
  await rec(eStart, y1, true);  await rec(eStart, y2, false); await rec(eStart, y3, true);
  await rec(eStart, y4, false);                               // inativo: fora de toda conta
  await rec(eMid, y1, false);   await rec(eMid, y2, false);   await rec(eMid, y3, true);
  await rec(eMid, z1, true);    await rec(eMid, z2, false);   await rec(eMid, n1, true);
  await t.q(`UPDATE public.youth SET group_id = NULL WHERE id = $1`, [n1]);
  await rec(eEnd, y1, false);   await rec(eEnd, y3, true);    // y2 não registrado em E-end
  await rec(eAfter, y1, false);
  await rec(eCancel, y1, false); await rec(eCancel, y2, false); // cancelado: ignorado

  // Acompanhamentos em março/2024
  fuY1a = await addFu(y1, '2024-03-05', 'conversation', coord);
  await addFu(y1, '2024-03-14', 'call', leaderA);
  await addFu(z1, '2024-03-10', 'in_person', leaderB);
  await addFu(y4, '2024-03-02', 'other', coord);
  await addFu(y1, '2024-03-16', 'guidance', coord);   // fora do período
  await addFu(y1, '2024-02-29', 'return', coord);     // fora do período
  // Próximas ações (relativas a hoje). Os acompanhamentos de 2024 de y3/z2 não existem => estes são os mais novos.
  await addFu(y3, await today(-2), 'call', leaderA, await today(-1), 'Ligar de novo');
  await addFu(z2, await today(-1), 'conversation', leaderB, await today(5), 'Visitar');

  // Ações do y1
  await addTask(y1, '2024-03-08', 'pending');
  await addTask(y1, await today(5), 'pending');
  await addTask(y1, '2023-12-01', 'cancelled');
  await addTask(y1, '2024-03-09', 'done');
}, 120_000);

// ---------------------------------------------------------------------------------------------
describe('validação comum dos parâmetros', () => {
  it('datas nulas, invertidas ou janela > 400 dias dão erro em pt-BR; 400 dias exatos passam', async () => {
    for (const run of [
      (f: string | null, to: string | null) => call(coord, `SELECT public.report_general($1::date, $2::date) AS r`, [f, to]),
      (f: string | null, to: string | null) => call(coord, `SELECT public.report_attendance($1::date, $2::date) AS r`, [f, to]),
      (f: string | null, to: string | null) => call(coord, `SELECT public.report_followups($1::date, $2::date) AS r`, [f, to]),
      (f: string | null, to: string | null) => call(coord, `SELECT public.report_alerts($1::date, $2::date) AS r`, [f, to]),
      (f: string | null, to: string | null) => call(coord, `SELECT public.report_groups($1::date, $2::date) AS r`, [f, to]),
      (f: string | null, to: string | null) => call(coord, `SELECT public.report_youth($3::uuid, $1::date, $2::date) AS r`, [f, to, y1]),
    ]) {
      await expect(run(null, '2024-03-15')).rejects.toThrow(/Informe o período/);
      await expect(run('2024-03-15', null)).rejects.toThrow(/Informe o período/);
      await expect(run('infinity', '2024-03-15')).rejects.toThrow(/Informe o período/);
      await expect(run('2024-03-16', '2024-03-15')).rejects.toThrow(/posterior/);
      await expect(run('2024-03-01', '2025-04-05')).rejects.toThrow(/400 dias/); // 401 dias
      await expect(run('2024-03-01', '2025-04-04')).resolves.toBeTruthy();       // 400 dias
      await expect(run('2024-03-15', '2024-03-15')).resolves.toBeTruthy();       // 1 dia
    }
  });

  it('grupo inexistente ou alheio => mesmo erro; mínimo de faltas fora de 1..50 => erro', async () => {
    await expect(general(coord, P.from, P.to, crypto.randomUUID())).rejects.toThrow(/Grupo não encontrado/);
    await expect(general(leaderA, P.from, P.to, g2)).rejects.toThrow(/Grupo não encontrado/);
    await expect(attendance(leaderA, P.from, P.to, g2)).rejects.toThrow(/Grupo não encontrado/);
    await expect(followups(leaderA, P.from, P.to, g2)).rejects.toThrow(/Grupo não encontrado/);
    await expect(alerts(leaderA, P.from, P.to, g2)).rejects.toThrow(/Grupo não encontrado/);
    await expect(attendance(coord, P.from, P.to, null, 0)).rejects.toThrow(/mínimo de faltas/);
    await expect(attendance(coord, P.from, P.to, null, 51)).rejects.toThrow(/mínimo de faltas/);
  });

  it('anon negado em todas; sem papel negado; RPCs públicas STABLE + DEFINER + search_path; internas fechadas', async () => {
    for (const fn of [
      `report_general('2024-03-01', '2024-03-15')`, `report_attendance('2024-03-01', '2024-03-15')`,
      `report_followups('2024-03-01', '2024-03-15')`, `report_alerts('2024-03-01', '2024-03-15')`,
      `report_groups('2024-03-01', '2024-03-15')`, `report_youth(NULL, '2024-03-01', '2024-03-15')`,
    ]) {
      await expect(t.as(null, () => t.q(`SELECT public.${fn}`))).rejects.toThrow(/permission denied/);
    }
    const orphan = await t.createUser('Sem Papel', 'leader');
    await t.q(`DELETE FROM public.user_roles WHERE user_id = $1`, [orphan]);
    await expect(general(orphan, P.from, P.to)).rejects.toThrow(/Sem permissão/);
    await expect(groupsRep(orphan, P.from, P.to)).rejects.toThrow(/Sem permissão/);

    const fns = await t.q<{ proname: string; anon: boolean; authed: boolean; definer: boolean; cfg: string | null; vol: string }>(
      `SELECT p.proname, p.prosecdef AS definer, p.proconfig::text AS cfg, p.provolatile AS vol,
              has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
              has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authed
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname LIKE 'report\\_%'`);
    const pub = ['report_general', 'report_attendance', 'report_followups', 'report_alerts', 'report_youth', 'report_groups'];
    expect(fns.map((f) => f.proname).sort()).toEqual(expect.arrayContaining(pub));
    for (const f of fns) {
      expect(f.anon, f.proname).toBe(false);
      expect(f.authed, f.proname).toBe(pub.includes(f.proname));
      if (pub.includes(f.proname)) {
        expect(f.definer, f.proname).toBe(true);
        expect(f.vol, f.proname).toBe('s');
        expect(f.cfg, f.proname).toMatch(/search_path=public/);
      }
    }
    await expect(t.as(coord, () => t.q(`SELECT public.report_check('2024-03-01', '2024-03-02', NULL)`)))
      .rejects.toThrow(/permission denied/);
  });

  it('índices dos relatórios existem', async () => {
    const idx = (await t.q<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE schemaname = 'public'`)).map((r) => r.indexname);
    for (const name of ['follow_ups_occurred_idx', 'follow_ups_next_due_idx', 'follow_up_transfers_at_idx',
      'alerts_created_idx', 'alerts_resolved_idx', 'tasks_completed_idx', 'tasks_created_idx',
      'attendance_group_idx', 'event_groups_group_idx', 'attendance_youth_idx', 'events_date_idx']) {
      expect(idx, name).toContain(name);
    }
  });
});

// ---------------------------------------------------------------------------------------------
describe('report_attendance — números, limites inclusivos, escopo', () => {
  it('coordenador: totais, por encontro (sem cancelado), série e por grupo; não registrado não é falta; inativo fora', async () => {
    const r = await attendance(coord, P.from, P.to);
    expect(r.period).toEqual({ from: P.from, to: P.to, days: 15, group_id: null });
    // E-start (3: 2p), E-mid (6: 3p), E-end (2: 1p) => 11 registros, 6 presenças, 5 faltas
    expect(r.summary).toEqual({
      events: 4, events_with_records: 3, events_cancelled: 1, present: 6, absent: 5, registered: 11, rate: 55,
    });
    expect(r.by_event.map((e: Rep) => [e.title, e.registered, e.present, e.absent, e.rate])).toEqual([
      ['E-start', 3, 2, 1, 67], ['E-mid', 6, 3, 3, 50], ['E-vazio', 0, 0, 0, null], ['E-end', 2, 1, 1, 50],
    ]);
    expect(r.series).toEqual([
      { date: '2024-03-01', present: 2, registered: 3, rate: 67 },
      { date: '2024-03-10', present: 3, registered: 6, rate: 50 },
      { date: '2024-03-15', present: 1, registered: 2, rate: 50 },
    ]);
    expect(r.by_group.map((g: Rep) => [g.name, g.events, g.present, g.absent, g.registered, g.rate])).toEqual([
      ['Grupo 1', 3, 4, 4, 8, 50], ['Grupo 2', 1, 1, 1, 2, 50], ['Grupo E', 0, 0, 0, 0, null],
      ['Sem grupo', 1, 1, 0, 1, 100],
    ]);
    expect(r.by_group[3].group_id).toBeNull();
  });

  it('limites inclusivos: 00:00:00 do primeiro dia e 23:59:59 do último entram; 1s antes/depois ficam fora', async () => {
    const inner = await attendance(coord, '2024-03-02', '2024-03-14');
    expect(inner.summary).toMatchObject({ registered: 6, events_with_records: 1 }); // só E-mid
    const first = await attendance(coord, '2024-03-01', '2024-03-01');
    expect(first.by_event.map((e: Rep) => e.title)).toEqual(['E-start']);
    const last = await attendance(coord, '2024-03-15', '2024-03-15');
    expect(last.by_event.map((e: Rep) => e.title)).toEqual(['E-end']);
    const after = await attendance(coord, '2024-03-16', '2024-03-16');
    expect(after.by_event.map((e: Rep) => [e.title, e.registered])).toEqual([['E-after', 1]]);
    const before = await attendance(coord, '2024-02-29', '2024-02-29');
    expect(before.by_event.map((e: Rep) => [e.title, e.registered])).toEqual([['E-before', 1]]);
    // período vazio: tudo zero/null, sem erro
    const none = await attendance(coord, '2024-04-01', '2024-04-10');
    expect(none.summary).toMatchObject({ events: 0, registered: 0, rate: null });
    expect(none.by_event).toEqual([]);
    expect(none.series).toEqual([]);
  });

  it('jovens com >= N faltas: ordem alfabética, sem ranking, N configurável', async () => {
    const m3 = await attendance(coord, P.from, P.to, null, 3);
    expect(m3.youth_absences).toEqual({ min_absences: 3, total: 0, limit: 50, items: [] });
    const m2 = await attendance(coord, P.from, P.to, null, 2);
    expect(m2.youth_absences.total).toBe(2);
    expect(m2.youth_absences.items).toEqual([
      expect.objectContaining({ full_name: 'Ana Um', group_name: 'Grupo 1', absences: 2, registered: 3 }),
      expect.objectContaining({ full_name: 'Bia Dois', group_name: 'Grupo 1', absences: 2, registered: 2 }),
    ]);
    const m1 = await attendance(coord, P.from, P.to, null, 1);
    expect(m1.youth_absences.items.map((i: Rep) => i.full_name)).toEqual(['Ana Um', 'Bia Dois', 'Fábio Zeta']);
    expect(m1.youth_absences.items.map((i: Rep) => i.full_name)).not.toContain('Davi Inativo');
  });

  it('filtro de grupo e escopo do líder: cada um vê só os seus jovens', async () => {
    const byG1 = await attendance(coord, P.from, P.to, g1);
    expect(byG1.summary).toMatchObject({ registered: 8, present: 4, absent: 4, rate: 50, events: 4 });
    expect(byG1.by_group.map((g: Rep) => g.name)).toEqual(['Grupo 1']);
    const lA = await attendance(leaderA, P.from, P.to);
    expect(lA.summary).toMatchObject({ registered: 8, present: 4, events_cancelled: 1 });
    expect(lA.by_group.map((g: Rep) => g.name)).toEqual(['Grupo 1']); // sem "Sem grupo" nem Grupo 2
    expect(lA.by_event.find((e: Rep) => e.title === 'E-mid')).toMatchObject({ registered: 3, present: 1 });
    expect(JSON.stringify(lA)).not.toContain('Eva Zeta');
    const lB = await attendance(leaderB, P.from, P.to);
    expect(lB.summary).toMatchObject({ registered: 2, present: 1, events: 1, events_cancelled: 0 });
    expect(lB.by_event.map((e: Rep) => e.title)).toEqual(['E-mid']);
    const lE = await attendance(leaderE, P.from, P.to);
    expect(lE.summary).toMatchObject({ events: 0, registered: 0, rate: null });
  });
});

// ---------------------------------------------------------------------------------------------
describe('report_general', () => {
  it('coordenador no período P', async () => {
    const r = await general(coord, P.from, P.to);
    expect(r.active_youth).toBe(6);                    // y1 y2 y3 z1 z2 n1
    expect(r.events).toEqual({ held: 4, cancelled: 1 });
    expect(r.attendance).toEqual({ present: 6, absent: 5, registered: 11, rate: 55 });
    expect(r.follow_ups).toEqual({ total: 4, youth_reached: 3 });  // inclui o jovem hoje inativo (histórico)
    expect(r.alerts.created).toBe(0);                   // alertas são de "agora", não de março/2024
    expect(r.alerts.open_now).toBeGreaterThan(0);
    expect(r.actions).toEqual({ open_now: 2, overdue_now: 1, created: 0, completed: 0 });
  });

  it('com filtro de grupo e como líder', async () => {
    expect(await general(coord, P.from, P.to, g2)).toMatchObject({
      active_youth: 2, events: { held: 1, cancelled: 0 }, attendance: { present: 1, absent: 1, registered: 2, rate: 50 },
      follow_ups: { total: 1, youth_reached: 1 }, actions: { open_now: 0 },
    });
    const a = await general(leaderA, P.from, P.to);
    expect(a).toMatchObject({
      active_youth: 3, events: { held: 4, cancelled: 1 }, attendance: { present: 4, absent: 4, registered: 8, rate: 50 },
      follow_ups: { total: 3, youth_reached: 2 }, actions: { open_now: 2, overdue_now: 1 },
    });
    const b = await general(leaderB, P.from, P.to);
    expect(b).toMatchObject({ active_youth: 2, events: { held: 1 }, follow_ups: { total: 1 }, actions: { open_now: 0 } });
  });

  it('janela de agora (W): criadas/concluídas no período contam com o fuso de São Paulo', async () => {
    const w = { from: await today(-3), to: await today(0) };
    const r = await general(coord, w.from, w.to);
    expect(r.actions).toMatchObject({ open_now: 2, overdue_now: 1, created: 4, completed: 1 });
    expect(r.follow_ups).toEqual({ total: 2, youth_reached: 2 });
    const [truth] = await t.q<{ n: number; o: number }>(
      `SELECT count(*)::int AS n, (count(*) FILTER (WHERE status = 'open'))::int AS o FROM public.alerts`);
    expect(r.alerts.created).toBe(truth.n);
    expect(r.alerts.open_now).toBe(truth.o);
    // Janela totalmente no futuro: nada criado/concluído, mas os instantâneos continuam
    const fut = await general(coord, await today(10), await today(20));
    expect(fut.actions).toMatchObject({ created: 0, completed: 0, open_now: 2 });
    expect(fut.alerts.created).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------
describe('report_followups', () => {
  it('totais por tipo e responsável no período P; nomes só de responsáveis de acompanhamentos acessíveis', async () => {
    const r = await followups(coord, P.from, P.to);
    expect(r).toMatchObject({ total: 4, youth_reached: 3 });
    expect(r.by_type).toEqual([
      { type: 'conversation', count: 1 }, { type: 'call', count: 1 }, { type: 'in_person', count: 1 },
      { type: 'guidance', count: 0 }, { type: 'return', count: 0 }, { type: 'other', count: 1 },
    ]);
    expect(r.by_responsible).toEqual([
      { responsible_id: coord, name: 'Coordenadora', count: 2 },
      { responsible_id: leaderA, name: 'Líder A', count: 1 },
      { responsible_id: leaderB, name: 'Líder B', count: 1 },
    ]);
    expect(r.transfers).toEqual({ count: 0, follow_ups: 0 });

    const a = await followups(leaderA, P.from, P.to);
    expect(a.total).toBe(3);
    expect(a.by_responsible.map((x: Rep) => [x.name, x.count])).toEqual([['Coordenadora', 2], ['Líder A', 1]]);
    expect(JSON.stringify(a)).not.toContain('Líder B');
  });

  it('próximas ações: instantâneo com vencidas e a vencer; escopo do líder', async () => {
    const r = await followups(coord, P.from, P.to);
    expect(r.next_actions).toMatchObject({ pending: 2, overdue: 1, upcoming: 1, limit: 50 });
    expect(r.next_actions.items.map((i: Rep) => [i.youth_name, i.overdue, i.next_action, i.responsible_name])).toEqual([
      ['Caio Três', true, 'Ligar de novo', 'Líder A'], ['Fábio Zeta', false, 'Visitar', 'Líder B'],
    ]);
    const a = await followups(leaderA, '2020-01-01', '2020-01-02');
    expect(a.total).toBe(0);
    expect(a.next_actions.items.map((i: Rep) => i.youth_name)).toEqual(['Caio Três']);
    const b = await followups(leaderB, '2020-01-01', '2020-01-02');
    expect(b.next_actions.items.map((i: Rep) => i.youth_name)).toEqual(['Fábio Zeta']);
  });

  it('transferência de responsável aparece no período e muda o responsável ATUAL', async () => {
    await t.as(coord, () => t.q(`SELECT public.transfer_follow_up($1, $2, 'Mudou de líder')`, [fuY1a, leaderA]));
    const w = { from: await today(-1), to: await today(0) };
    const r = await followups(coord, w.from, w.to);
    expect(r.transfers).toEqual({ count: 1, follow_ups: 1 });
    expect((await followups(leaderA, w.from, w.to)).transfers.count).toBe(1);
    expect((await followups(leaderB, w.from, w.to)).transfers.count).toBe(0);
    const p = await followups(coord, P.from, P.to);
    expect(p.by_responsible.map((x: Rep) => [x.name, x.count])).toEqual([
      ['Coordenadora', 1], ['Líder A', 2], ['Líder B', 1],
    ]);
  });
});

// ---------------------------------------------------------------------------------------------
describe('report_youth — ficha individual', () => {
  it('Ana: situação, presenças por encontro (cancelado fora, não registrado separado), acompanhamentos, ações, alertas', async () => {
    const r = await youthRep(leaderA, y1, P.from, P.to);
    expect(r.youth).toMatchObject({ id: y1, full_name: 'Ana Um', is_active: true, group_id: g1, group_name: 'Grupo 1', leader_name: 'Líder A' });
    expect(['attention', 'critical']).toContain(r.situation.situation);
    expect(r.situation.reasons).toContain('3 faltas seguidas');
    expect(r.situation.consecutive_absences).toBe(3);
    expect(r.attendance.events.map((e: Rep) => [e.title, e.state])).toEqual([
      ['E-start', 'present'], ['E-mid', 'absent'], ['E-vazio', 'not_registered'], ['E-end', 'absent'],
    ]);
    expect(r.attendance).toMatchObject({ present: 1, absent: 2, not_registered: 1, registered: 3, rate: 33 });
    expect(r.follow_ups.total).toBe(2);
    expect(r.follow_ups.items.map((f: Rep) => [f.occurred_at, f.type, f.responsible_name])).toEqual([
      ['2024-03-14', 'call', 'Líder A'], ['2024-03-05', 'conversation', 'Líder A'], // (transferido para o Líder A no teste de followups)
    ]);
    // ações: a pendente do período, a concluída que vencia no período e a aberta de hoje+5; a cancelada fica fora
    expect(r.actions.items.map((a: Rep) => [a.due_date, a.status, a.overdue])).toEqual([
      ['2024-03-08', 'pending', true], ['2024-03-09', 'done', false], [await today(5), 'pending', false],
    ]);
    expect(r.alerts.items.map((a: Rep) => a.type)).toContain('consecutive_absences');
    expect(r.alerts.items.every((a: Rep) => a.status === 'open')).toBe(true);
  });

  it('Bia: não registrado em E-end e E-vazio não vira falta; Davi (inativo) só mostra o que tem registro', async () => {
    const r = await youthRep(coord, y2, P.from, P.to);
    expect(r.attendance.events.map((e: Rep) => [e.title, e.state])).toEqual([
      ['E-start', 'absent'], ['E-mid', 'absent'], ['E-vazio', 'not_registered'], ['E-end', 'not_registered'],
    ]);
    expect(r.attendance).toMatchObject({ absent: 2, present: 0, not_registered: 2, registered: 2, rate: 0 });
    const d = await youthRep(coord, y4, P.from, P.to);
    expect(d.youth.is_active).toBe(false);
    expect(d.situation).toMatchObject({ situation: 'normal', inactive: true, reasons: [] });
    expect(d.attendance.events.map((e: Rep) => [e.title, e.state])).toEqual([['E-start', 'absent']]);
    expect(d.attendance.not_registered).toBe(0);
  });

  it('encontros futuros do grupo não aparecem como "não registrado"', async () => {
    const futureEv = await mkEvent([g1], `${await today(3)} 10:00:00`, 'Futuro', 'scheduled');
    const r = await youthRep(coord, y1, await today(0), await today(10));
    expect(r.attendance.events).toEqual([]);
    expect(r.attendance.not_registered).toBe(0);
    await t.q(`DELETE FROM public.events WHERE id = $1`, [futureEv]);
  });

  it('fora do escopo: erro único para inexistente, de outro grupo, sem grupo (líder) e nulo', async () => {
    for (const [user, id] of [
      [leaderB, y1], [leaderA, z1], [leaderA, n1], [leaderB, crypto.randomUUID()], [coord, crypto.randomUUID()],
      [coord, null],
    ] as [string, string | null][]) {
      await expect(youthRep(user, id, P.from, P.to)).rejects.toThrow(/Jovem não encontrado ou sem permissão/);
    }
    expect((await youthRep(coord, n1, P.from, P.to)).youth.group_id).toBeNull();
    await expect(t.as(null, () => t.q(`SELECT public.report_youth($1, '2024-03-01', '2024-03-15')`, [y1])))
      .rejects.toThrow(/permission denied/);
  });
});

// ---------------------------------------------------------------------------------------------
describe('report_groups', () => {
  it('uma entrada por grupo, por nome, com indicadores (012) e totais do período', async () => {
    const r = await groupsRep(coord, P.from, P.to);
    expect(r.period).toEqual({ from: P.from, to: P.to, days: 15, group_id: null });
    expect(r.groups.map((g: Rep) => g.name)).toEqual(['Grupo 1', 'Grupo 2', 'Grupo E']);
    const [g1r, g2r, gEr] = r.groups;
    expect(g1r).toMatchObject({ group_id: g1, leader_name: 'Líder A', active_youth: 3 });
    expect(g1r.period).toEqual({
      events_held: 4, events_with_records: 3, present: 4, absent: 4, registered: 8, rate: 50,
      follow_ups: 3, alerts_created: 0, actions_completed: 0,
    });
    expect(g2r.period).toMatchObject({ events_held: 1, present: 1, absent: 1, registered: 2, rate: 50, follow_ups: 1 });
    expect(gEr.period).toEqual({
      events_held: 0, events_with_records: 0, present: 0, absent: 0, registered: 0, rate: null,
      follow_ups: 0, alerts_created: 0, actions_completed: 0,
    });
    for (const g of r.groups) {
      expect(Object.keys(g).sort()).toEqual([
        'active_youth', 'attendance_rate', 'group_id', 'leader_name', 'name', 'overdue_actions', 'period',
        'trend', 'trend_delta', 'youth_in_attention']);
    }
  });

  it('líder só vê o próprio grupo; janela de agora conta alertas criados e ações concluídas', async () => {
    expect((await groupsRep(leaderA, P.from, P.to)).groups.map((g: Rep) => g.name)).toEqual(['Grupo 1']);
    expect((await groupsRep(leaderB, P.from, P.to)).groups.map((g: Rep) => g.group_id)).toEqual([g2]);
    const w = await groupsRep(coord, await today(-1), await today(0));
    const g1w = w.groups.find((g: Rep) => g.group_id === g1);
    expect(g1w.period.actions_completed).toBe(1);   // a ação concluída de Ana
    expect(g1w.period.alerts_created).toBeGreaterThan(0);
    expect(g1w.youth_in_attention).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------------------------
describe('report_alerts — criados/resolvidos/dispensados e histórico preservado', () => {
  let g3: string, o1: string, o2: string, o3: string;

  beforeAll(async () => {
    g3 = (await t.q<{ id: string }>(`INSERT INTO public.groups (name, leader_id) VALUES ('Grupo Alertas', $1) RETURNING id`, [leaderC]))[0].id;
    o1 = await mkYouth('Otávio Um', g3);
    o2 = await mkYouth('Paula Dois', g3);
    o3 = await mkYouth('Quico Três', g3);
    const evs: string[] = [];
    for (let i = 1; i <= 6; i++) evs.push(await mkEvent([g3], `2024-05-0${i} 10:00:00`, `Alerta ${i}`));
    for (const y of [o1, o2]) for (const e of evs.slice(0, 3)) await rec(e, y, false);   // 3 faltas => atenção
    for (const e of evs) await rec(e, o3, false);                                          // 6 faltas => crítico
  });

  const faltasOf = (y: string) =>
    t.q<{ id: string; status: string }>(
      `SELECT id, status::text AS status FROM public.alerts WHERE youth_id = $1 AND type = 'consecutive_absences'`, [y]);

  it('abertos por tipo e severidade; todos os tipos listados mesmo com zero', async () => {
    const w = { from: await today(-1), to: await today(1) };
    const r = await alerts(coord, w.from, w.to, g3);
    expect(r.open_now.critical).toBe(1);                        // Quico (6 faltas)
    expect(r.created.total).toBe(r.open_now.total);
    const tipos = r.by_type.map((x: Rep) => x.type);
    expect(tipos).toEqual(['consecutive_absences', 'low_attendance', 'attendance_drop', 'no_followup', 'overdue_action']);
    expect(r.by_type[0]).toMatchObject({ created: 3, open_now: 3, resolved: 0, dismissed: 0 });
    expect(r.by_severity.map((x: Rep) => x.severity)).toEqual(['attention', 'critical']);
    expect(r.by_severity[1]).toMatchObject({ created: 1 + 0, open_now: expect.any(Number) });
    expect(r.resolved).toBe(0);
    expect(r.avg_resolution_hours).toBeNull();
  });

  it('resolvido por usuário: tempo médio; dispensado separado; histórico (jovem inativado) preservado', async () => {
    const [a1] = await faltasOf(o1);
    const [a2] = await faltasOf(o2);
    await t.q(`UPDATE public.alerts SET created_at = now() - interval '48 hours' WHERE id = $1`, [a1.id]);
    await t.as(leaderC, () => t.q(`UPDATE public.alerts SET status = 'resolved' WHERE id = $1`, [a1.id]));
    await t.as(leaderC, () => t.q(`UPDATE public.alerts SET status = 'dismissed' WHERE id = $1`, [a2.id]));

    const w = { from: await today(-3), to: await today(1) };
    const r = await alerts(leaderC, w.from, w.to);
    expect(r.resolved).toBe(1);
    expect(r.resolved_automatically).toBe(0);
    expect(r.dismissed).toBe(1);
    expect(Number(r.avg_resolution_hours)).toBeGreaterThan(47.9);
    expect(Number(r.avg_resolution_hours)).toBeLessThan(48.2);
    expect(r.by_type[0]).toMatchObject({ resolved: 1, dismissed: 1 });
    expect(r.created.total).toBeGreaterThanOrEqual(3);

    // Inativar o jovem resolve os alertas abertos dele sozinho, mas o histórico segue nos relatórios
    await t.q(`UPDATE public.youth SET is_active = false WHERE id = $1`, [o3]);
    const after = await alerts(leaderC, w.from, w.to);
    expect(after.open_now.total).toBe(0);
    expect(after.resolved).toBeGreaterThanOrEqual(2);               // Otávio (usuário) + Quico (automático)
    expect(after.resolved_automatically).toBeGreaterThanOrEqual(1);
    expect(after.created.total).toBe(r.created.total);              // nada sumiu
    const [{ n }] = await t.q<{ n: number }>(`SELECT count(*)::int AS n FROM public.alerts WHERE youth_id = ANY($1)`, [[o1, o2, o3]]);
    expect(n).toBeGreaterThanOrEqual(after.created.total);
  });

  it('escopo: líder de outro grupo não enxerga estes alertas; períodos fora da janela não os contam', async () => {
    const w = { from: await today(-3), to: await today(1) };
    const lA = await alerts(leaderA, w.from, w.to);
    const mine = await t.q<{ n: number }>(
      `SELECT count(*)::int AS n FROM public.alerts a JOIN public.youth y ON y.id = a.youth_id WHERE y.group_id = $1`, [g1]);
    expect(lA.created.total).toBe(mine[0].n);
    const old = await alerts(coord, '2024-01-01', '2024-01-31', g3);
    expect(old.created.total).toBe(0);
    expect(old.resolved).toBe(0);
    expect(old.open_now.total).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------
describe('o histórico segue o jovem (decisão da 012) nos relatórios', () => {
  it('jovem que muda de grupo: relatórios do novo líder passam a incluir o histórico; do antigo, não', async () => {
    const before = await attendance(leaderA, P.from, P.to);
    expect(before.summary.registered).toBe(8);

    await t.q(`UPDATE public.youth SET group_id = $2 WHERE id = $1`, [z1, g1]);   // Eva: grupo 2 -> grupo 1

    const a = await attendance(leaderA, P.from, P.to);
    expect(a.summary).toMatchObject({ registered: 9, present: 5 });
    expect(a.by_event.find((e: Rep) => e.title === 'E-mid')).toMatchObject({ registered: 4, present: 2 });
    expect((await youthRep(leaderA, z1, P.from, P.to)).attendance.present).toBe(1);

    const b = await attendance(leaderB, P.from, P.to);
    expect(b.summary).toMatchObject({ registered: 1, present: 0 });
    await expect(youthRep(leaderB, z1, P.from, P.to)).rejects.toThrow(/Jovem não encontrado/);
    expect((await general(leaderA, P.from, P.to)).active_youth).toBe(4);

    // jovem sem grupo: some para o líder, continua para o coordenador
    await t.q(`UPDATE public.youth SET group_id = NULL WHERE id = $1`, [z1]);
    expect((await attendance(leaderA, P.from, P.to)).summary.registered).toBe(8);
    expect((await attendance(coord, P.from, P.to)).summary.registered).toBe(11);
    expect((await attendance(coord, P.from, P.to)).by_group.at(-1)).toMatchObject({ name: 'Sem grupo', registered: 2 });
  });
});
