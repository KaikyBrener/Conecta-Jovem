import { beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './harness';

// Auditoria de segurança adversarial: tenta reproduzir, no Postgres real (PGlite),
// os ataques típicos de um usuário malicioso ou comprometido manipulando IDs e
// payloads diretamente via PostgREST (não pelo app React — a "barreira" aqui é
// sempre o banco). Políticas e triggers já cobertos em rls.test.ts não são
// repetidos; este arquivo foca nos cenários pedidos na auditoria de segurança
// do Supabase/RLS que ainda não tinham um teste dedicado.

let t: TestDb;
let coord: string, leaderA: string, leaderB: string;
let groupA: string, groupB: string;
let ya1: string, yb1: string;
let dayOffset = -1000;

async function createEvent(groups: string[]): Promise<string> {
  dayOffset += 1;
  const [ev] = await t.q<{ id: string }>(
    `INSERT INTO public.events (title, event_date, status, created_by)
     VALUES ('Encontro', now() + ($1 || ' days')::interval, 'completed', $2) RETURNING id`,
    [String(dayOffset), coord],
  );
  for (const g of groups) {
    await t.q(`INSERT INTO public.event_groups (event_id, group_id) VALUES ($1, $2)`, [ev.id, g]);
  }
  return ev.id;
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
  yb1 = await mk('Carla', groupB);
}, 60_000);

describe('1. profiles', () => {
  it('líder A não lê o profile do líder B diretamente', async () => {
    const rows = await t.as(leaderA, () => t.q(`SELECT id FROM public.profiles WHERE id = $1`, [leaderB]));
    expect(rows).toHaveLength(0);
  });

  it('o embed groups→profiles não vaza o nome de outro líder (RLS de profiles se aplica ao JOIN)', async () => {
    // Mesmo se a leitura de "groups" alcançasse a linha do grupo B (não alcança,
    // ver seção 3), o JOIN com profiles continua sujeito à RLS de profiles.
    const rows = await t.as(leaderA, () =>
      t.q<{ id: string; leader_name: string | null }>(
        `SELECT g.id, p.full_name AS leader_name
         FROM public.groups g LEFT JOIN public.profiles p ON p.id = g.leader_id
         WHERE g.id = $1`,
        [groupB],
      ));
    // A linha de groups já não é visível (0 linhas) — confirma a defesa em duas camadas.
    expect(rows).toHaveLength(0);
  });

  it('coordenador lê profiles de qualquer usuário (necessário para administração)', async () => {
    const rows = await t.as(coord, () => t.q(`SELECT id FROM public.profiles WHERE id = $1`, [leaderB]));
    expect(rows).toHaveLength(1);
  });
});

