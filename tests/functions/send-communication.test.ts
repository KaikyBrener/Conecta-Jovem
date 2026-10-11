import { describe, expect, it, vi } from 'vitest';
import { contentKey, handleRequest, normalizeOrigin, type BeginErr, type BeginOk, type Db, type Deps, type FinishResult } from '../../supabase/functions/send-communication/handler.ts';
import { createResendProvider, providerFromEnv } from '../../supabase/functions/send-communication/provider.ts';
import { createTestDb } from '../db/harness.ts';
import { serviceApi } from '../db/communications-helpers.ts';

const ID = '11111111-2222-4333-8444-555555555555';
const JWT = 'header.payload.signature-abcdef';
const API_KEY = 're_SUPERSECRETKEY123';
const RECIPIENT = 'destino.privado@exemplo.com';
const SUBJECT = 'Assunto confidencial XYZ';
const BODY = 'Corpo <b>não é HTML</b>\ncom linhas';
const SENDER = 'lider@exemplo.com';
const PROVIDER_RAW = 'RAW-PROVIDER-ERROR-TEXT-do-not-leak';

const begun: BeginOk = {
  ok: true, id: ID, attempts: 2, recipient_email: RECIPIENT, recipient_name: 'Dest', subject: SUBJECT, body: BODY,
  sender_name: 'Líder', sender_email: SENDER,
};

type FetchInit = { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal };

function setup(over: {
  user?: { id: string } | null; canRead?: boolean; begin?: BeginOk | BeginErr | Error;
  fetchImpl?: (url: string, init: FetchInit) => Promise<{ status: number; json(): Promise<unknown> }>;
  configured?: boolean; finishFails?: number; finishResult?: FinishResult; allowedOrigin?: string | null;
  extraEnv?: Record<string, string>;
} = {}) {
  const calls = { finish: [] as unknown[], begin: 0 };
  let finishFailures = over.finishFails ?? 0;
  const fetchSpy = vi.fn(over.fetchImpl ?? (async () => ({ status: 200, json: async () => ({ id: 're_msg_1' }) })));
  const logs: string[] = [];
  const db: Db = {
    getUser: async () => (over.user === undefined ? { id: 'user-1' } : over.user),
    canRead: async () => over.canRead ?? true,
    begin: async () => {
      calls.begin += 1;
      if (over.begin instanceof Error) throw over.begin;
      return over.begin ?? begun;
    },
    finish: async (a) => {
      calls.finish.push(a);
      if (finishFailures > 0) { finishFailures -= 1; throw new Error(`db down ${RECIPIENT}`); }
      if (over.finishResult) return over.finishResult;
      return a.ok
        ? { ok: true, changed: true, status: 'sent', sent_at: '2026-10-04T12:00:00.000Z' }
        : { ok: true, changed: true, status: 'failed', failure_reason: a.failureReason };
    },
  };
  const env = over.configured === false ? {} : { RESEND_API_KEY: API_KEY, MAIL_FROM: 'Conecta Jovem <no-reply@exemplo.com>', ...over.extraEnv };
  const deps: Deps = {
    db,
    provider: providerFromEnv((k) => (env as Record<string, string>)[k], fetchSpy as never),
    allowedOrigin: over.allowedOrigin === undefined ? 'https://app.exemplo.com' : over.allowedOrigin,
    log: (e, id) => logs.push(`${id} ${e}`),
  };
  return { deps, calls, fetchSpy, logs };
}

