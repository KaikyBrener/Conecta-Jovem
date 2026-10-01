import { beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './harness';

let t: TestDb;
let coord: string, leaderA: string, leaderB: string;
let groupA: string, groupB: string;
let ya1: string, ya2: string, yb1: string;
let dayOffset = -400;

// Cria um encontro (como superusuário) vinculado aos grupos, em datas crescentes
async function createEvent(groups: string[], status = 'completed'): Promise<string> {
  dayOffset += 1;
  const [ev] = await t.q<{ id: string }>(
    `INSERT INTO public.events (title, event_date, status, created_by)
     VALUES ('Encontro', now() + ($1 || ' days')::interval, $2::event_status, $3) RETURNING id`,
    [String(dayOffset), status, coord],
  );
  for (const g of groups) {
    await t.q(`INSERT INTO public.event_groups (event_id, group_id) VALUES ($1, $2)`, [ev.id, g]);
  }
  return ev.id;
}

// Registra presença como o líder do grupo (caminho real do app)
async function mark(leader: string, eventId: string, youthId: string, groupId: string, present: boolean) {
  await t.as(leader, () =>
    t.q(
      `INSERT INTO public.attendance (event_id, youth_id, group_id, present, recorded_by)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (event_id, youth_id) DO UPDATE SET present = EXCLUDED.present, recorded_by = EXCLUDED.recorded_by`,
      [eventId, youthId, groupId, present, leader],
    ),
  );
}

async function openAlert(youthId: string) {
  const rows = await t.q<{ id: string; consecutive_absences: number; group_id: string }>(
    `SELECT id, consecutive_absences, group_id FROM public.alerts WHERE youth_id = $1 AND status = 'open'`,
    [youthId],
  );
  return rows[0] ?? null;
}

beforeAll(async () => {
  t = await createTestDb();
  coord = await t.createUser('Coordenadora', 'coordinator');
  leaderA = await t.createUser('Líder A', 'leader');
  leaderB = await t.createUser('Líder B', 'leader');

  [{ id: groupA }] = await t.q<{ id: string }>(
    `INSERT INTO public.groups (name, leader_id) VALUES ('Grupo A', $1) RETURNING id`, [leaderA]);
  [{ id: groupB }] = await t.q<{ id: string }>(
    `INSERT INTO public.groups (name, leader_id) VALUES ('Grupo B', $1) RETURNING id`, [leaderB]);

  const mk = async (name: string, g: string) =>
    (await t.q<{ id: string }>(
      `INSERT INTO public.youth (full_name, group_id, created_by) VALUES ($1, $2, $3) RETURNING id`,
      [name, g, coord],
    ))[0].id;
  ya1 = await mk('Ana', groupA);
  ya2 = await mk('Bruno', groupA);
  yb1 = await mk('Carla', groupB);
}, 60_000);

describe('migrations e cadastro', () => {
  it('trigger de novo usuário cria profile e papel', async () => {
    const [p] = await t.q<{ full_name: string; role: string }>(
      `SELECT p.full_name, r.role FROM public.profiles p JOIN public.user_roles r ON r.user_id = p.id WHERE p.id = $1`,
      [leaderA],
    );
    expect(p).toEqual({ full_name: 'Líder A', role: 'leader' });
  });

  it('app_settings tem uma única linha com valores padrão', async () => {
    const rows = await t.q(`SELECT absence_alert_threshold, low_attendance_threshold FROM public.app_settings`);
    expect(rows).toEqual([{ absence_alert_threshold: 3, low_attendance_threshold: 70 }]);
  });

  it('todas as tabelas de public têm RLS habilitado', async () => {
    const rows = await t.q<{ relname: string }>(
      `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT c.relrowsecurity`,
    );
    expect(rows).toEqual([]);
  });
});

describe('RLS básico', () => {
  it('anon não enxerga dados', async () => {
    const counts = await t.as(null, async () => ({
      youth: (await t.q(`SELECT 1 FROM public.youth`)).length,
      alerts: (await t.q(`SELECT 1 FROM public.alerts`)).length,
      tasks: (await t.q(`SELECT 1 FROM public.tasks`)).length,
      settings: (await t.q(`SELECT 1 FROM public.app_settings`)).length,
    }));
    expect(counts).toEqual({ youth: 0, alerts: 0, tasks: 0, settings: 0 });
  });

  it('líder vê só jovens do seu grupo; coordenador vê todos', async () => {
    const a = await t.as(leaderA, () => t.q<{ id: string }>(`SELECT id FROM public.youth ORDER BY full_name`));
    expect(a.map((r) => r.id)).toEqual([ya1, ya2]);
    const c = await t.as(coord, () => t.q(`SELECT id FROM public.youth`));
    expect(c).toHaveLength(3);
  });

  it('líder não registra presença de jovem de outro grupo', async () => {
    const ev = await createEvent([groupA, groupB]);
    await expect(mark(leaderA, ev, yb1, groupB, true)).rejects.toThrow(/row-level security/);
    await expect(mark(leaderA, ev, yb1, groupA, true)).rejects.toThrow(/row-level security/);
  });
});

describe('alertas de faltas consecutivas', () => {
  it('3 faltas seguidas geram alerta aberto visível só ao líder do grupo e coordenador', async () => {
    for (let i = 0; i < 3; i++) {
      const ev = await createEvent([groupA]);
      await mark(leaderA, ev, ya1, groupA, false);
      await mark(leaderA, ev, ya2, groupA, true);
    }
    const alert = await openAlert(ya1);
    expect(alert?.consecutive_absences).toBe(3);
    expect(alert?.group_id).toBe(groupA);
    expect(await openAlert(ya2)).toBeNull();

    expect(await t.as(leaderA, () => t.q(`SELECT id FROM public.alerts`))).toHaveLength(1);
    expect(await t.as(leaderB, () => t.q(`SELECT id FROM public.alerts`))).toHaveLength(0);
    expect(await t.as(coord, () => t.q(`SELECT id FROM public.alerts`))).toHaveLength(1);
  });

  it('nova falta atualiza a contagem do mesmo alerta', async () => {
    const before = await openAlert(ya1);
    const ev = await createEvent([groupA]);
    await mark(leaderA, ev, ya1, groupA, false);
    const after = await openAlert(ya1);
    expect(after?.id).toBe(before?.id);
    expect(after?.consecutive_absences).toBe(4);
  });

  it('encontro cancelado não conta', async () => {
    const ev = await createEvent([groupA], 'cancelled');
    await mark(leaderA, ev, ya1, groupA, false);
    expect((await openAlert(ya1))?.consecutive_absences).toBe(4);
  });

  it('presença resolve o alerta automaticamente', async () => {
    const ev = await createEvent([groupA]);
    await mark(leaderA, ev, ya1, groupA, true);
    expect(await openAlert(ya1)).toBeNull();
    const [a] = await t.q<{ status: string; resolution_notes: string }>(
      `SELECT status, resolution_notes FROM public.alerts WHERE youth_id = $1 ORDER BY created_at DESC LIMIT 1`, [ya1]);
    expect(a.status).toBe('resolved');
    expect(a.resolution_notes).toMatch(/automaticamente/);
  });

  it('líder não cria alerta manualmente', async () => {
    await expect(
      t.as(leaderA, () => t.q(`INSERT INTO public.alerts (youth_id, group_id) VALUES ($1, $2)`, [ya2, groupA])),
    ).rejects.toThrow(/row-level security/);
  });

  it('alerta dispensado não é recriado sem nova falta; nova falta cria outro', async () => {
    for (let i = 0; i < 3; i++) {
      const ev = await createEvent([groupA]);
      await mark(leaderA, ev, ya2, groupA, false);
    }
    const alert = await openAlert(ya2);
    expect(alert).not.toBeNull();

    // Líder só consegue mudar status/observações
    await expect(
      t.as(leaderA, () => t.q(`UPDATE public.alerts SET consecutive_absences = 0 WHERE id = $1`, [alert!.id])),
    ).rejects.toThrow(/Somente o status/);

    await t.as(leaderA, () =>
      t.q(`UPDATE public.alerts SET status = 'dismissed', resolution_notes = 'Viajando' WHERE id = $1`, [alert!.id]));
    const [d] = await t.q<{ resolved_by: string; resolved_at: string | null }>(
      `SELECT resolved_by, resolved_at FROM public.alerts WHERE id = $1`, [alert!.id]);
    expect(d.resolved_by).toBe(leaderA);
    expect(d.resolved_at).not.toBeNull();

    await t.as(coord, () => t.q(`SELECT public.recalculate_all_alerts()`));
    expect(await openAlert(ya2)).toBeNull();

    const ev = await createEvent([groupA]);
    await mark(leaderA, ev, ya2, groupA, false);
    expect((await openAlert(ya2))?.consecutive_absences).toBe(4);
  });

  it('inativar o jovem resolve o alerta', async () => {
    await t.as(leaderA, () => t.q(`UPDATE public.youth SET is_active = false WHERE id = $1`, [ya2]));
    expect(await openAlert(ya2)).toBeNull();
    await t.as(leaderA, () => t.q(`UPDATE public.youth SET is_active = true WHERE id = $1`, [ya2]));
    expect(await openAlert(ya2)).not.toBeNull();
  });

  it('mudar o limite nas configurações recalcula; líder não pode alterar', async () => {
    const r = await t.as(leaderA, () => t.q(`UPDATE public.app_settings SET absence_alert_threshold = 10 RETURNING id`));
    expect(r).toHaveLength(0);

    await t.as(coord, () => t.q(`UPDATE public.app_settings SET absence_alert_threshold = 5`));
    expect(await openAlert(ya2)).toBeNull();
    const [s] = await t.q<{ updated_by: string }>(`SELECT updated_by FROM public.app_settings`);
    expect(s.updated_by).toBe(coord);

    await t.as(coord, () => t.q(`UPDATE public.app_settings SET absence_alert_threshold = 3`));
    expect(await openAlert(ya2)).not.toBeNull();
  });

  it('cancelar o encontro da última falta recalcula o alerta', async () => {
    const yc = (await t.q<{ id: string }>(
      `INSERT INTO public.youth (full_name, group_id, created_by) VALUES ('Duda', $1, $2) RETURNING id`,
      [groupB, coord],
    ))[0].id;
    const evs: string[] = [];
    for (let i = 0; i < 3; i++) {
      const ev = await createEvent([groupB]);
      evs.push(ev);
      await mark(leaderB, ev, yc, groupB, false);
    }
    expect((await openAlert(yc))?.consecutive_absences).toBe(3);

    await t.as(coord, () => t.q(`UPDATE public.events SET status = 'cancelled' WHERE id = $1`, [evs[2]]));
    expect(await openAlert(yc)).toBeNull();

    await t.as(coord, () => t.q(`UPDATE public.events SET status = 'completed' WHERE id = $1`, [evs[2]]));
    expect((await openAlert(yc))?.consecutive_absences).toBe(3);

    // Líder B vê o alerta do seu jovem; líder A não
    expect(await t.as(leaderB, () => t.q(`SELECT id FROM public.alerts WHERE youth_id = $1`, [yc]))).not.toHaveLength(0);
    expect(await t.as(leaderA, () => t.q(`SELECT id FROM public.alerts WHERE youth_id = $1`, [yc]))).toHaveLength(0);
  });

  it('funções internas não são executáveis por clientes', async () => {
    await expect(
      t.as(leaderA, () => t.q(`SELECT public.youth_consecutive_absences($1)`, [ya2])),
    ).rejects.toThrow(/permission denied/);
    await expect(
      t.as(coord, () => t.q(`SELECT public.refresh_youth_alert($1)`, [ya2])),
    ).rejects.toThrow(/permission denied/);
    await expect(
      t.as(leaderA, () => t.q(`SELECT public.recalculate_all_alerts()`)),
    ).rejects.toThrow(/Apenas coordenadores/);
  });
});

describe('tarefas', () => {
  it('líder cria tarefa para si com jovem do seu grupo', async () => {
    const rows = await t.as(leaderA, () =>
      t.q<{ id: string; created_by: string }>(
        `INSERT INTO public.tasks (title, youth_id, group_id, assigned_to, created_by)
         VALUES ('Ligar para Ana', $1, $2, $3, $3) RETURNING id, created_by`,
        [ya1, groupA, leaderA],
      ));
    expect(rows[0].created_by).toBe(leaderA);
  });

  it('líder não cria tarefa com jovem de outro grupo nem atribuída a terceiros', async () => {
    await expect(t.as(leaderA, () =>
      t.q(`INSERT INTO public.tasks (title, youth_id, created_by) VALUES ('x', $1, $2)`, [yb1, leaderA]),
    )).rejects.toThrow(/row-level security/);
    await expect(t.as(leaderA, () =>
      t.q(`INSERT INTO public.tasks (title, assigned_to, created_by) VALUES ('x', $1, $2)`, [leaderB, leaderA]),
    )).rejects.toThrow(/row-level security/);
    await expect(t.as(leaderA, () =>
      t.q(`INSERT INTO public.tasks (title, created_by) VALUES ('x', $1)`, [leaderB]),
    )).rejects.toThrow(/row-level security/);
  });

  it('líder B não vê tarefas do grupo A', async () => {
    expect(await t.as(leaderB, () => t.q(`SELECT id FROM public.tasks`))).toHaveLength(0);
    expect(await t.as(leaderA, () => t.q(`SELECT id FROM public.tasks`))).toHaveLength(1);
  });

  it('concluir tarefa vinculada a alerta resolve o alerta e marca completed_at', async () => {
    const alert = await openAlert(ya2);
    expect(alert).not.toBeNull();
    const [task] = await t.as(coord, () =>
      t.q<{ id: string }>(
        `INSERT INTO public.tasks (title, youth_id, group_id, alert_id, assigned_to, created_by)
         VALUES ('Visitar Bruno', $1, $2, $3, $4, $5) RETURNING id`,
        [ya2, groupA, alert!.id, leaderA, coord],
      ));

    await t.as(leaderA, () => t.q(`UPDATE public.tasks SET status = 'done' WHERE id = $1`, [task.id]));
    const [tk] = await t.q<{ completed_at: string | null }>(`SELECT completed_at FROM public.tasks WHERE id = $1`, [task.id]);
    expect(tk.completed_at).not.toBeNull();

    const [a] = await t.q<{ status: string; resolved_by: string; resolution_notes: string }>(
      `SELECT status, resolved_by, resolution_notes FROM public.alerts WHERE id = $1`, [alert!.id]);
    expect(a.status).toBe('resolved');
    expect(a.resolved_by).toBe(leaderA);
    expect(a.resolution_notes).toContain('Visitar Bruno');

    await t.as(leaderA, () => t.q(`UPDATE public.tasks SET status = 'pending' WHERE id = $1`, [task.id]));
    const [tk2] = await t.q<{ completed_at: string | null }>(`SELECT completed_at FROM public.tasks WHERE id = $1`, [task.id]);
    expect(tk2.completed_at).toBeNull();
  });

  it('líder não reatribui tarefa a terceiros, não troca autor e não exclui tarefa do coordenador', async () => {
    const [task] = await t.q<{ id: string }>(
      `SELECT id FROM public.tasks WHERE title = 'Visitar Bruno'`);
    await expect(t.as(leaderA, () =>
      t.q(`UPDATE public.tasks SET assigned_to = $2 WHERE id = $1`, [task.id, leaderB]),
    )).rejects.toThrow(/si mesmos/);
    await expect(t.as(leaderA, () =>
      t.q(`UPDATE public.tasks SET group_id = $2 WHERE id = $1`, [task.id, groupB]),
    )).rejects.toThrow();

    await t.as(leaderA, () => t.q(`UPDATE public.tasks SET created_by = $2 WHERE id = $1`, [task.id, leaderA]));
    const [tk] = await t.q<{ created_by: string }>(`SELECT created_by FROM public.tasks WHERE id = $1`, [task.id]);
    expect(tk.created_by).toBe(coord);

    const del = await t.as(leaderA, () => t.q(`DELETE FROM public.tasks WHERE id = $1 RETURNING id`, [task.id]));
    expect(del).toHaveLength(0);
  });

  it('líder exclui tarefa que criou', async () => {
    const del = await t.as(leaderA, () =>
      t.q(`DELETE FROM public.tasks WHERE title = 'Ligar para Ana' RETURNING id`));
    expect(del).toHaveLength(1);
  });
});

describe('gestão de papéis', () => {
  it('líder não altera papéis', async () => {
    await expect(t.as(leaderA, () =>
      t.q(`SELECT public.set_user_role($1, 'coordinator')`, [leaderA]),
    )).rejects.toThrow(/Apenas coordenadores/);
  });

  it('líder não altera user_roles diretamente', async () => {
    const r = await t.as(leaderA, () =>
      t.q(`UPDATE public.user_roles SET role = 'coordinator' WHERE user_id = $1 RETURNING user_id`, [leaderA]));
    expect(r).toHaveLength(0);
  });

  it('coordenador promove e rebaixa; não remove o último coordenador', async () => {
    await t.as(coord, () => t.q(`SELECT public.set_user_role($1, 'coordinator')`, [leaderB]));
    await t.as(coord, () => t.q(`SELECT public.set_user_role($1, 'leader')`, [leaderB]));
    const [r] = await t.q<{ role: string }>(`SELECT role FROM public.user_roles WHERE user_id = $1`, [leaderB]);
    expect(r.role).toBe('leader');

    await expect(t.as(coord, () =>
      t.q(`SELECT public.set_user_role($1, 'leader')`, [coord]),
    )).rejects.toThrow(/último coordenador/);
  });

  it('usuário atualiza o próprio nome, mas não o de outro', async () => {
    await t.as(leaderA, () => t.q(`UPDATE public.profiles SET full_name = 'Líder A2' WHERE id = $1`, [leaderA]));
    const other = await t.as(leaderA, () =>
      t.q(`UPDATE public.profiles SET full_name = 'x' WHERE id = $1 RETURNING id`, [leaderB]));
    expect(other).toHaveLength(0);
    const [p] = await t.q<{ full_name: string }>(`SELECT full_name FROM public.profiles WHERE id = $1`, [leaderA]);
    expect(p.full_name).toBe('Líder A2');
  });
});
