import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './harness';
import { serviceApi } from './communications-helpers';

// Migration 025: auditoria da anonimização (marca no cadastro + linha no histórico) e cancelamento dos e-mails
// ainda não enviados (rascunho e falha) do jovem anonimizado.

let t: TestDb;
let coord: string, coord2: string, leader: string, otherLeader: string;
let g1: string;

interface Result {
  youth_id: string; tasks: number; follow_ups: number; communications: number;
  communications_cancelled: number; anonymized_at: string;
}

const mkYouth = async (name: string, group: string | null = g1) =>
  (await t.q<{ id: string }>(
    `INSERT INTO public.youth (full_name, email, phone, group_id, created_by)
     VALUES ($1, $2, '27999990000', $3, $4) RETURNING id`,
    [name, `${name.toLowerCase().replace(/\s/g, '.')}@exemplo.com`, group, coord]))[0].id;

const mkComm = async (youth: string, by = coord) =>
  (await t.q<{ id: string }>(
    `INSERT INTO public.communications (youth_id, recipient_email, recipient_name, recipient_kind, subject, body, created_by)
     VALUES ($1, 'responsavel@exemplo.com', 'Responsável', 'guardian', 'Assunto real', 'Corpo real', $2) RETURNING id`,
    [youth, by]))[0].id;

/** Rascunho no estado em que a função da 021 deixava (destinatário de marcação, ainda 'draft'). */
const mkCommAnonymizedDraft = async (youth: string) => {
  const id = await mkComm(youth);
  await t.q(
    `UPDATE public.communications
        SET recipient_email = 'anonimizado@anonimizado.invalid', recipient_name = NULL,
            subject = 'Mensagem anonimizada', body = 'Conteúdo removido por anonimização (LGPD).'
      WHERE id = $1`, [id]);
  return id;
};

const anonymize = (user: string | null, id: string) =>
  t.as(user, async () => (await t.q<{ r: Result }>(`SELECT public.anonymize_youth($1::uuid) AS r`, [id]))[0].r);

const youthRow = async (id: string) =>
  (await t.q<{ full_name: string; anonymized_at: string | null; anonymized_by: string | null; is_active: boolean }>(
    `SELECT full_name, anonymized_at::text, anonymized_by, is_active FROM public.youth WHERE id = $1`, [id]))[0];

const commRow = async (id: string) =>
  (await t.q<{ status: string; subject: string; recipient_email: string; failure_reason: string | null; attempts: number }>(
    `SELECT status::text, subject, recipient_email, failure_reason, attempts FROM public.communications WHERE id = $1`, [id]))[0];

const logRows = (youth: string) =>
  t.q<{ actor_id: string | null; actor_name: string | null; summary: string; meta: Record<string, number>; group_id: string | null; occurred_at: string }>(
    `SELECT actor_id, actor_name, summary, meta, group_id, occurred_at::text
       FROM public.activity_log WHERE youth_id = $1 AND action = 'youth_anonymized' ORDER BY occurred_at, id`, [youth]);

beforeAll(async () => {
  t = await createTestDb();
  coord = await t.createUser('Carla Coordenadora', 'coordinator');
  coord2 = await t.createUser('Otávio Coordenador', 'coordinator');
  leader = await t.createUser('Lia Líder', 'leader');
  otherLeader = await t.createUser('Davi Líder', 'leader');
  g1 = (await t.q<{ id: string }>(`INSERT INTO public.groups (name, leader_id) VALUES ('Grupo 025', $1) RETURNING id`, [leader]))[0].id;
  await t.q(`INSERT INTO public.groups (name, leader_id) VALUES ('Grupo alheio', $1)`, [otherLeader]);
}, 60_000);

