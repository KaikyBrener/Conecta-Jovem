import { beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './harness';
import { serviceApi } from './communications-helpers';

// Migrations 015 + 018: comunicações por e-mail. Escopo (RLS), máquina de estados, imutabilidade de `sent`,
// validação de e-mail/injeção de CR/LF, RPC mark_communication, activity_log sem vazamento e histórico que sobrevive
// à exclusão do jovem.
//
// MUDANÇAS INTENCIONAIS em relação ao modelo assistido (015) após a 018 — clientes NÃO declaram mais `sent`/`failed`:
//   * "sent" e "failed" agora são produzidos pelo servidor (begin/finish, só service_role): nos testes que precisam de
//     uma comunicação enviada/falha usa-se `sendOk`/`sendFail` (equivalem à Edge Function). A cobertura detalhada do
//     envio está em communications-send.test.ts.
//   * mark_communication só aceita cancelled/draft; as tentativas de 'sent'/'failed' por cliente viram testes de RECUSA.
//   * os testes de escopo usam 'cancelled' no lugar de 'sent' (a intenção — fora do escopo => "não encontrada" — é a mesma).
//   * o texto do histórico passou de "marcada como enviada" para "enviada" (agora é um envio real).

let t: TestDb;
let svc: ReturnType<typeof serviceApi>;
let coord: string, leaderA: string, leaderB: string;
let groupA: string, groupB: string;
let yA: string, yB: string;
let seq = 0;

const SECRET = 'SEGREDO-COMUNICACAO-XYZ';

interface Comm {
  id: string; channel: string; youth_id: string | null; alert_id: string | null; follow_up_id: string | null;
  recipient_email: string; recipient_name: string | null; recipient_kind: string; subject: string; body: string;
  status: string; failure_reason: string | null; created_by: string | null; created_at: string;
  sent_at: string | null; sent_by: string | null; updated_at: string;
  provider: string | null; provider_message_id: string | null; attempts: number; last_attempt_at: string | null;
}

async function mkYouth(group: string | null, email: string | null = null): Promise<string> {
  seq += 1;
  return (await t.q<{ id: string }>(
    `INSERT INTO public.youth (full_name, group_id, email, created_by) VALUES ($1, $2, $3, $4) RETURNING id`,
    [`Jovem Com ${seq}`, group, email, coord]))[0].id;
}

/** Cria um rascunho como `user`. Campos podem ser sobrescritos. */
async function draft(user: string, youth: string, over: Record<string, unknown> = {}): Promise<Comm> {
  const v = {
    recipient_email: 'destino@exemplo.com', recipient_name: 'Destino', recipient_kind: 'guardian',
    subject: 'Assunto normal', body: 'Corpo da mensagem\ncom duas linhas', ...over,
  };
  return t.as(user, async () => (await t.q<Comm>(
    `INSERT INTO public.communications (youth_id, alert_id, follow_up_id, recipient_email, recipient_name, recipient_kind, subject, body)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [youth, v.alert_id ?? null, v.follow_up_id ?? null, v.recipient_email, v.recipient_name, v.recipient_kind, v.subject, v.body]))[0]);
}

const mark = (user: string, id: string, status: string, reason?: string | null) =>
  t.as(user, async () => (await t.q<Comm>(
    `SELECT * FROM public.mark_communication($1, $2, $3)`, [id, status, reason ?? null]))[0]);

const rowOf = async (id: string) => (await t.q<Comm>(`SELECT * FROM public.communications WHERE id = $1`, [id]))[0];
const upd = (user: string, id: string, set: string, params: unknown[] = []) =>
  t.as(user, () => t.q(`UPDATE public.communications SET ${set} WHERE id = $1`, [id, ...params]));

beforeAll(async () => {
  t = await createTestDb();
  svc = serviceApi(t);
  coord =await t.createUser('Coordenadora', 'coordinator');
  leaderA = await t.createUser('Líder A', 'leader');
  leaderB = await t.createUser('Líder B', 'leader');
  const mk = async (name: string, owner: string) =>
    (await t.q<{ id: string }>(`INSERT INTO public.groups (name, leader_id) VALUES ($1, $2) RETURNING id`, [name, owner]))[0].id;
  groupA = await mk('Grupo A', leaderA);
  groupB = await mk('Grupo B', leaderB);
  yA = await mkYouth(groupA, '  Jovem.A@Exemplo.COM ');
  yB = await mkYouth(groupB, 'jovem.b@exemplo.com');
}, 60_000);

describe('criação e normalização', () => {
  it('líder cria rascunho para jovem do seu grupo; servidor força created_by, status draft e normaliza e-mail', async () => {
    const c = await draft(leaderA, yA, { recipient_email: '  Pai.Do.Jovem@Exemplo.COM ', subject: '  Oi  ' });
    expect(c).toMatchObject({
      channel: 'email', status: 'draft', created_by: leaderA, recipient_email: 'pai.do.jovem@exemplo.com',
      subject: 'Oi', sent_at: null, sent_by: null, failure_reason: null, youth_id: yA,
    });
  });

  it('created_by forjado é sobrescrito; criar já como "sent"/com carimbos é recusado ou zerado', async () => {
    const forged = await t.as(leaderA, async () => (await t.q<Comm>(
      `INSERT INTO public.communications (youth_id, created_by, recipient_email, subject, body, sent_by, sent_at, failure_reason,
                                          provider, attempts, last_attempt_at)
       VALUES ($1, $2, 'a@b.com', 's', 'b', $2, now(), 'bounced', 'resend', 7, now()) RETURNING *`, [yA, leaderB]))[0]);
    expect(forged).toMatchObject({
      created_by: leaderA, sent_at: null, sent_by: null, failure_reason: null, status: 'draft',
      provider: null, provider_message_id: null, attempts: 0, last_attempt_at: null,
    });

    for (const st of ['sent', 'sending', 'failed']) {
      await expect(t.as(leaderA, () => t.q(
        `INSERT INTO public.communications (youth_id, recipient_email, subject, body, status) VALUES ($1, 'a@b.com', 's', 'b', $2)`, [yA, st])), st)
        .rejects.toThrow(/rascunho/);
    }
  });

  it('só e-mail como canal; kind fora da lista é recusado', async () => {
    await expect(t.q(`INSERT INTO public.communications (channel, youth_id, recipient_email, subject, body)
                      VALUES ('sms', $1, 'a@b.com', 's', 'b')`, [yA])).rejects.toThrow(/channel/);
    await expect(draft(leaderA, yA, { recipient_kind: 'vizinho' })).rejects.toThrow(/recipient_kind/);
  });

  it('exige jovem (cliente) e limita assunto (1..200) e corpo (1..5000)', async () => {
    await expect(t.as(coord, () => t.q(
      `INSERT INTO public.communications (recipient_email, subject, body) VALUES ('a@b.com', 's', 'b')`))).rejects.toThrow(/jovem/i);
    await expect(draft(coord, yA, { subject: '   ' })).rejects.toThrow(/assunto/i);
    await expect(draft(coord, yA, { subject: 'x'.repeat(201) })).rejects.toThrow(/subject/);
    await draft(coord, yA, { subject: 'x'.repeat(200), body: 'y'.repeat(5000) });
    await expect(draft(coord, yA, { body: 'y'.repeat(5001) })).rejects.toThrow(/body/);
    await expect(draft(coord, yA, { body: '  \n\t ' })).rejects.toThrow(/body/);
  });
});

describe('validação de e-mail e injeção de cabeçalho', () => {
  const invalid = [
    'sem-arroba.com', 'a@b', 'a@b.c', 'a b@exemplo.com', 'a@exemplo..com', '.a@exemplo.com', 'a.@exemplo.com',
    'a@-exemplo.com', 'a@exemplo.com.', 'a@exemplo.c0m', 'a,b@exemplo.com', 'a@exemplo.com,c@exemplo.com',
    '<a@exemplo.com>', '"a"@exemplo.com', 'a?cc=x@exemplo.com', 'a&bcc=x@exemplo.com', 'a@exemplo.com\n',
    'a@exemplo.com\r\nBcc: x@y.com', 'a\n@exemplo.com', `${'a'.repeat(65)}@exemplo.com`, `a@${'b'.repeat(64)}.com`,
  ];
  for (const email of invalid) {
    it(`recusa ${JSON.stringify(email.length > 40 ? email.slice(0, 40) + '…' : email)}`, async () => {
      await expect(draft(coord, yA, { recipient_email: email })).rejects.toThrow();
    });
  }

  it('aceita e-mails comuns', async () => {
    for (const email of ['a@b.co', 'nome.sobrenome+tag@sub.exemplo.com.br', 'X_Y.z-1@E-xemplo.org']) {
      const c = await draft(coord, yA, { recipient_email: email });
      expect(c.recipient_email).toBe(email.toLowerCase());
    }
  });

  it('assunto e nome do destinatário não aceitam CR, LF, TAB, NEL nem U+2028/2029; corpo aceita quebras mas não NUL-like/controle', async () => {
    for (const bad of ['a\nb', 'a\rb', 'a\r\nBcc: x@y.com', 'a\tb', 'a\u0085b', 'a b', 'a b', 'a\u007fb']) {
      await expect(draft(coord, yA, { subject: bad })).rejects.toThrow();
      await expect(draft(coord, yA, { recipient_name: bad })).rejects.toThrow();
    }
    await draft(coord, yA, { body: 'linha 1\r\nlinha 2\n\tlinha 3' });
    await expect(draft(coord, yA, { body: 'a\u0001b' })).rejects.toThrow(/body/);
    await expect(draft(coord, yA, { body: 'a\u001bb' })).rejects.toThrow(/body/);
  });

  it('o mesmo vale em UPDATE de rascunho', async () => {
    const c = await draft(leaderA, yA);
    await expect(upd(leaderA, c.id, `subject = $2`, ['ok\nBcc: x@y.com'])).rejects.toThrow();
    await expect(upd(leaderA, c.id, `recipient_email = $2`, ['x@y.com\r\nBcc: z@y.com'])).rejects.toThrow();
    expect((await rowOf(c.id)).subject).toBe('Assunto normal');
  });
});

describe('edição de rascunho e máquina de estados', () => {
  it('rascunho é editável por UPDATE direto; updated_at é atualizado', async () => {
    const c = await draft(leaderA, yA);
    await upd(leaderA, c.id, `subject = 'Novo assunto', body = 'Novo corpo', recipient_email = 'NOVO@Exemplo.com'`);
    const r = await rowOf(c.id);
    expect(r).toMatchObject({ subject: 'Novo assunto', body: 'Novo corpo', recipient_email: 'novo@exemplo.com', status: 'draft' });
    expect(new Date(r.updated_at).getTime()).toBeGreaterThanOrEqual(new Date(c.updated_at).getTime());
  });

  it('o servidor envia (begin/finish): carimba sent_at/sent_by/provider; sent é imutável para o cliente', async () => {
    const c = await draft(leaderA, yA);
    const fin = await svc.sendOk(c.id, leaderA, 're_abc');
    expect(fin).toMatchObject({ ok: true, changed: true, status: 'sent' });
    const s = await rowOf(c.id);
    expect(s).toMatchObject({ status: 'sent', sent_by: leaderA, provider: 'resend', provider_message_id: 're_abc', attempts: 1 });
    expect(s.sent_at).not.toBeNull();

    const attempts: [string, unknown[]][] = [
      [`subject = 'outro'`, []], [`body = 'outro'`, []], [`recipient_email = 'outro@exemplo.com'`, []],
      [`recipient_name = 'Outro'`, []], [`recipient_kind = 'other'`, []], [`status = 'draft'`, []],
      [`status = 'failed'`, []], [`status = 'cancelled'`, []], [`status = 'sending'`, []],
    ];
    for (const [set, params] of attempts) {
      await expect(upd(leaderA, c.id, set, params), set).rejects.toThrow(/enviadas/i);
    }
    // carimbos e autoria são restaurados pelo servidor (não dá erro, mas nada muda)
    await upd(leaderA, c.id, `sent_at = now() - interval '1 day', sent_by = $2, failure_reason = 'bounced', created_by = $2,
                              provider = 'x', provider_message_id = 'forjado', attempts = 99`, [leaderB]);
    await expect(mark(leaderA, c.id, 'draft')).rejects.toThrow(/enviadas/);
    await expect(mark(leaderA, c.id, 'sent')).rejects.toThrow(/servidor/);
    const r = await rowOf(c.id);
    expect(r).toMatchObject({ status: 'sent', subject: 'Assunto normal', sent_by: leaderA, provider: 'resend',
                              provider_message_id: 're_abc', attempts: 1, created_by: leaderA });
    expect(r.sent_at).toEqual(s.sent_at);
  });

  it('coordenador também não altera uma comunicação enviada', async () => {
    const c = await draft(coord, yA);
    await svc.sendOk(c.id, coord);
    await expect(upd(coord, c.id, `subject = 'x'`)).rejects.toThrow(/enviadas/);
    await expect(upd(coord, c.id, `status = 'cancelled'`)).rejects.toThrow(/enviadas/);
  });

  it('cliente NÃO declara envio: UPDATE direto para sent/sending/failed e mark_communication são recusados (nada muda)', async () => {
    const c = await draft(leaderA, yA);
    await expect(upd(leaderA, c.id, `status = 'sent', sent_at = '2000-01-01', sent_by = $2`, [leaderB])).rejects.toThrow(/servidor/);
    await expect(upd(leaderA, c.id, `status = 'sending'`)).rejects.toThrow(/servidor/);
    await expect(upd(leaderA, c.id, `status = 'failed', failure_reason = 'bounced'`)).rejects.toThrow(/Mudança de status/);
    for (const st of ['sent', 'sending', 'failed']) {
      await expect(mark(leaderA, c.id, st), st).rejects.toThrow(/servidor/);
    }
    // coordenador também
    await expect(mark(coord, c.id, 'sent')).rejects.toThrow(/servidor/);
    await expect(upd(coord, c.id, `status = 'sent'`)).rejects.toThrow(/servidor/);
    expect(await rowOf(c.id)).toMatchObject({ status: 'draft', sent_at: null, sent_by: null, attempts: 0 });
  });

  it('falha do servidor (failed, motivo da lista) -> conteúdo travado -> reabrir (draft, limpa motivo) -> editável', async () => {
    const c = await draft(leaderA, yA);
    await svc.sendFail(c.id, leaderA, 'provider_rejected');
    expect(await rowOf(c.id)).toMatchObject({ status: 'failed', failure_reason: 'provider_rejected', sent_at: null, sent_by: null, provider: 'resend' });

    // failed: conteúdo travado; cliente não altera o motivo
    await expect(upd(leaderA, c.id, `subject = 'x'`)).rejects.toThrow(/rascunho/);
    await upd(leaderA, c.id, `failure_reason = 'timeout', provider = 'x', attempts = 0`);
    expect(await rowOf(c.id)).toMatchObject({ failure_reason: 'provider_rejected', provider: 'resend', attempts: 1 });
    // failed -> sent/sending não é permitido ao cliente
    await expect(mark(leaderA, c.id, 'sent')).rejects.toThrow(/servidor/);

    const d = await mark(leaderA, c.id, 'draft');
    expect(d).toMatchObject({ status: 'draft', failure_reason: null, attempts: 1 });
    await upd(leaderA, c.id, `subject = 'Corrigido'`);
    expect((await rowOf(c.id)).subject).toBe('Corrigido');
  });

  it('failed -> cancelled; cancelled é terminal', async () => {
    const c = await draft(leaderA, yA);
    await svc.sendFail(c.id, leaderA, 'network');
    const x = await mark(leaderA, c.id, 'cancelled');
    expect(x).toMatchObject({ status: 'cancelled', failure_reason: null });
    await expect(mark(leaderA, c.id, 'draft')).rejects.toThrow(/canceladas/);
    await expect(upd(leaderA, c.id, `body = 'x'`)).rejects.toThrow(/canceladas/);
  });

  it('draft -> cancelled direto; "sending" não pode ser alterado nem cancelado pelo cliente', async () => {
    const c = await draft(leaderA, yA);
    await svc.begin(c.id, leaderA);
    await expect(mark(leaderA, c.id, 'cancelled')).rejects.toThrow(/em envio/);
    await expect(mark(leaderA, c.id, 'draft')).rejects.toThrow(/em envio/);
    await expect(upd(leaderA, c.id, `subject = 'x'`)).rejects.toThrow(/em envio/);
    await expect(upd(coord, c.id, `body = 'x'`)).rejects.toThrow(/em envio/);
    expect((await rowOf(c.id)).status).toBe('sending');

    const d = await draft(leaderA, yA);
    expect((await mark(leaderA, d.id, 'cancelled')).status).toBe('cancelled');
  });

  it('não mistura mudança de conteúdo com mudança de status; failure_reason forjado fora de failed é ignorado', async () => {
    const c = await draft(leaderA, yA);
    await expect(upd(leaderA, c.id, `status = 'sent', subject = 'trocado na hora'`)).rejects.toThrow(/separadas/);
    await upd(leaderA, c.id, `failure_reason = 'bounced'`);
    expect((await rowOf(c.id)).failure_reason).toBeNull();
    await expect(mark(leaderA, c.id, 'inexistente')).rejects.toThrow(/Status inválido/);
    await expect(mark(leaderA, c.id, 'draft')).rejects.toThrow(/já está/);
  });

  it('cliente não troca jovem, alerta, acompanhamento, canal nem id; created_at/created_by são restaurados', async () => {
    const c = await draft(leaderA, yA);
    const other = await mkYouth(groupA);
    await expect(upd(leaderA, c.id, `youth_id = $2`, [other])).rejects.toThrow(/não podem ser alterados/);
    await expect(upd(leaderA, c.id, `youth_id = NULL`)).rejects.toThrow(/não podem ser alterados/);
    await expect(upd(leaderA, c.id, `id = gen_random_uuid()`)).rejects.toThrow();
    await upd(leaderA, c.id, `created_by = $2, created_at = '2001-01-01'`, [leaderB]);
    const r = await rowOf(c.id);
    expect(r.created_by).toBe(leaderA);
    expect(r.created_at).toEqual(c.created_at);
  });
});

describe('vínculos com alerta e acompanhamento', () => {
  async function mkAlert(youth: string, group: string): Promise<string> {
    for (let i = 0; i < 3; i++) {
      seq += 1;
      const [e] = await t.q<{ id: string }>(
        `INSERT INTO public.events (title, event_date, status, created_by)
         VALUES ('Enc com', now() - ($1 || ' days')::interval, 'completed', $2) RETURNING id`, [String(40 - i), coord]);
      await t.q(`INSERT INTO public.event_groups (event_id, group_id) VALUES ($1, $2)`, [e.id, group]);
      await t.q(`INSERT INTO public.attendance (event_id, youth_id, group_id, present, recorded_by) VALUES ($1, $2, $3, false, NULL)`,
        [e.id, youth, group]);
    }
    return (await t.q<{ id: string }>(
      `SELECT id FROM public.alerts WHERE youth_id = $1 AND type = 'consecutive_absences' AND status = 'open'`, [youth]))[0].id;
  }
  async function mkFollowUp(youth: string): Promise<string> {
    return (await t.q<{ id: string }>(
      `INSERT INTO public.follow_ups (youth_id, reason, responsible_id, created_by) VALUES ($1, 'Conversa', $2, $2) RETURNING id`,
      [youth, coord]))[0].id;
  }

  it('aceita alerta/acompanhamento do mesmo jovem e recusa os de outro jovem', async () => {
    const y1 = await mkYouth(groupA), y2 = await mkYouth(groupA);
    const alert1 = await mkAlert(y1, groupA), alert2 = await mkAlert(y2, groupA);
    const fu1 = await mkFollowUp(y1), fu2 = await mkFollowUp(y2);

    const ok = await draft(leaderA, y1, { alert_id: alert1, follow_up_id: fu1 });
    expect(ok).toMatchObject({ alert_id: alert1, follow_up_id: fu1 });
    await expect(draft(leaderA, y1, { alert_id: alert2 })).rejects.toThrow(/alerta/);
    await expect(draft(leaderA, y1, { follow_up_id: fu2 })).rejects.toThrow(/acompanhamento/);
    await expect(upd(leaderA, ok.id, `alert_id = NULL`)).rejects.toThrow(/não podem ser alterados/);
  });

  it('excluir alerta/acompanhamento não apaga a comunicação (SET NULL), inclusive enviada', async () => {
    const y1 = await mkYouth(groupA);
    const alert1 = await mkAlert(y1, groupA);
    const fu1 = await mkFollowUp(y1);
    const c = await draft(leaderA, y1, { alert_id: alert1, follow_up_id: fu1 });
    await svc.sendOk(c.id, leaderA);
    await t.q(`DELETE FROM public.follow_ups WHERE id = $1`, [fu1]);
    await t.q(`DELETE FROM public.alerts WHERE id = $1`, [alert1]);
    expect(await rowOf(c.id)).toMatchObject({ status: 'sent', alert_id: null, follow_up_id: null, youth_id: y1 });
  });
});

describe('escopo e RLS', () => {
  it('líder não cria para jovem de outro grupo nem sem jovem; não forja created_by de outra pessoa', async () => {
    await expect(draft(leaderA, yB)).rejects.toThrow();
    await expect(t.as(leaderA, () => t.q(
      `INSERT INTO public.communications (youth_id, recipient_email, subject, body) VALUES (NULL, 'a@b.com', 's', 'b')`))).rejects.toThrow();
    await expect(draft(leaderA, crypto.randomUUID())).rejects.toThrow();
  });

  it('líder alheio não vê, não edita, não marca e não exclui; o erro não vaza existência', async () => {
    const c = await draft(leaderA, yA, { subject: SECRET });
    const seen = await t.as(leaderB, () => t.q(`SELECT id FROM public.communications WHERE id = $1`, [c.id]));
    expect(seen).toHaveLength(0);
    expect(await t.as(leaderB, () => t.q(`UPDATE public.communications SET subject = 'hack' WHERE id = $1 RETURNING id`, [c.id]))).toHaveLength(0);
    expect(await t.as(leaderB, () => t.q(`DELETE FROM public.communications WHERE id = $1 RETURNING id`, [c.id]))).toHaveLength(0);
    await expect(mark(leaderB, c.id, 'cancelled')).rejects.toThrow(/não encontrada ou sem permissão/);
    await expect(mark(leaderB, crypto.randomUUID(), 'cancelled')).rejects.toThrow(/não encontrada ou sem permissão/);
    expect(await rowOf(c.id)).toMatchObject({ subject: SECRET, status: 'draft' });
  });

  it('líder vê comunicações do seu grupo criadas por coordenador, mas não as edita/marca', async () => {
    const c = await draft(coord, yA);
    const seen = await t.as(leaderA, () => t.q(`SELECT id FROM public.communications WHERE id = $1`, [c.id]));
    expect(seen).toHaveLength(1);
    expect(await t.as(leaderA, () => t.q(`UPDATE public.communications SET subject = 'x' WHERE id = $1 RETURNING id`, [c.id]))).toHaveLength(0);
    await expect(mark(leaderA, c.id, 'cancelled')).rejects.toThrow(/não encontrada ou sem permissão/);
  });

  it('líder não exclui nem os próprios rascunhos; coordenador exclui só draft/cancelled', async () => {
    const own = await draft(leaderA, yA);
    expect(await t.as(leaderA, () => t.q(`DELETE FROM public.communications WHERE id = $1 RETURNING id`, [own.id]))).toHaveLength(0);

    const del = (id: string) => t.as(coord, () => t.q(`DELETE FROM public.communications WHERE id = $1 RETURNING id`, [id]));
    const sent = await draft(coord, yA); await svc.sendOk(sent.id, coord);
    const failed = await draft(coord, yA); await svc.sendFail(failed.id, coord);
    const sending = await draft(coord, yA); await svc.begin(sending.id, coord);
    const cancelled = await draft(coord, yA); await mark(coord, cancelled.id, 'cancelled');
    const dr = await draft(coord, yA);
    expect(await del(sent.id)).toHaveLength(0);
    expect(await del(failed.id)).toHaveLength(0);
    expect(await del(sending.id)).toHaveLength(0);
    expect(await del(cancelled.id)).toHaveLength(1);
    expect(await del(dr.id)).toHaveLength(1);
    expect(await del(own.id)).toHaveLength(1);
    expect(await rowOf(sent.id)).toBeDefined();
  });

  it('coordenador vê tudo; líder só vê as dos jovens que estão HOJE nos seus grupos', async () => {
    const y = await mkYouth(groupA);
    const c = await draft(leaderA, y);
    expect(await t.as(leaderA, () => t.q(`SELECT id FROM public.communications WHERE id = $1`, [c.id]))).toHaveLength(1);
    expect(await t.as(coord, () => t.q(`SELECT id FROM public.communications WHERE id = $1`, [c.id]))).toHaveLength(1);

    await t.q(`UPDATE public.youth SET group_id = $2 WHERE id = $1`, [y, groupB]);
    expect(await t.as(leaderA, () => t.q(`SELECT id FROM public.communications WHERE id = $1`, [c.id]))).toHaveLength(0);
    await expect(mark(leaderA, c.id, 'cancelled')).rejects.toThrow(/não encontrada/);
    expect(await t.as(leaderB, () => t.q(`SELECT id FROM public.communications WHERE id = $1`, [c.id]))).toHaveLength(1);
    // ...mas leaderB não edita: foi criada por leaderA
    await expect(mark(leaderB, c.id, 'cancelled')).rejects.toThrow(/não encontrada/);

    await t.q(`UPDATE public.youth SET group_id = NULL WHERE id = $1`, [y]);
    expect(await t.as(leaderB, () => t.q(`SELECT id FROM public.communications WHERE id = $1`, [c.id]))).toHaveLength(0);
  });

  it('anon não lê, não escreve e não executa as funções', async () => {
    const c = await draft(coord, yA);
    await expect(t.as(null, () => t.q(`SELECT * FROM public.communications`))).rejects.toThrow(/permission denied/);
    await expect(t.as(null, () => t.q(
      `INSERT INTO public.communications (youth_id, recipient_email, subject, body) VALUES ($1, 'a@b.com', 's', 'b')`, [yA]))).rejects.toThrow(/permission denied/);
    await expect(t.as(null, () => t.q(`UPDATE public.communications SET subject = 'x'`))).rejects.toThrow(/permission denied/);
    await expect(t.as(null, () => t.q(`DELETE FROM public.communications`))).rejects.toThrow(/permission denied/);
    await expect(t.as(null, () => t.q(`SELECT * FROM public.mark_communication($1, 'sent')`, [c.id]))).rejects.toThrow(/permission denied/);
    await expect(t.as(null, () => t.q(`SELECT * FROM public.suggest_communication_recipients($1)`, [yA]))).rejects.toThrow(/permission denied/);
    await expect(t.as(null, () => t.q(`SELECT public.is_valid_email('a@b.com')`))).rejects.toThrow(/permission denied/);
  });

  it('funções-trigger não são chamáveis por clientes; TRUNCATE não é concedido', async () => {
    for (const fn of ['communications_guard', 'communications_log_activity']) {
      await expect(t.as(leaderA, () => t.q(`SELECT public.${fn}()`))).rejects.toThrow(/permission denied/);
    }
    await expect(t.as(coord, () => t.q(`TRUNCATE public.communications`))).rejects.toThrow(/permission denied/);
  });

  it('RLS está ativa na tabela', async () => {
    const [r] = await t.q<{ relrowsecurity: boolean }>(`SELECT relrowsecurity FROM pg_class WHERE oid = 'public.communications'::regclass`);
    expect(r.relrowsecurity).toBe(true);
  });
});

describe('RPC mark_communication', () => {
  it('coordenador cancela qualquer uma; retorna a linha atualizada', async () => {
    const c = await draft(leaderA, yA);
    const r = await mark(coord, c.id, 'cancelled');
    expect(r).toMatchObject({ id: c.id, status: 'cancelled', sent_by: null });
  });

  it('só é executável por authenticated (grant-level)', async () => {
    const rows = await t.q<{ a: boolean; p: boolean }>(
      `SELECT has_function_privilege('anon', 'public.mark_communication(uuid, text, text)', 'EXECUTE') AS a,
              has_function_privilege('authenticated', 'public.mark_communication(uuid, text, text)', 'EXECUTE') AS p`);
    expect(rows[0]).toEqual({ a: false, p: true });
  });

  it('não é SECURITY DEFINER (RLS do chamador vale)', async () => {
    const [r] = await t.q<{ prosecdef: boolean }>(`SELECT prosecdef FROM pg_proc WHERE proname = 'mark_communication'`);
    expect(r.prosecdef).toBe(false);
  });
});

describe('suggest_communication_recipients', () => {
  it('devolve só o e-mail (normalizado) do jovem dentro do escopo', async () => {
    const asA = await t.as(leaderA, () => t.q(`SELECT * FROM public.suggest_communication_recipients($1)`, [yA]));
    expect(asA).toEqual([{ kind: 'youth', name: expect.stringContaining('Jovem Com'), email: 'jovem.a@exemplo.com' }]);
    expect(await t.as(coord, () => t.q(`SELECT * FROM public.suggest_communication_recipients($1)`, [yB]))).toHaveLength(1);
  });

  it('vazio para líder alheio, jovem inexistente, jovem sem e-mail ou com e-mail inválido', async () => {
    expect(await t.as(leaderA, () => t.q(`SELECT * FROM public.suggest_communication_recipients($1)`, [yB]))).toHaveLength(0);
    expect(await t.as(leaderA, () => t.q(`SELECT * FROM public.suggest_communication_recipients($1)`, [crypto.randomUUID()]))).toHaveLength(0);
    const semEmail = await mkYouth(groupA, null);
    const ruim = await mkYouth(groupA, 'isso não é e-mail');
    expect(await t.as(leaderA, () => t.q(`SELECT * FROM public.suggest_communication_recipients($1)`, [semEmail]))).toHaveLength(0);
    expect(await t.as(leaderA, () => t.q(`SELECT * FROM public.suggest_communication_recipients($1)`, [ruim]))).toHaveLength(0);
  });
});

describe('activity_log', () => {
  it('o envio pelo servidor grava UMA entrada fixa (atribuída a quem enviou), sem assunto/corpo/e-mail/nome', async () => {
    const c = await draft(leaderA, yA, {
      subject: `Assunto ${SECRET}`, body: `Corpo ${SECRET}`, recipient_name: `Nome ${SECRET}`,
      recipient_email: `${SECRET.toLowerCase()}@exemplo.com`,
    });
    await svc.sendOk(c.id, leaderA);
    const rows = await t.q<{ actor_id: string; actor_name: string; entity_type: string; youth_id: string; group_id: string; summary: string; meta: unknown }>(
      `SELECT actor_id, actor_name, entity_type, youth_id, group_id, summary, meta FROM public.activity_log
        WHERE action = 'communication_sent' AND entity_id = $1`, [c.id]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actor_id: leaderA, actor_name: 'Líder A', entity_type: 'communication', youth_id: yA, group_id: groupA,
      summary: 'Comunicação por e-mail enviada.',
    });
    expect(rows[0].meta).toMatchObject({ channel: 'email', recipient_kind: 'guardian', provider: 'resend' });

    const all = await t.q<{ j: string }>(`SELECT to_jsonb(a)::text AS j FROM public.activity_log a`);
    expect(all.some((r) => r.j.toLowerCase().includes(SECRET.toLowerCase()))).toBe(false);

    // o líder do grupo enxerga a entrada; o líder alheio não
    const seenA = await t.as(leaderA, () => t.q(`SELECT id FROM public.activity_log WHERE action = 'communication_sent' AND entity_id = $1`, [c.id]));
    const seenB = await t.as(leaderB, () => t.q(`SELECT id FROM public.activity_log WHERE action = 'communication_sent' AND entity_id = $1`, [c.id]));
    expect(seenA).toHaveLength(1);
    expect(seenB).toHaveLength(0);
  });

  it('rascunho, falha, cancelamento e envio repetido não geram entrada de envio', async () => {
    const before = async () => Number((await t.q<{ n: string }>(`SELECT count(*)::text n FROM public.activity_log WHERE action = 'communication_sent'`))[0].n);
    const n0 = await before();
    const a = await draft(leaderA, yA); await svc.sendFail(a.id, leaderA); await mark(leaderA, a.id, 'draft'); await mark(leaderA, a.id, 'cancelled');
    expect(await before()).toBe(n0);
    const b = await draft(leaderA, yA); await svc.sendOk(b.id, leaderA);
    await expect(mark(leaderA, b.id, 'sent')).rejects.toThrow();
    expect(await svc.begin(b.id, leaderA)).toMatchObject({ ok: false, error: 'conflict' });
    expect(await svc.finish(b.id, true)).toMatchObject({ ok: true, changed: false, status: 'sent' });
    await upd(leaderA, b.id, `status = 'sent'`); // no-op sobre linha enviada: não duplica
    expect(await before()).toBe(n0 + 1);
  });

  it('clientes continuam sem escrever em activity_log; CHECKs aceitam os valores novos e recusam outros', async () => {
    await expect(t.as(coord, () => t.q(
      `INSERT INTO public.activity_log (action, entity_type, summary) VALUES ('communication_sent', 'communication', 'x')`))).rejects.toThrow(/permission denied/);
    await t.q(`INSERT INTO public.activity_log (action, entity_type, summary) VALUES ('communication_sent', 'communication', 'ok')`);
    await expect(t.q(`INSERT INTO public.activity_log (action, entity_type, summary) VALUES ('communication_deleted', 'communication', 'x')`))
      .rejects.toThrow(/activity_log_action_check/);
    await expect(t.q(`INSERT INTO public.activity_log (action, entity_type, summary) VALUES ('task_created', 'sms', 'x')`))
      .rejects.toThrow(/activity_log_entity_type_check/);
    // as ações antigas seguem aceitas
    await t.q(`INSERT INTO public.activity_log (action, entity_type, summary) VALUES ('event_series_created', 'event_series', 'ok')`);
  });
});

describe('histórico sobrevive à exclusão do jovem', () => {
  it('excluir o jovem anula youth_id mas mantém a comunicação (inclusive enviada); só o coordenador a vê depois', async () => {
    const y = await mkYouth(groupA);
    const sent = await draft(leaderA, y); await svc.sendOk(sent.id, leaderA);
    const dr = await draft(leaderA, y);

    await t.q(`DELETE FROM public.youth WHERE id = $1`, [y]);

    expect(await rowOf(sent.id)).toMatchObject({ status: 'sent', youth_id: null, subject: 'Assunto normal' });
    expect(await rowOf(dr.id)).toMatchObject({ status: 'draft', youth_id: null });
    expect(await t.as(coord, () => t.q(`SELECT id FROM public.communications WHERE id = $1`, [sent.id]))).toHaveLength(1);
    expect(await t.as(leaderA, () => t.q(`SELECT id FROM public.communications WHERE id = $1`, [sent.id]))).toHaveLength(0);
    // a entrada do activity_log também sobrevive (youth_id nulo)
    const log = await t.q<{ youth_id: string | null }>(
      `SELECT youth_id FROM public.activity_log WHERE action = 'communication_sent' AND entity_id = $1`, [sent.id]);
    expect(log).toHaveLength(1);
    expect(log[0].youth_id).toBeNull();
  });
});