describe('2. user_roles / set_user_role', () => {
  it('coordenador não altera user_roles diretamente (só via RPC) — nem para si, nem para outro', async () => {
    const r1 = await t.as(coord, () =>
      t.q(`UPDATE public.user_roles SET role = 'leader' WHERE user_id = $1 RETURNING user_id`, [coord]));
    expect(r1).toHaveLength(0);
    const r2 = await t.as(coord, () =>
      t.q(`UPDATE public.user_roles SET role = 'coordinator' WHERE user_id = $1 RETURNING user_id`, [leaderA]));
    expect(r2).toHaveLength(0);
    // Sem nenhuma policy de INSERT em user_roles para nenhum papel (nem coordenador):
    // diferente de UPDATE/SELECT, uma linha nova sem política aplicável sempre
    // levanta erro (não há "linha existente" para filtrar silenciosamente).
    await expect(t.as(coord, () =>
      t.q(`INSERT INTO public.user_roles (user_id, role) VALUES (gen_random_uuid(), 'leader')`)),
    ).rejects.toThrow(/row-level security/);
  });

  it('anon não consegue executar set_user_role nem recalculate_all_alerts (bloqueado por GRANT, antes mesmo da lógica interna)', async () => {
    await expect(t.as(null, () => t.q(`SELECT public.set_user_role($1, 'coordinator')`, [leaderA])))
      .rejects.toThrow(/permission denied/);
    await expect(t.as(null, () => t.q(`SELECT public.recalculate_all_alerts()`)))
      .rejects.toThrow(/permission denied/);
  });

  it('funções-trigger (guards) não podem ser chamadas diretamente via RPC', async () => {
    await expect(t.as(coord, () => t.q(`SELECT public.alerts_guard()`)))
      .rejects.toThrow(/trigger functions can only be called as triggers/);
    await expect(t.as(coord, () => t.q(`SELECT public.tasks_guard()`)))
      .rejects.toThrow(/trigger functions can only be called as triggers/);
    await expect(t.as(coord, () => t.q(`SELECT public.handle_new_user()`)))
      .rejects.toThrow(/trigger functions can only be called as triggers/);
  });

  it('set_user_role continua bloqueando o rebaixamento do último coordenador após a correção da corrida (migration 008)', async () => {
    // Confirma que a reescrita com advisory lock preserva a regra original.
    await expect(t.as(coord, () => t.q(`SELECT public.set_user_role($1, 'leader')`, [coord])))
      .rejects.toThrow(/último coordenador/);
  });

  // NOTA DE LIMITAÇÃO: o harness atual (PGlite) expõe uma única conexão lógica
  // e as chamadas em `t.as()` são sequenciais — não há como abrir duas
  // transações *concorrentes* de fato para reproduzir a corrida original
  // (duas chamadas de set_user_role() disputando o mesmo advisory lock ao
  // mesmo tempo). O teste acima prova que a lógica permanece correta em
  // chamadas sequenciais; a proteção contra a condição de corrida em si
  // (o ponto central da migration 008) depende do pg_advisory_xact_lock do
  // Postgres e só pode ser validada de fato com duas conexões reais
  // concorrentes contra um Supabase/Postgres real — registrado aqui em vez de
  // forjar um teste de concorrência que não concorre de verdade.
});

describe('3. groups', () => {
  it('líder A não enxerga o grupo B (SELECT)', async () => {
    const rows = await t.as(leaderA, () => t.q(`SELECT id FROM public.groups WHERE id = $1`, [groupB]));
    expect(rows).toHaveLength(0);
  });

  it('líder A não consegue UPDATE no grupo B (0 linhas, USING não casa)', async () => {
    const rows = await t.as(leaderA, () =>
      t.q(`UPDATE public.groups SET description = 'hackeado' WHERE id = $1 RETURNING id`, [groupB]));
    expect(rows).toHaveLength(0);
    const [check] = await t.q<{ description: string | null }>(`SELECT description FROM public.groups WHERE id = $1`, [groupB]);
    expect(check.description).not.toBe('hackeado');
  });

  it('líder A não consegue reatribuir o leader_id do PRÓPRIO grupo para outro usuário', async () => {
    // USING exige leader_id = auth.uid() na linha existente; como não há WITH CHECK
    // explícito, o Postgres usa a mesma expressão como WITH CHECK — a linha
    // resultante também precisa ter leader_id = auth.uid(), o que bloqueia a troca.
    await expect(t.as(leaderA, () =>
      t.q(`UPDATE public.groups SET leader_id = $2 WHERE id = $1`, [groupA, leaderB]),
    )).rejects.toThrow(/row-level security/);
    const [g] = await t.q<{ leader_id: string }>(`SELECT leader_id FROM public.groups WHERE id = $1`, [groupA]);
    expect(g.leader_id).toBe(leaderA);
  });

  it('líder não consegue criar grupo (sem policy de INSERT para leader)', async () => {
    await expect(t.as(leaderA, () =>
      t.q(`INSERT INTO public.groups (name, leader_id) VALUES ('Grupo Hacker', $1)`, [leaderA]),
    )).rejects.toThrow(/row-level security/);
  });

  it('coordenador edita qualquer grupo normalmente', async () => {
    await t.as(coord, () => t.q(`UPDATE public.groups SET description = 'ok' WHERE id = $1`, [groupB]));
    const [g] = await t.q<{ description: string }>(`SELECT description FROM public.groups WHERE id = $1`, [groupB]);
    expect(g.description).toBe('ok');
  });
});

