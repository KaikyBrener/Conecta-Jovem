import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './harness';

// Migration 012 (partes 1 e 2): attendance.group_id acompanha o grupo ATUAL do jovem (o histórico segue o
// jovem) e o resumo de save_attendance conta só jovens ativos.

let t: TestDb;
let coord: string, leaderA: string, leaderB: string, leaderC: string, leaderD: string;
let groupA: string, groupB: string, groupC: string, groupD1: string, groupD2: string;
let day = -3000;
let seqName = 0;

interface SaveResult {
  saved: number; present: number; absent: number; total_registered: number; rate: number;
  new_alerts: unknown[];
}

async function mkYouth(group: string | null, active = true): Promise<string> {
  seqName += 1;
  const [y] = await t.q<{ id: string }>(
    `INSERT INTO public.youth (full_name, group_id, is_active, created_by) VALUES ($1, $2, $3, $4) RETURNING id`,
    [`Jovem ${String(seqName).padStart(3, '0')}`, group, active, coord]);
  return y.id;
}

async function mkEvent(groups: string[], status = 'completed'): Promise<string> {
  day += 1;
  const [ev] = await t.q<{ id: string }>(
    `INSERT INTO public.events (title, event_date, status, created_by)
     VALUES ('Encontro', now() + ($1 || ' days')::interval, $2::event_status, $3) RETURNING id`,
    [String(day), status, coord]);
  for (const g of groups) {
    await t.q(`INSERT INTO public.event_groups (event_id, group_id) VALUES ($1, $2)`, [ev.id, g]);
  }
  return ev.id;
}

/** Grava presença como superusuário (group_id = grupo atual do jovem) */
async function rec(ev: string, youth: string, present: boolean) {
  await t.q(
    `INSERT INTO public.attendance (event_id, youth_id, group_id, present, recorded_by)
     SELECT $1, y.id, y.group_id, $3, NULL FROM public.youth y WHERE y.id = $2
     ON CONFLICT (event_id, youth_id) DO UPDATE SET present = EXCLUDED.present`,
    [ev, youth, present]);
}

const save = (user: string | null, ev: string, entries: unknown) =>
  t.as(user, async () =>
    (await t.q<{ r: SaveResult }>(`SELECT public.save_attendance($1::uuid, $2::jsonb) AS r`,
      [ev, JSON.stringify(entries)]))[0].r);

const rowsSeenBy = (user: string, youth: string) =>
  t.as(user, () => t.q<{ event_id: string; present: boolean }>(
    `SELECT event_id, present FROM public.attendance WHERE youth_id = $1`, [youth]));

const groupsOfRows = async (youth: string) =>
  (await t.q<{ group_id: string }>(`SELECT DISTINCT group_id FROM public.attendance WHERE youth_id = $1`, [youth]))
    .map((r) => r.group_id);

const moveYouth = (user: string, youth: string, group: string | null) =>
  t.as(user, () => t.q(`UPDATE public.youth SET group_id = $2 WHERE id = $1`, [youth, group]));

const alertsOf = (youth: string) =>
  t.q<{ id: string; status: string; group_id: string | null; consecutive_absences: number; type: string }>(
    `SELECT id, status::text AS status, group_id, consecutive_absences, type::text AS type
       FROM public.alerts WHERE youth_id = $1 ORDER BY created_at, id`, [youth]);

beforeAll(async () => {
  t = await createTestDb();
  coord = await t.createUser('Coordenadora', 'coordinator');
  leaderA = await t.createUser('Líder A', 'leader');
  leaderB = await t.createUser('Líder B', 'leader');
  leaderC = await t.createUser('Líder C', 'leader');
  leaderD = await t.createUser('Líder D', 'leader');
  const mkGroup = async (name: string, leader: string) =>
    (await t.q<{ id: string }>(`INSERT INTO public.groups (name, leader_id) VALUES ($1, $2) RETURNING id`, [name, leader]))[0].id;
  groupA = await mkGroup('Grupo A', leaderA);
  groupB = await mkGroup('Grupo B', leaderB);
  groupC = await mkGroup('Grupo C', leaderC);
  groupD1 = await mkGroup('Grupo D1', leaderD);
  groupD2 = await mkGroup('Grupo D2', leaderD);
}, 60_000);

