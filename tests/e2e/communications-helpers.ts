// Helpers dos specs de comunicação por e-mail (migration 018: ENVIO REAL pelo servidor). Dados 100% fictícios.
// O navegador chama a Edge Function send-communication (handler real no servidor falso); quem "envia" é um PROVEDOR
// FALSO controlado por /__test/mail-config e inspecionado por /__test/mail-calls. Nenhum e-mail real sai.
import { createHash } from 'node:crypto';
import type { Page } from '@playwright/test';
import { ANON_KEY, AUTH_STORAGE_KEY, CONTROL_TOKEN, SUPABASE_URL } from './env.ts';
import { daysFromNow, expect, type TestDb, type TestUser } from './fixtures.ts';
import { seedPeople, type People } from './phase7-helpers.ts';

export const ANA_EMAIL = 'ana.souza@exemplo.com';

export interface World extends People {
  ana: string;
  zeca: string;
  alertId: string;
}

/**
 * Carla/Caio (coordenadores), Lia (líder do Grupo Alfa, onde está a Ana, com e-mail), Davi (líder do Grupo Beta,
 * onde está o Zeca). A Ana tem 3 faltas seguidas -> o banco abre o alerta de faltas.
 */
export async function seedWorld(db: TestDb): Promise<World> {
  const p = await seedPeople(db);
  const ana = await db.createYouth('Ana Souza', p.alfa);
  const zeca = await db.createYouth('Zeca Alheio', p.beta);
  await db.sql(`UPDATE youth SET email = $2 WHERE id = $1`, [ana, ANA_EMAIL]);
  const bia = await db.createYouth('Bia Lima', p.alfa);
  for (let i = 0; i < 3; i++) {
    const ev = await db.createEvent(`Culto ${i + 1}`, daysFromNow(-21 + i * 7), [p.alfa], 'completed');
    await db.recordAttendance(ev, ana, p.alfa, false, p.carla.id);
    await db.recordAttendance(ev, bia, p.alfa, true, p.carla.id);
  }
  const [alert] = await db.sql<{ id: string }>(`SELECT id FROM alerts WHERE youth_id = $1 AND type = 'consecutive_absences'`, [ana]);
  return { ...p, ana, zeca, alertId: alert.id };
}

/** Tudo que o app escreve no console e nos avisos (toasts) — para provar que não vaza e-mail/assunto/corpo. */
export function collectLeaks(page: Page) {
  const console: string[] = [];
  page.on('console', (m) => console.push(`${m.type()}: ${m.text()}`));
  page.on('pageerror', (e) => console.push(`pageerror: ${e.message}`));
  return {
    console,
    /** Textos dos toasts (status/alert fora do modal) lidos agora */
    toasts: () => page.locator('[role="status"], [role="alert"]').allInnerTexts(),
  };
}

export const modalCom = (page: Page) => page.getByTestId('comunicacao-modal');
export const comItems = (page: Page) => page.getByTestId('secao-comunicacoes').getByTestId('comunicacao-item');

export interface Message {
  subject: string;
  body: string;
}

/** Passo 1 -> 2: aceita o destinatário já preenchido (ou o informado) e vai para a mensagem. */
export async function goToMessage(page: Page, o: { email?: string; name?: string; kind?: string } = {}) {
  const m = modalCom(page);
  await expect(m).toHaveAttribute('data-etapa', 'recipient');
  if (o.kind) await m.getByTestId('comunicacao-tipo').selectOption(o.kind);
  if (o.name !== undefined) await m.getByTestId('comunicacao-nome').fill(o.name);
  if (o.email !== undefined) await m.getByTestId('comunicacao-email').fill(o.email);
  await m.getByTestId('comunicacao-proximo').click();
  await expect(m).toHaveAttribute('data-etapa', 'message');
}

/** Passo 2 -> 3: preenche assunto/corpo (se informados) e vai para a revisão. */
export async function goToReview(page: Page, msg?: Message) {
  const m = modalCom(page);
  if (msg) {
    await m.getByTestId('comunicacao-assunto').fill(msg.subject);
    await m.getByTestId('comunicacao-corpo').fill(msg.body);
  }
  await m.getByTestId('comunicacao-proximo').click();
  await expect(m).toHaveAttribute('data-etapa', 'review');
}

/** Do começo (destinatário) até a etapa de revisão. */
export async function composeToReview(page: Page, msg?: Message, to: { email?: string; name?: string; kind?: string } = {}) {
  await goToMessage(page, to);
  await goToReview(page, msg);
}

/** Na revisão: um clique em "Enviar e-mail" e espera o resultado (enviado ou falhou) aparecer. */
export async function sendMail(page: Page) {
  const m = modalCom(page);
  await m.getByTestId('comunicacao-enviar').click();
  await expect(m).toHaveAttribute('data-etapa', 'resultado');
}

export const MSG: Message = {
  subject: 'Olá & até já: 100% ok?',
  body: 'Linha 1 com acentos çã\nLinha 2\n\nLinha 4 & mais = ? #x <b>não é html</b>',
};

// ---------------------------------------------------------------------------
// Provedor de e-mail FALSO (controle no servidor falso)
// ---------------------------------------------------------------------------
export type MailMode = 'success' | 'http4xx' | 'http5xx' | 'network' | 'timeout' | 'unconfigured';

async function control<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${SUPABASE_URL}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-e2e-token': CONTROL_TOKEN }, body: JSON.stringify(body ?? {}),
  });
  if (!res.ok) throw new Error(`${path} falhou (${res.status}): ${await res.text()}`);
  return (await res.json()) as T;
}

