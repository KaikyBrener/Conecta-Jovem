import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './harness';
import { serviceApi, type BeginOk, type Fail } from './communications-helpers';

// Migration 018: envio pelo servidor (begin_communication_send / finish_communication_send).
// LIMITAÇÃO (PGlite, conexão única): a "concorrência" é lógica (estado sending recente x antigo); corrida real
// entre duas transações não é reproduzida.

let t: TestDb;
let svc: ReturnType<typeof serviceApi>;
let coord: string, leaderA: string, leaderB: string, groupA: string, groupB: string, yA: string, yB: string;

const SECRET = 'SEGREDO-ENVIO-QWERTY';

interface Comm {
  id: string; status: string; failure_reason: string | null; sent_at: string | null; sent_by: string | null;
  provider: string | null; provider_message_id: string | null; attempts: number; last_attempt_at: string | null;
  alert_id: string | null; follow_up_id: string | null; youth_id: string | null; recipient_email: string;
  subject: string; created_by: string;
}

async function mkYouth(group: string | null): Promise<string> {
  return (await t.q<{ id: string }>(
    `INSERT INTO public.youth (full_name, group_id, email, created_by)
     VALUES ('Jovem Envio', $1, 'jovem-' || gen_random_uuid() || '@exemplo.com', $2) RETURNING id`, [group, coord]))[0].id;
}
async function draft(user: string, youth: string, over: Record<string, unknown> = {}): Promise<Comm> {
  // Migration 019: por padrão o destinatário é o e-mail do jovem (única opção do líder); `email`/`kind` sobrescrevem (coordenador).
  const yEmail = (await t.q<{ e: string }>(`SELECT email AS e FROM public.youth WHERE id = $1`, [youth]))[0].e;
  const v = { email: yEmail, kind: 'youth', subject: 'Assunto', body: 'Corpo\nem linhas', ...over };
  return t.as(user, async () => (await t.q<Comm>(
    `INSERT INTO public.communications (youth_id, recipient_email, recipient_name, recipient_kind, subject, body)
     VALUES ($1, $2, 'Dest', $5, $3, $4) RETURNING *`, [youth, v.email, v.subject, v.body, v.kind]))[0]);
}
const rowOf = async (id: string) => (await t.q<Comm>(`SELECT * FROM public.communications WHERE id = $1`, [id]))[0];
const ok = (r: BeginOk | Fail) => r as BeginOk;

beforeAll(async () => {
  t = await createTestDb();
  svc = serviceApi(t);
  coord = await t.createUser('Coordenadora', 'coordinator');
  leaderA = await t.createUser('Líder A', 'leader');
  leaderB = await t.createUser('Líder B', 'leader');
  const mk = async (n: string, o: string) =>
    (await t.q<{ id: string }>(`INSERT INTO public.groups (name, leader_id) VALUES ($1, $2) RETURNING id`, [n, o]))[0].id;
  groupA = await mk('Grupo A', leaderA);
  groupB = await mk('Grupo B', leaderB);
  yA = await mkYouth(groupA);
  yB = await mkYouth(groupB);
}, 60_000);

// O rate limit (20/h por usuário) é cumulativo no banco de teste; zera entre testes (o próprio teste de limite é autocontido).
beforeEach(async () => { await t.q(`DELETE FROM public.communication_send_log`); });