describe('troca de grupo: attendance.group_id segue o jovem', () => {
  it('líder A salva; jovem vai ao grupo B; líder B salva (antes dava 42501) e vê o histórico; líder A deixa de ver', async () => {
    const y = await mkYouth(groupA);
    const other = await mkYouth(groupB);
    const evOld = await mkEvent([groupA]);            // encontro antigo, só do grupo A
    const evShared = await mkEvent([groupA, groupB]); // encontro com os dois grupos

    expect((await save(leaderA, evOld, [{ youth_id: y, present: false }])).saved).toBe(1);
    expect((await save(leaderA, evShared, [{ youth_id: y, present: false }])).saved).toBe(1);
    expect(await groupsOfRows(y)).toEqual([groupA]);

    await moveYouth(coord, y, groupB);

    // O histórico seguiu o jovem
    expect(await groupsOfRows(y)).toEqual([groupB]);

    // Líder B edita a presença do encontro compartilhado (o bug: 42501 em leader_update_attendance)
    const r = await save(leaderB, evShared, [{ youth_id: y, present: true }, { youth_id: other, present: true }]);
    expect(r.saved).toBe(2);
    expect(r.present).toBe(2);
    const row = await t.q<{ present: boolean; recorded_by: string; group_id: string }>(
      `SELECT present, recorded_by, group_id FROM public.attendance WHERE event_id = $1 AND youth_id = $2`, [evShared, y]);
    expect(row[0]).toMatchObject({ present: true, recorded_by: leaderB, group_id: groupB });

    // Líder B vê o histórico completo do jovem (inclusive o encontro antigo do grupo A); não vira "não registrado"
    const seenB = await rowsSeenBy(leaderB, y);
    expect(seenB.map((x) => x.event_id).sort()).toEqual([evOld, evShared].sort());

    // Líder A deixou de ver e de salvar
    expect(await rowsSeenBy(leaderA, y)).toEqual([]);
    await expect(save(leaderA, evShared, [{ youth_id: y, present: true }])).rejects.toThrow(/não pertencem/);

    // Encontro vinculado só ao grupo antigo: o líder B vê o registro, mas não o edita (mensagem clara, nada gravado)
    // (o líder B nem enxerga o encontro, que é só do grupo A: mesma mensagem genérica de sempre)
    await expect(save(leaderB, evOld, [{ youth_id: y, present: true }])).rejects.toThrow(/não encontrado|não pertencem/);
    const [still] = await t.q<{ present: boolean }>(
      `SELECT present FROM public.attendance WHERE event_id = $1 AND youth_id = $2`, [evOld, y]);
    expect(still.present).toBe(false);
  });

  it('coordenador continua vendo e editando tudo; troca de grupo pelo líder entre dois grupos dele também sincroniza', async () => {
    const y = await mkYouth(groupD1);
    const ev = await mkEvent([groupD1]);
    await save(leaderD, ev, [{ youth_id: y, present: true }]);

    // O líder D move o jovem para outro grupo DELE (a nova linha não passaria na policy de UPDATE de attendance
    // porque o encontro não está em D2): a função do trigger é DEFINER justamente para isso.
    await moveYouth(leaderD, y, groupD2);
    expect(await groupsOfRows(y)).toEqual([groupD2]);
    expect((await rowsSeenBy(leaderD, y)).length).toBe(1);

    const seenByCoord = await t.as(coord, () => t.q(`SELECT 1 FROM public.attendance WHERE youth_id = $1`, [y]));
    expect(seenByCoord.length).toBe(1);
  });

  it('jovem sem grupo: líder antigo não lê mais o histórico; coordenador lê; ao entrar em outro grupo o histórico vai junto', async () => {
    const y = await mkYouth(groupA);
    const ev = await mkEvent([groupA]);
    await save(leaderA, ev, [{ youth_id: y, present: false }]);

    await moveYouth(coord, y, null);
    expect(await rowsSeenBy(leaderA, y)).toEqual([]);
    expect((await t.as(coord, () => t.q(`SELECT 1 FROM public.attendance WHERE youth_id = $1`, [y]))).length).toBe(1);
    // attendance.group_id é NOT NULL: guarda o último grupo
    expect(await groupsOfRows(y)).toEqual([groupA]);

    await moveYouth(coord, y, groupC);
    expect(await groupsOfRows(y)).toEqual([groupC]);
    expect((await rowsSeenBy(leaderC, y)).length).toBe(1);
    expect(await rowsSeenBy(leaderA, y)).toEqual([]);
  });

  it('alertas continuam coerentes: o mesmo alerta aberto segue o jovem, sem duplicar nem zerar a sequência', async () => {
    const y = await mkYouth(groupA);
    for (let i = 0; i < 3; i++) {
      const ev = await mkEvent([groupA, groupB]);
      await save(leaderA, ev, [{ youth_id: y, present: false }]);
    }
    const before = await alertsOf(y);
    const faltas = before.filter((a) => a.type === 'consecutive_absences');
    expect(faltas).toHaveLength(1);
    expect(faltas[0]).toMatchObject({ status: 'open', group_id: groupA, consecutive_absences: 3 });

    await moveYouth(coord, y, groupB);

    const after = await alertsOf(y);
    expect(after.map((a) => a.id)).toEqual(before.map((a) => a.id)); // nenhum alerta novo, nenhum apagado
    const fa = after.find((a) => a.type === 'consecutive_absences')!;
    expect(fa).toMatchObject({ status: 'open', group_id: groupB, consecutive_absences: 3 });

    // Visibilidade do alerta segue o grupo atual
    const seenB = await t.as(leaderB, () => t.q(`SELECT id FROM public.alerts WHERE youth_id = $1`, [y]));
    const seenA = await t.as(leaderA, () => t.q(`SELECT id FROM public.alerts WHERE youth_id = $1`, [y]));
    expect(seenB.length).toBe(before.length);
    expect(seenA).toEqual([]);

    // Situação (histórico completo) igual para o novo líder
    const [sit] = await t.as(leaderB, () =>
      t.q<{ consecutive_absences: number; situation: string }>(`SELECT * FROM public.youth_situation($1)`, [y]));
    expect(sit.consecutive_absences).toBe(3);
    expect(['attention', 'critical']).toContain(sit.situation);

    // A nova líder registra uma presença: a sequência zera e o alerta se resolve (comportamento normal)
    const evNew = await mkEvent([groupB]);
    await save(leaderB, evNew, [{ youth_id: y, present: true }]);
    const final = await alertsOf(y);
    expect(final.find((a) => a.type === 'consecutive_absences')!.status).toBe('resolved');
  });

  it('só reescrever group_id não dispara recálculo de alertas por linha (trigger estreitado), mas present/youth_id/event_id disparam', async () => {
    const [def] = await t.q<{ def: string }>(
      `SELECT pg_get_triggerdef(oid) AS def FROM pg_trigger WHERE tgname = 'attendance_refresh_alert'`);
    expect(def.def).toMatch(/UPDATE OF event_id, youth_id, present/);
    expect(def.def).toMatch(/INSERT OR DELETE/);
  });
});

