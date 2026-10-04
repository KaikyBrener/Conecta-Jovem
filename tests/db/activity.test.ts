import { beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './harness';

// Migration 014 (parte A): histórico operacional (activity_log). Escrita só por triggers/funções DEFINER,
// imutável, escopo por papel, sem texto livre.

let t: TestDb;
let coord: string, leaderA: string, leaderB: string;
let groupA: string, groupB: string;
let seq = 0;

const SECRET = 'SEGREDO-XYZ';

interface Entry {
  id: string; occurred_at: string; actor_id: string | null; actor_name: string | null; action: string;
  entity_type: string; entity_id: string | null; youth_id: string | null; group_id: string | null;
  summary: string; meta: Record<string, unknown>;
}

const COLS = `id, occurred_at, actor_id, actor_name, action, entity_type, entity_id, youth_id, group_id, summary, meta`;
const pgArray = (ids: string[]) => `{${ids.join(',')}}`;

/** Entradas (como superusuário, sem RLS) de uma ação, opcionalmente filtradas. */
const log = (where = 'true', params: unknown[] = []) =>
  t.q<Entry>(`SELECT ${COLS} FROM public.activity_log WHERE ${where} ORDER BY occurred_at, id`, params);
const logOf = (action: string, entity?: string) =>
  entity ? log(`action = $1 AND entity_id = $2`, [action, entity]) : log(`action = $1`, [action]);
const countAll = async () => Number((await t.q<{ n: string }>(`SELECT count(*)::text AS n FROM public.activity_log`))[0].n);
const seenBy = (user: string, where = 'true', params: unknown[] = []) =>
  t.as(user, () => t.q<Entry>(`SELECT ${COLS} FROM public.activity_log WHERE ${where} ORDER BY occurred_at, id`, params));

async function mkYouth(group: string | null, active = true): Promise<string> {
  seq += 1;
  return (await t.q<{ id: string }>(
    `INSERT INTO public.youth (full_name, group_id, is_active, created_by) VALUES ($1, $2, $3, $4) RETURNING id`,
    [`Jovem Log ${seq}`, group, active, coord]))[0].id;
}
async function mkEvent(groups: string[], daysAhead = 3, status = 'scheduled'): Promise<string> {
  seq += 1;
  const [e] = await t.q<{ id: string }>(
    `INSERT INTO public.events (title, event_date, status, created_by)
     VALUES ('Encontro log', now() + ($1 || ' days')::interval, $2::event_status, $3) RETURNING id`,
    [String(daysAhead), status, coord]);
  for (const g of groups) await t.q(`INSERT INTO public.event_groups (event_id, group_id) VALUES ($1, $2)`, [e.id, g]);
  return e.id;
}
/** Cria um alerta aberto de faltas consecutivas (3 faltas) para o jovem, via superusuário (sem sessão => sem log). */
async function mkAlertFor(youth: string, group: string): Promise<string> {
  for (let i = 0; i < 3; i++) {
    const ev = await mkEvent([group], -40 + i, 'completed');
    await t.q(`INSERT INTO public.attendance (event_id, youth_id, group_id, present, recorded_by) VALUES ($1, $2, $3, false, NULL)`,
      [ev, youth, group]);
  }
  const [a] = await t.q<{ id: string }>(
    `SELECT id FROM public.alerts WHERE youth_id = $1 AND type = 'consecutive_absences' AND status = 'open'`, [youth]);
  return a.id;
}

const save = (user: string, ev: string, entries: { youth_id: string; present: boolean }[]) =>
  t.as(user, async () =>
    (await t.q<{ r: { saved: number } }>(`SELECT public.save_attendance($1::uuid, $2::jsonb) AS r`,
      [ev, JSON.stringify(entries)]))[0].r);

beforeAll(async () => {
  t = await createTestDb();
  coord = await t.createUser('Coordenadora', 'coordinator');
  leaderA = await t.createUser('Líder A', 'leader');
  leaderB = await t.createUser('Líder B', 'leader');
  const mk = async (name: string, owner: string) =>
    (await t.q<{ id: string }>(`INSERT INTO public.groups (name, leader_id) VALUES ($1, $2) RETURNING id`, [name, owner]))[0].id;
  groupA = await mk('Grupo A', leaderA);
  groupB = await mk('Grupo B', leaderB);
}, 60_000);

describe('sem sessão não há registro', () => {
  it('ações feitas como superusuário/SQL Editor (auth.uid() nulo) não geram entradas', async () => {
    const before = await countAll();
    const y = await mkYouth(groupA);
    const ev = await mkEvent([groupA]);
    await t.q(`INSERT INTO public.attendance (event_id, youth_id, group_id, present, recorded_by) VALUES ($1, $2, $3, true, NULL)`,
      [ev, y, groupA]);
    await t.q(`UPDATE public.youth SET is_active = false WHERE id = $1`, [y]);
    await t.q(`UPDATE public.youth SET group_id = $2 WHERE id = $1`, [y, groupB]);
    await t.q(`INSERT INTO public.tasks (title, youth_id) VALUES ('t', $1)`, [y]);
    expect(await countAll()).toBe(before);
  });
});

describe('attendance_recorded — UMA entrada por chamada', () => {
  it('save_attendance com vários jovens grava 1 entrada (não 1 por linha) com contagens', async () => {
    const [y1, y2, y3] = [await mkYouth(groupA), await mkYouth(groupA), await mkYouth(groupA)];
    const ev = await mkEvent([groupA]);
    await save(leaderA, ev, [{ youth_id: y1, present: true }, { youth_id: y2, present: false }, { youth_id: y3, present: true }]);

    const rows = await logOf('attendance_recorded', ev);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actor_id: leaderA, actor_name: 'Líder A', entity_type: 'event', entity_id: ev, youth_id: null, group_id: groupA,
      summary: 'Chamada registrada: 2 presentes e 1 ausente.', meta: { present: 2, absent: 1 },
    });
  });

  it('repetir a mesma chamada (nada mudou) não gera entrada; mudar um estado gera uma nova só com o que mudou', async () => {
    const [y1, y2] = [await mkYouth(groupA), await mkYouth(groupA)];
    const ev = await mkEvent([groupA]);
    const entries = [{ youth_id: y1, present: true }, { youth_id: y2, present: false }];
    await save(leaderA, ev, entries);
    await save(leaderA, ev, entries);
    expect(await logOf('attendance_recorded', ev)).toHaveLength(1);

    await save(leaderA, ev, [{ youth_id: y2, present: true }]); // ausente -> presente
    const rows = await logOf('attendance_recorded', ev);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ summary: 'Chamada registrada: 1 presente e 0 ausentes.', meta: { present: 1, absent: 0 } });
  });

  it('chamada que mistura linhas novas e alteradas (INSERT + UPDATE no mesmo upsert) soma em UMA entrada', async () => {
    const [y1, y2, y3] = [await mkYouth(groupA), await mkYouth(groupA), await mkYouth(groupA)];
    const ev = await mkEvent([groupA]);
    await save(leaderA, ev, [{ youth_id: y1, present: false }]);
    expect(await logOf('attendance_recorded', ev)).toHaveLength(1);
    // y1 muda (UPDATE), y2 e y3 são novos (INSERT): um único comando
    await save(leaderA, ev, [{ youth_id: y1, present: true }, { youth_id: y2, present: false }, { youth_id: y3, present: true }]);
    const rows = await logOf('attendance_recorded', ev);
    expect(rows).toHaveLength(2);
    expect(rows[1].meta).toEqual({ present: 2, absent: 1 });
    expect(rows[1].summary).toBe('Chamada registrada: 2 presentes e 1 ausente.');
  });

  it('coordenador salvando dois grupos de uma vez gera uma entrada por grupo; cada líder vê a sua', async () => {
    const ya = await mkYouth(groupA);
    const yb = await mkYouth(groupB);
    const ev = await mkEvent([groupA, groupB]);
    await save(coord, ev, [{ youth_id: ya, present: true }, { youth_id: yb, present: false }]);
    const rows = await logOf('attendance_recorded', ev);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.group_id).sort()).toEqual([groupA, groupB].sort());
    expect(rows.every((r) => r.actor_id === coord)).toBe(true);

    expect((await seenBy(leaderA, `entity_id = $1`, [ev])).map((r) => r.group_id)).toEqual([groupA]);
    expect((await seenBy(leaderB, `entity_id = $1`, [ev])).map((r) => r.group_id)).toEqual([groupB]);
    expect(await seenBy(coord, `entity_id = $1`, [ev])).toHaveLength(2);
  });

  it('mudança de grupo do jovem (reescrita de attendance.group_id) não gera entrada de chamada', async () => {
    const y = await mkYouth(groupA);
    const ev = await mkEvent([groupA, groupB], -2, 'completed');
    await t.q(`INSERT INTO public.attendance (event_id, youth_id, group_id, present, recorded_by) VALUES ($1, $2, $3, true, NULL)`, [ev, y, groupA]);
    const before = (await logOf('attendance_recorded')).length;
    await t.as(coord, () => t.q(`UPDATE public.youth SET group_id = $2 WHERE id = $1`, [y, groupB]));
    expect((await logOf('attendance_recorded')).length).toBe(before);
    const [row] = await t.q<{ group_id: string }>(`SELECT group_id FROM public.attendance WHERE youth_id = $1`, [y]);
    expect(row.group_id).toBe(groupB); // o trigger de sincronização rodou
  });
});