const post = (body: unknown = { communication_id: ID }, headers: Record<string, string> = {}) =>
  new Request('https://x.supabase.co/functions/v1/send-communication', {
    method: 'POST',
    headers: { authorization: `Bearer ${JWT}`, 'content-type': 'application/json', origin: 'https://app.exemplo.com', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

async function run(req: Request, s = setup()) {
  const res = await handleRequest(req, s.deps);
  const text = await res.text();
  return { res, text, json: text ? JSON.parse(text) : null, s };
}

/** Nada sensível em respostas nem logs. */
function expectNoLeak(text: string, logs: string[]) {
  const all = text + '\n' + logs.join('\n');
  for (const secret of [API_KEY, RECIPIENT, SUBJECT, 'Corpo', SENDER, PROVIDER_RAW, 'api.resend.com', 'no-reply@exemplo.com']) {
    expect(all, secret).not.toContain(secret);
  }
}

describe('envio com sucesso', () => {
  it('200 sent; texto puro; from fixo; reply_to; Idempotency-Key estável por conteúdo; Authorization do provedor só na chamada ao provedor', async () => {
    const { res, json, s } = await run(post());
    expect(res.status).toBe(200);
    expect(json).toEqual({ status: 'sent', communication_id: ID, sent_at: '2026-10-04T12:00:00.000Z' });

    expect(s.fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = s.fetchSpy.mock.calls[0] as [string, FetchInit];
    expect(url).toBe('https://api.resend.com/emails');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe(`Bearer ${API_KEY}`);
    expect(init.headers['Idempotency-Key']).toBe(await contentKey(ID, RECIPIENT, SUBJECT, BODY));
    expect(init.headers['Idempotency-Key']).toMatch(new RegExp(`^${ID}:[0-9a-f]{16}$`));
    const payload = JSON.parse(init.body);
    expect(payload).toEqual({
      from: 'Conecta Jovem <no-reply@exemplo.com>', to: [RECIPIENT], subject: SUBJECT, text: BODY, reply_to: SENDER,
    });
    expect(payload.html).toBeUndefined();
    expect(s.calls.finish).toEqual([{
      communicationId: ID, ok: true, provider: 'resend', providerMessageId: 're_msg_1', failureReason: null,
    }]);
    expectNoLeak(JSON.stringify(json), s.logs);
  });

  it('sem sender_email não envia reply_to; 2xx sem id vira sent com id nulo', async () => {
    const s = setup({ begin: { ...begun, sender_email: null }, fetchImpl: async () => ({ status: 202, json: async () => ({}) }) });
    const { json } = await run(post(), s);
    expect(json.status).toBe('sent');
    expect(JSON.parse((s.fetchSpy.mock.calls[0] as [string, FetchInit])[1].body).reply_to).toBeUndefined();
    expect((s.calls.finish[0] as { providerMessageId: unknown }).providerMessageId).toBeNull();
  });
});

describe('REPLY_TO_EMAIL (secret opcional)', () => {
  const REPLY = 'contato@exemplo.com';
  const sentBody = (s: ReturnType<typeof setup>) => (s.fetchSpy.mock.calls[0] as [string, FetchInit])[1].body;

  it('com secret válido: SEMPRE substitui o e-mail de quem enviou (que não aparece na requisição ao provedor)', async () => {
    const s = setup({ extraEnv: { REPLY_TO_EMAIL: `  ${REPLY}  ` } });
    const { res, json } = await run(post(), s);
    expect(res.status).toBe(200);
    expect(json.status).toBe('sent');
    expect(JSON.parse(sentBody(s)).reply_to).toBe(REPLY);
    expect(sentBody(s)).not.toContain(SENDER);
    expectNoLeak(JSON.stringify(json), s.logs);
  });

  it('com secret e sem sender_email: usa o secret', async () => {
    const s = setup({ extraEnv: { REPLY_TO_EMAIL: REPLY }, begin: { ...begun, sender_email: null } });
    await run(post(), s);
    expect(JSON.parse(sentBody(s)).reply_to).toBe(REPLY);
  });

  it('sem secret (ou vazio): mantém o comportamento atual, reply_to = e-mail de quem enviou', async () => {
    for (const extraEnv of [undefined, { REPLY_TO_EMAIL: '' }, { REPLY_TO_EMAIL: '   ' }]) {
      const s = setup({ extraEnv });
      const { json } = await run(post(), s);
      expect(json.status).toBe('sent');
      expect(JSON.parse(sentBody(s)).reply_to).toBe(SENDER);
    }
  });

  it('secret inválido: NÃO envia (falha fechada), não cai no e-mail pessoal e não chama o provedor', async () => {
    const invalid = ['nao-e-email', 'a@b', 'Nome <contato@exemplo.com>', 'a b@exemplo.com', 'a%b@exemplo.com',
      'contato@exemplo.com\r\nBcc: x@y.com', 'a@@exemplo.com', '.a@exemplo.com', 'a..b@exemplo.com', `${'x'.repeat(250)}@exemplo.com`];
    for (const REPLY_TO_EMAIL of invalid) {
      const s = setup({ extraEnv: { REPLY_TO_EMAIL } });
      expect(s.deps.provider).toBeNull();
      const { res, json } = await run(post(), s);
      expect(res.status).toBe(200);
      expect(json).toEqual({ status: 'failed', communication_id: ID, failure_reason: 'provider_not_configured' });
      expect(s.fetchSpy).not.toHaveBeenCalled();
      expectNoLeak(JSON.stringify(json), s.logs);
    }
  });
});

describe('falhas do provedor (200 failed, sem vazar texto cru)', () => {
  const cases: [string, (url: string, init: FetchInit) => Promise<{ status: number; json(): Promise<unknown> }>, string][] = [
    ['4xx', async () => ({ status: 422, json: async () => ({ message: PROVIDER_RAW }) }), 'provider_rejected'],
    ['401', async () => ({ status: 401, json: async () => ({ message: PROVIDER_RAW }) }), 'provider_rejected'],
    ['5xx', async () => ({ status: 503, json: async () => ({ message: PROVIDER_RAW }) }), 'unknown'],
    ['erro de rede', async () => { throw new TypeError(`fetch failed ${PROVIDER_RAW} ${API_KEY}`); }, 'network'],
  ];
  for (const [name, fetchImpl, reason] of cases) {
    it(`${name} -> ${reason}`, async () => {
      const s = setup({ fetchImpl });
      const { res, json, text } = await run(post(), s);
      expect(res.status).toBe(200);
      expect(json).toEqual({ status: 'failed', communication_id: ID, failure_reason: reason });
      expect(s.calls.finish).toEqual([{
        communicationId: ID, ok: false, provider: 'resend', providerMessageId: null, failureReason: reason,
      }]);
      expectNoLeak(text, s.logs);
    });
  }

  it('timeout (15 s por padrão; aqui abortado) -> timeout', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const s = setup({
        fetchImpl: (_u, init) => new Promise((_resolve, reject) => {
          init.signal!.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
        }),
      });
      const p = handleRequest(post(), s.deps);
      for (let i = 0; i < 100 && s.fetchSpy.mock.calls.length === 0; i++) await new Promise((r) => setImmediate(r));   // digest é assíncrono real
      await vi.advanceTimersByTimeAsync(15_001);
      const res = await p;
      expect(await res.json()).toEqual({ status: 'failed', communication_id: ID, failure_reason: 'timeout' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('o provedor padrão usa 15 s de timeout', async () => {
    vi.useFakeTimers();
    try {
      let aborted = false;
      const p = createResendProvider({
        apiKey: API_KEY, from: 'a@b.com',
        fetch: (_u, init) => new Promise((_r, rej) => init.signal!.addEventListener('abort', () => { aborted = true; rej(new Error('x')); })),
      });
      const pending = p.send({ to: 'a@b.com', subject: 's', text: 't', idempotencyKey: 'k' });
      await vi.advanceTimersByTimeAsync(14_999);
      expect(aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(2);
      expect(aborted).toBe(true);
      expect(await pending).toMatchObject({ ok: false, reason: 'timeout' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('provedor que lança exceção inesperada -> unknown', async () => {
    const s = setup();
    s.deps.provider = { name: 'resend', send: async () => { throw new Error(PROVIDER_RAW); } };
    const { json, text } = await run(post(), s);
    expect(json.failure_reason).toBe('unknown');
    expectNoLeak(text, s.logs);
  });
});

describe('provedor não configurado', () => {
  for (const env of ['sem nada', 'só chave', 'só from']) {
    it(`${env}: NÃO chama fetch; registra provider_not_configured`, async () => {
      const s = setup({ configured: false });
      if (env !== 'sem nada') {
        const e: Record<string, string> = env === 'só chave' ? { RESEND_API_KEY: API_KEY } : { MAIL_FROM: 'a@b.com' };
        s.deps.provider = providerFromEnv((k) => e[k], s.fetchSpy as never);
      }
      const { res, json } = await run(post(), s);
      expect(res.status).toBe(200);
      expect(json).toEqual({ status: 'failed', communication_id: ID, failure_reason: 'provider_not_configured' });
      expect(s.fetchSpy).not.toHaveBeenCalled();
      expect(s.calls.finish[0]).toMatchObject({ ok: false, failureReason: 'provider_not_configured' });
    });
  }

  it('MAIL_PROVIDER desconhecido -> não configurado', () => {
    const e: Record<string, string> = { MAIL_PROVIDER: 'sendgrid', RESEND_API_KEY: API_KEY, MAIL_FROM: 'a@b.com' };
    expect(providerFromEnv((k) => e[k], vi.fn() as never)).toBeNull();
  });
});

describe('requisição e autorização', () => {
  it('OPTIONS: CORS só para a origem permitida; sem ALLOWED_ORIGIN nenhuma origem', async () => {
    const ok = await handleRequest(new Request('https://x/f', { method: 'OPTIONS', headers: { origin: 'https://app.exemplo.com' } }), setup().deps);
    expect(ok.status).toBe(204);
    expect(ok.headers.get('access-control-allow-origin')).toBe('https://app.exemplo.com');
    expect(ok.headers.get('access-control-allow-methods')).toBe('POST, OPTIONS');
    const bad = await handleRequest(new Request('https://x/f', { method: 'OPTIONS', headers: { origin: 'https://evil.com' } }), setup().deps);
    expect(bad.headers.get('access-control-allow-origin')).toBeNull();
    const none = await handleRequest(new Request('https://x/f', { method: 'OPTIONS', headers: { origin: 'https://app.exemplo.com' } }),
      setup({ allowedOrigin: null }).deps);
    expect(none.headers.get('access-control-allow-origin')).toBeNull();
    const { res } = await run(post(undefined, { origin: 'https://evil.com' }));
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('ALLOWED_ORIGIN: barra final/caminho/maiúsculas são normalizados; errada, "*" e sem esquema não liberam nada', async () => {
    const preflight = async (allowedOrigin: string | null, origin = 'https://app.exemplo.com') =>
      (await handleRequest(new Request('https://x/f', { method: 'OPTIONS', headers: { origin } }), setup({ allowedOrigin }).deps))
        .headers.get('access-control-allow-origin');

    for (const configured of ['https://app.exemplo.com', 'https://app.exemplo.com/', ' https://app.exemplo.com/ ', 'https://APP.exemplo.com/login'])
      expect(await preflight(configured)).toBe('https://app.exemplo.com');

    for (const wrong of ['http://app.exemplo.com', 'https://app.exemplo.com:8443', 'https://outro.exemplo.com', 'https://app.exemplo.com.evil.com'])
      expect(await preflight(wrong)).toBeNull();
    for (const invalid of ['*', 'app.exemplo.com', 'null', '', '   ', 'javascript:alert(1)', 'ftp://app.exemplo.com'])
      expect(await preflight(invalid)).toBeNull();
    expect(await preflight(null)).toBeNull();

    expect(await preflight('https://app.exemplo.com/', 'https://app.exemplo.com/')).toBeNull();
    expect(normalizeOrigin('http://localhost:5173/')).toBe('http://localhost:5173');
    expect(normalizeOrigin(undefined)).toBeNull();
  });

  it('método errado -> 405; corpo inválido/uuid inválido/grande -> 400 (sem tocar no banco)', async () => {
    const s = setup();
    expect((await run(new Request('https://x/f', { method: 'GET' }), s)).res.status).toBe(405);
    for (const body of ['não é json', '{}', '{"communication_id": 5}', '{"communication_id": "abc"}', '[]', 'null',
                        JSON.stringify({ communication_id: ID, x: 'a'.repeat(2000) })]) {
      const r = await run(post(body), s);
      expect(r.res.status, body.slice(0, 30)).toBe(400);
      expect(r.json).toEqual({ error: 'invalid_request' });
    }
    expect(s.calls.begin).toBe(0);
  });

  it('sem Authorization ou JWT inválido -> 401 (nem lê nem envia)', async () => {
    const s = setup({ user: null });
    expect((await run(post(undefined, { authorization: 'Bearer' }), s)).res.status).toBe(401);
    expect((await run(new Request('https://x/f', { method: 'POST', body: JSON.stringify({ communication_id: ID }) }), s)).res.status).toBe(401);
    const bad = await run(post(), s);
    expect(bad.res.status).toBe(401);
    expect(bad.json).toEqual({ error: 'unauthorized' });
    expect(s.calls.begin).toBe(0);
    expect(s.fetchSpy).not.toHaveBeenCalled();
  });

  it('escopo (RLS do usuário não enxerga) -> 404 genérico, sem begin nem envio', async () => {
    const s = setup({ canRead: false });
    const r = await run(post(), s);
    expect(r.res.status).toBe(404);
    expect(r.json).toEqual({ error: 'not_found' });
    expect(s.calls.begin).toBe(0);
    expect(s.fetchSpy).not.toHaveBeenCalled();
  });

  it('erros do begin: not_found 404; conflitos 409; rate limit 429 (+Retry-After); inválido 422; técnico 500', async () => {
    const t = async (begin: BeginErr | Error) => {
      const s = setup({ begin });
      const r = await run(post(), s);
      expect(s.fetchSpy).not.toHaveBeenCalled();
      expect(s.calls.finish).toHaveLength(0);
      expectNoLeak(r.text, s.logs);
      return r;
    };
    expect((await t({ ok: false, error: 'not_found' })).res.status).toBe(404);
    for (const reason of ['already_sent', 'in_progress', 'not_sendable']) {
      const r = await t({ ok: false, error: 'conflict', reason });
      expect(r.res.status).toBe(409);
      expect(r.json).toEqual({ error: reason });
    }
    const rl = await t({ ok: false, error: 'rate_limited', retry_after_seconds: 1234 });
    expect(rl.res.status).toBe(429);
    expect(rl.res.headers.get('retry-after')).toBe('1234');
    expect(rl.json).toEqual({ error: 'rate_limited', retry_after_seconds: 1234 });
    const inv = await t({ ok: false, error: 'invalid', field: 'recipient_email' });
    expect(inv.res.status).toBe(422);
    expect(inv.json).toEqual({ error: 'invalid_content', field: 'recipient_email' });
    const boom = await t(new Error(`pg: ${RECIPIENT}`));
    expect(boom.res.status).toBe(500);
    expect(boom.json).toEqual({ error: 'internal_error' });
  });

  it('segunda chamada com envio já concluído (finish idempotente) devolve o estado real', async () => {
    const s = setup({ finishResult: { ok: true, changed: false, status: 'sent', sent_at: '2026-01-01T00:00:00.000Z' } });
    expect((await run(post(), s)).json).toMatchObject({ status: 'sent', sent_at: '2026-01-01T00:00:00.000Z' });
  });
});

describe('migration 019 (contrato)', () => {
  it('begin invalid/recipient -> 422 invalid_content com field recipient, sem enviar', async () => {
    const s = setup({ begin: { ok: false, error: 'invalid', field: 'recipient' } });
    const r = await run(post(), s);
    expect(r.res.status).toBe(422);
    expect(r.json).toEqual({ error: 'invalid_content', field: 'recipient' });
    expect(s.fetchSpy).not.toHaveBeenCalled();
  });

  it('429 informa a janela (hour|day)', async () => {
    const r = await run(post(), setup({ begin: { ok: false, error: 'rate_limited', retry_after_seconds: 90, window: 'day' } }));
    expect(r.res.status).toBe(429);
    expect(r.json).toEqual({ error: 'rate_limited', retry_after_seconds: 90, window: 'day' });
  });

  it('Idempotency-Key: mesma em retry com mesmo conteúdo (mesmo com attempts diferente); diferente se o conteúdo mudar', async () => {
    const key = async (b: Partial<BeginOk>) => {
      const s = setup({ begin: { ...begun, ...b } });
      await run(post(), s);
      return (s.fetchSpy.mock.calls[0] as [string, FetchInit])[1].headers['Idempotency-Key'];
    };
    const k1 = await key({ attempts: 1 });
    expect(await key({ attempts: 5 })).toBe(k1);
    expect(await key({ subject: SUBJECT + '!' })).not.toBe(k1);
    expect(await key({ body: BODY + ' ' })).not.toBe(k1);
    expect(await key({ recipient_email: 'outro@exemplo.com' })).not.toBe(k1);
    // separador sem ambiguidade: (to, subject, body) deslocados não colidem
    expect(await contentKey(ID, 'a', 'bc', 'd')).not.toBe(await contentKey(ID, 'a', 'b', 'cd'));
    expect(k1.length).toBeLessThanOrEqual(256);
  });
});

describe('falha ao registrar o resultado', () => {
  it('finish falha 1 vez após envio bem-sucedido: tenta de novo e responde sent; incidente logado sem dados', async () => {
    const s = setup({ finishFails: 1 });
    const r = await run(post(), s);
    expect(r.json.status).toBe('sent');
    expect(s.calls.finish).toHaveLength(2);
    expect(s.fetchSpy).toHaveBeenCalledTimes(1);   // o e-mail NÃO é reenviado
    expect(s.logs).toEqual([`${ID.slice(0, 8)} finish_failed_after_send`]);
    expectNoLeak(r.text, s.logs);
  });

  it('finish falha 2 vezes: 500 sem detalhes (estado fica em sending no banco; ver docs/EMAIL.md)', async () => {
    const s = setup({ finishFails: 2 });
    const r = await run(post(), s);
    expect(r.res.status).toBe(500);
    expect(r.json).toEqual({ error: 'internal_error' });
    expect(s.logs.every((l) => l.endsWith('finish_failed_after_send'))).toBe(true);
    expectNoLeak(r.text, s.logs);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Integração handler + funções SQL reais (PGlite): garante que o contrato jsonb do banco é o que o handler espera.
describe('integração com o banco (PGlite)', () => {
  it('sent / failed / rate limit / escopo ponta a ponta', async () => {
    const t = await createTestDb();
    const svc = serviceApi(t);
    const leader = await t.createUser('Líder', 'leader');
    const other = await t.createUser('Outro', 'leader');
    const g = (await t.q<{ id: string }>(`INSERT INTO public.groups (name, leader_id) VALUES ('G', $1) RETURNING id`, [leader]))[0].id;
    const y = (await t.q<{ id: string }>(`INSERT INTO public.youth (full_name, group_id, email) VALUES ('J', $1, 'd@exemplo.com') RETURNING id`, [g]))[0].id;
    const mkDraft = async () => t.as(leader, async () => (await t.q<{ id: string }>(
      `INSERT INTO public.communications (youth_id, recipient_email, recipient_kind, subject, body) VALUES ($1, 'd@exemplo.com', 'youth', 'S', 'B') RETURNING id`, [y]))[0].id);

    const db: Db = {
      getUser: async (jwt) => ({ id: jwt === 'tok-leader-xxxxx' ? leader : other }),
      canRead: async (jwt, id) => {
        const uid = jwt === 'tok-leader-xxxxx' ? leader : other;
        return (await t.as(uid, () => t.q(`SELECT 1 FROM public.communications WHERE id = $1`, [id]))).length > 0;
      },
      begin: async (id, uid) => (await svc.begin(id, uid)) as BeginOk | BeginErr,
      finish: async (a) => svc.finish(a.communicationId, a.ok, { provider: a.provider, messageId: a.providerMessageId, reason: a.failureReason }),
    };
    const mk = (fetchImpl: Deps['provider']): Deps => ({ db, provider: fetchImpl, allowedOrigin: null, log: () => {} });
    const okProvider = createResendProvider({ apiKey: 'k', from: 'a@b.com', fetch: async () => ({ status: 200, json: async () => ({ id: 're_9' }) }) });
    const badProvider = createResendProvider({ apiKey: 'k', from: 'a@b.com', fetch: async () => ({ status: 400, json: async () => ({}) }) });
    const req = (id: string, jwt = 'tok-leader-xxxxx') => post({ communication_id: id }, { authorization: `Bearer ${jwt}` });

    const c1 = await mkDraft();
    const r1 = await handleRequest(req(c1), mk(okProvider));
    expect(await r1.json()).toMatchObject({ status: 'sent', communication_id: c1 });
    expect((await t.q<{ status: string; provider_message_id: string }>(`SELECT status, provider_message_id FROM public.communications WHERE id = $1`, [c1]))[0])
      .toEqual({ status: 'sent', provider_message_id: 're_9' });
    expect((await handleRequest(req(c1), mk(okProvider))).status).toBe(409);

    const c2 = await mkDraft();
    expect(await (await handleRequest(req(c2), mk(badProvider))).json()).toEqual({ status: 'failed', communication_id: c2, failure_reason: 'provider_rejected' });
    expect(await (await handleRequest(req(c2), mk(null))).json()).toMatchObject({ status: 'failed', failure_reason: 'provider_not_configured' });

    const c3 = await mkDraft();
    expect((await handleRequest(req(c3, 'tok-other-yyyyyy'), mk(okProvider))).status).toBe(404);
    expect((await t.q<{ status: string }>(`SELECT status FROM public.communications WHERE id = $1`, [c3]))[0].status).toBe('draft');

    // rate limit do líder (10/h): já foram 3 inícios; completa 10 e o próximo é 429
    for (let i = 0; i < 7; i++) await handleRequest(req(await mkDraft()), mk(okProvider));
    const limited = await handleRequest(req(c3), mk(okProvider));
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
  }, 60_000);
});