describe('backfill dos dados existentes', () => {
  it('o trecho de backfill da migration corrige linhas velhas e ignora jovem sem grupo', async () => {
    const sql = readFileSync(
      new URL('../../supabase/migrations/012_attendance_group_sync_dashboard.sql', import.meta.url), 'utf8');
    const m = sql.match(/-- >>> BACKFILL[^\n]*\n([\s\S]*?)-- <<< BACKFILL/);
    expect(m).not.toBeNull();

    const y = await mkYouth(groupA);
    const yNo = await mkYouth(groupA);
    const ev = await mkEvent([groupA, groupB]);
    await rec(ev, y, true);
    await rec(ev, yNo, true);

    // Simula dados antigos: muda o grupo SEM o trigger (como era antes da 012)
    await t.q(`ALTER TABLE public.youth DISABLE TRIGGER youth_sync_attendance_group`);
    await t.q(`UPDATE public.youth SET group_id = $2 WHERE id = $1`, [y, groupB]);
    await t.q(`UPDATE public.youth SET group_id = NULL WHERE id = $1`, [yNo]);
    await t.q(`ALTER TABLE public.youth ENABLE TRIGGER youth_sync_attendance_group`);
    expect(await groupsOfRows(y)).toEqual([groupA]); // velho: o bug original

    await t.db.exec(m![1]);

    expect(await groupsOfRows(y)).toEqual([groupB]);
    expect(await groupsOfRows(yNo)).toEqual([groupA]); // sem grupo: não há para onde reapontar
    // Idempotente
    await t.db.exec(m![1]);
    expect(await groupsOfRows(y)).toEqual([groupB]);
    // E o novo líder já consegue salvar
    expect((await save(leaderB, ev, [{ youth_id: y, present: false }])).saved).toBe(1);
  });
});