describe('acompanhamento, tarefa e alerta', () => {
  it('follow_up_created e follow_up_transferred: 1 entrada cada, sem texto livre', async () => {
    const y = await mkYouth(groupA);
    const [f] = await t.as(leaderA, () => t.q<{ id: string }>(
      `INSERT INTO public.follow_ups (youth_id, reason, notes, next_action)
       VALUES ($1, '${SECRET}-motivo', '${SECRET}-notas', '${SECRET}-proxima') RETURNING id`, [y]));
    const created = await logOf('follow_up_created', f.id);
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ actor_id: leaderA, entity_type: 'follow_up', youth_id: y, group_id: groupA,
      summary: 'Acompanhamento registrado.', meta: { type: 'conversation' } });

    await t.as(leaderA, () => t.q(`SELECT public.transfer_follow_up($1::uuid, $2::uuid, '${SECRET}-transferencia')`, [f.id, coord]));
    const tr = await logOf('follow_up_transferred', f.id);
    expect(tr).toHaveLength(1);
    expect(tr[0]).toMatchObject({ actor_id: leaderA, youth_id: y, group_id: groupA,
      summary: 'Acompanhamento transferido para outro responsável.',
      meta: { from_responsible_id: leaderA, to_responsible_id: coord } });
    // editar o acompanhamento não registra nada
    const n = await countAll();
    await t.as(coord, () => t.q(`UPDATE public.follow_ups SET notes = 'outra nota' WHERE id = $1`, [f.id]));
    expect(await countAll()).toBe(n);
  });

  it('task_created e task_completed (1 cada); concluir tarefa de alerta gera também alert_resolved', async () => {
    const y = await mkYouth(groupA);
    const alertId = await mkAlertFor(y, groupA);
    const [task] = await t.as(leaderA, () => t.q<{ id: string }>(
      `INSERT INTO public.tasks (title, description, youth_id, alert_id, assigned_to)
       VALUES ('${SECRET}-titulo', '${SECRET}-desc', $1, $2, $3) RETURNING id`, [y, alertId, leaderA]));

    const created = await logOf('task_created', task.id);
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ actor_id: leaderA, entity_type: 'task', youth_id: y, group_id: groupA,
      summary: 'Ação criada.', meta: { priority: 'medium' } });
    expect(await logOf('task_completed', task.id)).toHaveLength(0);

    await t.as(leaderA, () => t.q(`UPDATE public.tasks SET status = 'in_progress' WHERE id = $1`, [task.id]));
    expect(await logOf('task_completed', task.id)).toHaveLength(0);
    await t.as(leaderA, () => t.q(`UPDATE public.tasks SET status = 'done' WHERE id = $1`, [task.id]));
    await t.as(leaderA, () => t.q(`UPDATE public.tasks SET status = 'done', description = 'x' WHERE id = $1`, [task.id]));
    expect(await logOf('task_completed', task.id)).toHaveLength(1);
    expect((await logOf('task_completed', task.id))[0].summary).toBe('Ação concluída.');

    // o alerta foi resolvido PELA tarefa (resolved_by = quem concluiu): 1 entrada, sem duplicar
    const res = await logOf('alert_resolved', alertId);
    expect(res).toHaveLength(1);
    expect(res[0]).toMatchObject({ actor_id: leaderA, entity_type: 'alert', youth_id: y, group_id: groupA,
      summary: 'Alerta resolvido.', meta: { type: 'consecutive_absences', severity: 'attention' } });
  });

  it('alert_dismissed e alert_resolved manuais: 1 entrada cada, sem as observações', async () => {
    const y1 = await mkYouth(groupA);
    const y2 = await mkYouth(groupA);
    const a1 = await mkAlertFor(y1, groupA);
    const a2 = await mkAlertFor(y2, groupA);
    await t.as(leaderA, () => t.q(`UPDATE public.alerts SET status = 'dismissed', resolution_notes = '${SECRET}-nota' WHERE id = $1`, [a1]));
    await t.as(coord, () => t.q(`UPDATE public.alerts SET status = 'resolved', resolution_notes = '${SECRET}-nota2' WHERE id = $1`, [a2]));
    const d = await logOf('alert_dismissed', a1);
    const r = await logOf('alert_resolved', a2);
    expect(d).toHaveLength(1);
    expect(r).toHaveLength(1);
    expect(d[0]).toMatchObject({ actor_id: leaderA, summary: 'Alerta dispensado.', youth_id: y1 });
    expect(r[0]).toMatchObject({ actor_id: coord, summary: 'Alerta resolvido.', youth_id: y2 });
    // editar só a observação depois do encerramento não duplica
    await t.as(leaderA, () => t.q(`UPDATE public.alerts SET resolution_notes = 'nova' WHERE id = $1`, [a1]));
    expect(await logOf('alert_dismissed', a1)).toHaveLength(1);
  });

  it('resolução AUTOMÁTICA de alerta (inativação, recálculo, mudança de limite) não gera alert_resolved nem duplica', async () => {
    const y = await mkYouth(groupA);
    const a = await mkAlertFor(y, groupA);
    await t.as(coord, () => t.q(`UPDATE public.youth SET is_active = false WHERE id = $1`, [y]));
    const [al] = await t.q<{ status: string; resolved_by: string | null }>(
      `SELECT status::text AS status, resolved_by FROM public.alerts WHERE id = $1`, [a]);
    expect(al).toEqual({ status: 'resolved', resolved_by: null });
    expect(await logOf('alert_resolved', a)).toHaveLength(0);
    expect(await log(`youth_id = $1`, [y])).toHaveLength(1);        // só o youth_deactivated
    expect((await log(`youth_id = $1`, [y]))[0].action).toBe('youth_deactivated');

    const n = await countAll();
    await t.as(coord, () => t.q(`SELECT public.recalculate_all_alerts()`));
    await t.as(coord, () => t.q(`UPDATE public.app_settings SET absence_alert_threshold = 4`));
    await t.as(coord, () => t.q(`UPDATE public.app_settings SET absence_alert_threshold = 3`));
    await t.as(coord, () => t.q(`SELECT public.sync_time_alerts()`));
    expect(await countAll()).toBe(n);
  });
});

