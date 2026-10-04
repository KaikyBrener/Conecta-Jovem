import { beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './harness';

// Migration 010 (Fase 7, blocos 1-2): chamada com 3 estados (save_attendance), alertas objetivos
// (severity, low_attendance, attendance_drop) e a regra "resolver/dispensar nunca apaga faltas".

let t: TestDb;
let coord: string, leaderA: string, leaderB: string;
let groupA: string, groupB: string;
let day = -3000;
let retroDay = -9000; // datas "antigas" para chamadas retroativas
let seqName = 0;

type Mark = 'p' | 'a' | '-'; // presente | ausente | não registrado (sem linha)

interface AlertRow {
  id: string; type: string; status: string; severity: string; consecutive_absences: number;
  attendance_rate: number | null; previous_rate: number | null; sample_size: number | null;
  resolution_notes: string | null; resolved_by: string | null; episode_ended: boolean;
}

async function mkYouth(group = groupA, active = true): Promise<string> {
  seqName += 1;
  const [y] = await t.q<{ id: string }>(
    `INSERT INTO public.youth (full_name, group_id, is_active, created_by) VALUES ($1, $2, $3, $4) RETURNING id`,
    [`Jovem ${seqName}`, group, active, coord]);
  return y.id;
}

async function mkEvent(groups: string[], opts: { status?: string; at?: number } = {}): Promise<string> {
  const offset = opts.at ?? (day += 1);
  const [ev] = await t.q<{ id: string }>(
    `INSERT INTO public.events (title, event_date, status, created_by)
     VALUES ('Encontro', now() + ($1 || ' days')::interval, $2::event_status, $3) RETURNING id`,
    [String(offset), opts.status ?? 'completed', coord]);
  for (const g of groups) {
    await t.q(`INSERT INTO public.event_groups (event_id, group_id) VALUES ($1, $2)`, [ev.id, g]);
  }
  return ev.id;
}

/** Registra (como superusuário) a presença de um jovem, no grupo atual dele. */
async function rec(ev: string, youth: string, present: boolean) {
  await t.q(
    `INSERT INTO public.attendance (event_id, youth_id, group_id, present, recorded_by)
     SELECT $1, y.id, y.group_id, $3, NULL FROM public.youth y WHERE y.id = $2
     ON CONFLICT (event_id, youth_id) DO UPDATE SET present = EXCLUDED.present`,
    [ev, youth, present]);
}

/** Cria um encontro por marca, em ordem cronológica; '-' cria o encontro mas não registra nada. */
async function seq(youth: string, marks: Mark[], group = groupA): Promise<string[]> {
  const evs: string[] = [];
  for (const m of marks) {
    const ev = await mkEvent([group]);
    evs.push(ev);
    if (m !== '-') await rec(ev, youth, m === 'p');
  }
  return evs;
}

const alertsOf = (youth: string, type?: string) =>
  t.q<AlertRow>(
    `SELECT id, type::text AS type, status::text AS status, severity::text AS severity, consecutive_absences,
            attendance_rate, previous_rate, sample_size, resolution_notes, resolved_by, episode_ended
       FROM public.alerts WHERE youth_id = $1 AND ($2::text IS NULL OR type::text = $2)
      ORDER BY created_at, id`,
    [youth, type ?? null]);

async function openOf(youth: string, type: string): Promise<AlertRow | null> {
  return (await alertsOf(youth, type)).find((a) => a.status === 'open') ?? null;
}

const consecutive = async (youth: string) =>
  (await t.q<{ n: number }>(`SELECT public.youth_consecutive_absences($1) AS n`, [youth]))[0].n;

const attendanceCount = async (youth: string) =>
  (await t.q<{ n: number }>(`SELECT count(*)::int AS n FROM public.attendance WHERE youth_id = $1`, [youth]))[0].n;

interface SaveResult {
  saved: number; present: number; absent: number; total_registered: number; rate: number;
  new_alerts: { id: string; youth_id: string; youth_name: string; type: string; severity: string; consecutive_absences: number }[];
}

function save(user: string | null, ev: string, entries: unknown): Promise<SaveResult> {
  return t.as(user, async () =>
    (await t.q<{ r: SaveResult }>(`SELECT public.save_attendance($1::uuid, $2::jsonb) AS r`,
      [ev, JSON.stringify(entries)]))[0].r);
}

const rowOf = async (ev: string, youth: string) =>
  (await t.q<{ present: boolean; group_id: string; recorded_by: string | null }>(
    `SELECT present, group_id, recorded_by FROM public.attendance WHERE event_id = $1 AND youth_id = $2`,
    [ev, youth]))[0];

const setSettings = (sql: string) => t.as(coord, () => t.q(`UPDATE public.app_settings SET ${sql}`));
const resetSettings = () =>
  setSettings(`absence_alert_threshold = 3, critical_absence_threshold = 6, low_attendance_threshold = 70`);

beforeAll(async () => {
  t = await createTestDb();
  coord = await t.createUser('Coordenadora', 'coordinator');
  leaderA = await t.createUser('Líder A', 'leader');
  leaderB = await t.createUser('Líder B', 'leader');
  [{ id: groupA }] = await t.q<{ id: string }>(
    `INSERT INTO public.groups (name, leader_id) VALUES ('Grupo A', $1) RETURNING id`, [leaderA]);
  [{ id: groupB }] = await t.q<{ id: string }>(
    `INSERT INTO public.groups (name, leader_id) VALUES ('Grupo B', $1) RETURNING id`, [leaderB]);
}, 60_000);

describe('estrutura da migration 010', () => {
  it('novos tipos, colunas e configuração padrão', async () => {
    const types = await t.q<{ v: string }>(
      `SELECT e.enumlabel AS v FROM pg_enum e JOIN pg_type ty ON ty.oid = e.enumtypid WHERE ty.typname = 'alert_type'`);
    // 010 adiciona low_attendance/attendance_drop; a 011 adiciona no_followup/overdue_action (ver followups.test.ts)
    expect(types.map((r) => r.v).sort()).toEqual([
      'attendance_drop', 'consecutive_absences', 'low_attendance', 'no_followup', 'overdue_action']);
    const [s] = await t.q(`SELECT critical_absence_threshold FROM public.app_settings`);
    expect(s).toEqual({ critical_absence_threshold: 6 });
    const idx = await t.q(`SELECT 1 FROM pg_indexes WHERE indexname = 'alerts_youth_status_idx'`);
    expect(idx).toHaveLength(1);
  });

  it('critical_absence_threshold fora de 1..50 é rejeitado; líder não altera', async () => {
    await expect(setSettings(`critical_absence_threshold = 0`)).rejects.toThrow(/check/i);
    await expect(setSettings(`critical_absence_threshold = 51`)).rejects.toThrow(/check/i);
    const r = await t.as(leaderA, () => t.q(`UPDATE public.app_settings SET critical_absence_threshold = 2 RETURNING id`));
    expect(r).toHaveLength(0);
  });

  it('funções internas continuam sem EXECUTE para clientes', async () => {
    const y = await mkYouth();
    await expect(t.as(coord, () => t.q(`SELECT public.refresh_youth_alert($1)`, [y]))).rejects.toThrow(/permission denied/);
    await expect(t.as(coord, () =>
      t.q(`SELECT public.sync_rate_alert($1, NULL, 'low_attendance', true, 0, NULL, 4, NULL, 'x')`, [y]),
    )).rejects.toThrow(/permission denied/);
  });
});

describe('"não registrado" não é falta', () => {
  it('encontro sem linha não conta nas faltas consecutivas nem quebra a sequência', async () => {
    const y = await mkYouth();
    await seq(y, ['a', 'a', '-', 'a']);
    expect(await consecutive(y)).toBe(3);
    expect((await openOf(y, 'consecutive_absences'))?.consecutive_absences).toBe(3);
  });

  it('muitos encontros sem registro não geram nenhum alerta', async () => {
    const y = await mkYouth();
    await seq(y, ['-', '-', '-', '-', '-', '-', '-', '-']);
    expect(await consecutive(y)).toBe(0);
    expect(await alertsOf(y)).toHaveLength(0);

    const z = await mkYouth();
    await seq(z, ['a', '-', '-', '-', '-']);
    expect(await consecutive(z)).toBe(1);
    expect(await alertsOf(z)).toHaveLength(0);
  });

  it('não entra na frequência: só os encontros registrados formam a janela', async () => {
    const y = await mkYouth();
    await seq(y, ['p', '-', 'p', '-', 'p', '-', 'p', '-', '-', '-']);
    expect(await alertsOf(y)).toHaveLength(0); // 4/4 presenças, nada de low_attendance

    const z = await mkYouth();
    await seq(z, ['a', '-', 'a', '-', 'a', '-']); // 3 registros < mínimo de 4
    expect(await openOf(z, 'low_attendance')).toBeNull();
  });
});

describe('save_attendance', () => {
  it('líder grava só quem foi marcado; group_id vem do banco e recorded_by é o chamador', async () => {
    const y1 = await mkYouth(), y2 = await mkYouth(), y3 = await mkYouth();
    const ev = await mkEvent([groupA]);

    const r = await save(leaderA, ev, [{ youth_id: y1, present: true }, { youth_id: y2, present: false }, { youth_id: y3, present: null }]);

    expect(r).toMatchObject({ saved: 2, present: 1, absent: 1, total_registered: 2, rate: 50, new_alerts: [] });
    expect(await rowOf(ev, y1)).toEqual({ present: true, group_id: groupA, recorded_by: leaderA });
    expect(await rowOf(ev, y2)).toEqual({ present: false, group_id: groupA, recorded_by: leaderA });
    expect(await rowOf(ev, y3)).toBeUndefined(); // não registrado: nenhuma linha
  });

  it('group_id forjado no payload é ignorado', async () => {
    const y = await mkYouth();
    const ev = await mkEvent([groupA, groupB]);
    await save(leaderA, ev, [{ youth_id: y, present: true, group_id: groupB, recorded_by: leaderB }]);
    expect(await rowOf(ev, y)).toEqual({ present: true, group_id: groupA, recorded_by: leaderA });
  });

  it('present null (ou ausente) ignora e NÃO apaga a linha existente', async () => {
    const y = await mkYouth();
    const ev = await mkEvent([groupA]);
    await save(leaderA, ev, [{ youth_id: y, present: true }]);

    const r = await save(leaderA, ev, [{ youth_id: y, present: null }, { youth_id: y }]);

    expect(r.saved).toBe(0);
    expect((await rowOf(ev, y)).present).toBe(true);
    expect(r).toMatchObject({ present: 1, total_registered: 1, rate: 100 });
  });

  it('lista vazia é válida; repetidos valem pelo último não nulo', async () => {
    const y = await mkYouth();
    const ev = await mkEvent([groupA]);
    expect(await save(leaderA, ev, [])).toMatchObject({ saved: 0, total_registered: 0, rate: 0 });
    const r = await save(leaderA, ev, [{ youth_id: y, present: true }, { youth_id: y, present: false }, { youth_id: y, present: null }]);
    expect(r.saved).toBe(1);
    expect((await rowOf(ev, y)).present).toBe(false);
  });

  it('é um upsert: regravar altera o estado e é idempotente', async () => {
    const y = await mkYouth();
    const ev = await mkEvent([groupA]);
    await save(leaderA, ev, [{ youth_id: y, present: false }]);
    await save(leaderA, ev, [{ youth_id: y, present: false }]);
    await save(leaderA, ev, [{ youth_id: y, present: true }]);
    expect(await attendanceCount(y)).toBe(1);
    expect((await rowOf(ev, y)).present).toBe(true);
  });

  it('retorno: contagens do encontro e taxa inteira (2 de 3 = 67)', async () => {
    const [a, b, c] = [await mkYouth(), await mkYouth(), await mkYouth()];
    const ev = await mkEvent([groupA]);
    const r = await save(leaderA, ev, [{ youth_id: a, present: true }, { youth_id: b, present: true }, { youth_id: c, present: false }]);
    expect(r).toEqual({ saved: 3, present: 2, absent: 1, total_registered: 3, rate: 67, new_alerts: [] });
  });

  it('new_alerts traz só os alertas criados nesta chamada, com os campos combinados', async () => {
    const y = await mkYouth();
    await seq(y, ['a', 'a']);
    const ev = await mkEvent([groupA]);

    const r = await save(leaderA, ev, [{ youth_id: y, present: false }]);

    const alert = await openOf(y, 'consecutive_absences');
    expect(r.new_alerts).toEqual([{
      id: alert!.id, youth_id: y, youth_name: expect.stringMatching(/^Jovem /),
      type: 'consecutive_absences', severity: 'attention', consecutive_absences: 3,
    }]);

    // regravar o mesmo estado não "cria" de novo
    const again = await save(leaderA, ev, [{ youth_id: y, present: false }]);
    expect(again.new_alerts).toEqual([]);
    // uma 4ª falta apenas atualiza o alerta de faltas existente (o de frequência baixa, esse sim, nasce com 4 registros)
    const ev4 = await mkEvent([groupA]);
    const fourth = await save(leaderA, ev4, [{ youth_id: y, present: false }]);
    expect(fourth.new_alerts.map((a) => a.type)).toEqual(['low_attendance']);
  });

  it('new_alerts inclui os novos tipos (frequência) quando criados na chamada', async () => {
    const y = await mkYouth();
    await seq(y, ['p', 'a', 'p', 'p', 'a', 'p', 'p']); // 5/7 = 71%
    const ev = await mkEvent([groupA]);
    const r = await save(leaderA, ev, [{ youth_id: y, present: false }]); // 5/8 = 62% < 70
    expect(r.new_alerts.map((a) => a.type)).toEqual(['low_attendance']);
    expect(r.new_alerts[0]).toMatchObject({ severity: 'attention', consecutive_absences: 0 });
  });

  it('coordenador grava qualquer grupo e vê os alertas novos de todos', async () => {
    const ya = await mkYouth(groupA), yb = await mkYouth(groupB);
    await seq(ya, ['a', 'a']); await seq(yb, ['a', 'a'], groupB);
    const ev = await mkEvent([groupA, groupB]);
    const r = await save(coord, ev, [{ youth_id: ya, present: false }, { youth_id: yb, present: false }]);
    expect(r.new_alerts.map((a) => a.youth_id).sort()).toEqual([ya, yb].sort());
    expect((await rowOf(ev, yb)).recorded_by).toBe(coord);
  });

  it('jovem de outro grupo é rejeitado e NADA é gravado (nem os válidos do mesmo envio)', async () => {
    const mine = await mkYouth(groupA), theirs = await mkYouth(groupB);
    const ev = await mkEvent([groupA, groupB]);
    await expect(save(leaderA, ev, [{ youth_id: mine, present: true }, { youth_id: theirs, present: true }]))
      .rejects.toThrow(/não pertencem a um grupo deste encontro/);
    expect(await rowOf(ev, mine)).toBeUndefined();
    expect(await rowOf(ev, theirs)).toBeUndefined();
  });

  it('jovem de grupo que não está vinculado ao encontro é rejeitado (até para coordenador)', async () => {
    const yb = await mkYouth(groupB);
    const ev = await mkEvent([groupA]);
    await expect(save(coord, ev, [{ youth_id: yb, present: true }])).rejects.toThrow(/não pertencem a um grupo deste encontro/);
    const orphan = (await t.q<{ id: string }>(
      `INSERT INTO public.youth (full_name, created_by) VALUES ('Sem grupo', $1) RETURNING id`, [coord]))[0].id;
    await expect(save(coord, ev, [{ youth_id: orphan, present: true }])).rejects.toThrow(/não pertencem/);
    await expect(save(coord, ev, [{ youth_id: '00000000-0000-4000-8000-000000000009', present: true }]))
      .rejects.toThrow(/não pertencem/);
  });

  it('encontro cancelado é rejeitado; encontro inexistente ou invisível ao líder também', async () => {
    const y = await mkYouth();
    const cancelled = await mkEvent([groupA], { status: 'cancelled' });
    await expect(save(leaderA, cancelled, [{ youth_id: y, present: true }])).rejects.toThrow(/cancelado/);
    expect(await rowOf(cancelled, y)).toBeUndefined();

    await expect(save(coord, '00000000-0000-4000-8000-000000000009', [])).rejects.toThrow(/não encontrado ou sem permissão/);
    const onlyB = await mkEvent([groupB]);
    await expect(save(leaderA, onlyB, [{ youth_id: y, present: true }])).rejects.toThrow(/não encontrado ou sem permissão/);
  });

  it('payload malformado é rejeitado sem gravar nada', async () => {
    const y = await mkYouth();
    const ev = await mkEvent([groupA]);
    await expect(save(leaderA, ev, { youth_id: y, present: true })).rejects.toThrow(/inválida/);
    await expect(save(leaderA, ev, [{ youth_id: y, present: 'true' }])).rejects.toThrow(/inválida/);
    await expect(save(leaderA, ev, [{ youth_id: 'abc', present: true }])).rejects.toThrow(/inválida/);
    await expect(save(leaderA, ev, [{ present: true }])).rejects.toThrow(/inválida/);
    await expect(save(leaderA, ev, [42])).rejects.toThrow(/inválida/);
    await expect(t.as(leaderA, () => t.q(`SELECT public.save_attendance($1, NULL)`, [ev]))).rejects.toThrow(/inválida/);
    expect(await attendanceCount(y)).toBe(0);
  });

  it('anon não executa; função é SECURITY INVOKER com EXECUTE só para authenticated', async () => {
    const ev = await mkEvent([groupA]);
    await expect(save(null, ev, [])).rejects.toThrow(/permission denied/i);
    const [fn] = await t.q<{ definer: boolean; anon: boolean; authed: boolean; public_: boolean }>(
      `SELECT p.prosecdef AS definer,
              has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
              has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authed,
              has_function_privilege('public', p.oid, 'EXECUTE') AS public_
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = 'save_attendance'`);
    expect(fn).toEqual({ definer: false, anon: false, authed: true, public_: false });
  });

  it('RLS preservada: líder não apaga chamada nem escreve direto em grupo alheio', async () => {
    const y = await mkYouth();
    const ev = await mkEvent([groupA]);
    await save(leaderA, ev, [{ youth_id: y, present: true }]);

    const del = await t.as(leaderA, () => t.q(`DELETE FROM public.attendance WHERE event_id = $1 RETURNING id`, [ev]));
    expect(del).toHaveLength(0); // não existe política de DELETE para líder
    expect(await rowOf(ev, y)).toBeTruthy();

    await expect(t.as(leaderB, () =>
      t.q(`INSERT INTO public.attendance (event_id, youth_id, group_id, present, recorded_by) VALUES ($1, $2, $3, true, $4)`,
        [ev, y, groupA, leaderB]),
    )).rejects.toThrow(/row-level security/);
  });
});

describe('faltas consecutivas: severidade', () => {
  it('attention no limite, critical a partir de 6 (mesmo alerta), e presença resolve mantendo o histórico', async () => {
    const y = await mkYouth();
    await seq(y, ['a', 'a', 'a']);
    const first = await openOf(y, 'consecutive_absences');
    expect(first).toMatchObject({ severity: 'attention', consecutive_absences: 3 });

    await seq(y, ['a', 'a']);
    expect(await openOf(y, 'consecutive_absences')).toMatchObject({ id: first!.id, severity: 'attention', consecutive_absences: 5 });
    await seq(y, ['a']);
    expect(await openOf(y, 'consecutive_absences')).toMatchObject({ id: first!.id, severity: 'critical', consecutive_absences: 6 });

    await seq(y, ['p']);
    expect(await openOf(y, 'consecutive_absences')).toBeNull();
    const all = await alertsOf(y, 'consecutive_absences');
    expect(all).toHaveLength(1); // histórico preservado
    expect(all[0]).toMatchObject({ id: first!.id, status: 'resolved' });
    expect(all[0].resolution_notes).toMatch(/automaticamente/);
  });

  it('o coordenador muda o limite crítico e os alertas são reclassificados', async () => {
    const y = await mkYouth();
    await seq(y, ['a', 'a', 'a', 'a', 'a']);
    expect((await openOf(y, 'consecutive_absences'))?.severity).toBe('attention');
    await setSettings(`critical_absence_threshold = 4`);
    expect((await openOf(y, 'consecutive_absences'))?.severity).toBe('critical');
    await resetSettings();
    expect((await openOf(y, 'consecutive_absences'))?.severity).toBe('attention');
  });

  it('crítico nunca fica abaixo do limite de alerta (GREATEST)', async () => {
    const y = await mkYouth();
    await seq(y, ['a', 'a', 'a', 'a', 'a', 'a']); // 6 faltas: crítico no padrão
    expect((await openOf(y, 'consecutive_absences'))?.severity).toBe('critical');
    await setSettings(`absence_alert_threshold = 8`); // crítico configurado (6) < limite (8)
    expect(await openOf(y, 'consecutive_absences')).toBeNull();
    await seq(y, ['a', 'a']); // 8 faltas = limite = crítico efetivo
    expect((await openOf(y, 'consecutive_absences'))).toMatchObject({ severity: 'critical', consecutive_absences: 8 });
    await resetSettings();
  });
});

describe('resolver/dispensar nunca altera faltas; mesma sequência não recria', () => {
  it('dispensar mantém attendance e a contagem de faltas; o alerta fica no histórico', async () => {
    const y = await mkYouth();
    await seq(y, ['a', 'a', 'a', 'a']);
    const alert = (await openOf(y, 'consecutive_absences'))!;
    const before = { n: await consecutive(y), rows: await attendanceCount(y) };

    await t.as(leaderA, () => t.q(
      `UPDATE public.alerts SET status = 'dismissed', resolution_notes = 'Viajando' WHERE id = $1`, [alert.id]));

    expect(await consecutive(y)).toBe(before.n);
    expect(await attendanceCount(y)).toBe(before.rows);
    expect(await openOf(y, 'consecutive_absences')).toBeNull();
    expect(await alertsOf(y, 'consecutive_absences')).toMatchObject([{ id: alert.id, status: 'dismissed', resolved_by: leaderA }]);
  });

  it('encerrado manualmente: novas faltas (inclusive retroativas e recalculo) não recriam; presença zera; sequência nova gera novo alerta', async () => {
    const y = await mkYouth();
    await seq(y, ['a', 'a', 'a']);
    const first = (await openOf(y, 'consecutive_absences'))!;
    await t.as(coord, () => t.q(`UPDATE public.alerts SET status = 'dismissed' WHERE id = $1`, [first.id]));

    await seq(y, ['a', 'a']); // mesma sequência continua
    expect(await openOf(y, 'consecutive_absences')).toBeNull();
    expect(await consecutive(y)).toBe(5);

    // chamadas retroativas (encontros ANTIGOS registrados agora): falta e presença
    await rec(await mkEvent([groupA], { at: (retroDay -= 1) }), y, false);
    await rec(await mkEvent([groupA], { at: (retroDay -= 1) }), y, true);
    expect(await openOf(y, 'consecutive_absences')).toBeNull();
    expect(await consecutive(y)).toBe(6);

    await t.as(coord, () => t.q(`SELECT public.recalculate_all_alerts()`));
    expect(await openOf(y, 'consecutive_absences')).toBeNull();

    // presença recente zera a sequência
    await seq(y, ['p']);
    expect(await consecutive(y)).toBe(0);
    expect(await openOf(y, 'consecutive_absences')).toBeNull();

    // duas faltas ainda não atingem o limite; a terceira abre um alerta NOVO
    await seq(y, ['a', 'a']);
    expect(await openOf(y, 'consecutive_absences')).toBeNull();
    await seq(y, ['a']);
    const second = (await openOf(y, 'consecutive_absences'))!;
    expect(second.id).not.toBe(first.id);
    expect(second.consecutive_absences).toBe(3);

    const hist = await alertsOf(y, 'consecutive_absences');
    expect(hist.map((a) => a.status)).toEqual(['dismissed', 'open']); // histórico antigo permanece
  });

  it('resolvido por tarefa concluída também conta como encerramento manual', async () => {
    const y = await mkYouth();
    await seq(y, ['a', 'a', 'a']);
    const alert = (await openOf(y, 'consecutive_absences'))!;
    const [task] = await t.as(coord, () => t.q<{ id: string }>(
      `INSERT INTO public.tasks (title, youth_id, alert_id, created_by) VALUES ('Ligar', $1, $2, $3) RETURNING id`,
      [y, alert.id, coord]));
    await t.as(coord, () => t.q(`UPDATE public.tasks SET status = 'done' WHERE id = $1`, [task.id]));

    const [closed] = await alertsOf(y, 'consecutive_absences');
    expect(closed).toMatchObject({ status: 'resolved', resolved_by: coord });
    expect(await consecutive(y)).toBe(3);

    await seq(y, ['a']);
    expect(await openOf(y, 'consecutive_absences')).toBeNull();
    await seq(y, ['p', 'a', 'a', 'a']);
    expect(await openOf(y, 'consecutive_absences')).not.toBeNull();
  });

  it('encerramento AUTOMÁTICO não bloqueia: subir e baixar o limite recria o alerta', async () => {
    const y = await mkYouth();
    await seq(y, ['a', 'a', 'a']);
    const first = (await openOf(y, 'consecutive_absences'))!;
    await setSettings(`absence_alert_threshold = 5`);
    expect(await openOf(y, 'consecutive_absences')).toBeNull();
    await resetSettings();
    const again = (await openOf(y, 'consecutive_absences'))!;
    expect(again.id).not.toBe(first.id);
    expect((await alertsOf(y, 'consecutive_absences')).map((a) => a.status)).toEqual(['resolved', 'open']);
  });

  it('chamada retroativa em alerta aberto atualiza o mesmo alerta (sem duplicar)', async () => {
    const y = await mkYouth();
    await seq(y, ['a', 'a', 'a']);
    const alert = (await openOf(y, 'consecutive_absences'))!;

    await rec(await mkEvent([groupA], { at: (retroDay -= 1) }), y, false); // falta antiga
    expect(await openOf(y, 'consecutive_absences')).toMatchObject({ id: alert.id, consecutive_absences: 4 });

    await rec(await mkEvent([groupA], { at: (retroDay -= 1) }), y, true); // presença antiga (anterior a tudo)
    expect(await openOf(y, 'consecutive_absences')).toMatchObject({ id: alert.id, consecutive_absences: 4 });
    expect(await alertsOf(y, 'consecutive_absences')).toHaveLength(1);
  });

  it('encontro cancelado é ignorado: cancelar a última falta rebaixa/resolve; reativar volta', async () => {
    const y = await mkYouth();
    const evs = await seq(y, ['a', 'a', 'a']);
    await t.as(coord, () => t.q(`UPDATE public.events SET status = 'cancelled' WHERE id = $1`, [evs[2]]));
    expect(await openOf(y, 'consecutive_absences')).toBeNull();
    await t.as(coord, () => t.q(`UPDATE public.events SET status = 'completed' WHERE id = $1`, [evs[2]]));
    expect((await openOf(y, 'consecutive_absences'))?.consecutive_absences).toBe(3);
  });
});

describe('alerta low_attendance', () => {
  it('cria com métricas quando a frequência dos últimos 8 registros fica abaixo do limite', async () => {
    const y = await mkYouth();
    await seq(y, ['p', 'a', 'p', 'a', 'p', 'a', 'p', 'a']);
    expect(await openOf(y, 'low_attendance')).toMatchObject({
      severity: 'attention', attendance_rate: 50, previous_rate: null, sample_size: 8, consecutive_absences: 0,
    });
    expect(await openOf(y, 'attendance_drop')).toBeNull(); // 50% nos dois blocos de 4
  });

  it('exige no mínimo 4 registros', async () => {
    const y = await mkYouth();
    await seq(y, ['a', 'a', 'a']);
    expect(await openOf(y, 'low_attendance')).toBeNull();
    await seq(y, ['a']);
    expect(await openOf(y, 'low_attendance')).toMatchObject({ attendance_rate: 0, sample_size: 4 });
  });

  it('limite é estrito (< 70%): 6/8 não alerta (75%), 5/8 alerta (62%)', async () => {
    const ok = await mkYouth();
    await seq(ok, ['p', 'p', 'a', 'p', 'p', 'a', 'p', 'p']);
    expect(await openOf(ok, 'low_attendance')).toBeNull();
    const low = await mkYouth();
    await seq(low, ['p', 'p', 'a', 'p', 'a', 'a', 'p', 'p']);
    expect(await openOf(low, 'low_attendance')).toMatchObject({ attendance_rate: 63, sample_size: 8 });
  });

  it('janela é de 8: presenças antigas saem da conta', async () => {
    const y = await mkYouth();
    await seq(y, ['p', 'p', 'p', 'p', 'p', 'p', 'p', 'p']); // 100%
    await seq(y, ['a', 'a', 'a']); // janela: p p p p p a a a = 5/8 = 62,5%
    expect(await openOf(y, 'low_attendance')).toMatchObject({ sample_size: 8, attendance_rate: 63 });
  });

  it('resolve sozinho quando a frequência se recupera; histórico fica e não duplica', async () => {
    const y = await mkYouth();
    await seq(y, ['a', 'a', 'a', 'a']);
    const first = (await openOf(y, 'low_attendance'))!;
    await t.as(coord, () => t.q(`SELECT public.recalculate_all_alerts()`)); // idempotente
    await t.as(coord, () => t.q(`SELECT public.recalculate_all_alerts()`));
    expect((await alertsOf(y, 'low_attendance')).filter((a) => a.status === 'open')).toHaveLength(1);

    await seq(y, ['p', 'p', 'p', 'p', 'p', 'p', 'p', 'p']);
    expect(await openOf(y, 'low_attendance')).toBeNull();
    const [done] = await alertsOf(y, 'low_attendance');
    expect(done).toMatchObject({ id: first.id, status: 'resolved' });
    expect(done.resolution_notes).toMatch(/automaticamente/);

    await seq(y, ['a', 'a', 'a', 'a', 'a']); // piorou de novo: novo alerta, o antigo permanece
    const hist = await alertsOf(y, 'low_attendance');
    expect(hist.map((a) => a.status)).toEqual(['resolved', 'open']);
  });

  it('encontros cancelados são ignorados na janela', async () => {
    const y = await mkYouth();
    const evs = await seq(y, ['p', 'p', 'p', 'p', 'p', 'a', 'a', 'a']); // 5/8 = 62%
    expect(await openOf(y, 'low_attendance')).not.toBeNull();
    await t.as(coord, () => t.q(`UPDATE public.events SET status = 'cancelled' WHERE id = $1`, [evs[7]])); // 5/7 = 71%
    expect(await openOf(y, 'low_attendance')).toBeNull();
  });

  it('mudar low_attendance_threshold recalcula', async () => {
    const y = await mkYouth();
    await seq(y, ['p', 'p', 'a', 'p', 'p', 'a', 'p', 'p']); // 75%
    expect(await openOf(y, 'low_attendance')).toBeNull();
    await setSettings(`low_attendance_threshold = 80`);
    expect(await openOf(y, 'low_attendance')).not.toBeNull();
    await resetSettings();
    expect(await openOf(y, 'low_attendance')).toBeNull();
  });

  it('jovem inativo não gera alerta, e inativar resolve os abertos (todos os tipos)', async () => {
    const inactive = await mkYouth(groupA, false);
    await seq(inactive, ['a', 'a', 'a', 'a']);
    expect(await alertsOf(inactive)).toHaveLength(0);

    const y = await mkYouth();
    await seq(y, ['a', 'a', 'a', 'a']);
    expect(await openOf(y, 'low_attendance')).not.toBeNull();
    expect(await openOf(y, 'consecutive_absences')).not.toBeNull();
    await t.as(leaderA, () => t.q(`UPDATE public.youth SET is_active = false WHERE id = $1`, [y]));
    expect((await alertsOf(y)).filter((a) => a.status === 'open')).toHaveLength(0);
    await t.as(leaderA, () => t.q(`UPDATE public.youth SET is_active = true WHERE id = $1`, [y]));
    expect((await alertsOf(y)).filter((a) => a.status === 'open').map((a) => a.type).sort())
      .toEqual(['consecutive_absences', 'low_attendance']);
  });

  it('dispensado não é recriado enquanto o episódio continua; recria após a condição deixar de valer', async () => {
    const y = await mkYouth();
    await seq(y, ['a', 'a', 'a', 'a']);
    const first = (await openOf(y, 'low_attendance'))!;
    await t.as(leaderA, () => t.q(`UPDATE public.alerts SET status = 'dismissed' WHERE id = $1`, [first.id]));

    await seq(y, ['a']); // piora, mesmo episódio
    await t.as(coord, () => t.q(`SELECT public.recalculate_all_alerts()`));
    expect(await openOf(y, 'low_attendance')).toBeNull();

    await seq(y, ['p', 'p', 'p', 'p', 'p', 'p', 'p', 'p']); // recupera: episódio acaba
    expect((await alertsOf(y, 'low_attendance'))[0].episode_ended).toBe(true);
    await seq(y, ['a', 'a', 'a', 'a', 'a']); // novo episódio
    const hist = await alertsOf(y, 'low_attendance');
    expect(hist.map((a) => a.status)).toEqual(['dismissed', 'open']);
  });
});

describe('alerta attendance_drop', () => {
  it('queda de >= 30 pontos entre os 4 mais recentes e os 4 anteriores', async () => {
    const y = await mkYouth();
    await seq(y, ['p', 'p', 'p', 'p', 'a', 'a', 'p', 'a']); // anteriores 100%, recentes 25%
    expect(await openOf(y, 'attendance_drop')).toMatchObject({
      severity: 'attention', attendance_rate: 25, previous_rate: 100, sample_size: 8,
    });
  });

  it('queda de 25 pontos (3/4 -> ... 4/4 para 3/4) não alerta; 50 pontos alerta', async () => {
    const small = await mkYouth();
    await seq(small, ['p', 'p', 'p', 'p', 'p', 'p', 'p', 'a']);
    expect(await openOf(small, 'attendance_drop')).toBeNull();

    const big = await mkYouth();
    await seq(big, ['p', 'p', 'p', 'p', 'p', 'p', 'a', 'a']);
    expect(await openOf(big, 'attendance_drop')).toMatchObject({ attendance_rate: 50, previous_rate: 100 });
  });

  it('exige 8 registros', async () => {
    const y = await mkYouth();
    await seq(y, ['p', 'p', 'p', 'p', 'a', 'a', 'a']);
    expect(await openOf(y, 'attendance_drop')).toBeNull();
    await seq(y, ['a']);
    expect(await openOf(y, 'attendance_drop')).not.toBeNull();
  });

  it('não registrado fica de fora da comparação', async () => {
    const y = await mkYouth();
    await seq(y, ['p', '-', 'p', 'p', '-', 'p', 'a', '-', 'a', '-', 'a', 'a']);
    expect(await openOf(y, 'attendance_drop')).toMatchObject({ attendance_rate: 0, previous_rate: 100 });
  });

  it('resolve automaticamente quando recupera, mantém histórico e não duplica', async () => {
    const y = await mkYouth();
    await seq(y, ['p', 'p', 'p', 'p', 'p', 'p', 'a', 'a']);
    const alert = (await openOf(y, 'attendance_drop'))!;
    await t.as(coord, () => t.q(`SELECT public.recalculate_all_alerts()`));
    expect((await alertsOf(y, 'attendance_drop')).filter((a) => a.status === 'open')).toHaveLength(1);

    await seq(y, ['p', 'p', 'p', 'p']);
    expect(await openOf(y, 'attendance_drop')).toBeNull();
    expect(await alertsOf(y, 'attendance_drop')).toMatchObject([{ id: alert.id, status: 'resolved' }]);
  });

  it('resolver/dispensar não altera as presenças', async () => {
    const y = await mkYouth();
    await seq(y, ['p', 'p', 'p', 'p', 'p', 'p', 'a', 'a']);
    const alert = (await openOf(y, 'attendance_drop'))!;
    const rows = await attendanceCount(y);
    await t.as(coord, () => t.q(`UPDATE public.alerts SET status = 'resolved' WHERE id = $1`, [alert.id]));
    expect(await attendanceCount(y)).toBe(rows);
    expect(await openOf(y, 'attendance_drop')).toBeNull();
  });
});

describe('RLS dos alertas (inclui os novos tipos)', () => {
  it('líder vê/dispensa só alertas dos seus grupos; coordenador vê todos; anon nada', async () => {
    const ya = await mkYouth(groupA), yb = await mkYouth(groupB);
    await seq(ya, ['a', 'a', 'a', 'a']);
    await seq(yb, ['a', 'a', 'a', 'a'], groupB);
    const lowA = (await openOf(ya, 'low_attendance'))!;

    const seenA = await t.as(leaderA, () => t.q<{ youth_id: string }>(`SELECT youth_id FROM public.alerts WHERE youth_id IN ($1, $2)`, [ya, yb]));
    expect(new Set(seenA.map((r) => r.youth_id))).toEqual(new Set([ya]));
    const seenC = await t.as(coord, () => t.q<{ youth_id: string }>(`SELECT youth_id FROM public.alerts WHERE youth_id IN ($1, $2)`, [ya, yb]));
    expect(new Set(seenC.map((r) => r.youth_id))).toEqual(new Set([ya, yb]));
    // anon: sem privilégio algum (migration 016); antes era "0 linhas por RLS"
    await expect(t.as(null, () => t.q(`SELECT 1 FROM public.alerts`))).rejects.toThrow(/permission denied/);

    // líder B não enxerga nem altera
    const upd = await t.as(leaderB, () => t.q(`UPDATE public.alerts SET status = 'dismissed' WHERE id = $1 RETURNING id`, [lowA.id]));
    expect(upd).toHaveLength(0);
    // líder A dispensa o alerta de frequência do seu grupo
    await t.as(leaderA, () => t.q(`UPDATE public.alerts SET status = 'dismissed', resolution_notes = 'ok' WHERE id = $1`, [lowA.id]));
    expect((await alertsOf(ya, 'low_attendance'))[0]).toMatchObject({ status: 'dismissed', resolved_by: leaderA });
  });

  it('cliente não altera severidade, métricas nem episode_ended (alerts_guard) nem cria alertas', async () => {
    const y = await mkYouth();
    await seq(y, ['p', 'p', 'p', 'p', 'p', 'p', 'a', 'a']);
    const alert = (await openOf(y, 'attendance_drop'))!;
    for (const col of ["severity = 'critical'", 'attendance_rate = 100', 'previous_rate = 0', 'sample_size = 1', 'episode_ended = true', "type = 'low_attendance'"]) {
      await expect(t.as(leaderA, () => t.q(`UPDATE public.alerts SET ${col} WHERE id = $1`, [alert.id])), col)
        .rejects.toThrow(/Somente o status/);
      await expect(t.as(coord, () => t.q(`UPDATE public.alerts SET ${col} WHERE id = $1`, [alert.id])), col)
        .rejects.toThrow(/Somente o status/);
    }
    await expect(t.as(leaderA, () =>
      t.q(`INSERT INTO public.alerts (youth_id, type) VALUES ($1, 'low_attendance')`, [y]),
    )).rejects.toThrow(/row-level security/);
  });

  it('líder só vê em new_alerts alertas visíveis a ele (jovens do próprio grupo)', async () => {
    const y = await mkYouth(groupA);
    await seq(y, ['a', 'a']);
    const ev = await mkEvent([groupA, groupB]);
    const r = await save(leaderA, ev, [{ youth_id: y, present: false }]);
    expect(r.new_alerts).toHaveLength(1);
    expect(await t.as(leaderB, () => t.q(`SELECT 1 FROM public.alerts WHERE id = $1`, [r.new_alerts[0].id]))).toHaveLength(0);
  });
});