describe('privilégios', () => {
  it('só service_role executa begin/finish; anon, authenticated e PUBLIC não', async () => {
    const rows = await t.q<{ fn: string; anon: boolean; auth: boolean; svc: boolean; pub: boolean }>(
      `SELECT p.proname AS fn,
              has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
              has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth,
              has_function_privilege('service_role', p.oid, 'EXECUTE') AS svc,
              COALESCE((SELECT bool_or(a.grantee = 0) FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
                         WHERE a.privilege_type = 'EXECUTE'), false) AS pub
         FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
          AND p.proname IN ('begin_communication_send', 'finish_communication_send')`);
    expect(rows).toHaveLength(2);
    for (const r of rows) expect(r, r.fn).toMatchObject({ anon: false, auth: false, svc: true, pub: false });
  });

  it('chamadas por authenticated/anon são negadas (grant-level)', async () => {
    const c = await draft(leaderA, yA);
    await expect(t.as(leaderA, () => t.q(`SELECT public.begin_communication_send($1, $2)`, [c.id, leaderA]))).rejects.toThrow(/permission denied/);
    await expect(t.as(coord, () => t.q(`SELECT public.finish_communication_send($1, true, 'resend', 'x', NULL)`, [c.id]))).rejects.toThrow(/permission denied/);
    await expect(t.as(null, () => t.q(`SELECT public.begin_communication_send($1, $2)`, [c.id, leaderA]))).rejects.toThrow(/permission denied/);
    expect((await rowOf(c.id)).status).toBe('draft');
  });

  it('são SECURITY DEFINER com search_path public, pg_temp; a tabela do rate limit é inacessível a clientes', async () => {
    const rows = await t.q<{ prosecdef: boolean; cfg: string }>(
      `SELECT prosecdef, proconfig::text AS cfg FROM pg_proc
        WHERE proname IN ('begin_communication_send', 'finish_communication_send')`);
    for (const r of rows) expect(r).toEqual({ prosecdef: true, cfg: '{"search_path=public, pg_temp"}' });
    await expect(t.as(coord, () => t.q(`SELECT * FROM public.communication_send_log`))).rejects.toThrow(/permission denied/);
    await expect(t.as(null, () => t.q(`SELECT * FROM public.communication_send_log`))).rejects.toThrow(/permission denied/);
    const [r] = await t.q<{ relrowsecurity: boolean }>(`SELECT relrowsecurity FROM pg_class WHERE oid = 'public.communication_send_log'::regclass`);
    expect(r.relrowsecurity).toBe(true);
  });
});

