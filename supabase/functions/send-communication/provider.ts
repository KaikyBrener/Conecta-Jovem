// Provedores de e-mail (puro e injetável: nenhum acesso a Deno/Node; recebe `fetch`).
// Hoje só 'resend'. Para adicionar outro provedor, crie uma fábrica com a mesma interface `MailProvider`.
// NUNCA devolva texto cru do provedor, URL ou chave: o resultado é só { ok, reason | messageId }.

export type FailureReason =
  | 'provider_not_configured' | 'provider_rejected' | 'invalid_address' | 'network' | 'timeout' | 'unknown';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;            // TEXTO PURO (nunca HTML)
  replyTo?: string | null;
  idempotencyKey: string;
}

export type ProviderResult =
  | { ok: true; provider: string; messageId: string | null }
  | { ok: false; provider: string; reason: FailureReason };

export interface MailProvider {
  readonly name: string;
  send(msg: MailMessage): Promise<ProviderResult>;
}

type FetchLike = (url: string, init: {
  method: string; headers: Record<string, string>; body: string; signal?: AbortSignal;
}) => Promise<{ status: number; json(): Promise<unknown> }>;

export interface ResendOptions {
  apiKey: string;
  from: string;
  fetch: FetchLike;
  timeoutMs?: number;
}

const RESEND_URL = 'https://api.resend.com/emails';

export function createResendProvider(opts: ResendOptions): MailProvider {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const name = 'resend';
  return {
    name,
    async send(msg) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const payload: Record<string, unknown> = {
        from: opts.from,
        to: [msg.to],
        subject: msg.subject,
        text: msg.text,
      };
      if (msg.replyTo) payload.reply_to = msg.replyTo;
      try {
        const res = await opts.fetch(RESEND_URL, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${opts.apiKey}`,
            'Content-Type': 'application/json',
            'Idempotency-Key': msg.idempotencyKey,
          },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
        if (res.status >= 200 && res.status < 300) {
          let id: string | null = null;
          try {
            const body = (await res.json()) as { id?: unknown } | null;
            if (body && typeof body.id === 'string' && body.id.length > 0 && body.id.length <= 200) id = body.id;
          } catch {
            id = null;   // 2xx sem corpo legível: o provedor aceitou; sem id (ver migration 018)
          }
          return { ok: true, provider: name, messageId: id };
        }
        if (res.status === 408) return { ok: false, provider: name, reason: 'timeout' };
        if (res.status === 429) return { ok: false, provider: name, reason: 'unknown' };   // limite do provedor: não é "recusa" do conteúdo
        if (res.status >= 400 && res.status < 500) return { ok: false, provider: name, reason: 'provider_rejected' };
        return { ok: false, provider: name, reason: 'unknown' };   // 5xx e demais
      } catch (err) {
        const aborted = controller.signal.aborted || (err as { name?: string } | null)?.name === 'AbortError';
        return { ok: false, provider: name, reason: aborted ? 'timeout' : 'network' };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/** Escolhe o provedor pelas variáveis de ambiente; `null` = não configurado (a função NÃO tenta enviar). */
export function providerFromEnv(
  env: (key: string) => string | undefined,
  fetchImpl: FetchLike,
): MailProvider | null {
  const kind = (env('MAIL_PROVIDER') ?? 'resend').trim().toLowerCase();
  if (kind !== 'resend') return null;
  const apiKey = env('RESEND_API_KEY')?.trim();
  const from = env('MAIL_FROM')?.trim();
  if (!apiKey || !from) return null;
  // `from` é fixo e vem do ambiente; ainda assim recusa quebras de linha (defesa em profundidade).
  if (/[\r\n]/.test(from) || /[\r\n]/.test(apiKey)) return null;
  return createResendProvider({ apiKey, from, fetch: fetchImpl });
}