describe('jovens', () => {
  it('youth_deactivated / youth_activated: 1 entrada por mudança; outras edições não registram', async () => {
    const y = await mkYouth(groupA);
    await t.as(leaderA, () => t.q(`UPDATE public.youth SET is_active = false WHERE id = $1`, [y]));
    await t.as(leaderA, () => t.q(`UPDATE public.youth SET is_active = false, notes = 'x' WHERE id = $1`, [y])); // sem mudança de estado
    await t.as(leaderA, () => t.q(`UPDATE public.youth SET is_active = true WHERE id = $1`, [y]));
    await t.as(coord, () => t.q(`UPDATE public.youth SET full_name = 'Renomeado', phone = '1' WHERE id = $1`, [y]));
    const rows = await log(`youth_id = $1`, [y]);
    expect(rows.map((r) => r.action)).toEqual(['youth_deactivated', 'youth_activated']);
    expect(rows[0]).toMatchObject({ actor_id: leaderA, entity_type: 'youth', entity_id: y, group_id: groupA,
      summary: 'Jovem inativado.', meta: {} });
    expect(rows[1].summary).toBe('Jovem reativado.');
  });

  it('youth_group_changed: grupo novo no registro; desassociar guarda o grupo antigo e o líder antigo enxerga', async () => {
    const y = await mkYouth(groupA);
    await t.as(coord, () => t.q(`UPDATE public.youth SET group_id = $2 WHERE id = $1`, [y, groupB]));
    let rows = await log(`youth_id = $1`, [y]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: 'youth_group_changed', actor_id: coord, group_id: groupB,
      summary: 'Grupo do jovem alterado.', meta: { from_group_id: groupA, to_group_id: groupB } });
    // quem recebe vê; o líder anterior não (o jovem já não é dele e o registro aponta para o grupo novo)
    expect(await seenBy(leaderB, `youth_id = $1`, [y])).toHaveLength(1);
    expect(await seenBy(leaderA, `youth_id = $1`, [y])).toHaveLength(0);

    // desassociar pelo líder B (RPC em lote): registro com o grupo ANTIGO => o próprio líder B continua vendo
    await t.as(leaderB, () => t.q(`SELECT public.batch_set_youth_group($1::uuid[], NULL)`, [pgArray([y])]));
    rows = await log(`youth_id = $1`, [y]);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ action: 'youth_group_changed', actor_id: leaderB, group_id: groupB,
      summary: 'Jovem desassociado do grupo.', meta: { from_group_id: groupB, to_group_id: null } });
    expect(await seenBy(leaderB, `youth_id = $1 AND actor_id = $2`, [y, leaderB])).toHaveLength(1);
    expect(await seenBy(coord, `youth_id = $1`, [y])).toHaveLength(2);
  });

  it('lote: uma entrada por jovem alterado e nenhuma para os que já estavam no estado pedido', async () => {
    const [a, b, c] = [await mkYouth(groupA), await mkYouth(groupA), await mkYouth(groupA, false)];
    await t.as(coord, () => t.q(`SELECT public.batch_set_youth_active($1::uuid[], false)`, [pgArray([a, b, c])]));
    expect(await log(`youth_id = ANY($1::uuid[]) AND action = 'youth_deactivated'`, [pgArray([a, b, c])])).toHaveLength(2);
    await t.as(coord, () => t.q(`SELECT public.batch_set_youth_group($1::uuid[], $2::uuid)`, [pgArray([a, b, c]), groupB]));
    expect(await log(`youth_id = ANY($1::uuid[]) AND action = 'youth_group_changed'`, [pgArray([a, b, c])])).toHaveLength(3);
    await t.as(coord, () => t.q(`SELECT public.batch_set_youth_group($1::uuid[], $2::uuid)`, [pgArray([a, b, c]), groupB]));
    expect(await log(`youth_id = ANY($1::uuid[]) AND action = 'youth_group_changed'`, [pgArray([a, b, c])])).toHaveLength(3);
  });
});

