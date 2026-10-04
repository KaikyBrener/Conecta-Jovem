// Auxiliares dos testes de comunicações (migração 018): chamadas como service_role (a identidade da Edge Function).
// Não é um arquivo de teste (não termina em .test.ts).
import type { TestDb } from './harness';

export interface BeginOk {
  ok: true; id: string; attempts: number; recipient_email: string; recipient_name: string | null;
  subject: string; body: string; sender_name: string | null; sender_email: string | null;
}
export interface Fail { ok: false; error: string; reason?: string; field?: string; retry_after_seconds?: number }
export interface Finish { ok: boolean; changed?: boolean; status?: string; sent_at?: string | null; failure_reason?: string | null; error?: string }

export function serviceApi(t: TestDb) {
  /** Executa fn como service_role (sem `sub`, como no Supabase). */
  const asService = async <T,>(fn: () => Promise<T>): Promise<T> => {
    await t.db.exec(`RESET ROLE`);
    await t.db.query(`SELECT set_config('request.jwt.claim.sub', '', false)`);
    await t.db.exec(`SET ROLE service_role`);
    try {
      return await fn();
    } finally {
      await t.db.exec(`RESET ROLE`);
    }
  };

  const begin = (id: string, userId: string) =>
    asService(async () => (await t.q<{ r: BeginOk | Fail }>(
      `SELECT public.begin_communication_send($1, $2) AS r`, [id, userId]))[0].r);

  const finish = (id: string, ok: boolean, opts: { provider?: string | null; messageId?: string | null; reason?: string | null } = {}) =>
    asService(async () => (await t.q<{ r: Finish }>(
      `SELECT public.finish_communication_send($1, $2, $3, $4, $5) AS r`,
      [id, ok, opts.provider === undefined ? 'resend' : opts.provider,
       opts.messageId === undefined ? 're_msg_123' : opts.messageId, opts.reason ?? null]))[0].r);

  /** begin + finish(ok) — equivalente a um envio bem-sucedido pela Edge Function. */
  const sendOk = async (id: string, userId: string, messageId = 're_msg_123') => {
    const b = await begin(id, userId);
    if (!b.ok) throw new Error(`begin falhou: ${JSON.stringify(b)}`);
    return finish(id, true, { messageId });
  };

  /** begin + finish(falha). */
  const sendFail = async (id: string, userId: string, reason = 'provider_rejected') => {
    const b = await begin(id, userId);
    if (!b.ok) throw new Error(`begin falhou: ${JSON.stringify(b)}`);
    return finish(id, false, { reason });
  };

  return { asService, begin, finish, sendOk, sendFail };
}
