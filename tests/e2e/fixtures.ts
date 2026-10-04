// Fixtures dos testes E2E: banco falso limpo a cada teste, usuários de teste,
// login por sessão injetada (rápido) e helpers de seed (dados 100% fictícios).
import { test as base, expect, type Page } from '@playwright/test';
import { ANON_KEY, AUTH_STORAGE_KEY, CONTROL_TOKEN, SUPABASE_URL } from './env.ts';

export type Role = 'coordinator' | 'leader';

export interface TestUser {
  id: string;
  email: string;
  password: string;
  fullName: string;
  role: Role;
}

async function control<T = unknown>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${SUPABASE_URL}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-e2e-token': CONTROL_TOKEN },
    body: JSON.stringify(body ?? {}),
  });
  if (!res.ok) throw new Error(`${path} falhou (${res.status}): ${await res.text()}`);
  return (await res.json()) as T;
}

export class TestDb {
  /** Executa SQL como superusuário (ignora RLS) — só para preparar/inspecionar dados. */
  async sql<T = Record<string, any>>(sql: string, params: unknown[] = []): Promise<T[]> {
    return control<T[]>('/__test/sql', { sql, params });
  }

  async reset() {
    await control('/__test/reset');
  }

  async createUser(role: Role, fullName: string): Promise<TestUser> {
    const slug = fullName.toLowerCase().normalize('NFD').replace(/[^a-z]+/g, '.');
    const email = `${slug}@e2e.test`;
    const password = 'Senha-E2E-123';
    const { id } = await control<{ id: string }>('/__test/users', { email, password, fullName, role });
    return { id, email, password, fullName, role };
  }

  /** Fragmento de URL de um e-mail de recuperação/convite ("#access_token=…&type=recovery"). */
  async authLink(email: string, type: 'recovery' | 'invite' = 'recovery'): Promise<string> {
    const { hash } = await control<{ hash: string }>('/__test/auth-link', { email, type });
    return hash;
  }

  /** Pedidos de "esqueci minha senha" recebidos pelo GoTrue falso. */
  async recoverRequests(): Promise<{ email: string; redirectTo: string | null }[]> {
    return control('/__test/recover-requests');
  }

  async createGroup(name: string, leaderId: string): Promise<string> {
    const [row] = await this.sql<{ id: string }>(
      `INSERT INTO groups (name, leader_id) VALUES ($1, $2) RETURNING id`, [name, leaderId]);
    return row.id;
  }

  async createYouth(fullName: string, groupId: string | null): Promise<string> {
    const [row] = await this.sql<{ id: string }>(
      `INSERT INTO youth (full_name, group_id) VALUES ($1, $2) RETURNING id`, [fullName, groupId]);
    return row.id;
  }

  async createEvent(title: string, date: Date, groupIds: string[], status = 'scheduled'): Promise<string> {
    const [row] = await this.sql<{ id: string }>(
      `INSERT INTO events (title, event_date, status) VALUES ($1, $2, $3) RETURNING id`,
      [title, date.toISOString(), status]);
    for (const g of groupIds) {
      await this.sql(`INSERT INTO event_groups (event_id, group_id) VALUES ($1, $2)`, [row.id, g]);
    }
    return row.id;
  }