describe('RLS de leitura', () => {
  it('líder só lê entradas de jovens que estão hoje nos seus grupos, ou de grupo seu sem jovem', async () => {
    const ya = await mkYouth(groupA);
    const yb = await mkYouth(groupB);
    await t.as(leaderA, () => t.q(`INSERT INTO public.tasks (title, youth_id) VALUES ('a', $1)`, [ya]));
    await t.as(coord, () => t.q(`INSERT INTO public.tasks (title, youth_id) VALUES ('b', $1)`, [yb]));
    expect((await seenBy(leaderA, `youth_id = ANY($1::uuid[])`, [pgArray([ya, yb])])).map((r) => r.youth_id)).toEqual([ya]);
    expect((await seenBy(leaderB, `youth_id = ANY($1::uuid[])`, [pgArray([ya, yb])])).map((r) => r.youth_id)).toEqual([yb]);
    expect((await seenBy(coord, `youth_id = ANY($1::uuid[])`, [pgArray([ya, yb])]))).toHaveLength(2);

    // o histórico segue o jovem: depois que ya muda para B, o líder A deixa de ver o que já foi registrado
    await t.as(coord, () => t.q(`UPDATE public.youth SET group_id = $2 WHERE id = $1`, [ya, groupB]));
    expect((await seenBy(leaderA, `youth_id = $1 AND action = 'task_created'`, [ya]))).toHaveLength(0);
    expect((await seenBy(leaderB, `youth_id = $1 AND action = 'task_created'`, [ya]))).toHaveLength(1);
  });

  it('anon não lê; usuário sem papel não lê nada', async () => {
    await expect(t.as(null, () => t.q(`SELECT count(*) FROM public.activity_log`))).rejects.toThrow(/permission denied/);
    expect(await t.as(crypto.randomUUID(), () => t.q(`SELECT id FROM public.activity_log`))).toHaveLength(0);
  });

  it('consulta paginável do frontend: ordem, count exato, filtros por jovem/ação/período', async () => {
    const y = await mkYouth(groupA);
    await t.as(leaderA, () => t.q(`INSERT INTO public.tasks (title, youth_id) VALUES ('p1', $1)`, [y]));
    await t.as(leaderA, () => t.q(`INSERT INTO public.tasks (title, youth_id) VALUES ('p2', $1)`, [y]));
    await t.as(leaderA, () => t.q(`UPDATE public.youth SET is_active = false WHERE id = $1`, [y]));

    const page = (limit: number, offset: number, where = 'youth_id = $1', params: unknown[] = [y]) =>
      t.as(leaderA, () => t.q<Entry & { total: string }>(
        `SELECT ${COLS}, count(*) OVER ()::text AS total FROM public.activity_log WHERE ${where}
          ORDER BY occurred_at DESC, id DESC LIMIT ${limit} OFFSET ${offset}`, params));
    const p1 = await page(2, 0);
    const p2 = await page(2, 2);
    expect(p1).toHaveLength(2);
    expect(p2).toHaveLength(1);
    expect(p1[0].total).toBe('3');
    expect(p1[0].action).toBe('youth_deactivated');            // mais recente primeiro
    expect([...p1, ...p2].map((r) => r.id)).toEqual([...new Set([...p1, ...p2].map((r) => r.id))]);

    expect(await page(10, 0, `youth_id = $1 AND action = ANY($2::text[])`, [y, '{task_created}'])).toHaveLength(2);
    expect(await page(10, 0, `youth_id = $1 AND occurred_at >= now() + interval '1 day'`, [y])).toHaveLength(0);
    expect(await page(10, 0, `youth_id = $1 AND occurred_at < now() + interval '1 day' AND group_id = $2`, [y, groupA])).toHaveLength(3);
  });
});

