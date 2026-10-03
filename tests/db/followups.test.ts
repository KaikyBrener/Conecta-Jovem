import { beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './harness';

// Migration 011 (Fase 7, blocos 2-5): acompanhamentos (follow_ups + transferência), ações atrasadas,
// alertas por tempo (no_followup / overdue_action) e situação do jovem (youth_situation[s]).
//
// Limitação do harness: relógio real. Para "fazer o tempo passar" os testes envelhecem o alerta de
// faltas direto no banco (created_at), e usam datas de prazo relativas a public.app_today().

let t: TestDb;
let coord: string, coord2: string, leaderA: string, leaderB: string, leaderC: string;
let groupA: string, groupB: string, groupC: string;
let day = -4000;
let seqName = 0;

type Mark = 'p' | 'a' | '-';

interface AlertRow {
  id: string; type: string; status: string; severity: string; sample_size: number | null;
  consecutive_absences: number; resolution_notes: string | null; resolved_by: string | null;
  episode_ended: boolean; group_id: string | null; last_event_id: string | null;
}

interface Sit {
  youth_id: string; full_name: string; inactive: boolean; group_id: string | null; group_name: string | null;
  leader_name: string | null; attendance_rate: number | null; consecutive_absences: number; events_total: number;
  last_event: string | null; open_actions: number; overdue_actions: number; last_follow_up: string | null;
  situation: string; reasons: string[];
}

async function mkYouth(group: string | null = groupA, active = true): Promise<string> {
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

async function rec(ev: string, youth: string, present: boolean) {
  await t.q(
    `INSERT INTO public.attendance (event_id, youth_id, group_id, present, recorded_by)
     SELECT $1, y.id, y.group_id, $3, NULL FROM public.youth y WHERE y.id = $2
     ON CONFLICT (event_id, youth_id) DO UPDATE SET present = EXCLUDED.present`,
    [ev, youth, present]);
}

async function seq(youth: string, marks: Mark[], group = groupA) {
  for (const m of marks) {
    const ev = await mkEvent([group]);
    if (m !== '-') await rec(ev, youth, m === 'p');
  }
}

const alertsOf = (youth: string, type?: string) =>
  t.q<AlertRow>(
    `SELECT id, type::text AS type, status::text AS status, severity::text AS severity, sample_size,
            consecutive_absences, resolution_notes, resolved_by, episode_ended, group_id, last_event_id
       FROM public.alerts WHERE youth_id = $1 AND ($2::text IS NULL OR type::text = $2)
      ORDER BY created_at, id`,
    [youth, type ?? null]);

const openOf = async (youth: string, type: string) =>
  (await alertsOf(youth, type)).find((a) => a.status === 'open') ?? null;

/** Faz o alerta de faltas parecer ter sido criado há `days` dias (o relógio do teste é real). */
const ageAlert = (id: string, days: number) =>
  t.q(`UPDATE public.alerts SET created_at = now() - ($2 || ' days')::interval WHERE id = $1`, [id, String(days)]);

const sync = (user = coord) => t.as(user, () => t.q(`SELECT public.sync_time_alerts()`));

/** Jovem com 3 faltas seguidas e alerta de faltas envelhecido `age` dias. */
async function youthWithFaltas(age = 0, group = groupA) {
  const y = await mkYouth(group);
  await seq(y, ['a', 'a', 'a'], group);
  const fa = (await openOf(y, 'consecutive_absences'))!;
  if (age) await ageAlert(fa.id, age);
  return { y, fa };
}

interface FuOpts {
  reason?: string; ago?: number; responsible?: string | null; task?: string | null; alert?: string | null;
  completes?: boolean; nextDue?: string | null; createdBy?: string | null; notes?: string | null;
}
function addFu(user: string, youth: string, o: FuOpts = {}): Promise<string> {
  return t.as(user, async () => (await t.q<{ id: string }>(
    `INSERT INTO public.follow_ups
       (youth_id, reason, occurred_at, responsible_id, task_id, alert_id, completes_task, next_action_due, created_by, notes)
     VALUES ($1, $2, public.app_today() - $3::int, $4, $5, $6, $7, $8::date, $9, $10) RETURNING id`,
    [youth, o.reason ?? 'Conversa após as faltas', o.ago ?? 0, o.responsible ?? null, o.task ?? null,
     o.alert ?? null, o.completes ?? false, o.nextDue ?? null, o.createdBy ?? null, o.notes ?? null]))[0].id);
}

const fuRow = async (id: string) =>
  (await t.q<Record<string, any>>(`SELECT * FROM public.follow_ups WHERE id = $1`, [id]))[0];

/** Cria tarefa (como superusuário) para o jovem; due = dias relativos a hoje (negativo = atrasada). */
async function addTask(youth: string | null, due: number | null, status = 'pending', extra: { alert?: string } = {}) {
  const [r] = await t.q<{ id: string }>(
    `INSERT INTO public.tasks (title, youth_id, due_date, status, alert_id, created_by)
     VALUES ('Ação', $1, CASE WHEN $2::int IS NULL THEN NULL ELSE public.app_today() + $2::int END,
             $3::task_status, $4, $5) RETURNING id`,
    [youth, due, status, extra.alert ?? null, coord]);
  return r.id;
}
const setTask = (id: string, sql: string) => t.q(`UPDATE public.tasks SET ${sql} WHERE id = $1`, [id]);

const sit = (user: string | null, ids: string[]) =>
  t.as(user, () => t.q<Sit>(`SELECT * FROM public.youth_situations($1::uuid[])`, [ids]));
const sit1 = async (user: string | null, id: string) => (await sit(user, [id]))[0];

const transfer = (user: string | null, fu: string, to: string, reason = 'Mudou o acompanhamento') =>
  t.as(user, async () => (await t.q<{ r: Record<string, any> }>(
    `SELECT public.transfer_follow_up($1, $2, $3) AS r`, [fu, to, reason]))[0].r);

const history = (fu: string) =>
  t.q<{ from_responsible_id: string | null; to_responsible_id: string; reason: string; transferred_by: string }>(
    `SELECT from_responsible_id, to_responsible_id, reason, transferred_by
       FROM public.follow_up_transfers WHERE follow_up_id = $1 ORDER BY transferred_at, id`, [fu]);

const setSettings = (sql: string) => t.as(coord, () => t.q(`UPDATE public.app_settings SET ${sql}`));

beforeAll(async () => {
  t = await createTestDb();
  coord = await t.createUser('Coordenadora', 'coordinator');
  coord2 = await t.createUser('Coordenador 2', 'coordinator');
  leaderA = await t.createUser('Líder A', 'leader');
  leaderB = await t.createUser('Líder B', 'leader');
  leaderC = await t.createUser('Líder C', 'leader');
  const mkGroup = async (name: string, leader: string) =>
    (await t.q<{ id: string }>(`INSERT INTO public.groups (name, leader_id) VALUES ($1, $2) RETURNING id`, [name, leader]))[0].id;
  groupA = await mkGroup('Grupo A', leaderA);
  groupB = await mkGroup('Grupo B', leaderB);
  groupC = await mkGroup('Grupo C', leaderC);
}, 60_000);

// ---------------------------------------------------------------------------------------------
describe('estrutura da migration 011', () => {
  it('RLS ligado nas tabelas novas; anon sem nenhum acesso', async () => {
    const rows = await t.q<{ relname: string; relrowsecurity: boolean }>(
      `SELECT relname, relrowsecurity FROM pg_class
        WHERE relname IN ('follow_ups', 'follow_up_transfers') AND relnamespace = 'public'::regnamespace ORDER BY 1`);
    expect(rows).toEqual([
      { relname: 'follow_up_transfers', relrowsecurity: true },
      { relname: 'follow_ups', relrowsecurity: true }]);
    await expect(t.as(null, () => t.q(`SELECT * FROM public.follow_ups`))).rejects.toThrow(/permission denied/);
    await expect(t.as(null, () => t.q(`SELECT * FROM public.follow_up_transfers`))).rejects.toThrow(/permission denied/);
  });

  it('configuração padrão e limites de followup_grace_days (1..90)', async () => {
    const [s] = await t.q(`SELECT followup_grace_days FROM public.app_settings`);
    expect(s).toEqual({ followup_grace_days: 7 });
    await expect(setSettings(`followup_grace_days = 0`)).rejects.toThrow(/check/i);
    await expect(setSettings(`followup_grace_days = 91`)).rejects.toThrow(/check/i);
    const r = await t.as(leaderA, () => t.q(`UPDATE public.app_settings SET followup_grace_days = 3 RETURNING id`));
    expect(r).toHaveLength(0);
  });

  it('grants: internas sem EXECUTE; RPCs só para authenticated', async () => {
    const privs = await t.q<{ proname: string; anon: boolean; authed: boolean; definer: boolean }>(
      `SELECT p.proname, p.prosecdef AS definer,
              has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
              has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authed
         FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
          AND p.proname IN ('refresh_time_alerts', 'refresh_youth_time_alerts', 'sync_time_alerts', 'transfer_follow_up',
                            'youth_situation', 'youth_situations', 'follow_ups_guard', 'tasks_followup_guard',
                            'follow_ups_complete_task', 'tasks_refresh_time_alerts', 'follow_ups_refresh_time_alerts',
                            'alerts_refresh_time_alerts', 'youth_refresh_time_alerts', 'follow_up_transfers_immutable')
        ORDER BY 1`);
    const by = Object.fromEntries(privs.map((p) => [p.proname, p]));
    for (const n of ['refresh_time_alerts', 'refresh_youth_time_alerts', 'follow_ups_guard', 'tasks_followup_guard',
      'follow_ups_complete_task', 'tasks_refresh_time_alerts', 'follow_ups_refresh_time_alerts',
      'alerts_refresh_time_alerts', 'youth_refresh_time_alerts', 'follow_up_transfers_immutable']) {
      expect(by[n], n).toMatchObject({ anon: false, authed: false });
    }
    for (const n of ['sync_time_alerts', 'transfer_follow_up', 'youth_situation', 'youth_situations']) {
      expect(by[n], n).toMatchObject({ anon: false, authed: true });
    }
    // SECURITY DEFINER sempre com search_path fixo
    const bad = await t.q(
      `SELECT proname FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND prosecdef
          AND proname IN ('refresh_time_alerts','refresh_youth_time_alerts','sync_time_alerts','transfer_follow_up','youth_situations',
                          'tasks_refresh_time_alerts','follow_ups_refresh_time_alerts','alerts_refresh_time_alerts','youth_refresh_time_alerts')
          AND NOT (proconfig::text LIKE '%search_path=public%')`);
    expect(bad).toEqual([]);
  });

  it('funções internas e funções-trigger não são chamáveis via RPC', async () => {
    const y = await mkYouth();
    await expect(t.as(coord, () => t.q(`SELECT public.refresh_time_alerts()`))).rejects.toThrow(/permission denied/);
    await expect(t.as(coord, () => t.q(`SELECT public.refresh_youth_time_alerts($1)`, [y]))).rejects.toThrow(/permission denied/);
    await expect(t.as(coord, () => t.q(`SELECT public.follow_ups_guard()`))).rejects.toThrow(/permission denied/);
    await expect(t.as(null, () => t.q(`SELECT public.sync_time_alerts()`))).rejects.toThrow(/permission denied/);
    await expect(t.as(null, () => t.q(`SELECT * FROM public.youth_situations(ARRAY[$1]::uuid[])`, [y]))).rejects.toThrow(/permission denied/);
    await expect(transfer(null, crypto.randomUUID(), coord)).rejects.toThrow(/permission denied/);
  });
});

// ---------------------------------------------------------------------------------------------
describe('acompanhamento: criação e validação', () => {
  it('coordenador cria; padrões, responsável = ele, grupo do jovem e data de hoje', async () => {
    const y = await mkYouth(groupA);
    const id = await addFu(coord, y);
    const f = await fuRow(id);
    expect(f).toMatchObject({ youth_id: y, group_id: groupA, responsible_id: coord, created_by: coord, type: 'conversation',
      completes_task: false });
    const [{ ok }] = await t.q<{ ok: boolean }>(`SELECT $1::date = public.app_today() AS ok`, [f.occurred_at]);
    expect(ok).toBe(true);
  });

  it('motivo obrigatório (vazio, só espaços), data futura e prazo anterior ao contato são rejeitados em pt-BR', async () => {
    const y = await mkYouth();
    await expect(addFu(coord, y, { reason: '' })).rejects.toThrow(/Informe o motivo/);
    await expect(addFu(coord, y, { reason: '   ' })).rejects.toThrow(/Informe o motivo/);
    await expect(addFu(coord, y, { ago: -5 })).rejects.toThrow(/não pode estar no futuro/);
    await expect(addFu(coord, y, { nextDue: '2001-01-01' })).rejects.toThrow(/anterior à data do contato/);
    await expect(t.as(coord, () => t.q(
      `INSERT INTO public.follow_ups (youth_id, reason, occurred_at) VALUES ($1, 'x', '1990-01-01')`, [y]))).rejects.toThrow(/check/i);
    // amanhã é tolerado (fuso); trim do motivo
    const id = await addFu(coord, y, { ago: -1, reason: '  Visita  ' });
    expect((await fuRow(id)).reason).toBe('Visita');
  });

  it('tipos do enum; tipo inválido rejeitado', async () => {
    const y = await mkYouth();
    for (const ty of ['conversation', 'call', 'in_person', 'guidance', 'return', 'other']) {
      await t.as(coord, () => t.q(`INSERT INTO public.follow_ups (youth_id, reason, type) VALUES ($1, 'x', $2)`, [y, ty]));
    }
    await expect(t.as(coord, () => t.q(
      `INSERT INTO public.follow_ups (youth_id, reason, type) VALUES ($1, 'x', 'whatsapp')`, [y]))).rejects.toThrow(/invalid input value/);
  });

  it('líder cria para jovem do seu grupo: responsável = ele; created_by forjado é sobrescrito', async () => {
    const y = await mkYouth(groupA);
    const id = await addFu(leaderA, y, { createdBy: coord });
    expect(await fuRow(id)).toMatchObject({ responsible_id: leaderA, created_by: leaderA, group_id: groupA });
  });

  it('líder não cria para jovem de outro grupo, sem grupo, nem para terceiro como responsável', async () => {
    const yb = await mkYouth(groupB);
    const ynone = await mkYouth(null);
    const ya = await mkYouth(groupA);
    await expect(addFu(leaderA, yb)).rejects.toThrow(/Jovem não encontrado|row-level security/);
    await expect(addFu(leaderA, ynone)).rejects.toThrow(/Jovem não encontrado|row-level security/);
    await expect(addFu(leaderA, ya, { responsible: coord })).rejects.toThrow(/sob a sua responsabilidade/);
    await expect(addFu(leaderA, ya, { responsible: leaderB })).rejects.toThrow(/sob a sua responsabilidade/);
  });

  it('coordenador escolhe responsável válido (coordenador ou líder do grupo do jovem); inválido é rejeitado', async () => {
    const y = await mkYouth(groupA);
    expect((await fuRow(await addFu(coord, y, { responsible: leaderA }))).responsible_id).toBe(leaderA);
    expect((await fuRow(await addFu(coord, y, { responsible: coord2 }))).responsible_id).toBe(coord2);
    await expect(addFu(coord, y, { responsible: leaderB })).rejects.toThrow(/coordenador ou líder do grupo/);
    const none = await mkYouth(null);
    await expect(addFu(coord, none, { responsible: leaderA })).rejects.toThrow(/coordenador ou líder do grupo/);
    await expect(addFu(coord, none, { responsible: crypto.randomUUID() })).rejects.toThrow(/coordenador ou líder|foreign key/);
  });

  it('alerta e ação vinculados precisam ser do mesmo jovem', async () => {
    const { y, fa } = await youthWithFaltas();
    const other = await mkYouth();
    const taskOk = await addTask(y, 5);
    const taskOther = await addTask(other, 5);
    const taskNoYouth = await addTask(null, 5);
    expect(await addFu(coord, y, { alert: fa.id, task: taskOk })).toBeTruthy();
    await expect(addFu(coord, other, { alert: fa.id })).rejects.toThrow(/alerta informado não pertence/);
    await expect(addFu(coord, y, { task: taskOther })).rejects.toThrow(/ação informada não pertence/);
    await expect(addFu(coord, y, { task: taskNoYouth })).rejects.toThrow(/ação informada não pertence/);
    await expect(t.as(coord, () => t.q(
      `INSERT INTO public.follow_ups (youth_id, reason, completes_task) VALUES ($1, 'x', true)`, [y]))).rejects.toThrow(/Selecione a ação/);
  });

  it('líder não vincula alerta/ação que não enxerga (de outro grupo)', async () => {
    const ya = await mkYouth(groupA);
    const { fa } = await youthWithFaltas(0, groupB);
    await expect(addFu(leaderA, ya, { alert: fa.id })).rejects.toThrow(/alerta informado não pertence/);
  });
});

// ---------------------------------------------------------------------------------------------
describe('acompanhamento: edição, imutabilidade e RLS', () => {
  it('clientes não mudam responsible_id, youth_id, created_by, created_at nem group_id direto', async () => {
    const y = await mkYouth(groupA);
    const y2 = await mkYouth(groupA);
    const id = await addFu(leaderA, y);
    const before = await fuRow(id);
    for (const u of [leaderA, coord]) {
      await expect(t.as(u, () => t.q(`UPDATE public.follow_ups SET responsible_id = $2 WHERE id = $1`, [id, coord2])))
        .rejects.toThrow(/só pode ser alterado pela transferência|row-level security/);
      await expect(t.as(u, () => t.q(`UPDATE public.follow_ups SET youth_id = $2 WHERE id = $1`, [id, y2])))
        .rejects.toThrow(/trocar o jovem|row-level security/);
    }
    // created_by / created_at / group_id: alteração silenciosamente ignorada
    await t.as(leaderA, () => t.q(
      `UPDATE public.follow_ups SET created_by = $2, created_at = '2001-01-01', group_id = $3, notes = 'ok' WHERE id = $1`,
      [id, coord, groupB]));
    const after = await fuRow(id);
    expect(after).toMatchObject({ created_by: before.created_by, group_id: groupA, notes: 'ok', responsible_id: leaderA });
    expect(new Date(after.created_at).getTime()).toBe(new Date(before.created_at).getTime());
    expect(after.updated_at).not.toBeNull();
  });

  it('líder edita apenas onde é o responsável ATUAL; o de coordenador fica intocado', async () => {
    const y = await mkYouth(groupA);
    const mine = await addFu(leaderA, y);
    const theirs = await addFu(coord, y); // responsável = coordenadora
    const ok = await t.as(leaderA, () => t.q(`UPDATE public.follow_ups SET notes = 'meu' WHERE id = $1 RETURNING id`, [mine]));
    const no = await t.as(leaderA, () => t.q(`UPDATE public.follow_ups SET notes = 'alheio' WHERE id = $1 RETURNING id`, [theirs]));
    expect(ok).toHaveLength(1);
    expect(no).toHaveLength(0);
    expect((await fuRow(theirs)).notes).toBeNull();
    // líder enxerga o do coordenador (jovem do seu grupo), só não edita
    expect(await t.as(leaderA, () => t.q(`SELECT id FROM public.follow_ups WHERE id = $1`, [theirs]))).toHaveLength(1);
  });

  it('só coordenador exclui; líder não apaga nem o que criou', async () => {
    const y = await mkYouth(groupA);
    const id = await addFu(leaderA, y);
    expect(await t.as(leaderA, () => t.q(`DELETE FROM public.follow_ups WHERE id = $1 RETURNING id`, [id]))).toHaveLength(0);
    expect(await fuRow(id)).toBeTruthy();
    expect(await t.as(coord, () => t.q(`DELETE FROM public.follow_ups WHERE id = $1 RETURNING id`, [id]))).toHaveLength(1);
  });

  it('leitura: líder só vê acompanhamentos de jovens dos seus grupos; coordenador vê todos', async () => {
    const ya = await mkYouth(groupA);
    const yb = await mkYouth(groupB);
    const fa = await addFu(coord, ya);
    const fb = await addFu(coord, yb);
    const ids = async (u: string) =>
      (await t.as(u, () => t.q<{ id: string }>(`SELECT id FROM public.follow_ups WHERE id IN ($1, $2)`, [fa, fb]))).map((r) => r.id).sort();
    expect(await ids(leaderA)).toEqual([fa]);
    expect(await ids(leaderB)).toEqual([fb]);
    expect(await ids(leaderC)).toEqual([]);
    expect(await ids(coord)).toEqual([fa, fb].sort());
  });

  it('jovem que muda de grupo: o líder antigo perde o acesso, o novo ganha', async () => {
    const y = await mkYouth(groupA);
    const id = await addFu(coord, y);
    await t.q(`UPDATE public.youth SET group_id = $2 WHERE id = $1`, [y, groupB]);
    expect(await t.as(leaderA, () => t.q(`SELECT id FROM public.follow_ups WHERE id = $1`, [id]))).toHaveLength(0);
    expect(await t.as(leaderB, () => t.q(`SELECT id FROM public.follow_ups WHERE id = $1`, [id]))).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------
describe('transfer_follow_up', () => {
  it('coordenador transfere para o líder do grupo: histórico gravado e responsável atualizado atomicamente', async () => {
    const y = await mkYouth(groupA);
    const id = await addFu(coord, y);
    const r = await transfer(coord, id, leaderA, '  Líder do grupo assume  ');
    expect(r).toMatchObject({ follow_up_id: id, from_responsible_id: coord, to_responsible_id: leaderA,
      reason: 'Líder do grupo assume', transferred_by: coord });
    expect((await fuRow(id)).responsible_id).toBe(leaderA);
    expect(await history(id)).toEqual([
      { from_responsible_id: coord, to_responsible_id: leaderA, reason: 'Líder do grupo assume', transferred_by: coord }]);
  });

  it('só o responsável ATUAL é ativo: quem transferiu perde o direito de editar e de transferir', async () => {
    const y = await mkYouth(groupA);
    const id = await addFu(leaderA, y);
    await transfer(leaderA, id, coord, 'Caso complexo, coordenação assume');
    expect((await fuRow(id)).responsible_id).toBe(coord);
    // o líder (ex-responsável) continua VENDO o acompanhamento e o histórico, mas não edita nem transfere
    expect(await t.as(leaderA, () => t.q(`SELECT id FROM public.follow_ups WHERE id = $1`, [id]))).toHaveLength(1);
    expect(await t.as(leaderA, () => t.q(`UPDATE public.follow_ups SET notes = 'x' WHERE id = $1 RETURNING id`, [id]))).toHaveLength(0);
    await expect(transfer(leaderA, id, leaderA, 'voltar')).rejects.toThrow(/Somente o responsável atual/);
    // volta para o líder; a lista de histórico preserva a ordem
    await transfer(coord, id, leaderA, 'Devolvido ao grupo');
    const h = await history(id);
    expect(h.map((x) => [x.from_responsible_id, x.to_responsible_id])).toEqual([[leaderA, coord], [coord, leaderA]]);
    const [{ n }] = await t.q<{ n: number }>(
      `SELECT count(*)::int AS n FROM public.follow_ups WHERE id = $1 AND responsible_id = $2`, [id, leaderA]);
    expect(n).toBe(1);
  });

  it('destino inválido (líder de outro grupo, inexistente, jovem sem grupo) e mesma pessoa são rejeitados sem gravar nada', async () => {
    const y = await mkYouth(groupA);
    const id = await addFu(coord, y);
    await expect(transfer(coord, id, leaderB)).rejects.toThrow(/coordenador ou líder do grupo atual/);
    await expect(transfer(coord, id, crypto.randomUUID())).rejects.toThrow(/coordenador ou líder do grupo atual/);
    await expect(transfer(coord, id, coord)).rejects.toThrow(/já é a responsável/);
    await expect(transfer(coord, id, leaderA, '   ')).rejects.toThrow(/Informe o motivo/);
    expect(await history(id)).toEqual([]);
    expect((await fuRow(id)).responsible_id).toBe(coord);

    const none = await mkYouth(null);
    const idn = await addFu(coord, none);
    await expect(transfer(coord, idn, leaderA)).rejects.toThrow(/coordenador ou líder do grupo atual/);
    await transfer(coord, idn, coord2); // coordenador sempre é destino válido
    expect((await fuRow(idn)).responsible_id).toBe(coord2);
  });

  it('o destino acompanha o grupo ATUAL do jovem', async () => {
    const y = await mkYouth(groupA);
    const id = await addFu(coord, y);
    await t.q(`UPDATE public.youth SET group_id = $2 WHERE id = $1`, [y, groupB]);
    await expect(transfer(coord, id, leaderA)).rejects.toThrow(/coordenador ou líder do grupo atual/);
    await transfer(coord, id, leaderB, 'Jovem mudou de grupo');
    expect((await fuRow(id)).responsible_id).toBe(leaderB);
  });

  it('líder de outro grupo não transfere (nem descobre que existe); líder do grupo mas não responsável também não', async () => {
    const y = await mkYouth(groupA);
    const id = await addFu(coord, y);                 // responsável: coordenadora
    await expect(transfer(leaderB, id, leaderB)).rejects.toThrow(/não encontrado ou sem permissão/);
    await expect(transfer(leaderA, id, leaderA)).rejects.toThrow(/Somente o responsável atual/);
    await expect(transfer(leaderB, crypto.randomUUID(), leaderB)).rejects.toThrow(/não encontrado ou sem permissão/);
    expect(await history(id)).toEqual([]);
    // responsável removido (NULL): só o criador (coordenadora aqui) ou coordenação; o líder que não criou não transfere
    await t.q(`UPDATE public.follow_ups SET responsible_id = NULL WHERE id = $1`, [id]);
    await expect(transfer(leaderA, id, leaderA)).rejects.toThrow(/Somente o responsável atual/);
    await transfer(coord, id, leaderA, 'Reatribuído');
    expect((await fuRow(id)).responsible_id).toBe(leaderA);
  });

  it('cliente não escreve no histórico nem altera/apaga o que existe (privilégio e trigger)', async () => {
    const y = await mkYouth(groupA);
    const id = await addFu(leaderA, y);
    await transfer(leaderA, id, coord, 'Passando para a coordenação');
    for (const u of [coord, leaderA]) {
      await expect(t.as(u, () => t.q(
        `INSERT INTO public.follow_up_transfers (follow_up_id, to_responsible_id, reason) VALUES ($1, $2, 'forjado')`, [id, u])))
        .rejects.toThrow(/permission denied/);
      await expect(t.as(u, () => t.q(`UPDATE public.follow_up_transfers SET reason = 'x' WHERE follow_up_id = $1`, [id])))
        .rejects.toThrow(/permission denied/);
      await expect(t.as(u, () => t.q(`DELETE FROM public.follow_up_transfers WHERE follow_up_id = $1`, [id])))
        .rejects.toThrow(/permission denied/);
    }
    expect(await history(id)).toHaveLength(1);
  });

  it('histórico: líder só vê o dos acompanhamentos que enxerga; coordenador vê tudo; apagar o acompanhamento leva o histórico junto', async () => {
    const ya = await mkYouth(groupA);
    const id = await addFu(coord, ya);
    await transfer(coord, id, leaderA);
    const count = (u: string) =>
      t.as(u, async () => (await t.q<{ n: number }>(
        `SELECT count(*)::int AS n FROM public.follow_up_transfers WHERE follow_up_id = $1`, [id]))[0].n);
    expect(await count(leaderA)).toBe(1);
    expect(await count(leaderB)).toBe(0);
    expect(await count(leaderC)).toBe(0);
    expect(await count(coord)).toBe(1);
    await t.as(coord, () => t.q(`DELETE FROM public.follow_ups WHERE id = $1`, [id]));
    expect(await history(id)).toEqual([]);
  });

  it('atualiza updated_at do acompanhamento e mantém created_by', async () => {
    const y = await mkYouth(groupA);
    const id = await addFu(coord, y);
    const before = await fuRow(id);
    await transfer(coord, id, leaderA);
    const after = await fuRow(id);
    expect(after.created_by).toBe(before.created_by);
    expect(new Date(after.updated_at).getTime()).toBeGreaterThanOrEqual(new Date(before.updated_at).getTime());
  });
});

// ---------------------------------------------------------------------------------------------
describe('ações: atraso objetivo e conclusão', () => {
  it('is_task_overdue: só pending/in_progress com prazo anterior a hoje', async () => {
    const q = async (st: string, off: number | null) =>
      (await t.q<{ v: boolean }>(
        `SELECT public.is_task_overdue($1::task_status, CASE WHEN $2::int IS NULL THEN NULL ELSE public.app_today() + $2::int END) AS v`,
        [st, off]))[0].v;
    expect(await q('pending', -1)).toBe(true);
    expect(await q('in_progress', -30)).toBe(true);
    expect(await q('pending', 0)).toBe(false);   // vence hoje: ainda no prazo
    expect(await q('pending', 3)).toBe(false);
    expect(await q('pending', null)).toBe(false);
    expect(await q('done', -5)).toBe(false);
    expect(await q('cancelled', -5)).toBe(false);
  });

  it('concluir/cancelar/reabrir ação NUNCA altera attendance nem as faltas consecutivas', async () => {
    const { y, fa } = await youthWithFaltas();
    const snap = () => t.q(
      `SELECT event_id, youth_id, group_id, present, recorded_by, created_at FROM public.attendance
        WHERE youth_id = $1 ORDER BY event_id`, [y]);
    const before = await snap();
    expect(before).toHaveLength(3);

    // ação criada pelo líder, ligada ao alerta de faltas e ao jovem
    const [task] = await t.as(leaderA, () => t.q<{ id: string }>(
      `INSERT INTO public.tasks (title, youth_id, alert_id, assigned_to, due_date, created_by)
       VALUES ('Ligar', $1, $2, $3, public.app_today() + 2, $3) RETURNING id`, [y, fa.id, leaderA]));
    await t.as(leaderA, () => t.q(`UPDATE public.tasks SET status = 'in_progress' WHERE id = $1`, [task.id]));
    await t.as(leaderA, () => t.q(`UPDATE public.tasks SET status = 'done' WHERE id = $1`, [task.id]));
    expect(await snap()).toEqual(before);
    expect((await t.q<{ n: number }>(`SELECT public.youth_consecutive_absences($1) AS n`, [y]))[0].n).toBe(3);
    // (o alerta de faltas fecha como "resolvido pela tarefa" — o histórico de presença permanece)
    expect((await alertsOf(y, 'consecutive_absences'))[0].status).toBe('resolved');

    await t.as(leaderA, () => t.q(`UPDATE public.tasks SET status = 'pending' WHERE id = $1`, [task.id]));
    await t.as(leaderA, () => t.q(`UPDATE public.tasks SET status = 'cancelled' WHERE id = $1`, [task.id]));
    await t.as(coord, () => t.q(`DELETE FROM public.tasks WHERE id = $1`, [task.id]));
    expect(await snap()).toEqual(before);
    expect((await t.q<{ n: number }>(`SELECT public.youth_consecutive_absences($1) AS n`, [y]))[0].n).toBe(3);
  });

  it('acompanhamento com completes_task conclui a ação e registra quem concluiu; reabrir limpa o vínculo', async () => {
    const { y } = await youthWithFaltas();
    const [task] = await t.as(leaderA, () => t.q<{ id: string }>(
      `INSERT INTO public.tasks (title, youth_id, assigned_to, due_date, created_by)
       VALUES ('Visitar', $1, $2, public.app_today() - 3, $2) RETURNING id`, [y, leaderA]));
    expect(await openOf(y, 'overdue_action')).not.toBeNull();

    const fu = await addFu(leaderA, y, { task: task.id, completes: true, reason: 'Visita realizada' });
    const [row] = await t.q<{ status: string; completed_by_follow_up_id: string; completed_at: string | null }>(
      `SELECT status::text AS status, completed_by_follow_up_id, completed_at FROM public.tasks WHERE id = $1`, [task.id]);
    expect(row.status).toBe('done');
    expect(row.completed_by_follow_up_id).toBe(fu);
    expect(row.completed_at).not.toBeNull();
    expect(await openOf(y, 'overdue_action')).toBeNull(); // atraso resolvido

    await t.as(leaderA, () => t.q(`UPDATE public.tasks SET status = 'pending' WHERE id = $1`, [task.id]));
    const [re] = await t.q<{ completed_by_follow_up_id: string | null }>(
      `SELECT completed_by_follow_up_id FROM public.tasks WHERE id = $1`, [task.id]);
    expect(re.completed_by_follow_up_id).toBeNull();
  });

  it('acompanhamento só conclui ação aberta (concluída/cancelada permanecem) e não afeta ação de outro jovem', async () => {
    const y = await mkYouth();
    const cancelled = await addTask(y, 5, 'cancelled');
    await addFu(coord, y, { task: cancelled, completes: true });
    expect((await t.q<{ s: string }>(`SELECT status::text AS s FROM public.tasks WHERE id = $1`, [cancelled]))[0].s).toBe('cancelled');
  });

  it('completed_by_follow_up_id não pode ser forjado nem apontar para acompanhamento de outra ação', async () => {
    const y = await mkYouth();
    const t1 = await addTask(y, 5);
    const t2 = await addTask(y, 5);
    const fu = await addFu(coord, y, { task: t1 });
    await expect(t.as(coord, () => setTask(t2, `status = 'done', completed_by_follow_up_id = '${fu}'`)))
      .rejects.toThrow(/Acompanhamento inválido/);
    await t.as(coord, () => setTask(t1, `status = 'done', completed_by_follow_up_id = '${fu}'`)); // legítimo
    // preenchido enquanto não concluída => limpo
    await t.as(coord, () => setTask(t2, `completed_by_follow_up_id = NULL`));
  });
});

// ---------------------------------------------------------------------------------------------
describe('alerta no_followup', () => {
  it('respeita a carência, é idempotente e conta os dias desde o alerta de faltas', async () => {
    const { y, fa } = await youthWithFaltas(0);
    await sync();
    expect(await openOf(y, 'no_followup')).toBeNull();
    await ageAlert(fa.id, 6);
    await sync();
    expect(await openOf(y, 'no_followup')).toBeNull();      // 6 < 7 dias
    await ageAlert(fa.id, 8);
    await sync(); await sync(); await sync(coord2);          // idempotente e vale para qualquer usuário
    const all = await alertsOf(y, 'no_followup');
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ status: 'open', severity: 'attention', sample_size: 8, consecutive_absences: 0,
      group_id: groupA, last_event_id: fa.last_event_id });
  });

  it('registrar acompanhamento resolve sozinho (histórico fica) e não recria; excluir o acompanhamento reabre a pendência', async () => {
    const { y, fa } = await youthWithFaltas(9);
    await sync();
    expect(await openOf(y, 'no_followup')).not.toBeNull();

    const fu = await addFu(leaderA, y);
    let all = await alertsOf(y, 'no_followup');
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ status: 'resolved', episode_ended: true });
    expect(all[0].resolution_notes).toMatch(/acompanhamento registrado/);
    expect(all[0].resolved_by).toBeNull();                    // encerramento automático
    await sync();
    expect(await openOf(y, 'no_followup')).toBeNull();
    expect((await openOf(y, 'consecutive_absences'))?.id).toBe(fa.id); // faltas continuam abertas e intactas

    await t.as(coord, () => t.q(`DELETE FROM public.follow_ups WHERE id = $1`, [fu]));
    all = await alertsOf(y, 'no_followup');
    expect(all).toHaveLength(2);
    expect(all.filter((a) => a.status === 'open')).toHaveLength(1);
  });

  it('acompanhamento anterior ao alerta de faltas não conta', async () => {
    const { y } = await youthWithFaltas(8);
    await addFu(coord, y, { ago: 30 });
    await sync();
    expect(await openOf(y, 'no_followup')).not.toBeNull();
  });

  it('acompanhamento de OUTRO jovem não conta', async () => {
    const { y } = await youthWithFaltas(8);
    const other = await mkYouth();
    await addFu(coord, other);
    await sync();
    expect(await openOf(y, 'no_followup')).not.toBeNull();
  });

  it('encerramento manual não recria na mesma condição; novo episódio (faltas zeradas e de novo) recria', async () => {
    const { y } = await youthWithFaltas(8);
    await sync();
    const open = (await openOf(y, 'no_followup'))!;
    await t.as(leaderA, () => t.q(`UPDATE public.alerts SET status = 'dismissed' WHERE id = $1`, [open.id]));
    await sync(); await sync();
    expect(await openOf(y, 'no_followup')).toBeNull();
    expect(await alertsOf(y, 'no_followup')).toHaveLength(1);

    // presença quebra a sequência: alerta de faltas fecha (automático) e encerra o episódio
    await seq(y, ['p']);
    expect(await openOf(y, 'consecutive_absences')).toBeNull();
    expect((await alertsOf(y, 'no_followup'))[0].episode_ended).toBe(true);

    await seq(y, ['a', 'a', 'a']);
    const fa2 = (await openOf(y, 'consecutive_absences'))!;
    await ageAlert(fa2.id, 10);
    await sync();
    const all = await alertsOf(y, 'no_followup');
    expect(all).toHaveLength(2);
    expect(all.filter((a) => a.status === 'open')).toHaveLength(1);
  });

  it('resolve sozinho quando o alerta de faltas fecha (manual ou automático) ou o jovem é inativado', async () => {
    const a = await youthWithFaltas(8);
    await sync();
    expect(await openOf(a.y, 'no_followup')).not.toBeNull();
    await t.as(coord, () => t.q(`UPDATE public.alerts SET status = 'resolved' WHERE id = $1`, [a.fa.id]));
    const ra = (await alertsOf(a.y, 'no_followup'))[0];
    expect(ra).toMatchObject({ status: 'resolved' });
    expect(ra.resolution_notes).toMatch(/alerta de faltas foi encerrado/);

    const b = await youthWithFaltas(8);
    await sync();
    await seq(b.y, ['p']);
    expect(await openOf(b.y, 'no_followup')).toBeNull();

    const c = await youthWithFaltas(8);
    await sync();
    expect(await openOf(c.y, 'no_followup')).not.toBeNull();
    await t.as(coord, () => t.q(`UPDATE public.youth SET is_active = false WHERE id = $1`, [c.y]));
    expect(await openOf(c.y, 'no_followup')).toBeNull();
    expect((await alertsOf(c.y, 'no_followup'))[0].resolution_notes).toMatch(/inativado/);
  });

  it('mudar followup_grace_days reavalia: aumentar resolve, reduzir cria', async () => {
    const { y } = await youthWithFaltas(8);
    await sync();
    expect(await openOf(y, 'no_followup')).not.toBeNull();
    await setSettings(`followup_grace_days = 14`);
    expect(await openOf(y, 'no_followup')).toBeNull();
    await setSettings(`followup_grace_days = 7`);
    expect(await openOf(y, 'no_followup')).not.toBeNull();
  });

  it('RLS: líder só enxerga o alerta do próprio grupo e só altera status/observações', async () => {
    const { y } = await youthWithFaltas(8);
    await sync();
    const al = (await openOf(y, 'no_followup'))!;
    const visible = (u: string) =>
      t.as(u, () => t.q(`SELECT id FROM public.alerts WHERE id = $1`, [al.id]));
    expect(await visible(leaderA)).toHaveLength(1);
    expect(await visible(leaderB)).toHaveLength(0);
    await expect(t.as(leaderA, () => t.q(`UPDATE public.alerts SET sample_size = 99 WHERE id = $1`, [al.id])))
      .rejects.toThrow(/Somente o status/);
    await t.as(leaderA, () => t.q(`UPDATE public.alerts SET resolution_notes = 'ok' WHERE id = $1`, [al.id]));
  });

  it('o caminho só por sync_time_alerts() funciona (sem depender de trigger) e recalculate_all_alerts também gera', async () => {
    const { y, fa } = await youthWithFaltas(0);
    await t.q(`ALTER TABLE public.alerts DISABLE TRIGGER alerts_refresh_time_alerts`);
    await ageAlert(fa.id, 12);
    await t.q(`ALTER TABLE public.alerts ENABLE TRIGGER alerts_refresh_time_alerts`);
    expect(await openOf(y, 'no_followup')).toBeNull();        // o tempo passou, mas nenhum evento disparou
    await sync();
    expect(await openOf(y, 'no_followup')).toMatchObject({ sample_size: 12 });

    await t.q(`ALTER TABLE public.tasks DISABLE TRIGGER tasks_refresh_time_alerts`);
    const y2 = await mkYouth();
    await addTask(y2, -2);
    await t.q(`ALTER TABLE public.tasks ENABLE TRIGGER tasks_refresh_time_alerts`);
    expect(await openOf(y2, 'overdue_action')).toBeNull();
    await t.as(coord, () => t.q(`SELECT public.recalculate_all_alerts()`));
    expect(await openOf(y2, 'overdue_action')).toMatchObject({ sample_size: 1 });
  });
});

// ---------------------------------------------------------------------------------------------
describe('alerta overdue_action', () => {
  it('cria ao existir ação atrasada com jovem; conta, atualiza e não duplica', async () => {
    const y = await mkYouth();
    const t1 = await addTask(y, -2);
    let al = (await alertsOf(y, 'overdue_action'));
    expect(al).toHaveLength(1);
    expect(al[0]).toMatchObject({ status: 'open', severity: 'attention', sample_size: 1, group_id: groupA });
    const t2 = await addTask(y, -10, 'in_progress');
    await sync(); await sync();
    al = await alertsOf(y, 'overdue_action');
    expect(al).toHaveLength(1);
    expect(al[0].sample_size).toBe(2);

    await setTask(t1, `status = 'done'`);
    expect((await openOf(y, 'overdue_action'))?.sample_size).toBe(1);
    await setTask(t2, `due_date = public.app_today() + 4`);       // prazo prorrogado
    al = await alertsOf(y, 'overdue_action');
    expect(al[0]).toMatchObject({ status: 'resolved' });
    expect(al[0].resolution_notes).toMatch(/nenhuma ação atrasada/);
    expect(al[0].resolved_by).toBeNull();
  });

  it('não gera alerta: vence hoje, futuro, sem prazo, concluída, cancelada, sem jovem, jovem inativo', async () => {
    const y = await mkYouth();
    await addTask(y, 0); await addTask(y, 7); await addTask(y, null);
    await addTask(y, -3, 'done'); await addTask(y, -3, 'cancelled');
    await addTask(null, -9);
    const inactive = await mkYouth(groupA, false);
    await addTask(inactive, -9);
    await sync();
    expect(await alertsOf(y, 'overdue_action')).toHaveLength(0);
    expect(await alertsOf(inactive, 'overdue_action')).toHaveLength(0);
    const [{ n }] = await t.q<{ n: number }>(
      `SELECT count(*)::int AS n FROM public.alerts WHERE type::text = 'overdue_action' AND youth_id IS NULL`);
    expect(n).toBe(0);
  });

  it('cancelar ou excluir a última ação atrasada resolve; reabrir atrasada recria (encerramento automático)', async () => {
    const y = await mkYouth();
    const a = await addTask(y, -4);
    await setTask(a, `status = 'cancelled'`);
    expect(await openOf(y, 'overdue_action')).toBeNull();
    await setTask(a, `status = 'pending'`);
    expect(await openOf(y, 'overdue_action')).not.toBeNull();
    await t.q(`DELETE FROM public.tasks WHERE id = $1`, [a]);
    expect(await openOf(y, 'overdue_action')).toBeNull();
    expect(await alertsOf(y, 'overdue_action')).toHaveLength(2);   // histórico preservado
  });

  it('inativar o jovem resolve; trocar a ação de jovem atualiza os dois', async () => {
    const y = await mkYouth();
    const z = await mkYouth();
    const a = await addTask(y, -4);
    expect(await openOf(y, 'overdue_action')).not.toBeNull();
    await setTask(a, `youth_id = '${z}'`);
    expect(await openOf(y, 'overdue_action')).toBeNull();
    expect(await openOf(z, 'overdue_action')).not.toBeNull();
    await t.q(`UPDATE public.youth SET is_active = false WHERE id = $1`, [z]);
    expect(await openOf(z, 'overdue_action')).toBeNull();
  });

  it('encerramento manual não recria enquanto houver atraso; recria só em novo episódio', async () => {
    const y = await mkYouth();
    const a = await addTask(y, -4);
    const al = (await openOf(y, 'overdue_action'))!;
    await t.as(leaderA, () => t.q(`UPDATE public.alerts SET status = 'dismissed' WHERE id = $1`, [al.id]));
    await addTask(y, -1);                      // mais atraso, mesmo episódio
    await sync();
    expect(await openOf(y, 'overdue_action')).toBeNull();
    expect(await alertsOf(y, 'overdue_action')).toHaveLength(1);

    await t.q(`UPDATE public.tasks SET status = 'done' WHERE youth_id = $1`, [y]);   // tudo em dia
    expect((await alertsOf(y, 'overdue_action'))[0].episode_ended).toBe(true);
    await addTask(y, -1);                      // novo atraso
    expect(await alertsOf(y, 'overdue_action')).toHaveLength(2);
    expect(await openOf(y, 'overdue_action')).not.toBeNull();
    void a;
  });

  it('ação criada pelo líder via RLS dispara o alerta; um líder não vê o alerta do grupo alheio', async () => {
    const y = await mkYouth(groupA);
    await t.as(leaderA, () => t.q(
      `INSERT INTO public.tasks (title, youth_id, assigned_to, due_date, created_by)
       VALUES ('Atrasada', $1, $2, public.app_today() - 5, $2)`, [y, leaderA]));
    const al = (await openOf(y, 'overdue_action'))!;
    expect(al).toBeTruthy();
    expect(await t.as(leaderA, () => t.q(`SELECT id FROM public.alerts WHERE id = $1`, [al.id]))).toHaveLength(1);
    expect(await t.as(leaderB, () => t.q(`SELECT id FROM public.alerts WHERE id = $1`, [al.id]))).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------------
describe('nomes para a UI: assignable_responsibles e follow_up_people', () => {
  const assignable = (u: string | null, y: string) =>
    t.as(u, () => t.q<{ id: string; full_name: string; role: string }>(
      `SELECT * FROM public.assignable_responsibles($1)`, [y]));
  const people = (u: string | null, f: string) =>
    t.as(u, () => t.q<{ id: string; full_name: string }>(`SELECT * FROM public.follow_up_people($1)`, [f]));

  it('assignable_responsibles: coordenadores + líder do grupo atual, só com escopo; nada além disso', async () => {
    const y = await mkYouth(groupA);
    const expected = [coord, coord2, leaderA].sort();
    for (const u of [coord, leaderA]) {
      const r = await assignable(u, y);
      expect(r.map((x) => x.id).sort()).toEqual(expected);
      expect(r.find((x) => x.id === leaderA)).toMatchObject({ full_name: 'Líder A', role: 'leader' });
      expect(r.find((x) => x.id === coord)).toMatchObject({ full_name: 'Coordenadora', role: 'coordinator' });
    }
    expect(await assignable(leaderB, y)).toEqual([]);                       // líder de outro grupo
    expect(await assignable(leaderA, crypto.randomUUID())).toEqual([]);     // inexistente
    expect(await assignable(leaderA, await mkYouth(null))).toEqual([]);     // sem grupo: líder sem escopo
    expect((await assignable(coord, await mkYouth(null))).map((x) => x.id).sort()).toEqual([coord, coord2].sort());
    await expect(assignable(null, y)).rejects.toThrow(/permission denied/);
    // os candidatos são exatamente os destinos aceitos por transfer_follow_up
    const fu = await addFu(coord, y);
    for (const id of expected) { if (id !== coord) await transfer(coord, fu, id); await t.q(`UPDATE public.follow_ups SET responsible_id = $2 WHERE id = $1`, [fu, coord]); }
    await expect(transfer(coord, fu, leaderB)).rejects.toThrow(/coordenador ou líder do grupo atual/);
  });

  it('follow_up_people: responsável, criador e participantes das transferências, só para quem acessa o acompanhamento', async () => {
    const y = await mkYouth(groupA);
    const fu = await addFu(leaderA, y);
    await transfer(leaderA, fu, coord2, 'Coordenação assume');
    const names = (r: { id: string; full_name: string }[]) => r.map((x) => x.full_name).sort();
    expect(names(await people(leaderA, fu))).toEqual(['Coordenador 2', 'Líder A']);
    expect(names(await people(coord, fu))).toEqual(['Coordenador 2', 'Líder A']);
    expect(await people(leaderB, fu)).toEqual([]);
    expect(await people(leaderA, crypto.randomUUID())).toEqual([]);
    await expect(people(null, fu)).rejects.toThrow(/permission denied/);
    // jovem mudou de grupo: o líder antigo perde o acesso aos nomes
    await t.q(`UPDATE public.youth SET group_id = $2 WHERE id = $1`, [y, groupB]);
    expect(await people(leaderA, fu)).toEqual([]);
    expect(names(await people(leaderB, fu))).toEqual(['Coordenador 2', 'Líder A']);
  });
});

// ---------------------------------------------------------------------------------------------
describe('exclusão de jovem com dados de acompanhamento', () => {
  it('coordenador exclui jovem com alerta, acompanhamento, histórico e ação atrasada sem erro', async () => {
    const { y } = await youthWithFaltas(9);
    await sync();
    const task = await addTask(y, -3);
    const fu = await addFu(coord, y, { task });
    await transfer(coord, fu, leaderA);
    await t.as(coord, () => t.q(`DELETE FROM public.youth WHERE id = $1`, [y]));
    expect(await history(fu)).toEqual([]);
    expect(await alertsOf(y)).toEqual([]);
    const [tk] = await t.q<{ youth_id: string | null }>(`SELECT youth_id FROM public.tasks WHERE id = $1`, [task]);
    expect(tk.youth_id).toBeNull();
  });

  it('excluir a ação ou o alerta vinculado não apaga o acompanhamento (vínculo vira NULL)', async () => {
    const y = await mkYouth();
    const task = await addTask(y, 5);
    const fu = await addFu(coord, y, { task, completes: true });
    await t.q(`DELETE FROM public.tasks WHERE id = $1`, [task]);
    const f = await fuRow(fu);
    expect(f.task_id).toBeNull();
    expect(f.completes_task).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
describe('youth_situation / youth_situations', () => {
  it('normal: dados do grupo, líder, frequência, último encontro e zero motivos', async () => {
    const y = await mkYouth(groupA);
    await seq(y, ['p', 'p', 'a', 'p']);
    const s = await sit1(leaderA, y);
    expect(s).toMatchObject({ youth_id: y, inactive: false, group_id: groupA, group_name: 'Grupo A', leader_name: 'Líder A',
      attendance_rate: 75, consecutive_absences: 0, events_total: 4, open_actions: 0, overdue_actions: 0,
      last_follow_up: null, situation: 'normal', reasons: [] });
    expect(s.last_event).not.toBeNull();
  });

  it('sem nenhum registro: taxa nula, 0 encontros, sem último encontro, normal', async () => {
    const y = await mkYouth(groupA);
    const s = await sit1(coord, y);
    expect(s).toMatchObject({ attendance_rate: null, events_total: 0, last_event: null, consecutive_absences: 0, situation: 'normal' });
  });

  it('encontros cancelados e "não registrado" não contam', async () => {
    const y = await mkYouth(groupA);
    await seq(y, ['p']);
    const ev = await mkEvent([groupA], 'cancelled');
    await rec(ev, y, false);
    await seq(y, ['-', '-']);
    const s = await sit1(coord, y);
    expect(s).toMatchObject({ events_total: 1, attendance_rate: 100, consecutive_absences: 0, situation: 'normal' });
  });

  it('attention por faltas consecutivas (>= limite) e critical (>= crítico)', async () => {
    const y = await mkYouth(groupA);
    await seq(y, ['p', 'a', 'a']);
    expect((await sit1(coord, y)).situation).toBe('normal');           // 2 < 3
    await seq(y, ['a']);
    expect(await sit1(coord, y)).toMatchObject({ situation: 'attention', consecutive_absences: 3, reasons: expect.arrayContaining(['3 faltas seguidas']) });
    await seq(y, ['a', 'a']);
    expect((await sit1(coord, y)).situation).toBe('attention');         // 5 < 6
    await seq(y, ['a']);
    const s = await sit1(coord, y);
    expect(s).toMatchObject({ situation: 'critical', consecutive_absences: 6 });
    expect(s.reasons[0]).toBe('6 faltas seguidas');
    // coerente com o alerta (severity) calculado no banco
    expect((await openOf(y, 'consecutive_absences'))?.severity).toBe('critical');
  });

  it('crítico nunca fica abaixo do limite de alerta: GREATEST(critical, limite)', async () => {
    await setSettings(`absence_alert_threshold = 8, critical_absence_threshold = 6`);
    try {
      const y = await mkYouth(groupA);
      await seq(y, ['a', 'a', 'a', 'a', 'a', 'a', 'a']);
      // 7 < limite 8: não é "faltas seguidas" nem crítico (continua attention só pela frequência baixa, 0%)
      const s7 = await sit1(coord, y);
      expect(s7).toMatchObject({ consecutive_absences: 7, situation: 'attention' });
      expect(s7.reasons.some((r) => /faltas seguidas/.test(r))).toBe(false);
      await seq(y, ['a']);
      expect(await sit1(coord, y)).toMatchObject({ consecutive_absences: 8, situation: 'critical' });
    } finally {
      await setSettings(`absence_alert_threshold = 3, critical_absence_threshold = 6`);
    }
  });

  it('attention por ação atrasada (e a ação aberta em dia só conta como aberta)', async () => {
    const y = await mkYouth(groupA);
    await seq(y, ['p', 'p']);
    await addTask(y, 5);
    expect(await sit1(coord, y)).toMatchObject({ situation: 'normal', open_actions: 1, overdue_actions: 0 });
    await addTask(y, -2);
    await addTask(y, -9, 'in_progress');
    await addTask(y, -9, 'done');
    expect(await sit1(coord, y)).toMatchObject({ situation: 'attention', open_actions: 3, overdue_actions: 2,
      reasons: ['2 ações atrasadas'] });
  });

  it('attention por alerta de frequência baixa', async () => {
    const y = await mkYouth(groupA);
    await seq(y, ['p', 'a', 'p', 'a', 'p', 'a', 'p', 'a']);
    expect((await openOf(y, 'low_attendance'))).not.toBeNull();
    const s = await sit1(coord, y);
    expect(s).toMatchObject({ situation: 'attention', consecutive_absences: 1, attendance_rate: 50 });
    expect(s.reasons).toEqual(['Frequência baixa (50% nos últimos 8 registros)']);
  });

  it('attention por queda de frequência', async () => {
    const y = await mkYouth(groupA);
    await seq(y, ['p', 'p', 'p', 'p', 'a', 'p', 'a', 'a']);
    expect((await openOf(y, 'attendance_drop'))).not.toBeNull();
    const s = await sit1(coord, y);
    expect(s.situation).toBe('attention');
    expect(s.reasons.some((r) => r.startsWith('Queda de frequência'))).toBe(true);
  });

  it('attention por no_followup traz o motivo e last_follow_up reflete o último contato', async () => {
    const { y } = await youthWithFaltas(9);
    await sync();
    let s = await sit1(coord, y);
    expect(s.reasons).toEqual(['3 faltas seguidas', 'Sem acompanhamento há 9 dias']);
    await addFu(coord, y, { ago: 0 });
    s = await sit1(coord, y);
    expect(s.last_follow_up).not.toBeNull();
    expect(s.reasons).toEqual(['3 faltas seguidas']);
  });

  it('no_followup sozinho (faltas já abaixo do limite não existem) — attention vem do alerta aberto', async () => {
    // alerta no_followup aberto manualmente com faltas abaixo do limite ainda cobre a regra
    const y = await mkYouth(groupA);
    await seq(y, ['p']);
    await t.q(`INSERT INTO public.alerts (youth_id, group_id, type, sample_size) VALUES ($1, $2, 'no_followup', 12)`, [y, groupA]);
    expect(await sit1(coord, y)).toMatchObject({ situation: 'attention', reasons: ['Sem acompanhamento há 12 dias'] });
  });

  it('jovem inativo: normal, flag inactive, sem motivos (métricas continuam)', async () => {
    const y = await mkYouth(groupA);
    await seq(y, ['a', 'a', 'a', 'a', 'a', 'a', 'a']);
    await addTask(y, -4);
    expect((await sit1(coord, y)).situation).toBe('critical');
    await t.as(coord, () => t.q(`UPDATE public.youth SET is_active = false WHERE id = $1`, [y]));
    expect(await sit1(coord, y)).toMatchObject({ inactive: true, situation: 'normal', reasons: [], consecutive_absences: 7,
      overdue_actions: 1 });
  });

  it('escopo: coordenador vê todos; líder só os do seu grupo; jovem alheio/sem grupo/inexistente => nenhuma linha', async () => {
    const ya = await mkYouth(groupA);
    const yb = await mkYouth(groupB);
    const yn = await mkYouth(null);
    await seq(yb, ['a', 'a', 'a'], groupB);
    const ids = [ya, yb, yn, crypto.randomUUID()];
    expect((await sit(coord, ids)).map((r) => r.youth_id).sort()).toEqual([ya, yb, yn].sort());
    expect((await sit(leaderA, ids)).map((r) => r.youth_id)).toEqual([ya]);
    expect((await sit(leaderB, ids)).map((r) => r.youth_id)).toEqual([yb]);
    expect(await sit(leaderC, ids)).toEqual([]);
    // youth_situation (singular) segue o mesmo escopo e não vaza dados do alheio
    expect(await t.as(leaderA, () => t.q(`SELECT * FROM public.youth_situation($1)`, [yb]))).toEqual([]);
    expect(await t.as(leaderA, () => t.q(`SELECT * FROM public.youth_situation($1)`, [crypto.randomUUID()]))).toEqual([]);
    expect(await t.as(leaderA, () => t.q(`SELECT * FROM public.youth_situation($1)`, [yn]))).toEqual([]);
    expect((await t.as(coord, () => t.q(`SELECT * FROM public.youth_situation($1)`, [yb])))).toHaveLength(1);
  });

  it('lote: ordenado por nome, duplicados ignorados, vazio/NULL retornam nada, limite de 500', async () => {
    const a = await mkYouth(groupA);
    const b = await mkYouth(groupA);
    const rows = await sit(coord, [b, a, a]);
    expect(rows.map((r) => r.youth_id)).toEqual([a, b]);
    expect(await sit(coord, [])).toEqual([]);
    expect(await t.as(coord, () => t.q(`SELECT * FROM public.youth_situations(NULL)`))).toEqual([]);
    const many = Array.from({ length: 501 }, () => crypto.randomUUID());
    await expect(sit(coord, many)).rejects.toThrow(/no máximo 500/);
  });

  it('líder do grupo novo vê a mesma contagem de faltas dos alertas mesmo sem acesso às linhas antigas de attendance', async () => {
    const y = await mkYouth(groupA);
    await seq(y, ['a', 'a', 'a'], groupA);
    await t.q(`UPDATE public.youth SET group_id = $2 WHERE id = $1`, [y, groupB]);
    // o RLS de attendance usa o group_id gravado na linha: o líder B não lê o histórico antigo...
    expect(await t.as(leaderB, () => t.q(`SELECT 1 FROM public.attendance WHERE youth_id = $1`, [y]))).toHaveLength(0);
    // ...mas a situação usa o histórico completo, igual ao alerta
    const s = await sit1(leaderB, y);
    expect(s).toMatchObject({ consecutive_absences: 3, group_name: 'Grupo B', leader_name: 'Líder B', situation: 'attention' });
    expect((await openOf(y, 'consecutive_absences'))?.consecutive_absences).toBe(3);
    expect(await sit(leaderA, [y])).toEqual([]);                      // líder antigo perdeu o acesso
  });
});