describe('begin_communication_send', () => {
  it('devolve só o necessário e passa a sending (attempts, last_attempt_at, sent_by = quem iniciou)', async () => {
    const c = await draft(leaderA, yA, { subject: 'Oi', body: 'Texto' });
    const r = ok(await svc.begin(c.id, leaderA));
    expect(r.ok).toBe(true);
    expect(Object.keys(r).sort()).toEqual(
      ['attempts', 'body', 'id', 'ok', 'recipient_email', 'recipient_name', 'sender_email', 'sender_name', 'subject']);
    expect(r).toMatchObject({ id: c.id, attempts: 1, recipient_email: expect.stringMatching(/^jovem-.*@exemplo.com$/), subject: 'Oi', body: 'Texto', sender_name: 'Líder A' });
    expect(r.sender_email).toMatch(/@teste\.local$/);   // o stub usa <uuid>@teste.local (válido)
    const row = await rowOf(c.id);
    expect(row).toMatchObject({ status: 'sending', attempts: 1, sent_by: leaderA, sent_at: null });
    expect(row.last_attempt_at).not.toBeNull();
  });

  it('líder só envia o SEU jovem e o que ele criou; coordenador envia qualquer uma; fora do escopo = not_found sem mudar nada', async () => {
    const own = await draft(leaderA, yA);
    const byCoord = await draft(coord, yA);
    const other = await draft(leaderB, yB);
    expect(await svc.begin(own.id, leaderB)).toEqual({ ok: false, error: 'not_found' });
    expect(await svc.begin(other.id, leaderA)).toEqual({ ok: false, error: 'not_found' });
    expect(await svc.begin(byCoord.id, leaderA)).toEqual({ ok: false, error: 'not_found' });   // criada por coordenador
    expect(await svc.begin(crypto.randomUUID(), leaderA)).toEqual({ ok: false, error: 'not_found' });
    expect(await svc.begin(own.id, crypto.randomUUID())).toEqual({ ok: false, error: 'not_found' });
    for (const id of [own.id, other.id, byCoord.id]) expect(await rowOf(id)).toMatchObject({ status: 'draft', attempts: 0 });
    expect(ok(await svc.begin(other.id, coord)).ok).toBe(true);

    // jovem que saiu do grupo do líder: sem escopo
    const moved = await mkYouth(groupA);
    const m = await draft(leaderA, moved);
    await t.q(`UPDATE public.youth SET group_id = $2 WHERE id = $1`, [moved, groupB]);
    expect(await svc.begin(m.id, leaderA)).toEqual({ ok: false, error: 'not_found' });
  });

  it('segundo begin sobre sending RECENTE é recusado; sending > 5 min é retomável (attempts incrementa)', async () => {
    const c = await draft(leaderA, yA);
    expect(ok(await svc.begin(c.id, leaderA)).attempts).toBe(1);
    expect(await svc.begin(c.id, leaderA)).toMatchObject({ ok: false, error: 'conflict', reason: 'in_progress' });
    expect(await svc.begin(c.id, coord)).toMatchObject({ ok: false, error: 'conflict', reason: 'in_progress' });
    expect((await rowOf(c.id)).attempts).toBe(1);

    await t.q(`UPDATE public.communications SET last_attempt_at = now() - interval '6 minutes' WHERE id = $1`, [c.id]);
    const again = ok(await svc.begin(c.id, leaderA));
    expect(again).toMatchObject({ ok: true, attempts: 2 });
    expect(await rowOf(c.id)).toMatchObject({ status: 'sending', attempts: 2 });

    await t.q(`UPDATE public.communications SET last_attempt_at = now() - interval '4 minutes' WHERE id = $1`, [c.id]);
    expect(await svc.begin(c.id, leaderA)).toMatchObject({ ok: false, reason: 'in_progress' });
  });

  it('sent e cancelled não reenviam; failed permite novo envio (attempts acumula)', async () => {
    const s = await draft(leaderA, yA);
    await svc.sendOk(s.id, leaderA);
    expect(await svc.begin(s.id, leaderA)).toMatchObject({ ok: false, error: 'conflict', reason: 'already_sent' });
    expect(await svc.begin(s.id, coord)).toMatchObject({ reason: 'already_sent' });

    const x = await draft(leaderA, yA);
    await t.as(leaderA, () => t.q(`UPDATE public.communications SET status = 'cancelled' WHERE id = $1`, [x.id]));
    expect(await svc.begin(x.id, leaderA)).toMatchObject({ ok: false, error: 'conflict', reason: 'not_sendable' });

    const f = await draft(leaderA, yA);
    await svc.sendFail(f.id, leaderA, 'network');
    expect(await rowOf(f.id)).toMatchObject({ status: 'failed', failure_reason: 'network', attempts: 1 });
    const retry = ok(await svc.begin(f.id, leaderA));
    expect(retry).toMatchObject({ ok: true, attempts: 2 });
    expect(await rowOf(f.id)).toMatchObject({ status: 'sending', failure_reason: null, attempts: 2 });
    await svc.finish(f.id, true);
    expect(await rowOf(f.id)).toMatchObject({ status: 'sent', attempts: 2, failure_reason: null });
  });

  it('e-mail/CRLF: dado inválido gravado fora do guard é recusado pelo begin (invalid) sem mudar estado', async () => {
    const c = await draft(leaderA, yA);
    // simula linha legada/adulterada (superusuário contorna o guard, mas não os CHECKs): o begin revalida o que existe
    await t.q(`ALTER TABLE public.communications DISABLE TRIGGER communications_guard`);
    try {
      await t.q(`ALTER TABLE public.communications DROP CONSTRAINT communications_recipient_email_check`);
      await t.q(`UPDATE public.communications SET recipient_email = E'a@exemplo.com\\r\\nBcc: x@y.com' WHERE id = $1`, [c.id]);
      expect(await svc.begin(c.id, leaderA)).toEqual({ ok: false, error: 'invalid', field: 'recipient_email' });
      await t.q(`UPDATE public.communications SET recipient_email = 'ok@exemplo.com' WHERE id = $1`, [c.id]);
      await t.q(`ALTER TABLE public.communications DROP CONSTRAINT communications_subject_check`);
      await t.q(`UPDATE public.communications SET subject = E'Assunto\\r\\nBcc: x@y.com' WHERE id = $1`, [c.id]);
      expect(await svc.begin(c.id, leaderA)).toEqual({ ok: false, error: 'invalid', field: 'subject' });
    } finally {
      await t.q(`ALTER TABLE public.communications ENABLE TRIGGER communications_guard`);
    }
    expect(await rowOf(c.id)).toMatchObject({ status: 'draft', attempts: 0 });
  });

  it('jovem excluído (youth_id nulo): não enviável', async () => {
    const y = await mkYouth(groupA);
    const c = await draft(leaderA, y);
    await t.q(`DELETE FROM public.youth WHERE id = $1`, [y]);
    expect(await svc.begin(c.id, coord)).toEqual({ ok: false, error: 'invalid', field: 'youth' });
  });

  it('rate limit do LÍDER: 10/hora; 11º recusado (window hour) sem mudar estado; coordenador livre; janela desliza', async () => {
    const rl = await t.createUser('Líder RL', 'leader');
    const g = (await t.q<{ id: string }>(`INSERT INTO public.groups (name, leader_id) VALUES ('RL', $1) RETURNING id`, [rl]))[0].id;
    const y = await mkYouth(g);
    for (let i = 0; i < 10; i++) {
      const c = await draft(rl, y);
      expect(ok(await svc.begin(c.id, rl)).ok, `envio ${i + 1}`).toBe(true);
    }
    const extra = await draft(rl, y);
    const r = await svc.begin(extra.id, rl);
    expect(r).toMatchObject({ ok: false, error: 'rate_limited', window: 'hour' });
    expect((r as Fail).retry_after_seconds).toBeGreaterThan(0);
    expect(await rowOf(extra.id)).toMatchObject({ status: 'draft', attempts: 0 });
    // outro usuário (coordenador) segue livre
    expect(ok(await svc.begin(extra.id, coord)).ok).toBe(true);

    // janela de 1 hora: envios antigos deixam de contar
    await t.q(`UPDATE public.communication_send_log SET started_at = now() - interval '61 minutes' WHERE user_id = $1`, [rl]);
    const again = await draft(rl, y);
    expect(ok(await svc.begin(again.id, rl)).ok).toBe(true);
  });

  it('teto DIÁRIO do líder: 30/dia (window day), mesmo com a hora livre', async () => {
    const rl = await t.createUser('Líder Dia', 'leader');
    const g = (await t.q<{ id: string }>(`INSERT INTO public.groups (name, leader_id) VALUES ('Dia', $1) RETURNING id`, [rl]))[0].id;
    const y = await mkYouth(g);
    const c0 = await draft(rl, y);
    // 30 inícios espalhados nas últimas 20 horas (nenhum na última hora)
    await t.q(`INSERT INTO public.communication_send_log (user_id, communication_id, started_at)
               SELECT $1, $2, now() - (g || ' minutes')::interval FROM generate_series(100, 1290, 41) g`, [rl, c0.id]);
    const n = Number((await t.q<{ n: string }>(`SELECT count(*)::text n FROM public.communication_send_log WHERE user_id = $1`, [rl]))[0].n);
    expect(n).toBe(30);
    const r = await svc.begin(c0.id, rl);
    expect(r).toMatchObject({ ok: false, error: 'rate_limited', window: 'day' });
    expect((r as Fail).retry_after_seconds).toBeGreaterThan(0);
    expect(await rowOf(c0.id)).toMatchObject({ status: 'draft', attempts: 0 });
    // o coordenador tem 100/dia: 30 não o limitam
    await t.q(`INSERT INTO public.communication_send_log (user_id, communication_id, started_at)
               SELECT $1, $2, now() - (g || ' minutes')::interval FROM generate_series(100, 1290, 41) g`, [coord, c0.id]);
    expect(ok(await svc.begin(c0.id, coord)).ok).toBe(true);
  });

  it('rate limit do COORDENADOR: 20/hora', async () => {
    for (let i = 0; i < 20; i++) {
      const c = await draft(coord, yA);
      expect(ok(await svc.begin(c.id, coord)).ok, `envio ${i + 1}`).toBe(true);
    }
    const extra = await draft(coord, yA);
    expect(await svc.begin(extra.id, coord)).toMatchObject({ ok: false, error: 'rate_limited', window: 'hour' });
  });

  it('o log do rate limit SOBREVIVE à exclusão da comunicação (communication_id vira NULL)', async () => {
    const c = await draft(coord, yA);
    await svc.begin(c.id, coord);
    await t.q(`UPDATE public.communications SET status = 'draft', attempts = 0, last_attempt_at = NULL, sent_by = NULL WHERE id = $1`, [c.id]);
    const before = Number((await t.q<{ n: string }>(`SELECT count(*)::text n FROM public.communication_send_log WHERE user_id = $1`, [coord]))[0].n);
    expect(before).toBe(1);
    await t.as(coord, () => t.q(`DELETE FROM public.communications WHERE id = $1`, [c.id]));
    const rows = await t.q<{ communication_id: string | null }>(`SELECT communication_id FROM public.communication_send_log WHERE user_id = $1`, [coord]);
    expect(rows).toEqual([{ communication_id: null }]);
  });

  it('LÍDER: destinatário diferente do e-mail do jovem é recusado no begin (field recipient); coordenador livre', async () => {
    const c = await draft(leaderA, yA);
    // linha antiga/adulterada (superusuário): destinatário alheio ou kind != youth
    await t.q(`ALTER TABLE public.communications DISABLE TRIGGER communications_leader_recipient`);
    try {
      await t.q(`UPDATE public.communications SET recipient_email = 'vitima@exemplo.com' WHERE id = $1`, [c.id]);
      expect(await svc.begin(c.id, leaderA)).toEqual({ ok: false, error: 'invalid', field: 'recipient' });
      await t.q(`UPDATE public.communications SET recipient_email = (SELECT lower(email) FROM public.youth WHERE id = $2), recipient_kind = 'guardian' WHERE id = $1`, [c.id, yA]);
      expect(await svc.begin(c.id, leaderA)).toEqual({ ok: false, error: 'invalid', field: 'recipient' });
      await t.q(`UPDATE public.communications SET recipient_email = 'vitima@exemplo.com' WHERE id = $1`, [c.id]);
    } finally {
      await t.q(`ALTER TABLE public.communications ENABLE TRIGGER communications_leader_recipient`);
    }
    expect(await rowOf(c.id)).toMatchObject({ status: 'draft', attempts: 0 });
    // coordenador pode enviar a qualquer destinatário válido (mesma linha)
    expect(ok(await svc.begin(c.id, coord)).recipient_email).toBe('vitima@exemplo.com');

    // jovem sem e-mail: líder não consegue sequer criar o rascunho
    const semEmail = await mkYouth(groupA);
    await t.q(`UPDATE public.youth SET email = NULL WHERE id = $1`, [semEmail]);
    await expect(t.as(leaderA, () => t.q(
      `INSERT INTO public.communications (youth_id, recipient_email, recipient_kind, subject, body) VALUES ($1, 'x@exemplo.com', 'youth', 's', 'b')`, [semEmail])))
      .rejects.toThrow(/próprio jovem/);
  });
});