describe('imutabilidade, integridade e vazamento', () => {
  it('clientes (coordenador inclusive) não têm INSERT/UPDATE/DELETE; anon nada', async () => {
    const [{ id }] = await t.q<{ id: string }>(`SELECT id FROM public.activity_log LIMIT 1`);
    for (const user of [coord, leaderA]) {
      await expect(t.as(user, () => t.q(
        `INSERT INTO public.activity_log (action, entity_type, summary) VALUES ('task_created', 'task', 'forjado')`))).rejects.toThrow(/permission denied/);
      await expect(t.as(user, () => t.q(`UPDATE public.activity_log SET summary = 'x' WHERE id = $1`, [id]))).rejects.toThrow(/permission denied/);
      await expect(t.as(user, () => t.q(`DELETE FROM public.activity_log WHERE id = $1`, [id]))).rejects.toThrow(/permission denied/);
    }
    await expect(t.as(null, () => t.q(`INSERT INTO public.activity_log (action, entity_type, summary) VALUES ('task_created','task','x')`)))
      .rejects.toThrow(/permission denied/);
    await expect(t.as(coord, () => t.q(`TRUNCATE public.activity_log`))).rejects.toThrow(/permission denied/);
  });

  it('defesa em profundidade: mesmo com privilégio e policy concedidos por engano, o trigger bloqueia UPDATE/DELETE de clientes', async () => {
    const [{ id }] = await t.q<{ id: string }>(`SELECT id FROM public.activity_log LIMIT 1`);
    await t.q(`GRANT UPDATE, DELETE ON public.activity_log TO authenticated`);
    await t.q(`CREATE POLICY tmp_upd ON public.activity_log FOR UPDATE USING (true)`);
    await t.q(`CREATE POLICY tmp_del ON public.activity_log FOR DELETE USING (true)`);
    try {
      // coordenador enxerga a linha (RLS de SELECT) e teria privilégio: o trigger de imutabilidade recusa
      await expect(t.as(coord, () => t.q(`UPDATE public.activity_log SET summary = 'x' WHERE id = $1`, [id])))
        .rejects.toThrow(/não pode ser alterado/);
      await expect(t.as(coord, () => t.q(`DELETE FROM public.activity_log WHERE id = $1`, [id])))
        .rejects.toThrow(/não pode ser alterado/);
    } finally {
      await t.q(`DROP POLICY tmp_upd ON public.activity_log`);
      await t.q(`DROP POLICY tmp_del ON public.activity_log`);
      await t.q(`REVOKE UPDATE, DELETE ON public.activity_log FROM authenticated`);
    }
    const [row] = await t.q<{ summary: string }>(`SELECT summary FROM public.activity_log WHERE id = $1`, [id]);
    expect(row.summary).not.toBe('x');
  });

  it('funções internas não são chamáveis por clientes; grants e search_path', async () => {
    await expect(t.as(coord, () => t.q(
      `SELECT public.activity_write('task_created', 'task', NULL, NULL, NULL, 'forjado', '{}'::jsonb)`))).rejects.toThrow(/permission denied/);
    await expect(t.as(coord, () => t.q(`SELECT public.attendance_log_activity()`))).rejects.toThrow(/permission denied/);

    const privs = await t.q<{ proname: string; anon: boolean; authed: boolean; definer: boolean; cfg: string | null }>(
      `SELECT p.proname, p.prosecdef AS definer, p.proconfig::text AS cfg,
              has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
              has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authed
         FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
          AND p.proname IN ('activity_write', 'attendance_log_activity', 'follow_ups_log_activity',
                            'follow_up_transfers_log_activity', 'tasks_log_activity', 'alerts_log_activity',
                            'youth_log_activity', 'activity_log_immutable')`);
    expect(privs).toHaveLength(8);
    for (const p of privs) {
      expect(p, p.proname).toMatchObject({ anon: false, authed: false });
      if (p.definer) expect(p.cfg, p.proname).toContain('search_path=public');
    }
  });

  it('CHECKs: lista fechada de ações, tipo de entidade, resumo curto e meta pequeno (objeto)', async () => {
    const ins = (cols: string) => t.q(
      `INSERT INTO public.activity_log (action, entity_type, summary, meta) VALUES ${cols}`);
    await expect(ins(`('qualquer_coisa', 'task', 'x', '{}')`)).rejects.toThrow(/check/i);
    await expect(ins(`('task_created', 'tabela', 'x', '{}')`)).rejects.toThrow(/check/i);
    await expect(ins(`('task_created', 'task', '', '{}')`)).rejects.toThrow(/check/i);
    await expect(ins(`('task_created', 'task', '${'x'.repeat(201)}', '{}')`)).rejects.toThrow(/check/i);
    await expect(ins(`('task_created', 'task', 'x', '[]')`)).rejects.toThrow(/check/i);
    await expect(ins(`('task_created', 'task', 'x', '{"a":"${'x'.repeat(1001)}"}')`)).rejects.toThrow(/check/i);
    await expect(ins(`('task_created', 'task', 'x', '{"a":1}')`)).resolves.toBeDefined();
    await t.q(`DELETE FROM public.activity_log WHERE summary = 'x' AND action = 'task_created' AND meta = '{"a":1}'`);
  });

  it('sem vazamento: nenhum texto livre (motivo, notas, título, observação) chega ao histórico', async () => {
    const all = await t.q<{ j: string }>(`SELECT to_jsonb(a)::text AS j FROM public.activity_log a`);
    expect(all.length).toBeGreaterThan(10);
    expect(all.filter((r) => r.j.includes(SECRET))).toEqual([]);
    expect(all.filter((r) => /Jovem Log|Renomeado/.test(r.j))).toEqual([]); // nem nomes de jovens
    const summaries = new Set((await t.q<{ summary: string }>(`SELECT DISTINCT summary FROM public.activity_log`)).map((r) => r.summary));
    for (const s of summaries) {
      expect(s).toMatch(/^(Chamada registrada: \d+ presentes? e \d+ ausentes?\.|Acompanhamento registrado\.|Acompanhamento transferido para outro responsável\.|Ação criada\.|Ação concluída\.|Alerta resolvido\.|Alerta dispensado\.|Grupo do jovem alterado\.|Jovem desassociado do grupo\.|Jovem reativado\.|Jovem inativado\.|Série de encontros criada\.)$/);
    }
  });

  it('remover jovem ou usuário não apaga o histórico (youth_id/actor_id viram NULL, actor_name permanece)', async () => {
    const y = await mkYouth(groupA);
    await t.as(leaderA, () => t.q(`INSERT INTO public.tasks (title, youth_id) VALUES ('del', $1)`, [y]));
    const temp = await t.createUser('Temporário', 'leader');
    const [{ id }] = await t.as(temp, () => t.q<{ id: string }>(
      `INSERT INTO public.tasks (title) VALUES ('minha') RETURNING id`));
    expect(await logOf('task_created', id)).toHaveLength(1);

    await t.q(`DELETE FROM public.youth WHERE id = $1`, [y]);
    await t.q(`DELETE FROM auth.users WHERE id = $1`, [temp]);
    const orphanYouth = await log(`action = 'task_created' AND summary = 'Ação criada.' AND youth_id IS NULL AND group_id = $1`, [groupA]);
    expect(orphanYouth.length).toBeGreaterThan(0);
    const [e] = await logOf('task_created', id);
    expect(e).toMatchObject({ actor_id: null, actor_name: 'Temporário' });
  });
});
