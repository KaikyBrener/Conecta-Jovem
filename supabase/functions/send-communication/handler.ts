// Lógica PURA da Edge Function send-communication (sem Deno.*, sem rede própria): tudo que toca o mundo externo entra
// por `Deps`, então roda em Vitest/Node e no servidor falso dos E2E.
//
// Contrato HTTP (POST, Authorization: Bearer <JWT do usuário>, body {"communication_id": "<uuid>"}):
//   200 {status:'sent', communication_id, sent_at}            enviado de fato (2xx do provedor)
//   200 {status:'failed', communication_id, failure_reason}   resultado de negócio: provider_not_configured |
//                                                             provider_rejected | invalid_address | network | timeout | unknown
//   400 invalid_request | 401 unauthorized | 404 not_found | 405 method_not_allowed
//   409 already_sent | in_progress | not_sendable | 422 invalid_content (+ field: recipient_email|recipient_name|subject|body|youth|recipient) | 429 rate_limited (+ Retry-After)
//   500 internal_error
// Corpo de erro: {"error": "<código>"}. Nunca devolve/loga texto do provedor, chaves, URLs, e-mails, assunto ou corpo.
import type { FailureReason, MailProvider } from './provider.ts';

export interface BeginOk {
  ok: true; id: string; attempts: number; recipient_email: string; recipient_name: string | null;
  subject: string; body: string; sender_name: string | null; sender_email: string | null;
}
export interface BeginErr {
  ok: false; error: string; reason?: string; field?: string; retry_after_seconds?: number; window?: string;
}
export interface FinishResult {
  ok: boolean; changed?: boolean; status?: string; sent_at?: string | null; failure_reason?: string | null; error?: string;
}

export interface Db {
  /** Valida o JWT (auth.getUser). null = inválido/expirado. */
  getUser(jwt: string): Promise<{ id: string } | null>;
  /** Lê a comunicação COM O CLIENTE DO USUÁRIO (RLS): prova que ele a enxerga. */
  canRead(jwt: string, communicationId: string): Promise<boolean>;
  /** begin_communication_send (service_role). Lança em erro técnico. */
  begin(communicationId: string, userId: string): Promise<BeginOk | BeginErr>;
  /** finish_communication_send (service_role). Lança em erro técnico. */
  finish(args: {
    communicationId: string; ok: boolean; provider: string | null; providerMessageId: string | null;
    failureReason: FailureReason | null;
  }): Promise<FinishResult>;
}

export interface Deps {
  db: Db;
  /** null = provedor não configurado: a função não tenta enviar. */
  provider: MailProvider | null;
  /** Origem permitida no CORS (ALLOWED_ORIGIN). null/vazio = nenhuma (restrito). */
  allowedOrigin: string | null;
  /** Log sem dados pessoais: só evento e id curto. */
  log: (event: string, shortId: string) => void;
  clock?: () => Date;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_BODY_CHARS = 1000;

/** ALLOWED_ORIGIN -> origem pura (sem barra final nem caminho). Valor inválido, "*" ou sem http(s) = null (restrito). */
export function normalizeOrigin(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const u = new URL(value.trim());
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.origin : null;
  } catch {
    return null;
  }
}

function corsHeaders(req: Request, allowedOrigin: string | null): Record<string, string> {
  const h: Record<string, string> = {
    Vary: 'Origin',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'authorization, content-type, apikey, x-client-info',
    'Access-Control-Max-Age': '600',
  };
  const origin = req.headers.get('origin');
  const allowed = normalizeOrigin(allowedOrigin);
  if (allowed && origin && origin === allowed) h['Access-Control-Allow-Origin'] = origin;
  return h;
}

function json(req: Request, deps: Deps, status: number, body: unknown, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...corsHeaders(req, deps.allowedOrigin), ...extra },
  });
}

