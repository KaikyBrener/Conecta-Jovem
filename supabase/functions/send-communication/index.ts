// Edge Function (Deno) — send-communication: envia UMA comunicação por e-mail, por clique do usuário, e registra o
// resultado REAL do provedor. Lógica em handler.ts (testada em Node); este arquivo só liga o ambiente.
//
// DEPLOY:   supabase functions deploy send-communication      (verify_jwt padrão = true: o gateway já exige um JWT válido)
// SECRETS:  supabase secrets set RESEND_API_KEY=... MAIL_FROM="ConectJovem <no-reply@seudominio>" \
//                                ALLOWED_ORIGIN=https://seu-app MAIL_PROVIDER=resend
//   SUPABASE_URL, SUPABASE_ANON_KEY e SUPABASE_SERVICE_ROLE_KEY são injetadas pelo Supabase (NUNCA no frontend/repositório).
//   ALLOWED_ORIGIN: origem EXATA do app (ex.: https://app.exemplo.com). Sem ela nenhuma origem recebe CORS (restrito).
//   Sem RESEND_API_KEY/MAIL_FROM a função NÃO envia: marca a tentativa como failed/provider_not_configured.
//   REPLY_TO_EMAIL (opcional): se válido, é SEMPRE o reply_to (esconde o e-mail pessoal); inválido = não envia.
// Ver docs/EMAIL.md.
import { createClient } from 'npm:@supabase/supabase-js@2.117.2';
import { handleRequest, type BeginErr, type BeginOk, type Db, type FinishResult } from './handler.ts';
import { providerFromEnv } from './provider.ts';

declare const Deno: {
  env: { get(key: string): string | undefined };
  serve(handler: (req: Request) => Response | Promise<Response>): void;
};

const env = (k: string) => Deno.env.get(k);
const SUPABASE_URL = env('SUPABASE_URL') ?? '';
const ANON_KEY = env('SUPABASE_ANON_KEY') ?? '';
const SERVICE_KEY = env('SUPABASE_SERVICE_ROLE_KEY') ?? '';

const noSession = { auth: { persistSession: false, autoRefreshToken: false } };
const admin = createClient(SUPABASE_URL, SERVICE_KEY, noSession);

const db: Db = {
  async getUser(jwt) {
    const { data, error } = await admin.auth.getUser(jwt);
    return error || !data.user ? null : { id: data.user.id };
  },
  async canRead(jwt, id) {
    const userClient = createClient(SUPABASE_URL, ANON_KEY, {
      ...noSession, global: { headers: { Authorization: `Bearer ${jwt}` } },
    });
    const { data, error } = await userClient.from('communications').select('id').eq('id', id).maybeSingle();
    if (error) throw new Error('read_failed');
    return !!data;
  },
  async begin(id, userId) {
    const { data, error } = await admin.rpc('begin_communication_send', { p_id: id, p_user_id: userId });
    if (error) throw new Error('begin_failed');
    return data as BeginOk | BeginErr;
  },
  async finish(a) {
    const { data, error } = await admin.rpc('finish_communication_send', {
      p_id: a.communicationId, p_ok: a.ok, p_provider: a.provider,
      p_provider_message_id: a.providerMessageId, p_failure_reason: a.failureReason,
    });
    if (error) throw new Error('finish_failed');
    return data as FinishResult;
  },
};

Deno.serve((req) =>
  handleRequest(req, {
    db,
    provider: providerFromEnv(env, (url, init) => fetch(url, init)),
    allowedOrigin: env('ALLOWED_ORIGIN')?.trim() || null,
    // Log sem dados pessoais: evento + id curto. Nunca e-mail, assunto, corpo, chaves ou texto do provedor.
    log: (event, shortId) => console.error(`[send-communication] ${shortId} ${event}`),
  }));