describe('migration 025: auditoria da anonimização', () => {
  it('grava quem e quando no cadastro e devolve a data', async () => {
    const y = await mkYouth('Maria Silva');
    expect(await youthRow(y)).toMatchObject({ anonymized_at: null, anonymized_by: null });

    const before = Date.now();
    const r = await anonymize(coord, y);
    const row = await youthRow(y);
    expect(row).toMatchObject({ full_name: 'Jovem anonimizado', anonymized_by: coord, is_active: false });
    expect(row.anonymized_at).not.toBeNull();
    expect(Math.abs(new Date(row.anonymized_at!).getTime() - before)).toBeLessThan(60_000);
    expect(new Date(r.anonymized_at).getTime()).toBe(new Date(row.anonymized_at!).getTime());
  });

  it('gera UMA linha no histórico com o autor, texto fixo e só contagens (nenhum dado do jovem)', async () => {
    const y = await mkYouth('Joana Dado Pessoal');
    await t.q(`INSERT INTO public.tasks (title, youth_id, created_by) VALUES ('Ligar para Joana Dado Pessoal', $1, $2)`, [y, coord]);
    await mkComm(y);
    await anonymize(coord, y);

    const rows = await logRows(y);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actor_id: coord, actor_name: 'Carla Coordenadora', summary: 'Dados do jovem anonimizados.', group_id: g1,
      meta: { tasks: 1, follow_ups: 0, communications: 1, communications_cancelled: 1 },
    });
    expect(JSON.stringify(rows)).not.toMatch(/Joana|Dado Pessoal|exemplo\.com|Assunto real/);
    // a inativação continua registrada pelo trigger de sempre
    expect(await t.q(`SELECT 1 FROM public.activity_log WHERE youth_id = $1 AND action = 'youth_deactivated'`, [y])).toHaveLength(1);
  });

  it('repetir mantém a data e o responsável ORIGINAIS no cadastro; cada ato tem a sua linha no histórico', async () => {
    const y = await mkYouth('Ana Lima');
    await anonymize(coord, y);
    const first = await youthRow(y);
    const again = await anonymize(coord2, y);
    const second = await youthRow(y);
    expect(second.anonymized_by).toBe(coord);
    expect(second.anonymized_at).toBe(first.anonymized_at);
    expect(new Date(again.anonymized_at).getTime()).toBe(new Date(first.anonymized_at!).getTime());
    expect((await logRows(y)).map((r) => r.actor_id)).toEqual([coord, coord2]);
  });

  it('jovem sem grupo: a linha do histórico fica sem grupo', async () => {
    const y = await mkYouth('Sem Grupo', null);
    await anonymize(coord, y);
    expect((await logRows(y))[0].group_id).toBeNull();
  });

  it('clientes não escrevem na marca: nem o coordenador forja, altera ou apaga', async () => {
    const y = await mkYouth('Pedro Rocha');
    // forjar em quem não foi anonimizado: o valor é ignorado, o resto do UPDATE vale
    await t.as(coord, () => t.q(
      `UPDATE public.youth SET anonymized_at = now(), anonymized_by = $2, phone = '27000000000' WHERE id = $1`, [y, coord2]));
    expect(await youthRow(y)).toMatchObject({ full_name: 'Pedro Rocha', anonymized_at: null, anonymized_by: null });
    expect((await t.q<{ phone: string }>(`SELECT phone FROM public.youth WHERE id = $1`, [y]))[0].phone).toBe('27000000000');

    await anonymize(coord, y);
    const marked = await youthRow(y);
    for (const who of [coord, coord2, leader]) {
      await t.as(who, () => t.q(
        `UPDATE public.youth SET anonymized_at = NULL, anonymized_by = $2 WHERE id = $1`, [y, coord2]));
      await t.as(who, () => t.q(`UPDATE public.youth SET anonymized_at = '2001-01-01' WHERE id = $1`, [y]));
    }
    expect(await youthRow(y)).toMatchObject({ anonymized_at: marked.anonymized_at, anonymized_by: coord });

    // cadastro novo com a marca preenchida: nasce sem marca
    const forged = await t.as(coord, async () => (await t.q<{ id: string }>(
      `INSERT INTO public.youth (full_name, group_id, created_by, anonymized_at, anonymized_by)
       VALUES ('Novo Jovem', $1, $2, now(), $2) RETURNING id`, [g1, coord]))[0].id);
    expect(await youthRow(forged)).toMatchObject({ anonymized_at: null, anonymized_by: null });
  });

  it('a função-trigger não é chamável por clientes e o histórico continua imutável', async () => {
    const y = await mkYouth('Lucas Alves');
    await anonymize(coord, y);
    await expect(t.as(coord, () => t.q(`SELECT public.youth_anonymized_guard()`))).rejects.toThrow(/permission denied/);
    await expect(t.as(coord, () => t.q(
      `INSERT INTO public.activity_log (action, entity_type, youth_id, summary) VALUES ('youth_anonymized', 'youth', $1, 'forjado')`, [y])))
      .rejects.toThrow(/permission denied/);
    await expect(t.as(coord, () => t.q(`DELETE FROM public.activity_log WHERE youth_id = $1`, [y]))).rejects.toThrow();
    expect(await logRows(y)).toHaveLength(1);
  });

  it('RLS do histórico: o líder do grupo vê o registro; líder de outro grupo e anônimo não', async () => {
    const y = await mkYouth('Bia Costa');
    await anonymize(coord, y);
    const seen = (who: string | null) => t.as(who, () => t.q(
      `SELECT 1 FROM public.activity_log WHERE youth_id = $1 AND action = 'youth_anonymized'`, [y]));
    expect(await seen(coord2)).toHaveLength(1);
    expect(await seen(leader)).toHaveLength(1);
    expect(await seen(otherLeader)).toHaveLength(0);
    await expect(seen(null)).rejects.toThrow(/permission denied/);
  });

  it('líder e anônimo continuam sem poder anonimizar; nada é marcado nem registrado', async () => {
    const y = await mkYouth('Carla Dias');
    await expect(anonymize(leader, y)).rejects.toThrow(/Apenas coordenadores/);
    await expect(anonymize(null, y)).rejects.toThrow(/permission denied/);
    expect(await youthRow(y)).toMatchObject({ full_name: 'Carla Dias', anonymized_at: null });
    expect(await logRows(y)).toHaveLength(0);
  });
});

