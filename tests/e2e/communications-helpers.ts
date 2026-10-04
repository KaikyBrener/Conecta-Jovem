// Helpers dos specs de comunicação por e-mail assistido (Fase 7, bloco 10). Dados 100% fictícios.
// O envio é ASSISTIDO: o app só faz `location.assign('mailto:...')`. Nos testes essa navegação é interceptada
// (Navigation API) para NUNCA abrir um cliente de e-mail real, e o href é registrado para conferência.
import type { Page } from '@playwright/test';
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

/**
 * Intercepta navegações para `mailto:` ANTES de o app carregar: registra o href em `window.__mailtos` e cancela a
 * navegação (nenhum aplicativo de e-mail é aberto). Cobre `location.assign` e cliques em `<a href="mailto:...">`.
 * Devolve uma função que lê os hrefs registrados na página atual.
 */
export async function captureMailto(page: Page): Promise<() => Promise<string[]>> {
  await page.addInitScript(() => {
    const w = window as unknown as { __mailtos: string[] };
    w.__mailtos = [];
    const nav = (window as unknown as { navigation?: EventTarget }).navigation;
    nav?.addEventListener('navigate', (e: any) => {
      const url: string = e.destination?.url ?? '';
      if (url.startsWith('mailto:')) {
        w.__mailtos.push(url);
        if (e.cancelable) e.preventDefault();
      }
    });
    document.addEventListener('click', (ev) => {
      const a = (ev.target as Element | null)?.closest?.('a[href^="mailto:"]') as HTMLAnchorElement | null;
      if (a) {
        w.__mailtos.push(a.getAttribute('href') ?? '');
        ev.preventDefault();
      }
    }, true);
  });
  return () => page.evaluate(() => (window as unknown as { __mailtos: string[] }).__mailtos.slice());
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

/** Na revisão: abre o e-mail (grava rascunho + navega para o mailto interceptado) e espera a confirmação. */
export async function openMail(page: Page) {
  const m = modalCom(page);
  await m.getByTestId('comunicacao-abrir-email').click();
  await expect(m).toHaveAttribute('data-etapa', 'confirm');
  await expect(m.getByTestId('comunicacao-confirmacao')).toBeVisible();
}

export const MSG: Message = {
  subject: 'Olá & até já: 100% ok?',
  body: 'Linha 1 com acentos çã\nLinha 2\n\nLinha 4 & mais = ? #x',
};

export type CommRow = {
  id: string; status: string; subject: string; body: string; recipient_email: string; recipient_name: string | null;
  recipient_kind: string; failure_reason: string | null; sent_at: string | null; sent_by: string | null;
  created_by: string | null; youth_id: string | null; alert_id: string | null; follow_up_id: string | null;
};

export const commRows = (db: TestDb) =>
  db.sql<CommRow>(`SELECT id, status::text AS status, subject, body, recipient_email, recipient_name, recipient_kind,
    failure_reason, sent_at::text AS sent_at, sent_by, created_by, youth_id, alert_id, follow_up_id
    FROM communications ORDER BY created_at, id`);

/** Insere uma comunicação direto no banco (como superusuário), já no status pedido. */
export async function seedComm(
  db: TestDb,
  o: { youthId: string | null; createdBy: TestUser; status?: 'draft' | 'sent' | 'failed' | 'cancelled'; subject?: string;
    body?: string; email?: string; alertId?: string | null; followUpId?: string | null; kind?: string },
): Promise<string> {
  const status = o.status ?? 'draft';
  const [row] = await db.sql<{ id: string }>(
    `INSERT INTO communications (youth_id, alert_id, follow_up_id, recipient_email, recipient_kind, subject, body, status,
                                 failure_reason, sent_at, sent_by, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::text::communication_status,
             CASE WHEN $8::text = 'failed' THEN 'other' END,
             CASE WHEN $8::text = 'sent' THEN now() END,
             CASE WHEN $8::text = 'sent' THEN $9::uuid END, $9::uuid)
     RETURNING id`,
    [o.youthId, o.alertId ?? null, o.followUpId ?? null, o.email ?? ANA_EMAIL, o.kind ?? 'youth',
      o.subject ?? 'Assunto de teste', o.body ?? 'Corpo de teste', status, o.createdBy.id]);
  return row.id;
}