  /** Tarefa/ação direto no banco (dispara os triggers de alerta por tempo, como no app). */
  async createTask(
    title: string,
    o: { createdBy: string; assignedTo?: string | null; youthId?: string | null; groupId?: string | null;
      alertId?: string | null; dueDate?: string | null; status?: string },
  ): Promise<string> {
    const [row] = await this.sql<{ id: string }>(
      `INSERT INTO tasks (title, created_by, assigned_to, youth_id, group_id, alert_id, due_date, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [title, o.createdBy, o.assignedTo ?? null, o.youthId ?? null, o.groupId ?? null, o.alertId ?? null,
        o.dueDate ?? null, o.status ?? 'pending']);
    return row.id;
  }

  /** Acompanhamento direto no banco (como superusuário: created_by/responsible_id são os informados). */
  async createFollowUp(
    youthId: string,
    reason: string,
    o: { responsibleId: string; createdBy?: string; occurredAt?: string; type?: string; alertId?: string | null },
  ): Promise<string> {
    const [row] = await this.sql<{ id: string }>(
      `INSERT INTO follow_ups (youth_id, reason, responsible_id, created_by, occurred_at, type, alert_id)
       VALUES ($1, $2, $3, $4, COALESCE($5::date, public.app_today()), COALESCE($6, 'conversation')::follow_up_type, $7)
       RETURNING id`,
      [youthId, reason, o.responsibleId, o.createdBy ?? o.responsibleId, o.occurredAt ?? null, o.type ?? null, o.alertId ?? null]);
    return row.id;
  }

  /** "Envelhece" os alertas de um tipo (created_at para trás): alertas por tempo dependem do relógio. */
  async ageAlerts(type: string, days: number) {
    await this.sql(`UPDATE alerts SET created_at = now() - make_interval(days => $2) WHERE type = $1::alert_type`, [type, days]);
  }

  /**
   * Zera o throttle de 60 s de sync_time_alerts() no banco (migration 016, tabela time_alerts_sync_state).
   * Sem isso, reabrir /alertas em < 60 s depois de "envelhecer" um alerta NÃO dispara nova varredura.
   */
  async resetSyncThrottle() {
    await this.sql(`UPDATE public.time_alerts_sync_state SET last_run = '-infinity'`);
  }

  /** Instante da última varredura de alertas por tempo (null = nunca / zerado). */
  async lastSyncRun(): Promise<string | null> {
    const [row] = await this.sql<{ last_run: string }>(
      `SELECT CASE WHEN last_run = '-infinity' THEN NULL ELSE last_run::text END AS last_run FROM public.time_alerts_sync_state`);
    return row.last_run;
  }

  /** Registra presença direto no banco (dispara os triggers de alerta, como no app). */
  async recordAttendance(eventId: string, youthId: string, groupId: string, present: boolean, by: string) {
    await this.sql(
      `INSERT INTO attendance (event_id, youth_id, group_id, present, recorded_by) VALUES ($1, $2, $3, $4, $5)`,
      [eventId, youthId, groupId, present, by]);
  }
}

/** Obtém uma sessão real (token JWT) do GoTrue falso para o usuário. */
export async function passwordSession(user: TestUser) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', apikey: ANON_KEY },
    body: JSON.stringify({ email: user.email, password: user.password }),
  });
  if (!res.ok) throw new Error(`login de teste falhou: ${await res.text()}`);
  return res.json();
}

interface Fixtures {
  db: TestDb;
  /** Deixa o navegador autenticado como `user` (sessão injetada no localStorage). */
  loginAs: (user: TestUser) => Promise<void>;
}

export const test = base.extend<Fixtures>({
  // auto: todo teste começa com o banco limpo
  db: [
    // oxlint-disable-next-line no-empty-pattern -- o Playwright exige a desestruturação do 1º argumento
    async ({}, provide) => {
      const db = new TestDb();
      await db.reset();
      await provide(db);
    },
    { auto: true },
  ],
  loginAs: async ({ page }, provide) => {
    await provide(async (user) => injectSession(page, await passwordSession(user)));
  },
});

/** Grava uma sessão no localStorage antes de o app carregar (equivale a já estar logado). */
export async function injectSession(page: Page, session: unknown) {
  // O flag em sessionStorage evita "re-logar" após signOut/reload na mesma aba.
  await page.addInitScript(
    ([key, value]) => {
      if (!sessionStorage.getItem('__e2e_seeded')) {
        localStorage.setItem(key, value);
        sessionStorage.setItem('__e2e_seeded', '1');
      }
    },
    [AUTH_STORAGE_KEY, JSON.stringify(session)] as const,
  );
}

export { expect };

/** Data (YYYY-MM-DD) no fuso do produto (America/Sao_Paulo), `offsetDays` a partir de hoje. */
export function spDay(offsetDays = 0): string {
  const d = new Date(Date.now() + offsetDays * 86_400_000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

/** "2026-09-12" -> "12/09/2026" (como a UI formata datas puras). */
export function brDate(isoDay: string): string {
  const [y, m, d] = isoDay.split('-');
  return `${d}/${m}/${y}`;
}

/**
 * Chamada direta à API REST do Supabase falso com a sessão do navegador (adulteração de requisição).
 * A página precisa já estar no app (origem). Devolve status e corpo JSON (ou null).
 */
export async function api(
  page: Page,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  return page.evaluate(
    async ([key, url, anon, m, p, b]) => {
      const session = JSON.parse(localStorage.getItem(key as string)!);
      const res = await fetch(`${url}/rest/v1/${p}`, {
        method: m as string,
        headers: {
          'content-type': 'application/json', apikey: anon as string,
          authorization: `Bearer ${session.access_token}`, prefer: 'return=representation',
        },
        body: b === null ? undefined : (b as string),
      });
      const text = await res.text();
      let json: unknown = null;
      try { json = text ? JSON.parse(text) : null; } catch { json = text; }
      return { status: res.status, body: json };
    },
    [AUTH_STORAGE_KEY, SUPABASE_URL, ANON_KEY, method, path, body === undefined ? null : JSON.stringify(body)] as const,
  );
}

/** Abre a ficha ("Detalhes do Jovem") de um jovem a partir de /jovens (lista ou cards). */
export async function openYouthSheet(page: Page, name: string, filter: 'Ativos' | 'Todos' | 'Inativos' = 'Ativos') {
  await page.goto('/jovens');
  if (filter !== 'Ativos') await page.getByRole('button', { name: filter, exact: true }).click();
  await page.getByRole('button', { name: new RegExp(name) }).first().click();
  const sheet = page.locator('div.fixed.inset-0').first(); // a ficha é o 1º overlay; modais aninhados vêm depois (use modal(page))
  await expect(sheet.getByRole('heading', { name: 'Detalhes do Jovem' })).toBeVisible();
  await expect(sheet.getByRole('heading', { name })).toBeVisible();
  return sheet;
}

// ---------------------------------------------------------------------------
// Helpers de UI
// ---------------------------------------------------------------------------

export async function loginViaForm(page: Page, email: string, password: string) {
  await page.goto('/login');
  await page.getByLabel('E-mail').fill(email);
  await page.getByLabel('Senha', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Entrar' }).click();
}

/** Modal aberto (o componente Modal não expõe role=dialog). */
export const modal = (page: Page) => page.locator('div.fixed.inset-0').last();

/** Data futura/passada relativa a agora, em horário local de São Paulo, sem segundos. */
export function daysFromNow(days: number, hour = 19): Date {
  const d = new Date();
  d.setDate(d.getDate() + days);
  d.setHours(hour, 0, 0, 0);
  return d;
}

/** Formato aceito por <input type="datetime-local">. */
export function toDatetimeLocal(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ---------------------------------------------------------------------------
// Helpers da Chamada (3 estados: não registrado / presente / ausente)
// ---------------------------------------------------------------------------

export type ChamadaState = 'unregistered' | 'present' | 'absent';

/** Linha de um jovem na lista da chamada (data-testid="chamada-jovem"). */
export const chamadaRow = (page: Page, name: string) =>
  page.getByTestId('chamada-jovem').filter({ hasText: name });

export const markPresent = (page: Page, name: string) => page.getByRole('button', { name: `Presente: ${name}` }).click();
export const markAbsent = (page: Page, name: string) => page.getByRole('button', { name: `Ausente: ${name}` }).click();

/** Confere os contadores do topo da chamada. */
export async function expectCounters(
  page: Page,
  c: { total: number; presentes: number; ausentes: number; naoRegistrados: number; percentual?: string },
) {
  await expect(page.getByTestId('contador-total')).toHaveText(String(c.total));
  await expect(page.getByTestId('contador-presentes')).toHaveText(String(c.presentes));
  await expect(page.getByTestId('contador-ausentes')).toHaveText(String(c.ausentes));
  await expect(page.getByTestId('contador-nao-registrados')).toHaveText(String(c.naoRegistrados));
  if (c.percentual !== undefined) await expect(page.getByTestId('contador-percentual')).toHaveText(c.percentual);
}
