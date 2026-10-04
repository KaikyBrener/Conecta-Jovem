// Helpers compartilhados pelos specs da Fase 7 (blocos 6-9): painel, indicadores, relatórios, séries,
// busca global, ações em lote e histórico. Dados 100% fictícios, criados no banco falso.
import type { Browser, Page } from '@playwright/test';
import { APP_URL } from './env.ts';
import { daysFromNow, injectSession, passwordSession, spDay, type TestDb, type TestUser } from './fixtures.ts';

export const hasHorizontalScroll = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);

export interface People {
  carla: TestUser;
  caio: TestUser;
  lia: TestUser;
  davi: TestUser;
  alfa: string;
  beta: string;
}

/** Carla/Caio (coordenadores), Lia (líder do Grupo Alfa) e Davi (líder do Grupo Beta). */
export async function seedPeople(db: TestDb): Promise<People> {
  const carla = await db.createUser('coordinator', 'Carla Coordenadora');
  const caio = await db.createUser('coordinator', 'Caio Coordenador');
  const lia = await db.createUser('leader', 'Lia Lider');
  const davi = await db.createUser('leader', 'Davi Lider');
  const alfa = await db.createGroup('Grupo Alfa', lia.id);
  const beta = await db.createGroup('Grupo Beta', davi.id);
  return { carla, caio, lia, davi, alfa, beta };
}

/** Encontro realizado `daysAgo` dias atrás (19h) para os grupos informados. */
export function pastEvent(db: TestDb, title: string, daysAgo: number, groupIds: string[], status = 'completed') {
  return db.createEvent(title, daysFromNow(-daysAgo), groupIds, status);
}

/** Acompanhamento direto no banco com próxima ação/prazo (relativos a hoje no fuso do produto). */
export async function addFollowUp(
  db: TestDb,
  youthId: string,
  reason: string,
  o: { responsibleId: string; occurredDaysAgo?: number; nextAction?: string; dueInDays?: number },
): Promise<string> {
  const [row] = await db.sql<{ id: string }>(
    `INSERT INTO follow_ups (youth_id, reason, responsible_id, created_by, occurred_at, next_action, next_action_due)
     VALUES ($1, $2, $3, $3, $4::date, $5, $6::date) RETURNING id`,
    [youthId, reason, o.responsibleId, spDay(-(o.occurredDaysAgo ?? 0)), o.nextAction ?? null,
      o.dueInDays === undefined ? null : spDay(o.dueInDays)]);
  return row.id;
}

/** Ação atrasada: prazo ontem, ainda pendente, ligada ao jovem. */
export function overdueTask(db: TestDb, title: string, youthId: string, by: TestUser, groupId: string | null = null) {
  return db.createTask(title, { createdBy: by.id, assignedTo: by.id, youthId, groupId, dueDate: spDay(-1) });
}

/** Cria N jovens ativos (nomes "Prefixo 001"...) de uma vez, direto no banco. */
export async function bulkYouth(db: TestDb, prefix: string, count: number, groupId: string | null): Promise<string[]> {
  const rows = await db.sql<{ id: string }>(
    `INSERT INTO youth (full_name, group_id)
     SELECT $1 || ' ' || lpad(g::text, 3, '0'), $3::uuid FROM generate_series(1, $2::int) g RETURNING id`,
    [prefix, count, groupId]);
  return rows.map((r) => r.id);
}

/** Página de OUTRO usuário (contexto separado do navegador, com sessão própria). */
export async function pageAs(browser: Browser, user: TestUser) {
  const ctx = await browser.newContext({ baseURL: APP_URL, locale: 'pt-BR', timezoneId: 'America/Sao_Paulo' });
  const page = await ctx.newPage();
  await injectSession(page, await passwordSession(user));
  return { page, close: () => ctx.close() };
}