describe('finish_communication_send', () => {
  it('sucesso: sent com sent_at, sent_by (quem iniciou), provider e id da mensagem', async () => {
    const c = await draft(leaderA, yA);
    await svc.begin(c.id, leaderA);
    const f = await svc.finish(c.id, true, { provider: 'Resend', messageId: ' re_123\n ' });
    expect(f).toMatchObject({ ok: true, changed: true, status: 'sent' });
    expect(f.sent_at).not.toBeNull();
    expect(await rowOf(c.id)).toMatchObject({ status: 'sent', sent_by: leaderA, provider: 'resend', provider_message_id: 're_123', failure_reason: null });
  });

  it('sucesso sem id do provedor: sent com provider_message_id NULL (decisão documentada)', async () => {
    const c = await draft(leaderA, yA);
    await svc.begin(c.id, leaderA);
    await svc.finish(c.id, true, { messageId: null });
    expect(await rowOf(c.id)).toMatchObject({ status: 'sent', provider_message_id: null, provider: 'resend' });
  });

  it('falha: motivo da lista fechada; qualquer outro valor vira unknown; sent_by/provider_message_id limpos', async () => {
    for (const reason of ['provider_not_configured', 'provider_rejected', 'invalid_address', 'network', 'timeout', 'unknown']) {
      const c = await draft(leaderA, yA);
      await svc.begin(c.id, leaderA);
      await svc.finish(c.id, false, { reason });
      expect(await rowOf(c.id), reason).toMatchObject({ status: 'failed', failure_reason: reason, sent_by: null, sent_at: null, provider_message_id: null });
    }
    for (const bad of ['bounced', 'other', `texto livre ${SECRET}`, null]) {
      const c = await draft(leaderA, yA);
      await svc.begin(c.id, leaderA);
      await svc.finish(c.id, false, { reason: bad });
      expect((await rowOf(c.id)).failure_reason, String(bad)).toBe('unknown');
    }
  });

  it('idempotente: segunda chamada em estado final não altera nada; sem begin não altera; inexistente = not_found', async () => {
    const c = await draft(leaderA, yA);
    expect(await svc.finish(c.id, true)).toMatchObject({ ok: true, changed: false, status: 'draft' });
    expect((await rowOf(c.id)).status).toBe('draft');

    await svc.begin(c.id, leaderA);
    await svc.finish(c.id, true, { messageId: 'primeiro' });
    const before = await rowOf(c.id);
    expect(await svc.finish(c.id, true, { messageId: 'segundo' })).toMatchObject({ ok: true, changed: false, status: 'sent' });
    expect(await svc.finish(c.id, false, { reason: 'network' })).toMatchObject({ changed: false, status: 'sent' });
    expect(await rowOf(c.id)).toEqual(before);

    const f = await draft(leaderA, yA);
    await svc.sendFail(f.id, leaderA, 'timeout');
    expect(await svc.finish(f.id, true)).toMatchObject({ changed: false, status: 'failed' });
    expect((await rowOf(f.id)).failure_reason).toBe('timeout');

    expect(await svc.finish(crypto.randomUUID(), true)).toEqual({ ok: false, error: 'not_found' });
  });

  it('sent é imutável para clientes (inclusive reverter) e para o conteúdo', async () => {
    const c = await draft(leaderA, yA);
    await svc.sendOk(c.id, leaderA);
    for (const set of [`status = 'draft'`, `status = 'failed'`, `subject = 'x'`, `body = 'x'`]) {
      await expect(t.as(leaderA, () => t.q(`UPDATE public.communications SET ${set} WHERE id = $1`, [c.id])), set).rejects.toThrow(/enviadas/);
    }
  });
});