describe('segurança do trigger de sincronização', () => {
  it('função do trigger sem EXECUTE para anon/authenticated e DEFINER com search_path fixo', async () => {
    const [fn] = await t.q<Record<string, any>>(
      `SELECT p.prosecdef AS definer, p.proconfig::text AS cfg,
              has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
              has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authed
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = 'youth_sync_attendance_group'`);
    expect(fn.definer).toBe(true);
    expect(fn.cfg).toMatch(/search_path=public/);
    expect(fn.anon).toBe(false);
    expect(fn.authed).toBe(false);
  });

  it('líder não consegue mover jovem para grupo alheio (RLS de youth continua valendo) e nada é reescrito', async () => {
    const y = await mkYouth(groupA);
    const ev = await mkEvent([groupA]);
    await save(leaderA, ev, [{ youth_id: y, present: true }]);
    await expect(moveYouth(leaderA, y, groupB)).rejects.toThrow();
    expect(await groupsOfRows(y)).toEqual([groupA]);
  });

  it('RLS de attendance preservada: líder não lê jovem de grupo alheio nem anon lê', async () => {
    const y = await mkYouth(groupB);
    const ev = await mkEvent([groupB]);
    await save(leaderB, ev, [{ youth_id: y, present: true }]);
    expect(await rowsSeenBy(leaderA, y)).toEqual([]);
    // anon: sem privilégio algum (migration 016); antes era "0 linhas por RLS"
    await expect(t.as(null, () => t.q(`SELECT * FROM public.attendance`))).rejects.toThrow(/permission denied/);
  });
});

describe('save_attendance: resumo só com jovens ativos', () => {
  it('present/absent/total_registered/rate ignoram jovens inativos; assinatura e chaves do JSON iguais', async () => {
    const a1 = await mkYouth(groupC), a2 = await mkYouth(groupC), a3 = await mkYouth(groupC);
    const inactive = await mkYouth(groupC, false);
    const ev = await mkEvent([groupC]);
    await rec(ev, inactive, true);   // registro antigo de quem foi inativado depois

    const r = await save(leaderC, ev, [
      { youth_id: a1, present: true }, { youth_id: a2, present: false }, { youth_id: a3, present: true },
    ]);
    expect(r).toMatchObject({ saved: 3, present: 2, absent: 1, total_registered: 3, rate: 67 });
    expect(Object.keys(r).sort()).toEqual(['absent', 'new_alerts', 'present', 'rate', 'saved', 'total_registered']);

    // O inativo continua gravado (histórico), só não entra no resumo
    const [row] = await t.q<{ n: number }>(`SELECT count(*)::int AS n FROM public.attendance WHERE event_id = $1`, [ev]);
    expect(row.n).toBe(4);
  });

  it('encontro só com inativos => total 0 e rate 0 (como antes)', async () => {
    const inactive = await mkYouth(groupC, false);
    const ev = await mkEvent([groupC]);
    await rec(ev, inactive, false);
    const r = await save(leaderC, ev, []);
    expect(r).toMatchObject({ saved: 0, present: 0, absent: 0, total_registered: 0, rate: 0 });
  });

  it('privilégios de save_attendance preservados: INVOKER, authenticated sim, anon não', async () => {
    const [fn] = await t.q<Record<string, any>>(
      `SELECT p.prosecdef AS definer,
              has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
              has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authed
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = 'save_attendance'`);
    expect(fn).toEqual({ definer: false, anon: false, authed: true });
  });
});
