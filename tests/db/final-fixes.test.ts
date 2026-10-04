import { beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './harness';

// Migration 017 (correções finais):
//   1) excluir grupo (recusa com jovens/chamada; grupo vazio exclui sem erro no activity_log)
//   2) nota de resolução de no_followup reflete a causa real
//   3) funções-trigger sem EXECUTE para PUBLIC/anon/authenticated (triggers seguem funcionando)
//   4) (apenas documentação no cabeçalho da 017: verificação de communications.recipient_email)
//
// Limitação do harness: relógio real; o alerta de faltas é "envelhecido" direto no banco (created_at).

let t: TestDb;
let coord: string, leaderA: string, leaderB: string;
let groupA: string, groupB: string;
let day = -6000;
let seqName = 0;

const MSG_BLOCK = /Não é possível excluir um grupo com jovens ou histórico de chamada\. Mova os jovens para outro grupo primeiro\./;

const mkGroup = async (name: string, leader: string | null = null) =>
  (await t.q<{ id: string }>(`INSERT INTO public.groups (name, leader_id) VALUES ($1, $2) RETURNING id`, [name, leader]))[0].id;

async function mkYouth(group: string | null, active = true): Promise<string> {
  seqName += 1;
  const [y] = await t.q<{ id: string }>(
    `INSERT INTO public.youth (full_name, group_id, is_active, created_by) VALUES ($1, $2, $3, $4) RETURNING id`,
    [`Jovem ${String(seqName).padStart(3, '0')}`, group, active, coord]);
  return y.id;
}

async function mkEvent(groups: string[]): Promise<string> {
  day += 1;
  const [ev] = await t.q<{ id: string }>(
    `INSERT INTO public.events (title, event_date, status, created_by)
     VALUES ('Encontro', now() + ($1 || ' days')::interval, 'completed', $2) RETURNING id`,
    [String(day), coord]);
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

const groupExists = async (id: string) =>
  (await t.q(`SELECT 1 FROM public.groups WHERE id = $1`, [id])).length === 1;
const delGroup = (user: string, id: string) =>
  t.as(user, () => t.q<{ id: string }>(`DELETE FROM public.groups WHERE id = $1 RETURNING id`, [id]));

const sync = async (user = coord) => {
  await t.q(`UPDATE public.time_alerts_sync_state SET last_run = '-infinity'`);
  return t.as(user, () => t.q(`SELECT public.sync_time_alerts()`));
};
const setGrace = (days: number) =>
  t.as(coord, () => t.q(`UPDATE public.app_settings SET followup_grace_days = $1`, [days]));

interface Al { id: string; status: string; resolution_notes: string | null; resolved_by: string | null }
const noFollowups = (youth: string) =>
  t.q<Al>(`SELECT id, status::text AS status, resolution_notes, resolved_by FROM public.alerts
            WHERE youth_id = $1 AND type::text = 'no_followup' ORDER BY created_at, id`, [youth]);

/** Jovem com 3 faltas seguidas e alerta de faltas envelhecido (padrão 8 dias) + no_followup aberto. */
async function youthWithNoFollowup(age = 8) {
  const y = await mkYouth(groupA);
  for (let i = 0; i < 3; i++) await rec(await mkEvent([groupA]), y, false);
  const [fa] = await t.q<{ id: string }>(
    `SELECT id FROM public.alerts WHERE youth_id = $1 AND type::text = 'consecutive_absences' AND status = 'open'`, [y]);
  await t.q(`UPDATE public.alerts SET created_at = now() - ($2 || ' days')::interval WHERE id = $1`, [fa.id, String(age)]);
  await sync();
  const open = (await noFollowups(y)).filter((a) => a.status === 'open');
  expect(open).toHaveLength(1);
  return { y, fa: fa.id };
}

beforeAll(async () => {
  t = await createTestDb();
  coord = await t.createUser('Coordenadora', 'coordinator');
  leaderA = await t.createUser('Líder A', 'leader');
  leaderB = await t.createUser('Líder B', 'leader');
  groupA = await mkGroup('Grupo A', leaderA);
  groupB = await mkGroup('Grupo B', leaderB);
}, 60_000);

// ---------------------------------------------------------------------------------------------
describe('1) exclusão de grupo', () => {
  it('grupo vazio e sem histórico é excluído pelo coordenador, sem erro no activity_log', async () => {
    const g = await mkGroup('Vazio');
    const r = await delGroup(coord, g);
    expect(r).toHaveLength(1);
    expect(await groupExists(g)).toBe(false);
  });

  it('grupo vazio cujo histórico de atividade existe (jovem já movido) também é excluído; log fica com group_id nulo', async () => {
    const g = await mkGroup('Esvaziado');
    const y = await mkYouth(g);
    await t.as(coord, () => t.q(`UPDATE public.youth SET group_id = $2 WHERE id = $1`, [y, groupB]));
    const before = await t.q<{ group_id: string | null }>(
      `SELECT group_id FROM public.activity_log WHERE youth_id = $1 AND action = 'youth_group_changed'`, [y]);
    expect(before).toHaveLength(1);
    expect(before[0].group_id).toBe(groupB);                 // COALESCE(NEW, OLD): grupo novo
    const g2 = await mkGroup('Esvaziado 2');
    await t.as(coord, () => t.q(`UPDATE public.youth SET group_id = $2 WHERE id = $1`, [y, g2]));
    await t.as(coord, () => t.q(`UPDATE public.youth SET group_id = NULL WHERE id = $1`, [y]));
    expect(await delGroup(coord, g2)).toHaveLength(1);
    const logs = await t.q<{ group_id: string | null }>(
      `SELECT group_id FROM public.activity_log WHERE youth_id = $1 AND action = 'youth_group_changed' ORDER BY occurred_at, id`, [y]);
    expect(logs).toHaveLength(3);
    expect(logs.filter((l) => l.group_id === g2)).toEqual([]); // FK SET NULL anulou as referências ao grupo excluído
  });

  it('grupo com jovem (ativo ou inativo) é recusado com mensagem pt-BR; nada muda', async () => {
    for (const active of [true, false]) {
      const g = await mkGroup(`Com jovem ${active}`);
      const y = await mkYouth(g, active);
      await expect(delGroup(coord, g)).rejects.toThrow(MSG_BLOCK);
      expect(await groupExists(g)).toBe(true);
      expect((await t.q<{ group_id: string }>(`SELECT group_id FROM public.youth WHERE id = $1`, [y]))[0].group_id).toBe(g);
    }
  });

  it('erro é P0001 (mensagem nossa) e a recusa vale também para superusuário', async () => {
    const g = await mkGroup('Com jovem P0001');
    await mkYouth(g);
    await expect(delGroup(coord, g)).rejects.toMatchObject({ code: 'P0001' });
    await expect(t.q(`DELETE FROM public.groups WHERE id = $1`, [g])).rejects.toThrow(MSG_BLOCK);
  });

  it('grupo com attendance (jovem já desassociado) é recusado e a chamada não é apagada', async () => {
    const g = await mkGroup('Com chamada');
    const y = await mkYouth(g);
    await rec(await mkEvent([g]), y, true);
    // desassociar não reescreve attendance.group_id (a sincronização da 012 só roda com novo grupo não nulo)
    await t.as(coord, () => t.q(`UPDATE public.youth SET group_id = NULL WHERE id = $1`, [y]));
    expect(await t.q(`SELECT 1 FROM public.youth WHERE group_id = $1`, [g])).toHaveLength(0);
    await expect(delGroup(coord, g)).rejects.toThrow(MSG_BLOCK);
    expect(await groupExists(g)).toBe(true);
    expect(await t.q(`SELECT 1 FROM public.attendance WHERE group_id = $1`, [g])).toHaveLength(1);
  });

  it('líder não exclui grupo (nem o próprio, nem vazio): RLS filtra, grupo permanece', async () => {
    const g = await mkGroup('Do líder A, vazio', leaderA);
    expect(await delGroup(leaderA, g)).toHaveLength(0);
    expect(await delGroup(leaderB, g)).toHaveLength(0);
    expect(await groupExists(g)).toBe(true);
    await expect(t.as(null, () => t.q(`DELETE FROM public.groups WHERE id = $1`, [g]))).rejects.toThrow(/permission denied/);
    expect(await delGroup(coord, g)).toHaveLength(1);        // o coordenador exclui o vazio
  });

  it('youth_log_activity nunca grava group_id inexistente (guarda), mesmo com o bloqueio desligado', async () => {
    const g = await mkGroup('Guarda');
    const y = await mkYouth(g);
    await t.q(`ALTER TABLE public.groups DISABLE TRIGGER groups_block_delete_with_history`);
    try {
      expect(await delGroup(coord, g)).toHaveLength(1);       // sem a guarda: violação de FK em activity_log
    } finally {
      await t.q(`ALTER TABLE public.groups ENABLE TRIGGER groups_block_delete_with_history`);
    }
    const [row] = await t.q<{ group_id: string | null }>(`SELECT group_id FROM public.youth WHERE id = $1`, [y]);
    expect(row.group_id).toBeNull();
    const logs = await t.q<{ group_id: string | null; summary: string }>(
      `SELECT group_id, summary FROM public.activity_log WHERE youth_id = $1 AND action = 'youth_group_changed'`, [y]);
    expect(logs).toEqual([{ group_id: null, summary: 'Jovem desassociado do grupo.' }]);
  });

  it('inativar/reativar jovem sem grupo e com grupo continua registrando', async () => {
    const y = await mkYouth(groupB);
    await t.as(coord, () => t.q(`UPDATE public.youth SET is_active = false WHERE id = $1`, [y]));
    await t.as(coord, () => t.q(`UPDATE public.youth SET is_active = true, group_id = NULL WHERE id = $1`, [y]));
    const logs = await t.q<{ action: string; group_id: string | null }>(
      `SELECT action, group_id FROM public.activity_log WHERE youth_id = $1 ORDER BY occurred_at, id`, [y]);
    expect(logs.map((l) => l.action).sort()).toEqual(['youth_activated', 'youth_deactivated', 'youth_group_changed']);
    expect(logs.find((l) => l.action === 'youth_deactivated')!.group_id).toBe(groupB);
    expect(logs.find((l) => l.action === 'youth_group_changed')!.group_id).toBe(groupB);
  });
});

// ---------------------------------------------------------------------------------------------
describe('2) nota de resolução de no_followup', () => {
  it('aumentar followup_grace_days: "prazo de carência ampliado" (e não "acompanhamento registrado")', async () => {
    const { y } = await youthWithNoFollowup(8);
    await setGrace(14);
    const [al] = await noFollowups(y);
    expect(al).toMatchObject({ status: 'resolved', resolved_by: null });
    expect(al.resolution_notes).toBe('Resolvido automaticamente: prazo de carência ampliado.');
    expect(al.resolution_notes).not.toMatch(/acompanhamento registrado/);
    await setGrace(7);                                       // reduzir de novo reabre
    expect((await noFollowups(y)).filter((a) => a.status === 'open')).toHaveLength(1);
  });

  it('acompanhamento registrado: "acompanhamento registrado"', async () => {
    const { y } = await youthWithNoFollowup(9);
    await t.as(coord, () => t.q(`INSERT INTO public.follow_ups (youth_id, reason) VALUES ($1, 'Conversa')`, [y]));
    const [al] = await noFollowups(y);
    expect(al).toMatchObject({ status: 'resolved' });
    expect(al.resolution_notes).toBe('Resolvido automaticamente: acompanhamento registrado.');
  });

  it('alerta de faltas encerrado: "o alerta de faltas foi encerrado"', async () => {
    const { y, fa } = await youthWithNoFollowup(8);
    await t.as(coord, () => t.q(`UPDATE public.alerts SET status = 'resolved' WHERE id = $1`, [fa]));
    const [al] = await noFollowups(y);
    expect(al).toMatchObject({ status: 'resolved' });
    expect(al.resolution_notes).toBe('Resolvido automaticamente: o alerta de faltas foi encerrado.');
  });

  it('jovem inativado: "jovem inativado"', async () => {
    const { y } = await youthWithNoFollowup(8);
    await t.as(coord, () => t.q(`UPDATE public.youth SET is_active = false WHERE id = $1`, [y]));
    const [al] = await noFollowups(y);
    expect(al).toMatchObject({ status: 'resolved' });
    expect(al.resolution_notes).toBe('Resolvido automaticamente: jovem inativado.');
  });

  it('com acompanhamento E carência maior, vale "acompanhamento registrado" (causa mais específica)', async () => {
    const { y } = await youthWithNoFollowup(8);
    await t.as(coord, () => t.q(`INSERT INTO public.follow_ups (youth_id, reason) VALUES ($1, 'Conversa')`, [y]));
    await setGrace(30);
    await setGrace(7);
    const all = await noFollowups(y);
    expect(all[0].resolution_notes).toBe('Resolvido automaticamente: acompanhamento registrado.');
  });

  it('a função mantém pg_temp no search_path e continua sem EXECUTE para clientes', async () => {
    const [fn] = await t.q<{ cfg: string }>(
      `SELECT proconfig::text AS cfg FROM pg_proc WHERE proname = 'refresh_youth_time_alerts' AND pronamespace = 'public'::regnamespace`);
    expect(fn.cfg).toContain('search_path=public, pg_temp');
    await expect(t.as(leaderA, () => t.q(`SELECT public.refresh_youth_time_alerts(gen_random_uuid())`))).rejects.toThrow(/permission denied/);
  });
});

// ---------------------------------------------------------------------------------------------
describe('3) funções-trigger sem EXECUTE para clientes', () => {
  it('nenhuma função que retorna trigger em public é executável por anon, authenticated ou PUBLIC', async () => {
    const fns = await t.q<{ sig: string; anon: boolean; auth: boolean; pub: boolean }>(
      `SELECT p.oid::regprocedure::text AS sig,
              has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
              has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth,
              COALESCE((SELECT bool_or(a.grantee = 0) FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
                         WHERE a.privilege_type = 'EXECUTE'), false) AS pub
         FROM pg_proc p
        WHERE p.pronamespace = 'public'::regnamespace AND p.prorettype = 'trigger'::regtype
          AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')`);
    expect(fns.length).toBeGreaterThan(20);
    expect(fns.filter((f) => f.anon || f.auth || f.pub).map((f) => f.sig)).toEqual([]);
  });

  it('chamar uma função-trigger como cliente falha por permissão (antes de qualquer outra checagem)', async () => {
    for (const u of [null, leaderA, coord]) {
      await expect(t.as(u, () => t.q(`SELECT public.groups_block_delete_with_history()`))).rejects.toThrow(/permission denied/);
      await expect(t.as(u, () => t.q(`SELECT public.youth_log_activity()`))).rejects.toThrow(/permission denied/);
    }
  });

  it('RPCs e helpers do app NÃO foram afetados (get_my_role, sync_time_alerts, set_user_role, save_event, search)', async () => {
    const sigs = await t.q<{ proname: string; auth: boolean; anon: boolean }>(
      `SELECT p.proname,
              has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth,
              has_function_privilege('anon', p.oid, 'EXECUTE') AS anon
         FROM pg_proc p
        WHERE p.pronamespace = 'public'::regnamespace
          AND p.proname IN ('get_my_role', 'sync_time_alerts', 'set_user_role', 'save_event')`);
    expect(sigs.map((s) => s.proname).sort()).toEqual(['get_my_role', 'save_event', 'set_user_role', 'sync_time_alerts']);
    for (const s of sigs) expect(s.auth).toBe(true);
    expect(await t.as(coord, async () => (await t.q<{ r: string }>(`SELECT public.get_my_role()::text AS r`))[0].r)).toBe('coordinator');
    expect(await t.as(leaderA, async () => (await t.q<{ r: string }>(`SELECT public.get_my_role()::text AS r`))[0].r)).toBe('leader');
  });

  it('triggers continuam disparando para os papéis de cliente (chamada gera alerta e histórico)', async () => {
    const y = await mkYouth(groupA);
    for (let i = 0; i < 3; i++) {
      const ev = await mkEvent([groupA]);
      await t.as(leaderA, () => t.q(
        `INSERT INTO public.attendance (event_id, youth_id, group_id, present, recorded_by) VALUES ($1, $2, $3, false, $4)`,
        [ev, y, groupA, leaderA]));
    }
    expect(await t.q(`SELECT 1 FROM public.alerts WHERE youth_id = $1 AND type::text = 'consecutive_absences' AND status = 'open'`, [y]))
      .toHaveLength(1);
    expect((await t.as(coord, () => t.q(
      `SELECT 1 FROM public.activity_log WHERE group_id = $1 AND action = 'attendance_recorded'`, [groupA])))).not.toHaveLength(0);
  });
});
