import { beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './harness';

// Migration 023: varredura diária dos alertas temporais por pg_cron.
// O PGlite NÃO tem pg_cron: aqui só se testa a FUNÇÃO e que a migration aplica sem a extensão (bloco de agendamento pulado).
// NÃO testado: cron.schedule/unschedule, horário em UTC e a limpeza de cron.job_run_details (conferir no projeto real).

let t: TestDb;
let coord: string, leader: string, group: string;
let seq = 0;
let day = -4000;

async function mkYouth(): Promise<string> {
  seq += 1;
  const [y] = await t.q<{ id: string }>(
    `INSERT INTO public.youth (full_name, group_id, is_active, created_by) VALUES ($1, $2, true, $3) RETURNING id`,
    [`Jovem Cron ${seq}`, group, coord]);
  return y.id;
}

async function absence(youth: string) {
  day += 1;
  const [ev] = await t.q<{ id: string }>(
    `INSERT INTO public.events (title, event_date, status, created_by)
     VALUES ('Encontro', now() + ($1 || ' days')::interval, 'completed', $2) RETURNING id`, [String(day), coord]);
  await t.q(`INSERT INTO public.event_groups (event_id, group_id) VALUES ($1, $2)`, [ev.id, group]);
  await t.q(
    `INSERT INTO public.attendance (event_id, youth_id, group_id, present, recorded_by)
     SELECT $1, y.id, y.group_id, false, NULL FROM public.youth y WHERE y.id = $2`, [ev.id, youth]);
}

/** 3 faltas; o alerta de faltas é envelhecido sem disparar o trigger: "no_followup" só nasce numa varredura. */
async function pendingTimeAlert(): Promise<string> {
  const y = await mkYouth();
  for (let i = 0; i < 3; i++) await absence(y);
  await t.q(`ALTER TABLE public.alerts DISABLE TRIGGER alerts_refresh_time_alerts`);
  await t.q(`UPDATE public.alerts SET created_at = now() - interval '12 days'
              WHERE youth_id = $1 AND type::text = 'consecutive_absences'`, [y]);
  await t.q(`ALTER TABLE public.alerts ENABLE TRIGGER alerts_refresh_time_alerts`);
  return y;
}

const openNoFollowup = async (youth: string) =>
  (await t.q(`SELECT 1 FROM public.alerts WHERE youth_id = $1 AND type::text = 'no_followup' AND status = 'open'`, [youth])).length;
const lastRun = async () =>
  (await t.q<{ last_run: string }>(`SELECT last_run::text AS last_run FROM public.time_alerts_sync_state`))[0].last_run;

beforeAll(async () => {
  t = await createTestDb();
  coord = await t.createUser('Coordenadora', 'coordinator');
  leader = await t.createUser('Líder', 'leader');
  [{ id: group }] = await t.q<{ id: string }>(
    `INSERT INTO public.groups (name, leader_id) VALUES ('Grupo Cron', $1) RETURNING id`, [leader]);
}, 60_000);

describe('migration 023 sem pg_cron', () => {
  it('aplica sem a extensão (agendamento pulado) e a função existe: DEFINER com pg_temp', async () => {
    expect(await t.q(`SELECT 1 FROM pg_extension WHERE extname = 'pg_cron'`)).toEqual([]);
    const [f] = await t.q<{ prosecdef: boolean; cfg: string }>(
      `SELECT prosecdef, array_to_string(proconfig, ' ') AS cfg FROM pg_proc
        WHERE proname = 'cron_refresh_time_alerts' AND pronamespace = 'public'::regnamespace`);
    expect(f.prosecdef).toBe(true);
    expect(f.cfg).toMatch(/search_path=.*pg_temp/);
  });
});

describe('cron_refresh_time_alerts()', () => {
  it('sem EXECUTE para PUBLIC, anon, authenticated e service_role; cliente autenticado é barrado no grant', async () => {
    for (const role of ['anon', 'authenticated', 'service_role']) {
      const [r] = await t.q<{ ok: boolean }>(
        `SELECT has_function_privilege($1, 'public.cron_refresh_time_alerts()', 'execute') AS ok`, [role]);
      expect(r.ok, role).toBe(false);
    }
    for (const u of [coord, leader, null]) {
      await expect(t.as(u, () => t.q(`SELECT public.cron_refresh_time_alerts()`))).rejects.toThrow(/permission denied/);
    }
  });

  it('sem sessão (como o pg_cron): cria o alerta temporal, atualiza last_run e é idempotente', async () => {
    const y = await pendingTimeAlert();
    expect(await openNoFollowup(y)).toBe(0);
    await t.q(`UPDATE public.time_alerts_sync_state SET last_run = now() - interval '1 hour'`);
    const before = await lastRun();

    const [r] = await t.q<{ n: number }>(`SELECT public.cron_refresh_time_alerts() AS n`);
    expect(r.n).toBeGreaterThanOrEqual(1);
    expect(await openNoFollowup(y)).toBe(1);
    expect(await lastRun() > before).toBe(true);

    const snap = () => t.q(`SELECT youth_id, type::text AS type, status::text AS status FROM public.alerts ORDER BY youth_id, type::text, created_at`);
    const first = await snap();
    await t.q(`SELECT public.cron_refresh_time_alerts()`);
    expect(await snap()).toEqual(first);
  });

  it('não grava activity_log para alertas criados sem sessão (activity_write não registra sem auth.uid())', async () => {
    const y = await pendingTimeAlert();
    const [{ n: before }] = await t.q<{ n: number }>(`SELECT count(*)::int AS n FROM public.activity_log WHERE youth_id = $1`, [y]);
    await t.q(`SELECT public.cron_refresh_time_alerts()`);
    expect(await openNoFollowup(y)).toBe(1);
    const [{ n: after }] = await t.q<{ n: number }>(`SELECT count(*)::int AS n FROM public.activity_log WHERE youth_id = $1`, [y]);
    expect(after).toBe(before);
  });

  it('com sessão de usuário (auth.uid() não nulo) recusa, mesmo para quem tem o privilégio de dono', async () => {
    await t.q(`SELECT set_config('request.jwt.claim.sub', $1, false)`, [coord]);
    try {
      await expect(t.q(`SELECT public.cron_refresh_time_alerts()`)).rejects.toThrow(/Função interna/);
    } finally {
      await t.q(`SELECT set_config('request.jwt.claim.sub', '', false)`);
    }
  });
});
