import { beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './harness';

// Migration 016 (hardening da auditoria de segurança):
//   1) throttle de sync_time_alerts()      4) is_valid_email sem '%'
//   2) relatórios do líder sem dados de    5) TRUNCATE/REFERENCES/TRIGGER revogados; anon sem acesso
//      encontro de outro grupo             6) pg_temp no search_path de toda função SECURITY DEFINER
//   3) follow_up com transferências não é excluível (cascata do jovem continua)
//
// Limitação do harness: uma única conexão lógica. O ramo "outra transação está varrendo" de sync_time_alerts()
// (pg_try_advisory_xact_lock ocupado) não é reproduzível aqui (advisory lock é reentrante na mesma sessão) e,
// portanto, NÃO é testado; só o ramo do intervalo de 60 s.

let t: TestDb;
let coord: string, leaderA: string, leaderB: string;
let groupA: string, groupB: string;
let seqName = 0;
let day = -3000;

async function mkYouth(group: string | null, active = true): Promise<string> {
  seqName += 1;
  const [y] = await t.q<{ id: string }>(
    `INSERT INTO public.youth (full_name, group_id, is_active, created_by) VALUES ($1, $2, $3, $4) RETURNING id`,
    [`Jovem ${String(seqName).padStart(3, '0')}`, group, active, coord]);
  return y.id;
}

/** Encontro `completed` em `at` dias a partir de agora (padrão: sequência crescente no passado) vinculado aos grupos. */
async function mkEvent(groups: string[], title = 'Encontro', at?: number): Promise<string> {
  day += 1;
  const [ev] = await t.q<{ id: string }>(
    `INSERT INTO public.events (title, event_date, status, created_by)
     VALUES ($1, now() + ($2 || ' days')::interval, 'completed', $3) RETURNING id`,
    [title, String(at ?? day), coord]);
  for (const g of groups) {
    await t.q(`INSERT INTO public.event_groups (event_id, group_id) VALUES ($1, $2)`, [ev.id, g]);
  }
  return ev.id;
}

async function rec(ev: string, youth: string, present: boolean) {
  await t.q(
    `INSERT INTO public.attendance (event_id, youth_id, group_id, present, recorded_by)
     SELECT $1, y.id, y.group_id, $3, NULL FROM public.youth y WHERE y.id = $2`,
    [ev, youth, present]);
}

const setThrottle = (sql: string) => t.q(`UPDATE public.time_alerts_sync_state SET last_run = ${sql}`);
const lastRun = async () =>
  (await t.q<{ last_run: string }>(`SELECT last_run::text AS last_run FROM public.time_alerts_sync_state`))[0].last_run;
const sync = (user: string) => t.as(user, () => t.q(`SELECT public.sync_time_alerts()`));
const alertsSnapshot = () =>
  t.q(`SELECT youth_id, type::text AS type, status::text AS status, sample_size FROM public.alerts
        ORDER BY youth_id, type::text, created_at`);
const openNoFollowup = async (youth: string) =>
  (await t.q<{ sample_size: number }>(
    `SELECT sample_size FROM public.alerts WHERE youth_id = $1 AND type::text = 'no_followup' AND status = 'open'`,
    [youth]))[0] ?? null;

/**
 * Jovem com 3 faltas seguidas cujo alerta de faltas é envelhecido (12 dias) SEM disparar o trigger de eventos:
 * o alerta "no_followup" só passa a existir quando alguém varre o banco (sync_time_alerts / recalculate).
 */
async function pendingTimeAlert(): Promise<string> {
  const y = await mkYouth(groupA);
  for (let i = 0; i < 3; i++) await rec(await mkEvent([groupA]), y, false);
  await t.q(`ALTER TABLE public.alerts DISABLE TRIGGER alerts_refresh_time_alerts`);
  await t.q(
    `UPDATE public.alerts SET created_at = now() - interval '12 days'
      WHERE youth_id = $1 AND type::text = 'consecutive_absences'`, [y]);
  await t.q(`ALTER TABLE public.alerts ENABLE TRIGGER alerts_refresh_time_alerts`);
  expect(await openNoFollowup(y)).toBeNull();
  return y;
}

beforeAll(async () => {
  t = await createTestDb();
  coord = await t.createUser('Coordenadora', 'coordinator');
  leaderA = await t.createUser('Líder A', 'leader');
  leaderB = await t.createUser('Líder B', 'leader');
  const mkGroup = async (name: string, leader: string) =>
    (await t.q<{ id: string }>(`INSERT INTO public.groups (name, leader_id) VALUES ($1, $2) RETURNING id`, [name, leader]))[0].id;
  groupA = await mkGroup('Grupo A', leaderA);
  groupB = await mkGroup('Grupo B', leaderB);
}, 60_000);

// ---------------------------------------------------------------------------------------------
describe('1) throttle de sync_time_alerts()', () => {
  it('tabela de estado: RLS ligado, sem policies, linha única, sem acesso para clientes', async () => {
    const [c] = await t.q<{ relrowsecurity: boolean }>(
      `SELECT relrowsecurity FROM pg_class WHERE relname = 'time_alerts_sync_state' AND relnamespace = 'public'::regnamespace`);
    expect(c.relrowsecurity).toBe(true);
    expect(await t.q(`SELECT 1 FROM pg_policy WHERE polrelid = 'public.time_alerts_sync_state'::regclass`)).toEqual([]);
    expect(await t.q(`SELECT 1 FROM public.time_alerts_sync_state`)).toHaveLength(1);
    await expect(t.q(`INSERT INTO public.time_alerts_sync_state (id) VALUES (false)`)).rejects.toThrow(/check|duplicate/i);
    for (const u of [coord, leaderA, null]) {
      await expect(t.as(u, () => t.q(`SELECT * FROM public.time_alerts_sync_state`))).rejects.toThrow(/permission denied/);
      await expect(t.as(u, () => t.q(`UPDATE public.time_alerts_sync_state SET last_run = now()`))).rejects.toThrow(/permission denied/);
    }
  });

  it('segunda chamada em < 60 s não varre; após o intervalo (last_run manipulado) a varredura acontece', async () => {
    await setThrottle(`'-infinity'`);
    await sync(leaderA);                                  // varre e marca last_run
    const first = await lastRun();
    expect(first).not.toBe('-infinity');

    const y = await pendingTimeAlert();
    const before = await alertsSnapshot();
    await sync(leaderA);                                  // < 60 s: retorna sem trabalho
    await sync(coord);                                    // (qualquer usuário autenticado)
    expect(await openNoFollowup(y)).toBeNull();
    expect(await alertsSnapshot()).toEqual(before);       // resultado idêntico
    expect(await lastRun()).toBe(first);                  // e nem atualiza o estado

    await setThrottle(`now() - interval '59 seconds'`);   // ainda dentro da janela
    await sync(leaderA);
    expect(await openNoFollowup(y)).toBeNull();

    await setThrottle(`now() - interval '61 seconds'`);   // janela vencida: varre
    await sync(leaderA);
    expect(await openNoFollowup(y)).toMatchObject({ sample_size: 12 });
    expect(new Date(await lastRun()).getTime()).toBeGreaterThan(Date.now() - 30_000);

    const after = await alertsSnapshot();
    await setThrottle(`now() - interval '61 seconds'`);   // varrer de novo é idempotente
    await sync(coord);
    expect(await alertsSnapshot()).toEqual(after);
  });

  it('recalculate_all_alerts (coordenador) e refresh_time_alerts não sofrem o throttle', async () => {
    await setThrottle(`now()`);                           // janela totalmente fechada
    const stamp = await lastRun();
    const y = await pendingTimeAlert();
    await sync(coord);
    expect(await openNoFollowup(y)).toBeNull();           // sync_time_alerts está travada...
    await t.as(coord, () => t.q(`SELECT public.recalculate_all_alerts()`));
    expect(await openNoFollowup(y)).toMatchObject({ sample_size: 12 });   // ...mas recalcular funciona
    expect(await lastRun()).toBe(stamp);

    const y2 = await pendingTimeAlert();
    expect(await t.q<{ n: number }>(`SELECT public.refresh_time_alerts() AS n`)).toHaveLength(1);
    expect(await openNoFollowup(y2)).toMatchObject({ sample_size: 12 });
  });

  it('continua exigindo autenticação e papel; anon não executa; DEFINER com search_path fixo', async () => {
    await expect(t.as(null, () => t.q(`SELECT public.sync_time_alerts()`))).rejects.toThrow(/permission denied/);
    const orphan = await t.createUser('Sem papel', 'leader');
    await t.q(`DELETE FROM public.user_roles WHERE user_id = $1`, [orphan]);
    await setThrottle(`'-infinity'`);
    await expect(sync(orphan)).rejects.toThrow(/Não autenticado/);
    expect(await lastRun()).toBe('-infinity');
    const [fn] = await t.q<{ definer: boolean; cfg: string; authed: boolean; anon: boolean }>(
      `SELECT prosecdef AS definer, proconfig::text AS cfg,
              has_function_privilege('authenticated', oid, 'EXECUTE') AS authed,
              has_function_privilege('anon', oid, 'EXECUTE') AS anon
         FROM pg_proc WHERE proname = 'sync_time_alerts' AND pronamespace = 'public'::regnamespace`);
    expect(fn).toMatchObject({ definer: true, authed: true, anon: false });
    expect(fn.cfg).toContain('search_path=public, pg_temp');
  });
});

// ---------------------------------------------------------------------------------------------
describe('2) relatórios do líder não vazam encontro de outro grupo', () => {
  const SECRET = 'Culto secreto do Grupo B';
  let youth: string, evB: string, evA: string, evBoth: string;
  const from = () => t.q<{ d: string }>(`SELECT (public.app_today() - 40)::text AS d`).then((r) => r[0].d);
  const to = () => t.q<{ d: string }>(`SELECT (public.app_today() + 40)::text AS d`).then((r) => r[0].d);

  const attendance = (u: string) => t.as(u, async () => (await t.q<{ r: any }>(
    `SELECT public.report_attendance($1::date, $2::date, NULL, 3) AS r`, [await from(), await to()]))[0].r);
  const ficha = (u: string, y: string) => t.as(u, async () => (await t.q<{ r: any }>(
    `SELECT public.report_youth($1, $2::date, $3::date) AS r`, [y, await from(), await to()]))[0].r);

  beforeAll(async () => {
    youth = await mkYouth(groupB);
    evB = await mkEvent([groupB], SECRET, -10);
    evBoth = await mkEvent([groupA, groupB], 'Culto conjunto', -8);
    await rec(evB, youth, false);
    await rec(evBoth, youth, true);
    await t.q(`UPDATE public.youth SET group_id = $2 WHERE id = $1`, [youth, groupA]);   // jovem trocou de grupo
    evA = await mkEvent([groupA], 'Culto do Grupo A', -5);
    await rec(evA, youth, true);
  });

  it('report_attendance: líder do novo grupo vê data/estado, mas título genérico e event_id NULL', async () => {
    const r = await attendance(leaderA);
    const byTitle = (title: string) => r.by_event.filter((e: any) => e.title === title);
    expect(byTitle('Culto do Grupo A')).toHaveLength(1);
    expect(byTitle('Culto do Grupo A')[0].event_id).toBe(evA);
    expect(byTitle('Culto conjunto')[0].event_id).toBe(evBoth);          // vinculado ao grupo dele: normal
    const foreign = byTitle('Encontro de outro grupo');
    expect(foreign).toHaveLength(1);
    expect(foreign[0]).toMatchObject({ event_id: null, status: 'completed', present: 0, absent: 1, registered: 1, rate: 0 });
    expect(foreign[0].event_date).toBeTruthy();
    expect(JSON.stringify(r)).not.toContain(SECRET);
    expect(JSON.stringify(r)).not.toContain(evB);
    expect(r.summary).toMatchObject({ registered: 3, present: 2, absent: 1 });   // contagens inalteradas
  });

  it('report_attendance: coordenador inalterado (título e id reais)', async () => {
    const r = await attendance(coord);
    const real = r.by_event.find((e: any) => e.title === SECRET);
    expect(real).toMatchObject({ event_id: evB, status: 'completed', registered: 1 });
    expect(r.by_event.some((e: any) => e.title === 'Encontro de outro grupo')).toBe(false);
  });

  it('report_youth: ficha do líder mascara o encontro alheio; coordenador vê tudo', async () => {
    const f = await ficha(leaderA, youth);
    const ev = f.attendance.events;
    expect(ev).toHaveLength(3);
    const foreign = ev.filter((e: any) => e.event_id === null);
    expect(foreign).toEqual([expect.objectContaining({ title: 'Encontro de outro grupo', state: 'absent' })]);
    expect(ev.find((e: any) => e.event_id === evA)).toMatchObject({ title: 'Culto do Grupo A', state: 'present' });
    expect(ev.find((e: any) => e.event_id === evBoth)).toMatchObject({ title: 'Culto conjunto', state: 'present' });
    expect(JSON.stringify(f)).not.toContain(SECRET);
    expect(f.attendance).toMatchObject({ present: 2, absent: 1, registered: 3 });

    const c = await ficha(coord, youth);
    expect(c.attendance.events.find((e: any) => e.event_id === evB)).toMatchObject({ title: SECRET, state: 'absent' });
  });

  it('dashboard, relatório geral e de grupos do líder também não carregam o título', async () => {
    for (const sql of [
      `SELECT public.dashboard_overview() AS r`,
      `SELECT public.report_general(public.app_today() - 40, public.app_today() + 40, NULL) AS r`,
      `SELECT public.report_groups(public.app_today() - 40, public.app_today() + 40) AS r`,
      `SELECT public.report_followups(public.app_today() - 40, public.app_today() + 40, NULL) AS r`,
    ]) {
      const [row] = await t.as(leaderA, () => t.q<{ r: unknown }>(sql));
      expect(JSON.stringify(row.r)).not.toContain(SECRET);
    }
  });

  it('líder do grupo antigo (B) perde o acesso à ficha do jovem (escopo inalterado)', async () => {
    await expect(ficha(leaderB, youth)).rejects.toThrow(/não encontrado ou sem permissão/);
  });
});

// ---------------------------------------------------------------------------------------------
describe('3) acompanhamento com histórico de transferências não é excluível', () => {
  const addFu = async (y: string) => (await t.as(coord, () => t.q<{ id: string }>(
    `INSERT INTO public.follow_ups (youth_id, reason) VALUES ($1, 'Conversa') RETURNING id`, [y])))[0].id;
  const transfer = (fu: string, to: string) =>
    t.as(coord, () => t.q(`SELECT public.transfer_follow_up($1, $2, 'Passando adiante')`, [fu, to]));
  const transfersOf = (fu: string) =>
    t.q(`SELECT 1 FROM public.follow_up_transfers WHERE follow_up_id = $1`, [fu]);

  it('coordenador (e qualquer papel, inclusive superusuário) é bloqueado com mensagem pt-BR e P0001', async () => {
    const y = await mkYouth(groupA);
    const fu = await addFu(y);
    await transfer(fu, leaderA);
    const attempt = async (run: () => Promise<unknown>) => {
      try { await run(); } catch (e) { return e as Error & { code?: string }; }
      return null;
    };
    const e1 = await attempt(() => t.as(coord, () => t.q(`DELETE FROM public.follow_ups WHERE id = $1`, [fu])));
    expect(e1?.message).toBe('Este acompanhamento tem histórico de transferências e não pode ser excluído.');
    expect(e1?.code).toBe('P0001');
    const e2 = await attempt(() => t.q(`DELETE FROM public.follow_ups WHERE id = $1`, [fu]));
    expect(e2?.message).toMatch(/histórico de transferências/);
    // líder continua sem DELETE (RLS): 0 linhas, sem erro
    expect(await t.as(leaderA, () => t.q(`DELETE FROM public.follow_ups WHERE id = $1 RETURNING id`, [fu]))).toHaveLength(0);
    expect(await transfersOf(fu)).toHaveLength(1);
    expect(await t.q(`SELECT 1 FROM public.follow_ups WHERE id = $1`, [fu])).toHaveLength(1);
  });

  it('sem transferências o coordenador continua podendo excluir', async () => {
    const y = await mkYouth(groupA);
    const fu = await addFu(y);
    expect(await t.as(coord, () => t.q(`DELETE FROM public.follow_ups WHERE id = $1 RETURNING id`, [fu]))).toHaveLength(1);
  });

  it('exclusão do JOVEM continua em cascata (decisão documentada): leva acompanhamento e histórico', async () => {
    const y = await mkYouth(groupA);
    const fu = await addFu(y);
    await transfer(fu, leaderA);
    await t.as(coord, () => t.q(`DELETE FROM public.youth WHERE id = $1`, [y]));
    expect(await t.q(`SELECT 1 FROM public.follow_ups WHERE id = $1`, [fu])).toEqual([]);
    expect(await transfersOf(fu)).toEqual([]);
  });

  it('a função do trigger não é chamável por clientes', async () => {
    await expect(t.as(coord, () => t.q(`SELECT public.follow_ups_protect_history()`))).rejects.toThrow(/permission denied/);
  });
});

// ---------------------------------------------------------------------------------------------
describe('4) is_valid_email sem "%"', () => {
  const valid = (email: string) => t.q<{ v: boolean }>(`SELECT public.is_valid_email($1) AS v`, [email]).then((r) => r[0].v);

  it('rejeita "%" no local-part (injeção de cabeçalho via percent-encoding)', async () => {
    for (const bad of ['a%0d%0abcc%3dx@y.com', 'a%0abcc@y.com', '%@y.com', 'X_Y%z@y.com']) {
      expect(await valid(bad), bad).toBe(false);
    }
  });

  it('continua aceitando + . _ - e rejeitando o que já era rejeitado', async () => {
    for (const ok of ['a+b@y.com', 'nome.sobrenome@sub.exemplo.com.br', 'a_b@y.com', 'a-b@y.co', 'X1@E-xemplo.org', 'A@Y.CO']) {
      expect(await valid(ok), ok).toBe(true);
    }
    for (const bad of ['a b@y.com', 'a@b', 'a@@b.com', '.a@y.com', 'a.@y.com', 'a..b@y.com', 'a@y.com\n', 'a,b@y.com', '<a>@y.com']) {
      expect(await valid(bad), bad).toBe(false);
    }
    expect(await t.q<{ v: null }>(`SELECT public.is_valid_email(NULL) AS v`)).toEqual([{ v: false }]);
  });

  it('communications (guard e CHECK) usa a função atualizada', async () => {
    const y = await mkYouth(groupA);
    const ins = (email: string) => t.q(
      `INSERT INTO public.communications (youth_id, recipient_email, subject, body, created_by)
       VALUES ($1, $2, 'Assunto', 'Corpo', $3)`, [y, email, coord]);
    await expect(ins('a%0d%0abcc%3dx@y.com')).rejects.toThrow(/e-mail de destinatário válido|recipient_email|check/i);
    await ins('a+b.c_d-e@y.com');
  });
});

// ---------------------------------------------------------------------------------------------
describe('5) privilégios de tabela', () => {
  const relations = () => t.q<{ oid: number; relname: string }>(
    `SELECT c.oid::int AS oid, c.relname FROM pg_class c
      WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p', 'v', 'm', 'f') ORDER BY 2`);
  const has = async (role: string, oid: number, priv: string) =>
    (await t.q<{ h: boolean }>(`SELECT has_table_privilege($1, $2::oid, $3) AS h`, [role, oid, priv]))[0].h;

  it('nenhuma tabela de public concede TRUNCATE/REFERENCES/TRIGGER a anon/authenticated; anon não tem NENHUM privilégio', async () => {
    const rels = await relations();
    expect(rels.length).toBeGreaterThan(15);
    for (const r of rels) {
      for (const priv of ['TRUNCATE', 'REFERENCES', 'TRIGGER']) {
        expect(await has('authenticated', r.oid, priv), `authenticated ${priv} ${r.relname}`).toBe(false);
        expect(await has('anon', r.oid, priv), `anon ${priv} ${r.relname}`).toBe(false);
      }
      for (const priv of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
        expect(await has('anon', r.oid, priv), `anon ${priv} ${r.relname}`).toBe(false);
      }
    }
  });

  it('authenticated não consegue TRUNCATE (ignoraria o RLS); anon não lê nada', async () => {
    for (const u of [coord, leaderA]) {
      for (const table of ['youth', 'attendance', 'follow_up_transfers', 'activity_log', 'app_settings']) {
        await expect(t.as(u, () => t.q(`TRUNCATE public.${table} CASCADE`)), table).rejects.toThrow(/permission denied/);
      }
    }
    for (const table of ['youth', 'groups', 'events', 'attendance', 'alerts', 'tasks', 'profiles', 'user_roles',
      'app_settings', 'follow_ups', 'communications', 'activity_log']) {
      await expect(t.as(null, () => t.q(`SELECT * FROM public.${table}`)), table).rejects.toThrow(/permission denied/);
    }
    expect(await t.q(`SELECT 1 FROM public.youth`)).not.toBeNull();   // nada foi truncado
  });

  it('o que o app faz continua funcionando para authenticated (leitura/escrita sob RLS)', async () => {
    const y = await mkYouth(groupA);
    expect((await t.as(leaderA, () => t.q(`SELECT id FROM public.youth WHERE id = $1`, [y])))).toHaveLength(1);
    expect((await t.as(leaderB, () => t.q(`SELECT id FROM public.youth WHERE id = $1`, [y])))).toHaveLength(0);
    await t.as(leaderA, () => t.q(`UPDATE public.youth SET phone = '1199999' WHERE id = $1`, [y]));
    expect(await t.as(coord, () => t.q(`INSERT INTO public.groups (name) VALUES ('Grupo novo') RETURNING id`))).toHaveLength(1);
  });

  it('tabelas futuras: privilégios padrão sem anon e sem TRUNCATE/REFERENCES/TRIGGER para authenticated', async () => {
    await t.q(`CREATE TABLE public.zz_future (id int)`);
    try {
      const [{ oid }] = await t.q<{ oid: number }>(`SELECT 'public.zz_future'::regclass::oid::int AS oid`);
      for (const priv of ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) {
        expect(await has('anon', oid, priv), `anon ${priv}`).toBe(false);
      }
      for (const priv of ['TRUNCATE', 'REFERENCES', 'TRIGGER']) {
        expect(await has('authenticated', oid, priv), `authenticated ${priv}`).toBe(false);
      }
      // authenticated mantém o CRUD padrão (a proteção real é o RLS que cada tabela nova precisa ligar)
      expect(await has('authenticated', oid, 'SELECT')).toBe(true);
      expect(await has('service_role', oid, 'TRUNCATE')).toBe(true);
    } finally {
      await t.q(`DROP TABLE public.zz_future`);
    }
  });
});

// ---------------------------------------------------------------------------------------------
describe('6) search_path das funções SECURITY DEFINER', () => {
  it('toda função SECURITY DEFINER de public tem search_path fixo terminando em pg_temp', async () => {
    const fns = await t.q<{ sig: string; sp: string | null }>(
      `SELECT p.oid::regprocedure::text AS sig,
              (SELECT substr(c, 13) FROM unnest(COALESCE(p.proconfig, '{}'::text[])) c WHERE c LIKE 'search_path=%') AS sp
         FROM pg_proc p
        WHERE p.pronamespace = 'public'::regnamespace AND p.prosecdef
          AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')`);
    expect(fns.length).toBeGreaterThan(30);
    expect(fns.filter((f) => f.sp === null).map((f) => f.sig)).toEqual([]);
    const bad = fns.filter((f) => !/^public(, ?[\w$"]+)*, pg_temp$/.test(f.sp!)).map((f) => `${f.sig} -> ${f.sp}`);
    expect(bad).toEqual([]);
  });

  it('funções que não eram DEFINER não foram alteradas', async () => {
    const [fn] = await t.q<{ cfg: string }>(
      `SELECT proconfig::text AS cfg FROM pg_proc
        WHERE proname = 'app_today' AND pronamespace = 'public'::regnamespace`);
    expect(fn.cfg).toBe('{search_path=public}');
  });
});