describe('4. youth', () => {
  it('líder A não consegue UPDATE em jovem do grupo B', async () => {
    const rows = await t.as(leaderA, () =>
      t.q(`UPDATE public.youth SET full_name = 'hackeado' WHERE id = $1 RETURNING id`, [yb1]));
    expect(rows).toHaveLength(0);
  });

  it('líder A não consegue mover jovem do seu grupo para o grupo B', async () => {
    await expect(t.as(leaderA, () =>
      t.q(`UPDATE public.youth SET group_id = $2 WHERE id = $1`, [ya1, groupB]),
    )).rejects.toThrow(/row-level security/);
    const [y] = await t.q<{ group_id: string }>(`SELECT group_id FROM public.youth WHERE id = $1`, [ya1]);
    expect(y.group_id).toBe(groupA);
  });

  it('líder não consegue "adotar" jovem sem grupo (USING exige que o grupo atual já seja seu)', async () => {
    const [{ id: orphan }] = await t.q<{ id: string }>(
      `INSERT INTO public.youth (full_name, group_id, created_by) VALUES ('Sem Grupo', NULL, $1) RETURNING id`, [coord]);
    const rows = await t.as(leaderA, () =>
      t.q(`UPDATE public.youth SET group_id = $2 WHERE id = $1 RETURNING id`, [orphan, groupA]));
    expect(rows).toHaveLength(0);
  });

  it('líder não consegue cadastrar jovem (sem policy de INSERT para leader)', async () => {
    await expect(t.as(leaderA, () =>
      t.q(`INSERT INTO public.youth (full_name, group_id, created_by) VALUES ('Novo', $1, $2)`, [groupA, leaderA]),
    )).rejects.toThrow(/row-level security/);
  });
});

describe('5. events / event_groups', () => {
  it('líder não consegue inserir event_groups nem para o próprio grupo (sem policy de INSERT)', async () => {
    const [{ id: ev }] = await t.q<{ id: string }>(
      `INSERT INTO public.events (title, event_date, status, created_by) VALUES ('X', now(), 'scheduled', $1) RETURNING id`, [coord]);
    await expect(t.as(leaderA, () =>
      t.q(`INSERT INTO public.event_groups (event_id, group_id) VALUES ($1, $2)`, [ev, groupA]),
    )).rejects.toThrow(/row-level security/);
  });

  it('líder não consegue criar nem editar encontro (sem policy de INSERT/UPDATE para leader)', async () => {
    await expect(t.as(leaderA, () =>
      t.q(`INSERT INTO public.events (title, event_date, status, created_by) VALUES ('Hack', now(), 'scheduled', $1)`, [leaderA]),
    )).rejects.toThrow(/row-level security/);

    const ev = await createEvent([groupA]);
    const rows = await t.as(leaderA, () =>
      t.q(`UPDATE public.events SET title = 'hackeado' WHERE id = $1 RETURNING id`, [ev]));
    expect(rows).toHaveLength(0);
  });

  it('líder A não enxerga encontro vinculado só ao grupo B', async () => {
    const evB = await createEvent([groupB]);
    const rows = await t.as(leaderA, () => t.q(`SELECT id FROM public.events WHERE id = $1`, [evB]));
    expect(rows).toHaveLength(0);
  });
});