describe('migration 025: e-mails não enviados do jovem anonimizado', () => {
  it('rascunho e falha viram cancelados; enviado continua enviado; cancelado continua cancelado', async () => {
    const y = await mkYouth('Rafa Nunes');
    const api = serviceApi(t);
    const draft = await mkComm(y);
    const failed = await mkComm(y);
    await api.sendFail(failed, coord, 'provider_rejected');
    const sent = await mkComm(y);
    await api.sendOk(sent, coord);
    const cancelled = await mkComm(y);
    await t.as(coord, () => t.q(`SELECT public.mark_communication($1, 'cancelled')`, [cancelled]));
    expect((await commRow(failed)).status).toBe('failed');

    const r = await anonymize(coord, y);
    expect(r).toMatchObject({ communications: 4, communications_cancelled: 2 });

    expect(await commRow(draft)).toMatchObject({ status: 'cancelled', subject: 'Mensagem anonimizada', recipient_email: 'anonimizado@anonimizado.invalid' });
    expect(await commRow(failed)).toMatchObject({ status: 'cancelled', failure_reason: null, attempts: 1 });
    expect(await commRow(sent)).toMatchObject({ status: 'sent', subject: 'Mensagem anonimizada' });
    expect((await commRow(cancelled)).status).toBe('cancelled');
  });

  it('o servidor recusa enviar o que era rascunho ou falha (not_sendable) e nenhuma tentativa é contada', async () => {
    const y = await mkYouth('Tiago Melo');
    const api = serviceApi(t);
    const draft = await mkComm(y);
    const failed = await mkComm(y);
    await api.sendFail(failed, coord);
    await anonymize(coord, y);

    for (const id of [draft, failed]) {
      const before = (await commRow(id)).attempts;
      expect(await api.begin(id, coord)).toEqual({ ok: false, error: 'conflict', reason: 'not_sendable' });
      expect(await commRow(id)).toMatchObject({ status: 'cancelled', attempts: before });
    }
  });

  it('clientes não reabrem nem editam o e-mail cancelado pela anonimização', async () => {
    const y = await mkYouth('Vera Pinto');
    const api = serviceApi(t);
    const draft = await mkComm(y);
    const failed = await mkComm(y);
    await api.sendFail(failed, coord);
    await anonymize(coord, y);

    for (const id of [draft, failed]) {
      await expect(t.as(coord, () => t.q(`SELECT public.mark_communication($1, 'draft')`, [id]))).rejects.toThrow(/canceladas não podem ser alteradas/);
      await expect(t.as(coord, () => t.q(
        `UPDATE public.communications SET recipient_email = 'outro@exemplo.com', subject = 'Novo', body = 'Novo corpo' WHERE id = $1`, [id])))
        .rejects.toThrow(/canceladas não podem ser alteradas/);
      await expect(t.as(coord, () => t.q(`UPDATE public.communications SET status = 'draft' WHERE id = $1`, [id])))
        .rejects.toThrow(/canceladas não podem ser alteradas/);
      expect(await commRow(id)).toMatchObject({ status: 'cancelled', recipient_email: 'anonimizado@anonimizado.invalid' });
    }
  });

  it('e-mail em envio continua bloqueando a anonimização: nada é cancelado, marcado nem registrado', async () => {
    const y = await mkYouth('Nina Reis');
    const api = serviceApi(t);
    const draft = await mkComm(y);
    const sending = await mkComm(y);
    expect((await api.begin(sending, coord)).ok).toBe(true);

    await expect(anonymize(coord, y)).rejects.toThrow(/em envio/);
    expect((await commRow(draft)).status).toBe('draft');
    expect(await youthRow(y)).toMatchObject({ full_name: 'Nina Reis', anonymized_at: null });
    expect(await logRows(y)).toHaveLength(0);

    await api.finish(sending, true);
    expect(await anonymize(coord, y)).toMatchObject({ communications: 2, communications_cancelled: 1 });
    expect((await commRow(sending)).status).toBe('sent');
  });

  it('não toca nos e-mails de outro jovem', async () => {
    const y = await mkYouth('Igor Sales');
    const other = await mkYouth('Outro Jovem');
    const otherDraft = await mkComm(other);
    await mkComm(y);
    await anonymize(coord, y);
    expect(await commRow(otherDraft)).toMatchObject({ status: 'draft', subject: 'Assunto real' });
    expect(await youthRow(other)).toMatchObject({ full_name: 'Outro Jovem', anonymized_at: null });
  });
});