describe('activity_log e histórico', () => {
  it('communication_sent só quando sent, atribuída a quem iniciou, sem vazar assunto/corpo/e-mail/nome', async () => {
    const count = async () => Number((await t.q<{ n: string }>(`SELECT count(*)::text n FROM public.activity_log WHERE action = 'communication_sent'`))[0].n);
    const n0 = await count();
    const ySec = await mkYouth(groupA);
    await t.q(`UPDATE public.youth SET email = $2 WHERE id = $1`, [ySec, `${SECRET.toLowerCase()}@exemplo.com`]);

    const failed = await draft(leaderA, ySec, { subject: `A ${SECRET}`, body: `B ${SECRET}` });
    await svc.sendFail(failed.id, leaderA);
    const sending = await draft(leaderA, yA);
    await svc.begin(sending.id, leaderA);
    expect(await count()).toBe(n0);

    const c = await draft(leaderA, ySec, { subject: `A ${SECRET}`, body: `B ${SECRET}` });
    await svc.sendOk(c.id, leaderA);
    expect(await count()).toBe(n0 + 1);
    await svc.finish(c.id, true);
    expect(await count()).toBe(n0 + 1);

    const [log] = await t.q<{ actor_id: string; actor_name: string; summary: string; youth_id: string; group_id: string }>(
      `SELECT actor_id, actor_name, summary, youth_id, group_id FROM public.activity_log WHERE action = 'communication_sent' AND entity_id = $1`, [c.id]);
    expect(log).toMatchObject({ actor_id: leaderA, actor_name: 'Líder A', summary: 'Comunicação por e-mail enviada.', youth_id: ySec, group_id: groupA });
    const all = await t.q<{ j: string }>(`SELECT to_jsonb(a)::text AS j FROM public.activity_log a`);
    expect(all.some((r) => r.j.toLowerCase().includes(SECRET.toLowerCase()))).toBe(false);
    // o claim temporário não vaza para fora da função
    const [s] = await t.q<{ v: string | null }>(`SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '') AS v`);
    expect(s.v).toBeNull();
  });

  it('histórico: destinatário, assunto, data, responsável e vínculo com alerta/acompanhamento', async () => {
    const y = await mkYouth(groupA);
    const fu = (await t.q<{ id: string }>(
      `INSERT INTO public.follow_ups (youth_id, reason, responsible_id, created_by) VALUES ($1, 'Conversa', $2, $2) RETURNING id`, [y, coord]))[0].id;
    const c = await t.as(leaderA, async () => (await t.q<Comm>(
      `INSERT INTO public.communications (youth_id, follow_up_id, recipient_email, recipient_kind, subject, body)
       SELECT $1, $2, lower(email), 'youth', 'Contato', 'Olá' FROM public.youth WHERE id = $1 RETURNING *`, [y, fu]))[0]);
    await svc.sendOk(c.id, leaderA, 're_hist');
    const rows = await t.as(leaderA, () => t.q<Comm>(
      `SELECT * FROM public.communications WHERE youth_id = $1 ORDER BY created_at DESC`, [y]));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: 'sent', recipient_email: expect.stringMatching(/^jovem-/), subject: 'Contato', sent_by: leaderA,
      follow_up_id: fu, provider_message_id: 're_hist',
    });
    expect(rows[0].sent_at).not.toBeNull();
    // líder alheio não vê
    expect(await t.as(leaderB, () => t.q(`SELECT id FROM public.communications WHERE id = $1`, [c.id]))).toHaveLength(0);
  });
});