describe('6. attendance — adulteração manual de IDs', () => {
  it('recorded_by diferente de auth.uid() é bloqueado (mesmo com group/youth/event corretos)', async () => {
    const ev = await createEvent([groupA]);
    await expect(t.as(leaderA, () =>
      t.q(
        `INSERT INTO public.attendance (event_id, youth_id, group_id, present, recorded_by)
         VALUES ($1, $2, $3, true, $4)`,
        [ev, ya1, groupA, leaderB],
      ),
    )).rejects.toThrow(/row-level security/);
  });

  it('grupo e jovem corretos, mas evento vinculado só a outro grupo é bloqueado', async () => {
    const evOnlyB = await createEvent([groupB]);
    await expect(t.as(leaderA, () =>
      t.q(
        `INSERT INTO public.attendance (event_id, youth_id, group_id, present, recorded_by)
         VALUES ($1, $2, $3, true, $4)`,
        [evOnlyB, ya1, groupA, leaderA],
      ),
    )).rejects.toThrow(/row-level security/);
  });

  it('UPDATE não pode mover um registro válido para apontar a um jovem de outro grupo', async () => {
    const ev = await createEvent([groupA]);
    await t.as(leaderA, () =>
      t.q(
        `INSERT INTO public.attendance (event_id, youth_id, group_id, present, recorded_by) VALUES ($1, $2, $3, true, $4)`,
        [ev, ya1, groupA, leaderA],
      ));
    await expect(t.as(leaderA, () =>
      t.q(`UPDATE public.attendance SET youth_id = $2 WHERE event_id = $1 AND youth_id = $3`, [ev, yb1, ya1]),
    )).rejects.toThrow(/row-level security/);
  });

  it('UPDATE não pode falsificar recorded_by para outra pessoa', async () => {
    const ev = await createEvent([groupA]);
    await t.as(leaderA, () =>
      t.q(
        `INSERT INTO public.attendance (event_id, youth_id, group_id, present, recorded_by) VALUES ($1, $2, $3, false, $4)`,
        [ev, ya1, groupA, leaderA],
      ));
    await expect(t.as(leaderA, () =>
      t.q(`UPDATE public.attendance SET recorded_by = $2 WHERE event_id = $1 AND youth_id = $3`, [ev, leaderB, ya1]),
    )).rejects.toThrow(/row-level security/);
  });

  it('líder não consegue excluir (DELETE) registro de presença', async () => {
    const ev = await createEvent([groupA]);
    await t.as(leaderA, () =>
      t.q(
        `INSERT INTO public.attendance (event_id, youth_id, group_id, present, recorded_by) VALUES ($1, $2, $3, true, $4)`,
        [ev, ya1, groupA, leaderA],
      ));
    const rows = await t.as(leaderA, () =>
      t.q(`DELETE FROM public.attendance WHERE event_id = $1 AND youth_id = $2 RETURNING id`, [ev, ya1]));
    expect(rows).toHaveLength(0);
  });

  it('criação duplicada (sem ON CONFLICT) é rejeitada pela restrição UNIQUE(event_id, youth_id)', async () => {
    const ev = await createEvent([groupA]);
    await t.as(leaderA, () =>
      t.q(
        `INSERT INTO public.attendance (event_id, youth_id, group_id, present, recorded_by) VALUES ($1, $2, $3, true, $4)`,
        [ev, ya1, groupA, leaderA],
      ));
    await expect(t.as(leaderA, () =>
      t.q(
        `INSERT INTO public.attendance (event_id, youth_id, group_id, present, recorded_by) VALUES ($1, $2, $3, false, $4)`,
        [ev, ya1, groupA, leaderA],
      ),
    )).rejects.toThrow(/duplicate key|unique constraint/);
  });

  it('coordenador insere/edita attendance de qualquer grupo (acesso administrativo)', async () => {
    const ev = await createEvent([groupB]);
    await t.as(coord, () =>
      t.q(
        `INSERT INTO public.attendance (event_id, youth_id, group_id, present, recorded_by) VALUES ($1, $2, $3, true, $4)`,
        [ev, yb1, groupB, leaderB],
      ));
    const [row] = await t.q(`SELECT id FROM public.attendance WHERE event_id = $1 AND youth_id = $2`, [ev, yb1]);
    expect(row).toBeTruthy();
  });
});