const err = (req: Request, deps: Deps, status: number, code: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
  json(req, deps, status, { error: code, ...extra }, headers);

/** Chave estável por CONTEÚDO: mesmo id+to+subject+body => mesma chave em retries; conteúdo editado => chave nova. */
export async function contentKey(id: string, to: string, subject: string, body: string): Promise<string> {
  const data = new TextEncoder().encode(JSON.stringify([to, subject, body]));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
  const hex = Array.from(digest.slice(0, 8), (b) => b.toString(16).padStart(2, '0')).join('');
  return `${id}:${hex}`;
}

export async function handleRequest(req: Request, deps: Deps): Promise<Response> {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders(req, deps.allowedOrigin) });
  }
  if (req.method !== 'POST') return err(req, deps, 405, 'method_not_allowed');

  const auth = req.headers.get('authorization') ?? '';
  const m = /^Bearer\s+([A-Za-z0-9._~+/=-]{10,4096})$/.exec(auth);
  if (!m) return err(req, deps, 401, 'unauthorized');
  const jwt = m[1];

  // Corpo
  let communicationId: string;
  try {
    const raw = await req.text();
    if (raw.length > MAX_BODY_CHARS) return err(req, deps, 400, 'invalid_request');
    const parsed = JSON.parse(raw) as { communication_id?: unknown } | null;
    const id = parsed && typeof parsed === 'object' ? parsed.communication_id : undefined;
    if (typeof id !== 'string' || !UUID_RE.test(id)) return err(req, deps, 400, 'invalid_request');
    communicationId = id.toLowerCase();
  } catch {
    return err(req, deps, 400, 'invalid_request');
  }
  const short = communicationId.slice(0, 8);

  try {
    // 1) autenticação
    const user = await deps.db.getUser(jwt);
    if (!user) return err(req, deps, 401, 'unauthorized');

    // 2) escopo/RLS provado com o cliente do usuário (404 genérico, não vaza existência)
    if (!(await deps.db.canRead(jwt, communicationId))) return err(req, deps, 404, 'not_found');

    // 3) início atômico (valida escopo de escrita, estado, conteúdo e rate limit no banco)
    const begun = await deps.db.begin(communicationId, user.id);
    if (!begun.ok) {
      switch (begun.error) {
        case 'not_found': return err(req, deps, 404, 'not_found');
        case 'conflict': {
          const reason = ['already_sent', 'in_progress', 'not_sendable'].includes(begun.reason ?? '') ? begun.reason! : 'in_progress';
          return err(req, deps, 409, reason);
        }
        case 'rate_limited': {   // window: hour | day (informativo)
          const retry = Math.max(1, Math.floor(begun.retry_after_seconds ?? 60));
          return err(req, deps, 429, 'rate_limited', { retry_after_seconds: retry, ...(begun.window === 'hour' || begun.window === 'day' ? { window: begun.window } : {}) }, { 'Retry-After': String(retry) });
        }
        case 'invalid': return err(req, deps, 422, 'invalid_content', begun.field ? { field: String(begun.field) } : {});
        default: deps.log('begin_unexpected', short); return err(req, deps, 500, 'internal_error');
      }
    }

    // 4) envio ao provedor (ou falha por falta de configuração, SEM tentar enviar)
    let ok = false;
    let provider: string | null = deps.provider?.name ?? null;
    let messageId: string | null = null;
    let reason: FailureReason | null = null;
    if (!deps.provider) {
      reason = 'provider_not_configured';
      deps.log('provider_not_configured', short);
    } else {
      let result;
      try {
        result = await deps.provider.send({
          to: begun.recipient_email,
          subject: begun.subject,
          text: begun.body,
          replyTo: begun.sender_email,
          idempotencyKey: await contentKey(begun.id, begun.recipient_email, begun.subject, begun.body),
        });
      } catch {
        result = { ok: false as const, provider: deps.provider.name, reason: 'unknown' as FailureReason };
      }
      provider = result.provider;
      if (result.ok) { ok = true; messageId = result.messageId; }
      else { reason = result.reason; deps.log(`send_failed:${result.reason}`, short); }
    }

    // 5) registra o resultado REAL (1 nova tentativa se o registro falhar: o e-mail pode já ter saído)
    let fin: FinishResult | null = null;
    for (let i = 0; i < 2 && !fin; i++) {
      try {
        fin = await deps.db.finish({
          communicationId, ok, provider, providerMessageId: messageId, failureReason: reason,
        });
      } catch {
        deps.log(ok ? 'finish_failed_after_send' : 'finish_failed', short);
      }
    }
    if (!fin || !fin.ok) return err(req, deps, 500, 'internal_error');

    if (fin.status === 'sent') {
      return json(req, deps, 200, {
        status: 'sent', communication_id: communicationId,
        sent_at: fin.sent_at ?? (deps.clock ?? (() => new Date()))().toISOString(),
      });
    }
    if (fin.status === 'failed') {
      return json(req, deps, 200, {
        status: 'failed', communication_id: communicationId, failure_reason: fin.failure_reason ?? reason ?? 'unknown',
      });
    }
    return err(req, deps, 409, 'in_progress');   // estado inesperado (outra tentativa assumiu)
  } catch {
    deps.log('unexpected', short);
    return err(req, deps, 500, 'internal_error');
  }
}
