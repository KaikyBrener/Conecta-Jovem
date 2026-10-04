import { beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './harness';

// Migration 012 (partes 3 e 4): dashboard_overview() e group_indicators(), mais a infraestrutura de escopo.
// Escopo: coordenador tudo; líder só jovens do grupo ATUAL dele; anon nada.
//
// Limitação do harness: relógio real. Os dados são datados em dias relativos a app_today() (fuso SP) e as
// asserções usam esses mesmos deslocamentos. Uma única conexão lógica sequencial (sem concorrência real).

let t: TestDb;
let coord: string, leaderA: string, leaderB: string, leaderF: string;
let g1: string, g2: string;
let a1: string, a2: string, a3: string, a4: string, b1: string, b2: string, n1: string;
let seqName = 0;

interface Dash {
  attention: { youth_id: string; full_name: string; group_name: string | null; situation: string; reasons: string[] }[];
  attention_total: number;
  open_alerts: { total: number; critical: number; attention: number };
  overdue_actions: number;
  upcoming_follow_ups: { follow_up_id: string; youth_id: string; youth_name: string; next_action: string | null;
    next_action_due: string; responsible_name: string | null }[];
  youth_without_group: number;
  upcoming_events: { id: string; title: string; event_date: string; groups: { id: string; name: string }[] }[];
  avg_attendance: number | null;
  avg_attendance_records: number;
  active_youth: number;
}

interface Ind {
  group_id: string; name: string; leader_name: string | null; active_youth: number; attendance_rate: number | null;
  trend: string | null; trend_delta: number | null; youth_in_attention: number; overdue_actions: number;
}

const dash = (user: string | null) =>
  t.as(user, async () => (await t.q<{ r: Dash }>(`SELECT public.dashboard_overview() AS r`))[0].r);
const indicators = (user: string | null, ids: string[] | null = null) =>
  t.as(user, () => t.q<Ind>(`SELECT * FROM public.group_indicators($1::uuid[])`, [ids]));

async function dateOf(offset: number): Promise<string> {
  return (await t.q<{ d: string }>(`SELECT (public.app_today() + $1::int)::text AS d`, [offset]))[0].d;
}

async function mkYouth(name: string, group: string | null, active = true): Promise<string> {
  seqName += 1;
  const [y] = await t.q<{ id: string }>(
    `INSERT INTO public.youth (full_name, group_id, is_active, created_by) VALUES ($1, $2, $3, $4) RETURNING id`,
    [name, group, active, coord]);
  return y.id;
}

/** Encontro em `offset` dias a partir de hoje (SP), na hora local `time` */
async function mkEvent(groups: string[], offset: number, opts: { time?: string; status?: string; title?: string } = {}) {
  const d = await dateOf(offset);
  const [ev] = await t.q<{ id: string }>(
    `INSERT INTO public.events (title, event_date, status, created_by)
     VALUES ($1, ($2 || ' ' || $3)::timestamp AT TIME ZONE 'America/Sao_Paulo', $4::event_status, $5) RETURNING id`,
    [opts.title ?? `Encontro ${d}`, d, opts.time ?? '12:00:00', opts.status ?? 'completed', coord]);
  for (const g of groups) {
    await t.q(`INSERT INTO public.event_groups (event_id, group_id) VALUES ($1, $2)`, [ev.id, g]);
  }
  return ev.id;
}

async function rec(ev: string, youth: string, present: boolean) {
  await t.q(
    `INSERT INTO public.attendance (event_id, youth_id, group_id, present, recorded_by)
     SELECT $1, y.id, y.group_id, $3, NULL FROM public.youth y WHERE y.id = $2
     ON CONFLICT (event_id, youth_id) DO UPDATE SET present = EXCLUDED.present`,
    [ev, youth, present]);
}

/** Sequência 'p'/'a' em encontros consecutivos (mais antigo primeiro) terminando em `endOffset` */
async function seq(youth: string, group: string, marks: string, endOffset: number) {
  const n = marks.length;
  for (let i = 0; i < n; i++) {
    const ev = await mkEvent([group], endOffset - (n - 1 - i));
    await rec(ev, youth, marks[i] === 'p');
  }
}

async function addTask(youth: string | null, due: number | null, status = 'pending', assignedTo: string | null = null) {
  const [r] = await t.q<{ id: string }>(
    `INSERT INTO public.tasks (title, youth_id, due_date, status, assigned_to, created_by)
     VALUES ('Ação', $1, CASE WHEN $2::int IS NULL THEN NULL ELSE public.app_today() + $2::int END,
             $3::task_status, $4, $5) RETURNING id`,
    [youth, due, status, assignedTo, coord]);
  return r.id;
}

async function addFu(youth: string, ago: number, nextDue: number | null, responsible: string, task: string | null = null) {
  const [r] = await t.q<{ id: string }>(
    `INSERT INTO public.follow_ups (youth_id, reason, occurred_at, next_action, next_action_due, responsible_id, task_id)
     VALUES ($1, 'Conversa', public.app_today() - $2::int, 'Ligar de novo',
             CASE WHEN $3::int IS NULL THEN NULL ELSE public.app_today() + $3::int END, $4, $5) RETURNING id`,
    [youth, ago, nextDue, responsible, task]);
  return r.id;
}

beforeAll(async () => {
  t = await createTestDb();
  coord = await t.createUser('Coordenadora', 'coordinator');
  leaderA = await t.createUser('Líder A', 'leader');
  leaderB = await t.createUser('Líder B', 'leader');
  leaderF = await t.createUser('Líder F', 'leader');
  const mkGroup = async (name: string, leader: string | null) =>
    (await t.q<{ id: string }>(`INSERT INTO public.groups (name, leader_id) VALUES ($1, $2) RETURNING id`, [name, leader]))[0].id;
  g1 = await mkGroup('Grupo Um', leaderA);
  g2 = await mkGroup('Grupo Dois', leaderB);
  await mkGroup('Grupo Vazio', leaderF);

  a1 = await mkYouth('Ana A1', g1);
  a2 = await mkYouth('Carla Crítica', g1);
  a3 = await mkYouth('Davi Dedicado', g1);
  a4 = await mkYouth('Inativo Antigo', g1, false);
  b1 = await mkYouth('Bruno B1', g2);
  b2 = await mkYouth('Elisa Presente', g2);
  n1 = await mkYouth('Zé Sem Grupo', null);

  // Borda da janela de 30 dias: -30 (fora) e -29 (dentro), só do grupo 1, só Davi
  const evM30 = await mkEvent([g1], -30);
  const evM29 = await mkEvent([g1], -29);
  await rec(evM30, a3, false);
  await rec(evM29, a3, true);
  // Antigo (fora da janela) do grupo 2
  const evM45 = await mkEvent([g2], -45);
  await rec(evM45, b2, false);

  // Seis encontros recentes (-6..-1) dos dois grupos
  const E: string[] = [];
  for (let off = -6; off <= -1; off++) E.push(await mkEvent([g1, g2], off));
  const mark = (y: string, m: string) => Promise.all(E.map((ev, i) => rec(ev, y, m[i] === 'p')));
  await mark(a1, 'pppaaa');   // 3 faltas seguidas  -> atenção
  await mark(a2, 'aaaaaa');   // 6 faltas seguidas  -> crítico
  await mark(a3, 'pppppp');
  await mark(a4, 'aaaaaa');   // inativo: fica fora de tudo
  await mark(b1, 'pppaaa');
  await mark(b2, 'pppppp');

  // Ações: atrasada de Ana, atrasada de Bruno (em andamento), de Zé (sem grupo), concluída (não conta),
  // futura (não conta) e uma atribuída ao líder A sem jovem
  await addTask(a1, -2);
  await addTask(b1, -1, 'in_progress');
  await addTask(n1, -1);
  await addTask(a3, -3, 'done');
  await addTask(a3, 5);
  await addTask(null, -1, 'pending', leaderA);

  // Acompanhamentos
  await addFu(a1, 9, -4, coord);                       // substituído pelo seguinte -> fora
  await addFu(a1, 5, -1, coord);                       // vencido -> entra
  await addFu(b1, 1, 10, leaderB);                     // em 10 dias -> entra
  await addFu(a3, 1, 30, coord);                       // além de 14 dias -> fora
  const doneTask = await addTask(a2, null, 'done');
  await addFu(a2, 2, 3, coord, doneTask);              // ligado a ação concluída -> fora
  await addFu(a4, 1, 2, coord);                        // jovem inativo -> fora

  // Encontros agendados
  await mkEvent([g2], 0, { time: '00:00:01', status: 'scheduled', title: 'Hoje cedo' });
  await mkEvent([g2], 1, { status: 'scheduled', title: 'S2' });
  await mkEvent([g1], 2, { status: 'scheduled', title: 'S1' });
  await mkEvent([g1, g2], 5, { status: 'scheduled', title: 'S3' });
  await mkEvent([g1], 6, { status: 'scheduled', title: 'S4' });
  await mkEvent([g2], 7, { status: 'scheduled', title: 'S5' });
  await mkEvent([g1], 8, { status: 'scheduled', title: 'S6' });
  await mkEvent([g1], -3, { status: 'scheduled', title: 'Passado agendado' });
  await mkEvent([g1], 3, { status: 'completed', title: 'Futuro concluído' });
  await mkEvent([g1], 4, { status: 'cancelled', title: 'Futuro cancelado' });
}, 120_000);

describe('dashboard_overview — coordenador (escopo total)', () => {
  it('atenção: críticos primeiro, depois por nome; sem número de ranking; inativos fora', async () => {
    const d = await dash(coord);
    expect(d.attention.map((x) => `${x.situation}:${x.full_name}`)).toEqual([
      'critical:Carla Crítica',
      'attention:Ana A1',
      'attention:Bruno B1',
      'attention:Zé Sem Grupo',
    ]);
    expect(d.attention_total).toBe(4);
    const carla = d.attention[0];
    expect(carla.group_name).toBe('Grupo Um');
    expect(carla.reasons).toContain('6 faltas seguidas');
    expect(Object.keys(carla).sort()).toEqual(['full_name', 'group_name', 'reasons', 'situation', 'youth_id']);
    const ze = d.attention.find((x) => x.full_name === 'Zé Sem Grupo')!;
    expect(ze.group_name).toBeNull();
    expect(ze.reasons).toEqual(['1 ação atrasada']);
    expect(d.attention.some((x) => x.full_name === 'Inativo Antigo')).toBe(false);
  });

  it('contadores: jovens ativos, sem grupo, alertas abertos e ações atrasadas', async () => {
    const d = await dash(coord);
    expect(d.active_youth).toBe(6);           // a1 a2 a3 b1 b2 n1 (a4 inativo)
    expect(d.youth_without_group).toBe(1);
    expect(d.overdue_actions).toBe(4);        // a1, b1, n1 e a atribuída ao líder A
    const [truth] = await t.q<{ total: number; critical: number; attention: number }>(
      `SELECT count(*)::int AS total, (count(*) FILTER (WHERE severity = 'critical'))::int AS critical,
              (count(*) FILTER (WHERE severity = 'attention'))::int AS attention
         FROM public.alerts WHERE status = 'open'`);
    expect(d.open_alerts).toEqual(truth);
    expect(d.open_alerts.critical).toBe(1);
    expect(d.open_alerts.total).toBeGreaterThanOrEqual(4);
  });

  it('próximas ações: vencidas e até 14 dias; substituídas, de ação concluída, de inativo ou distantes ficam fora', async () => {
    const d = await dash(coord);
    expect(d.upcoming_follow_ups.map((f) => f.youth_name)).toEqual(['Ana A1', 'Bruno B1']);
    const [vencida, futura] = d.upcoming_follow_ups;
    expect(vencida).toMatchObject({ next_action: 'Ligar de novo', responsible_name: 'Coordenadora' });
    expect(vencida.next_action_due).toBe(await dateOf(-1));
    expect(futura.next_action_due).toBe(await dateOf(10));
    expect(futura.responsible_name).toBe('Líder B');
  });

  it('próximos encontros agendados: de hoje (00:00:01 SP) em diante, no máximo 5, com os grupos', async () => {
    const d = await dash(coord);
    expect(d.upcoming_events.map((e) => e.title)).toEqual(['Hoje cedo', 'S2', 'S1', 'S3', 'S4']);
    expect(d.upcoming_events[3].groups.map((g) => g.name)).toEqual(['Grupo Dois', 'Grupo Um']);
  });

  it('frequência média: últimos 30 dias (inclui -29, exclui -30), só ativos, não registrado não conta', async () => {
    const d = await dash(coord);
    // ativos: a1 6 (3p) + a2 6 (0p) + a3 7 (7p, com -29) + b1 6 (3p) + b2 6 (6p) = 31 registros, 19 presenças
    expect(d.avg_attendance_records).toBe(31);
    expect(d.avg_attendance).toBe(61);
  });
});

describe('dashboard_overview — líder (só jovens do grupo atual dele)', () => {
  it('líder A vê só o grupo 1', async () => {
    const d = await dash(leaderA);
    expect(d.attention.map((x) => x.full_name)).toEqual(['Carla Crítica', 'Ana A1']);
    expect(d.attention_total).toBe(2);
    expect(d.active_youth).toBe(3);
    expect(d.youth_without_group).toBe(0);
    expect(d.overdue_actions).toBe(2);   // a1 + a atribuída a ele (visível pelo RLS de tasks)
    expect(d.upcoming_follow_ups.map((f) => f.youth_name)).toEqual(['Ana A1']);
    expect(d.upcoming_follow_ups[0].responsible_name).toBe('Coordenadora'); // só do acompanhamento que ele acessa
    expect(d.upcoming_events.map((e) => e.title)).toEqual(['S1', 'S3', 'S4', 'S6']);
    expect(d.upcoming_events[1].groups.map((g) => g.name)).toEqual(['Grupo Um']); // não vaza o grupo alheio
    expect(d.avg_attendance_records).toBe(19);
    expect(d.avg_attendance).toBe(53);
    const [truth] = await t.q<{ n: number }>(
      `SELECT count(*)::int AS n FROM public.alerts a JOIN public.youth y ON y.id = a.youth_id
        WHERE a.status = 'open' AND y.group_id = $1`, [g1]);
    expect(d.open_alerts.total).toBe(truth.n);
  });

  it('líder B vê só o grupo 2', async () => {
    const d = await dash(leaderB);
    expect(d.attention.map((x) => x.full_name)).toEqual(['Bruno B1']);
    expect(d.active_youth).toBe(2);
    expect(d.overdue_actions).toBe(1);
    expect(d.upcoming_follow_ups.map((f) => f.youth_name)).toEqual(['Bruno B1']);
    expect(d.upcoming_follow_ups[0].responsible_name).toBe('Líder B');
    expect(d.upcoming_events.map((e) => e.title)).toEqual(['Hoje cedo', 'S2', 'S3', 'S5']);
    expect(d.avg_attendance_records).toBe(12);
    expect(d.avg_attendance).toBe(75);
  });

  it('líder sem dados: listas vazias e frequência média null (não 0)', async () => {
    const d = await dash(leaderF);
    expect(d).toMatchObject({
      attention: [], attention_total: 0, overdue_actions: 0, upcoming_follow_ups: [], upcoming_events: [],
      youth_without_group: 0, avg_attendance: null, avg_attendance_records: 0, active_youth: 0,
      open_alerts: { total: 0, critical: 0, attention: 0 },
    });
  });

  it('jovem que muda de grupo passa a aparecer só para o novo líder', async () => {
    await t.q(`UPDATE public.youth SET group_id = $2 WHERE id = $1`, [a2, g2]);
    expect((await dash(leaderA)).attention.map((x) => x.full_name)).toEqual(['Ana A1']);
    expect((await dash(leaderB)).attention.map((x) => x.full_name)).toEqual(['Carla Crítica', 'Bruno B1']);
    await t.q(`UPDATE public.youth SET group_id = $2 WHERE id = $1`, [a2, g1]); // volta
    expect((await dash(leaderA)).attention.map((x) => x.full_name)).toEqual(['Carla Crítica', 'Ana A1']);
  });
});

describe('group_indicators', () => {
  it('coordenador: uma linha por grupo, ordenada por nome (não por desempenho)', async () => {
    const rows = await indicators(coord);
    expect(rows.map((r) => r.name)).toEqual(['Grupo Dois', 'Grupo Um', 'Grupo Vazio']);
    const [dois, um, vazio] = rows;

    // Grupo 2: 7 encontros com registro (<8) => sem tendência. 13 registros, 9 presenças => 69%
    expect(dois).toMatchObject({
      group_id: g2, leader_name: 'Líder B', active_youth: 2, attendance_rate: 69,
      trend: null, trend_delta: null, youth_in_attention: 1, overdue_actions: 1,
    });
    // Grupo 1: 8 encontros com registro (os 6 recentes + -29 + -30). Últimos 8: 10 presenças / 20 = 50%.
    // 4 mais recentes: 5/12 = 41,7% ; 4 anteriores: 5/8 = 62,5% => -21 pontos
    expect(um).toMatchObject({
      group_id: g1, leader_name: 'Líder A', active_youth: 3, attendance_rate: 50,
      trend: 'down', trend_delta: -21, youth_in_attention: 2, overdue_actions: 1,
    });
    // Grupo sem jovens/encontros
    expect(vazio).toMatchObject({
      leader_name: 'Líder F', active_youth: 0, attendance_rate: null, trend: null, trend_delta: null,
      youth_in_attention: 0, overdue_actions: 0,
    });
  });

  it('líder só recebe os próprios grupos; ids alheios em p_group_ids são ignorados em silêncio', async () => {
    expect((await indicators(leaderA)).map((r) => r.group_id)).toEqual([g1]);
    expect(await indicators(leaderA, [g2])).toEqual([]);
    expect((await indicators(leaderA, [g1, g2])).map((r) => r.group_id)).toEqual([g1]);
    expect((await indicators(coord, [g2])).map((r) => r.group_id)).toEqual([g2]);
    expect(await indicators(coord, [])).toEqual([]);
  });

  it('tendência: up, down, stable e o mínimo de 8 encontros com registro', async () => {
    const mk = async (name: string, marks: string) => {
      const leader = await t.createUser(`Líder ${name}`, 'leader');
      const g = (await t.q<{ id: string }>(
        `INSERT INTO public.groups (name, leader_id) VALUES ($1, $2) RETURNING id`, [`Tendência ${name}`, leader]))[0].id;
      const y = await mkYouth(`Jovem ${name}`, g);
      await seq(y, g, marks, -100);
      return g;
    };
    const up = await mk('Up', 'ppaappppp'.slice(0, 8));      // antigos pp aa (50%), recentes pppp (100%) => +50
    const down = await mk('Down', 'pppppaap'.slice(0, 8));   // antigos pppp (100%), recentes paap (50%) => -50
    const stable = await mk('Stable', 'pppapppa');           // 75% e 75% => 0
    const short = await mk('Short', 'ppppppp');              // 7 encontros => sem tendência

    const rows = await indicators(coord, [up, down, stable, short]);
    const by = Object.fromEntries(rows.map((r) => [r.name, r]));
    expect(by['Tendência Up']).toMatchObject({ trend: 'up', trend_delta: 50, attendance_rate: 75 });
    expect(by['Tendência Down']).toMatchObject({ trend: 'down', trend_delta: -50, attendance_rate: 75 });
    expect(by['Tendência Stable']).toMatchObject({ trend: 'stable', trend_delta: 0, attendance_rate: 75 });
    expect(by['Tendência Short']).toMatchObject({ trend: null, trend_delta: null, attendance_rate: 100 });
  });

  it('encontro cancelado não conta e jovem inativo fica fora da frequência', async () => {
    const leader = await t.createUser('Líder Canc', 'leader');
    const g = (await t.q<{ id: string }>(
      `INSERT INTO public.groups (name, leader_id) VALUES ('Cancelados', $1) RETURNING id`, [leader]))[0].id;
    const ativo = await mkYouth('Ativo C', g);
    const inativo = await mkYouth('Inativo C', g, false);
    const e1 = await mkEvent([g], -90);
    const e2 = await mkEvent([g], -89, { status: 'cancelled' });
    await rec(e1, ativo, true);
    await rec(e2, ativo, false);   // cancelado: ignorado
    await rec(e1, inativo, false); // inativo: ignorado
    const [row] = await indicators(leader);
    expect(row).toMatchObject({ active_youth: 1, attendance_rate: 100 });
  });
});

describe('segurança e metadados', () => {
  it('anon não executa nenhuma RPC nova; authenticated só as públicas', async () => {
    await expect(dash(null)).rejects.toThrow(/permission denied/);
    await expect(indicators(null)).rejects.toThrow(/permission denied/);
    const fns = await t.q<{ proname: string; anon: boolean; authed: boolean; definer: boolean; cfg: string | null; vol: string }>(
      `SELECT p.proname, p.prosecdef AS definer, p.proconfig::text AS cfg, p.provolatile AS vol,
              has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
              has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authed
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND p.proname IN ('dashboard_overview', 'group_indicators', 'report_scope_youth', 'report_scope_events',
                            'report_scope_tasks', 'report_att_rows', 'report_pending_followups',
                            'youth_sync_attendance_group')`);
    expect(fns).toHaveLength(8);
    for (const f of fns) {
      expect(f.anon, f.proname).toBe(false);
      expect(f.definer, f.proname).toBe(true);
      expect(f.cfg, f.proname).toMatch(/search_path=public/);
      const isPublic = ['dashboard_overview', 'group_indicators'].includes(f.proname);
      expect(f.authed, f.proname).toBe(isPublic);
      if (isPublic) expect(f.vol, f.proname).toBe('s'); // STABLE
    }
  });

  it('infraestrutura interna não é chamável diretamente por usuários logados', async () => {
    await expect(t.as(coord, () => t.q(`SELECT * FROM public.report_scope_youth(NULL)`))).rejects.toThrow(/permission denied/);
    await expect(t.as(leaderA, () => t.q(`SELECT * FROM public.report_att_rows(CURRENT_DATE, CURRENT_DATE, NULL)`)))
      .rejects.toThrow(/permission denied/);
  });

  it('usuário sem papel não recebe nada', async () => {
    const orphan = await t.createUser('Sem Papel', 'leader');
    await t.q(`DELETE FROM public.user_roles WHERE user_id = $1`, [orphan]);
    await expect(dash(orphan)).rejects.toThrow(/Sem permissão/);
    await expect(indicators(orphan)).rejects.toThrow(/Sem permissão/);
  });
});

describe('volume: mais de 500 jovens (blocos de youth_situations)', () => {
  it('todos os 505 jovens em atenção são contados mesmo passando do limite de 500 ids por consulta', async () => {
    const leader = await t.createUser('Líder Volume', 'leader');
    const g = (await t.q<{ id: string }>(
      `INSERT INTO public.groups (name, leader_id) VALUES ('Volume', $1) RETURNING id`, [leader]))[0].id;
    const evs = [await mkEvent([g], -200), await mkEvent([g], -199), await mkEvent([g], -198)];
    // Insere em massa sem disparar os triggers (a situação é calculada a partir de attendance direto)
    await t.db.exec(`SET session_replication_role = replica`);
    try {
      await t.q(
        `INSERT INTO public.youth (full_name, group_id, created_by)
         SELECT 'Volume ' || lpad(i::text, 4, '0'), $1, $2 FROM generate_series(1, 505) i`, [g, coord]);
      await t.q(
        `INSERT INTO public.attendance (event_id, youth_id, group_id, present)
         SELECT e, y.id, $1, false FROM public.youth y, unnest($2::uuid[]) e WHERE y.group_id = $1`, [g, evs]);
    } finally {
      await t.db.exec(`SET session_replication_role = origin`);
    }
    const d = await dash(leader);
    expect(d.active_youth).toBe(505);
    expect(d.attention_total).toBe(505);
    expect(d.attention).toHaveLength(10);
    expect(d.attention.map((x) => x.full_name)).toEqual(
      Array.from({ length: 10 }, (_, i) => `Volume ${String(i + 1).padStart(4, '0')}`));
    const [row] = await indicators(leader);
    expect(row).toMatchObject({ active_youth: 505, youth_in_attention: 505 });
  }, 120_000);
});