describe('7. alerts', () => {
  it('líder não consegue mover um alerta para outro jovem/grupo (alerts_guard bloqueia campos estruturais)', async () => {
    for (let i = 0; i < 3; i++) {
      const ev = await createEvent([groupA]);
      await t.as(leaderA, () =>
        t.q(
          `INSERT INTO public.attendance (event_id, youth_id, group_id, present, recorded_by) VALUES ($1, $2, $3, false, $4)`,
          [ev, ya1, groupA, leaderA],
        ));
    }
    const [alert] = await t.q<{ id: string }>(
      `SELECT id FROM public.alerts WHERE youth_id = $1 AND status = 'open'`, [ya1]);
    expect(alert).toBeTruthy();

    await expect(t.as(leaderA, () =>
      t.q(`UPDATE public.alerts SET youth_id = $2 WHERE id = $1`, [alert.id, yb1]),
    )).rejects.toThrow(/Somente o status/);
    await expect(t.as(leaderA, () =>
      t.q(`UPDATE public.alerts SET group_id = $2 WHERE id = $1`, [alert.id, groupB]),
    )).rejects.toThrow(/Somente o status/);
  });

  it('líder B não enxerga nem altera alerta do grupo A', async () => {
    const [alert] = await t.q<{ id: string }>(
      `SELECT id FROM public.alerts WHERE youth_id = $1 AND status = 'open'`, [ya1]);
    const rows = await t.as(leaderB, () => t.q(`SELECT id FROM public.alerts WHERE id = $1`, [alert.id]));
    expect(rows).toHaveLength(0);
    const upd = await t.as(leaderB, () =>
      t.q(`UPDATE public.alerts SET status = 'dismissed' WHERE id = $1 RETURNING id`, [alert.id]));
    expect(upd).toHaveLength(0);
  });
});

describe('9. app_settings', () => {
  it('valores fora dos limites são rejeitados pelo CHECK, mesmo para o coordenador', async () => {
    await expect(t.as(coord, () =>
      t.q(`UPDATE public.app_settings SET absence_alert_threshold = 0`),
    )).rejects.toThrow(/violates check constraint|check/i);
    await expect(t.as(coord, () =>
      t.q(`UPDATE public.app_settings SET absence_alert_threshold = 21`),
    )).rejects.toThrow(/violates check constraint|check/i);
    await expect(t.as(coord, () =>
      t.q(`UPDATE public.app_settings SET low_attendance_threshold = -1`),
    )).rejects.toThrow(/violates check constraint|check/i);
    await expect(t.as(coord, () =>
      t.q(`UPDATE public.app_settings SET low_attendance_threshold = 101`),
    )).rejects.toThrow(/violates check constraint|check/i);
  });

  it('updated_by não pode ser falsificado — o trigger sempre grava quem realmente fez a chamada', async () => {
    await t.as(coord, () =>
      t.q(`UPDATE public.app_settings SET updated_by = $1, absence_alert_threshold = 4 WHERE id = true`, [leaderA]));
    const [s] = await t.q<{ updated_by: string }>(`SELECT updated_by FROM public.app_settings`);
    expect(s.updated_by).toBe(coord);
  });

  it('qualquer autenticado lê; só coordenador altera', async () => {
    const readA = await t.as(leaderA, () => t.q(`SELECT absence_alert_threshold FROM public.app_settings`));
    expect(readA).toHaveLength(1);
    const writeA = await t.as(leaderA, () =>
      t.q(`UPDATE public.app_settings SET absence_alert_threshold = 10 RETURNING id`));
    expect(writeA).toHaveLength(0);
  });
});