/** Comportamento do provedor falso a partir de agora (o reset de cada teste volta para 'success'). */
export const setMail = (mode: MailMode, delayMs = 0) => control('/__test/mail-config', { mode, delayMs });

export interface MailCall {
  url: string;
  headers: Record<string, string>;
  payload: { from: string; to: string[]; subject: string; text: string; reply_to?: string; html?: unknown };
}
/** Tudo que chegou ao provedor falso (uma entrada por tentativa de envio). */
export const mailCalls = () => control<MailCall[]>('/__test/mail-calls');

/** Texto cru que o provedor falso devolve nos erros: NUNCA pode aparecer na tela, no console nem nas respostas. */
export const PROVIDER_RAW_TEXT = 'RAW-PROVIDER-ERROR-TEXT-do-not-leak';
export const FAKE_PROVIDER_KEY = 'fake-provider-key-e2e';

/** Idempotency-Key esperada (calculada de forma independente): `<id>:<sha256(JSON [to, subject, body]) 16 hex>`. */
export const idemKey = (id: string, to: string, subject: string, body: string) =>
  `${id}:${createHash('sha256').update(JSON.stringify([to, subject, body])).digest('hex').slice(0, 16)}`;

export interface SendCall { status: number; body: any; text: string; retryAfter: string | null }

/**
 * Chama a Edge Function direto do navegador (adulteração/concorrência). `token`: padrão = sessão do app;
 * `null` = sem Authorization; string = esse JWT. `raw` substitui o corpo; `extra` acrescenta campos ao corpo.
 */
export async function callSend(
  page: Page, communicationId: string | null,
  o: { token?: string | null; method?: string; raw?: string; extra?: Record<string, unknown> } = {},
): Promise<SendCall> {
  return page.evaluate(
    async ([key, base, anon, id, tokenOpt, hasToken, method, raw, extra]) => {
      const session = JSON.parse(localStorage.getItem(key as string)!);
      const token = hasToken ? (tokenOpt as string | null) : session.access_token;
      const headers: Record<string, string> = { 'content-type': 'application/json', apikey: anon as string };
      if (token) headers.authorization = `Bearer ${token}`;
      const body = raw !== null ? (raw as string) : JSON.stringify({ communication_id: id, ...(extra as object) });
      const res = await fetch(`${base}/functions/v1/send-communication`, {
        method: method as string, headers, body: method === 'GET' ? undefined : body,
      });
      const text = await res.text();
      let json: unknown = null;
      try { json = text ? JSON.parse(text) : null; } catch { json = text; }
      return { status: res.status, body: json, text, retryAfter: res.headers.get('retry-after') };
    },
    [AUTH_STORAGE_KEY, SUPABASE_URL, ANON_KEY, communicationId, o.token ?? null, o.token !== undefined, o.method ?? 'POST',
      o.raw ?? null, o.extra ?? {}] as const,
  );
}

// ---------------------------------------------------------------------------
// Banco
// ---------------------------------------------------------------------------
export type CommRow = {
  id: string; status: string; subject: string; body: string; recipient_email: string; recipient_name: string | null;
  recipient_kind: string; failure_reason: string | null; sent_at: string | null; sent_by: string | null;
  created_by: string | null; youth_id: string | null; alert_id: string | null; follow_up_id: string | null;
  provider: string | null; provider_message_id: string | null; attempts: number; last_attempt_at: string | null;
};

export const commRows = (db: TestDb) =>
  db.sql<CommRow>(`SELECT id, status::text AS status, subject, body, recipient_email, recipient_name, recipient_kind,
    failure_reason, sent_at::text AS sent_at, sent_by, created_by, youth_id, alert_id, follow_up_id,
    provider, provider_message_id, attempts, last_attempt_at::text AS last_attempt_at
    FROM communications ORDER BY created_at, id`);

/**
 * Insere uma comunicação direto no banco (como superusuário), já no status pedido. `sending`: `minutesAgo` define
 * quando a tentativa começou (> 5 min = envio preso, retomável); `sent_by` = quem iniciou.
 */
export async function seedComm(
  db: TestDb,
  o: { youthId: string | null; createdBy: TestUser; status?: 'draft' | 'sending' | 'sent' | 'failed' | 'cancelled'; subject?: string;
    body?: string; email?: string; alertId?: string | null; followUpId?: string | null; kind?: string;
    failureReason?: string; minutesAgo?: number },
): Promise<string> {
  const status = o.status ?? 'draft';
  const [row] = await db.sql<{ id: string }>(
    `INSERT INTO communications (youth_id, alert_id, follow_up_id, recipient_email, recipient_kind, subject, body, status,
                                 failure_reason, sent_at, sent_by, created_by, attempts, last_attempt_at, provider)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::text::communication_status,
             CASE WHEN $8::text = 'failed' THEN $10::text END,
             CASE WHEN $8::text = 'sent' THEN now() END,
             CASE WHEN $8::text IN ('sent', 'sending') THEN $9::uuid END, $9::uuid,
             CASE WHEN $8::text IN ('sent', 'sending', 'failed') THEN 1 ELSE 0 END,
             CASE WHEN $8::text IN ('sent', 'sending', 'failed') THEN now() - make_interval(mins => $11::int) END,
             CASE WHEN $8::text IN ('sent', 'failed') THEN 'resend' END)
     RETURNING id`,
    [o.youthId, o.alertId ?? null, o.followUpId ?? null, o.email ?? ANA_EMAIL, o.kind ?? 'youth',
      o.subject ?? 'Assunto de teste', o.body ?? 'Corpo de teste', status, o.createdBy.id,
      o.failureReason ?? 'provider_rejected', o.minutesAgo ?? 0]);
  return row.id;
}
