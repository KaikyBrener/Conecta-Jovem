import { beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './harness';
import { serviceApi } from './communications-helpers';

// Migration 021: anonymize_youth — limpa dados pessoais do jovem preservando id, grupo e estatísticas.

let t: TestDb;
let coord: string, leader: string;
let g1: string;

const PII = 'DADO-PESSOAL';

async function mkYouthFull(name: string): Promise<string> {
  return (await t.q<{ id: string }>(
    `INSERT INTO public.youth (full_name, birth_date, gender, phone, email, address, notes, group_id, created_by)
     VALUES ($1, '2008-05-10', 'female', '27999990000', $2, 'Rua ' || $3, 'Obs ' || $3, $4, $5) RETURNING id`,
    [name, `${name.toLowerCase().replace(/\s/g, '')}@exemplo.com`, PII, g1, coord]))[0].id;
}

const anonymize = (user: string | null, id: string | null) =>
  t.as(user, async () =>
    (await t.q<{ r: { youth_id: string; tasks: number; follow_ups: number; communications: number } }>(
      `SELECT public.anonymize_youth($1::uuid) AS r`, [id]))[0].r);

beforeAll(async () => {
  t = await createTestDb();
  coord = await t.createUser('Coordenadora', 'coordinator');
  leader = await t.createUser('Líder', 'leader');
  g1 = (await t.q<{ id: string }>(
    `INSERT INTO public.groups (name, leader_id) VALUES ('Grupo 021', $1) RETURNING id`, [leader]))[0].id;
}, 60_000);

describe('migration 021: anonymize_youth', () => {
  it('limpa dados pessoais em todas as tabelas, mantém id, grupo, presença e contagens', async () => {
    const y = await mkYouthFull('Maria Silva');
    const bystander = await mkYouthFull('Joao Souza');

    // presença com observação + faltas suficientes para gerar alerta (limite padrão 3)
    for (let i = 1; i <= 3; i++) {
      const ev = (await t.q<{ id: string }>(
        `INSERT INTO public.events (title, event_date, status, created_by)
         VALUES ($1, now() - ($2 || ' days')::interval, 'completed', $3) RETURNING id`, [`Enc ${i}`, String(i * 7), coord]))[0].id;
      await t.q(`INSERT INTO public.event_groups (event_id, group_id) VALUES ($1, $2)`, [ev, g1]);
      await t.q(`INSERT INTO public.attendance (event_id, youth_id, group_id, present, notes, recorded_by)
                 VALUES ($1, $2, $3, false, $4, $5)`, [ev, y, g1, `Nota ${PII}`, coord]);
      await t.q(`INSERT INTO public.attendance (event_id, youth_id, group_id, present, notes, recorded_by)
                 VALUES ($1, $2, $3, true, $4, $5)`, [ev, bystander, g1, `Nota ${PII}`, coord]);
    }
    const [alert] = await t.q<{ id: string }>(`SELECT id FROM public.alerts WHERE youth_id = $1`, [y]);
    expect(alert).toBeTruthy();
    await t.as(coord, () => t.q(
      `UPDATE public.alerts SET status = 'resolved', resolution_notes = $2 WHERE id = $1`, [alert.id, `Conversei ${PII}`]));

    const task = (await t.q<{ id: string }>(
      `INSERT INTO public.tasks (title, description, youth_id, created_by)
       VALUES ($1, $2, $3, $4) RETURNING id`, [`Ligar para Maria ${PII}`, `Desc ${PII}`, y, coord]))[0].id;
    const fu = (await t.q<{ id: string }>(
      `INSERT INTO public.follow_ups (youth_id, reason, notes, next_action, responsible_id, created_by)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`, [y, `Motivo ${PII}`, `Notas ${PII}`, `Ação ${PII}`, leader, coord]))[0].id;
    await t.as(coord, () => t.q(`SELECT public.transfer_follow_up($1, $2, $3)`, [fu, coord, `Transferi ${PII}`]));
    const comm = (await t.q<{ id: string }>(
      `INSERT INTO public.communications (youth_id, recipient_email, recipient_name, recipient_kind, subject, body, created_by)
       VALUES ($1, 'responsavel@exemplo.com', $2, 'guardian', $3, $4, $5) RETURNING id`,
      [y, `Mãe ${PII}`, `Assunto ${PII}`, `Corpo ${PII}`, coord]))[0].id;
    await t.q(`UPDATE public.communications SET status = 'cancelled' WHERE id = $1`, [comm]);

    const before = Number((await t.q<{ n: string }>(`SELECT count(*)::text AS n FROM public.attendance WHERE youth_id = $1`, [y]))[0].n);
    const r = await anonymize(coord, y);
    expect(r).toMatchObject({ youth_id: y, tasks: 1, follow_ups: 1, communications: 1 });

    const [yo] = await t.q<Record<string, any>>(`SELECT * FROM public.youth WHERE id = $1`, [y]);
    expect(yo).toMatchObject({
      full_name: 'Jovem anonimizado', birth_date: null, gender: null, phone: null, email: null,
      address: null, notes: null, is_active: false, group_id: g1,
    });

    const dump = async (sql: string) => JSON.stringify(await t.q(sql, [y]));
    expect(await dump(`SELECT notes FROM public.attendance WHERE youth_id = $1`)).not.toContain(PII);
    expect(await dump(`SELECT resolution_notes FROM public.alerts WHERE youth_id = $1`)).not.toContain(PII);
    expect(await dump(`SELECT title, description FROM public.tasks WHERE youth_id = $1`)).not.toContain(PII);
    expect(await dump(`SELECT reason, notes, next_action FROM public.follow_ups WHERE youth_id = $1`)).not.toContain(PII);
    expect(await dump(`SELECT t.reason FROM public.follow_up_transfers t JOIN public.follow_ups f ON f.id = t.follow_up_id WHERE f.youth_id = $1`))
      .not.toContain(PII);
    expect(await dump(`SELECT recipient_email, recipient_name, subject, body FROM public.communications WHERE youth_id = $1`))
      .not.toContain(PII);
    expect(await dump(`SELECT recipient_email FROM public.communications WHERE youth_id = $1`)).toContain('anonimizado@anonimizado.invalid');
    expect(await dump(`SELECT summary, meta::text FROM public.activity_log WHERE youth_id = $1`)).not.toContain(PII);

    // preserva: presença (linhas), status da comunicação, id da tarefa
    const after = Number((await t.q<{ n: string }>(`SELECT count(*)::text AS n FROM public.attendance WHERE youth_id = $1`, [y]))[0].n);
    expect(after).toBe(before);
    expect((await t.q<{ s: string }>(`SELECT status::text AS s FROM public.communications WHERE id = $1`, [comm]))[0].s).toBe('cancelled');
    expect((await t.q(`SELECT 1 FROM public.tasks WHERE id = $1`, [task])).length).toBe(1);

    // não toca em outro jovem
    const [by] = await t.q<Record<string, any>>(`SELECT * FROM public.youth WHERE id = $1`, [bystander]);
    expect(by.full_name).toBe('Joao Souza');
    expect(by.email).toBeTruthy();
    expect(JSON.stringify(await t.q(`SELECT notes FROM public.attendance WHERE youth_id = $1`, [bystander]))).toContain(PII);
  });

  it('é idempotente (repetir não falha)', async () => {
    const y = await mkYouthFull('Ana Lima');
    await anonymize(coord, y);
    await expect(anonymize(coord, y)).resolves.toMatchObject({ youth_id: y });
  });

  it('recusa quando há e-mail em envio (sending), sem alterar nada', async () => {
    const y = await mkYouthFull('Pedro Rocha');
    const c = (await t.q<{ id: string }>(
      `INSERT INTO public.communications (youth_id, recipient_email, recipient_kind, subject, body, created_by)
       VALUES ($1, 'x@exemplo.com', 'guardian', 'Assunto', 'Corpo', $2) RETURNING id`, [y, coord]))[0].id;
    const api = serviceApi(t);
    const b = await api.begin(c, coord);
    expect(b.ok).toBe(true);
    await expect(anonymize(coord, y)).rejects.toThrow(/em envio/);
    expect((await t.q<{ n: string }>(`SELECT full_name AS n FROM public.youth WHERE id = $1`, [y]))[0].n).toBe('Pedro Rocha');
    await api.finish(c, true);
    await expect(anonymize(coord, y)).resolves.toMatchObject({ communications: 1 });
  });

  it('só coordenador; sem sessão e jovem inexistente falham', async () => {
    const y = await mkYouthFull('Carla Dias');
    await expect(anonymize(leader, y)).rejects.toThrow(/Apenas coordenadores/);
    await expect(anonymize(null, y)).rejects.toThrow(/permission denied/);
    await expect(anonymize(coord, crypto.randomUUID())).rejects.toThrow(/Jovem não encontrado/);
    await expect(anonymize(coord, null)).rejects.toThrow(/Informe o jovem/);
    expect((await t.q<{ n: string }>(`SELECT full_name AS n FROM public.youth WHERE id = $1`, [y]))[0].n).toBe('Carla Dias');
  });
});