describe('migration 025: quem foi anonimizado antes dela (função da 021)', () => {
  const MIGRATION = fileURLToPath(new URL('../../supabase/migrations/025_anonymize_audit_and_cancel_unsent.sql', import.meta.url));

  it('ao aplicar, cancela os rascunhos e falhas que a 021 deixou enviáveis; enviados e e-mails de outros jovens ficam como estão', async () => {
    const api = serviceApi(t);
    const y = await mkYouth('Antes Da 025');
    const draft = await mkComm(y);
    const failed = await mkComm(y);
    await api.sendFail(failed, coord, 'provider_rejected');
    const sent = await mkComm(y);
    await api.sendOk(sent, coord);
    // Estado que a função da 021 deixava: conteúdo anonimizado, status intacto, cadastro sem marca.
    await t.q(
      `UPDATE public.communications
          SET recipient_email = 'anonimizado@anonimizado.invalid', recipient_name = NULL,
              subject = 'Mensagem anonimizada', body = 'Conteúdo removido por anonimização (LGPD).'
        WHERE youth_id = $1`, [y]);
    await t.q(`UPDATE public.youth SET full_name = 'Jovem anonimizado', email = NULL, phone = NULL, is_active = false WHERE id = $1`, [y]);
    expect((await commRow(draft)).status).toBe('draft');
    const sending = await mkCommAnonymizedDraft(y);
    expect((await api.begin(sending, coord)).ok).toBe(true);   // antes da 025 o servidor ainda aceitava enviar

    const other = await mkYouth('Jovem Comum');
    const otherDraft = await mkComm(other);

    await t.db.exec(readFileSync(MIGRATION, 'utf8'));

    expect(await commRow(draft)).toMatchObject({ status: 'cancelled', subject: 'Mensagem anonimizada' });
    expect(await commRow(failed)).toMatchObject({ status: 'cancelled', attempts: 1 });
    expect((await commRow(sent)).status).toBe('sent');
    expect((await commRow(sending)).status).toBe('sending');   // envio em andamento nunca é tocado
    expect(await commRow(otherDraft)).toMatchObject({ status: 'draft', subject: 'Assunto real', recipient_email: 'responsavel@exemplo.com' });
    expect(await api.begin(draft, coord)).toEqual({ ok: false, error: 'conflict', reason: 'not_sendable' });
    expect(await api.begin(failed, coord)).toEqual({ ok: false, error: 'conflict', reason: 'not_sendable' });
    // sem inventar auditoria: o cadastro antigo continua sem marca e sem linha no histórico
    expect((await youthRow(y)).anonymized_at).toBeNull();
    expect(await logRows(y)).toHaveLength(0);
  });
});

describe('migration 025: reexecução', () => {
  it('aplicar a 025 de novo não falha e preserva a marca, o histórico e os cancelamentos', async () => {
    const y = await mkYouth('Reaplica Teste');
    const draft = await mkComm(y);
    await anonymize(coord, y);
    const before = await youthRow(y);

    const sql = readFileSync(fileURLToPath(new URL('../../supabase/migrations/025_anonymize_audit_and_cancel_unsent.sql', import.meta.url)), 'utf8');
    await t.db.exec(sql);

    expect(await youthRow(y)).toEqual(before);
    expect(await logRows(y)).toHaveLength(1);
    expect((await commRow(draft)).status).toBe('cancelled');
    // a guarda e a função continuam valendo depois da reaplicação
    await t.as(coord, () => t.q(`UPDATE public.youth SET anonymized_at = NULL WHERE id = $1`, [y]));
    expect((await youthRow(y)).anonymized_at).toBe(before.anonymized_at);
    const other = await mkYouth('Depois Da Reaplicacao');
    expect(await anonymize(coord, other)).toMatchObject({ youth_id: other, communications_cancelled: 0 });
  });
});
