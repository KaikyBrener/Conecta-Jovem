import type { Page } from '@playwright/test';
import { expect, modal, test, type TestDb } from './fixtures.ts';

// Paginação server-side das listagens (tamanho de página = 25).
// Cada bloco cobre: primeira página, página seguinte, última página, filtro + paginação e estado vazio.

const nav = (page: Page) => page.getByRole('navigation', { name: 'Paginação' });
const next = (page: Page) => nav(page).getByRole('button', { name: 'Próxima' });
const prev = (page: Page) => nav(page).getByRole('button', { name: 'Anterior' });

/** Linhas da tabela (desktop) */
const tableRows = (page: Page) => page.locator('tbody tr');

async function seedYouth(db: TestDb, opts: { prefix: string; count: number; groupId?: string | null; active?: boolean }) {
  await db.sql(
    `INSERT INTO youth (full_name, group_id, is_active)
     SELECT $1 || ' ' || lpad(i::text, 3, '0'), $2, $3 FROM generate_series(1, $4) i`,
    [opts.prefix, opts.groupId ?? null, opts.active ?? true, opts.count],
  );
}

test.describe('Jovens — paginação', () => {
  test('primeira, seguinte e última página, na ordem alfabética', async ({ page, db, loginAs }) => {
    const coord = await db.createUser('coordinator', 'Carla Coordenadora');
    await seedYouth(db, { prefix: 'Jovem', count: 60 });
    await loginAs(coord);
    await page.goto('/jovens');

    // 1ª página
    await expect(tableRows(page)).toHaveCount(25);
    await expect(tableRows(page).first()).toContainText('Jovem 001');
    await expect(tableRows(page).last()).toContainText('Jovem 025');
    await expect(nav(page)).toContainText('Mostrando 1–25 de 60 jovens');
    await expect(nav(page)).toContainText('Página 1 de 3');
    await expect(prev(page)).toBeDisabled();

    // página seguinte
    await next(page).click();
    await expect(tableRows(page).first()).toContainText('Jovem 026');
    await expect(tableRows(page)).toHaveCount(25);
    await expect(tableRows(page).last()).toContainText('Jovem 050');
    await expect(nav(page)).toContainText('Mostrando 26–50 de 60 jovens');
    await expect(prev(page)).toBeEnabled();

    // última página (parcial)
    await next(page).click();
    await expect(tableRows(page)).toHaveCount(10);
    await expect(tableRows(page).first()).toContainText('Jovem 051');
    await expect(tableRows(page).last()).toContainText('Jovem 060');
    await expect(nav(page)).toContainText('Mostrando 51–60 de 60 jovens');
    await expect(nav(page)).toContainText('Página 3 de 3');
    await expect(next(page)).toBeDisabled();

    // volta
    await prev(page).click();
    await expect(tableRows(page).first()).toContainText('Jovem 026');
  });

  test('lista que cabe em uma página não mostra paginação', async ({ page, db, loginAs }) => {
    await loginAs(await db.createUser('coordinator', 'Carla Coordenadora'));
    await seedYouth(db, { prefix: 'Jovem', count: 25 });
    await page.goto('/jovens');

    await expect(tableRows(page)).toHaveCount(25);
    await expect(nav(page)).toHaveCount(0);
  });

  test('busca no servidor com paginação: o total e as páginas refletem o filtro', async ({ page, db, loginAs }) => {
    await loginAs(await db.createUser('coordinator', 'Carla Coordenadora'));
    await seedYouth(db, { prefix: 'Maria', count: 40 });
    await seedYouth(db, { prefix: 'Pedro', count: 30 });
    await page.goto('/jovens');
    await expect(nav(page)).toContainText('de 70 jovens');

    await page.getByPlaceholder('Buscar por nome...').fill('maria');

    await expect(nav(page)).toContainText('Mostrando 1–25 de 40 jovens');
    await expect(tableRows(page).first()).toContainText('Maria 001');
    await next(page).click();
    await expect(tableRows(page)).toHaveCount(15);
    await expect(tableRows(page).last()).toContainText('Maria 040');
    await expect(page.getByText('Pedro')).toHaveCount(0);
  });

  test('mudar o filtro volta para a página 1 e a ordenação é preservada', async ({ page, db, loginAs }) => {
    await loginAs(await db.createUser('coordinator', 'Carla Coordenadora'));
    await seedYouth(db, { prefix: 'Ativo', count: 60 });
    await seedYouth(db, { prefix: 'Inativo', count: 30, active: false });
    await page.goto('/jovens');
    // cabeçalho continua mostrando os totais globais, não os da página/filtro
    await expect(page.getByText('60 ativos · 30 inativos')).toBeVisible();

    await next(page).click();
    await next(page).click();
    await expect(nav(page)).toContainText('Página 3 de 3');

    await page.getByRole('button', { name: 'Inativos' }).click();

    await expect(nav(page)).toContainText('Página 1 de 2');
    await expect(nav(page)).toContainText('Mostrando 1–25 de 30 jovens');
    await expect(tableRows(page).first()).toContainText('Inativo 001');
    await expect(page.getByText('60 ativos · 30 inativos')).toBeVisible();
  });

  test('filtro por grupo (e "Sem grupo") pagina só os jovens daquele recorte', async ({ page, db, loginAs }) => {
    const coord = await db.createUser('coordinator', 'Carla Coordenadora');
    const alfa = await db.createGroup('Grupo Alfa', coord.id);
    await seedYouth(db, { prefix: 'Alfa', count: 30, groupId: alfa });
    await seedYouth(db, { prefix: 'Solto', count: 28 });
    await loginAs(coord);
    await page.goto('/jovens');

    await page.getByLabel('Filtrar por grupo').selectOption({ label: 'Grupo Alfa' });
    await expect(nav(page)).toContainText('de 30 jovens');
    await expect(tableRows(page).first()).toContainText('Alfa 001');

    await page.getByLabel('Filtrar por grupo').selectOption({ label: 'Sem grupo' });
    await expect(nav(page)).toContainText('de 28 jovens');
    await expect(tableRows(page).first()).toContainText('Solto 001');
  });

  test('estado vazio: busca sem resultado não mostra paginação', async ({ page, db, loginAs }) => {
    await loginAs(await db.createUser('coordinator', 'Carla Coordenadora'));
    await seedYouth(db, { prefix: 'Jovem', count: 60 });
    await page.goto('/jovens');
    await expect(nav(page)).toBeVisible();

    await page.getByPlaceholder('Buscar por nome...').fill('zzz');

    await expect(page.getByText('Nenhum jovem encontrado para "zzz".')).toBeVisible();
    await expect(nav(page)).toHaveCount(0);
    await expect(tableRows(page)).toHaveCount(0);
  });

  test('sem nenhum jovem cadastrado: estado vazio com convite para cadastrar', async ({ page, db, loginAs }) => {
    await loginAs(await db.createUser('coordinator', 'Carla Coordenadora'));
    await page.goto('/jovens');
    await expect(page.getByText('Nenhum jovem cadastrado ainda.')).toBeVisible();
    await expect(nav(page)).toHaveCount(0);
  });

  test('passa do teto de 1000 linhas do PostgREST: total e navegação continuam corretos', async ({ page, db, loginAs }) => {
    await loginAs(await db.createUser('coordinator', 'Carla Coordenadora'));
    await seedYouth(db, { prefix: 'Jovem', count: 1050 });
    await page.goto('/jovens');

    await expect(nav(page)).toContainText('Mostrando 1–25 de 1050 jovens');
    await expect(nav(page)).toContainText('Página 1 de 42');
    await expect(page.getByText('1050 ativos · 0 inativos')).toBeVisible();
    await next(page).click();
    await expect(tableRows(page).first()).toContainText('Jovem 026');
  });

  test('líder: a paginação respeita o RLS (só jovens do seu grupo)', async ({ page, db, loginAs }) => {
    const lia = await db.createUser('leader', 'Lia Lider');
    const davi = await db.createUser('leader', 'Davi Lider');
    const gLia = await db.createGroup('Grupo da Lia', lia.id);
    const gDavi = await db.createGroup('Grupo do Davi', davi.id);
    await seedYouth(db, { prefix: 'DaLia', count: 30, groupId: gLia });
    await seedYouth(db, { prefix: 'DoDavi', count: 40, groupId: gDavi });
    await loginAs(lia);
    await page.goto('/jovens');

    await expect(nav(page)).toContainText('Mostrando 1–25 de 30 jovens');
    await next(page).click();
    await expect(tableRows(page)).toHaveCount(5);
    await expect(page.getByText('DoDavi')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Novo jovem' })).toHaveCount(0);
  });

  test('o formulário de tarefa oferece TODOS os jovens ativos (>1000), não só os primeiros', async ({ page, db, loginAs }) => {
    await loginAs(await db.createUser('coordinator', 'Carla Coordenadora'));
    await seedYouth(db, { prefix: 'Jovem', count: 1050 });
    await page.goto('/tarefas');

    await page.getByRole('button', { name: 'Nova tarefa' }).click();
    const options = modal(page).getByLabel('Jovem').locator('option');
    await expect(options).toHaveCount(1051); // "Nenhum" + 1050
  });
});

test.describe('Encontros — paginação', () => {
  async function seedEvents(db: TestDb, creatorId: string, groupId: string, count: number) {
    // Encontro 01 = o mais recente (ordenação por data decrescente); pares realizados, ímpares agendados
    await db.sql(
      `INSERT INTO events (title, event_date, status, created_by)
       SELECT 'Encontro ' || lpad(i::text, 2, '0'), now() - (i || ' days')::interval,
              (CASE WHEN i % 2 = 0 THEN 'completed' ELSE 'scheduled' END)::event_status, $1
         FROM generate_series(1, $2) i`, [creatorId, count]);
    await db.sql(`INSERT INTO event_groups (event_id, group_id) SELECT id, $1 FROM events`, [groupId]);
  }

  test('primeira, seguinte e última página, mais recentes primeiro, com os grupos de cada encontro', async ({ page, db, loginAs }) => {
    const coord = await db.createUser('coordinator', 'Carla Coordenadora');
    const group = await db.createGroup('Grupo Alfa', coord.id);
    await seedEvents(db, coord.id, group, 60);
    await loginAs(coord);
    await page.goto('/encontros');

    await expect(page.getByText('60 encontros', { exact: true })).toBeVisible(); // subtítulo = total global
    await expect(tableRows(page)).toHaveCount(25);
    await expect(tableRows(page).first()).toContainText('Encontro 01');
    await expect(tableRows(page).last()).toContainText('Encontro 25');
    await expect(nav(page)).toContainText('Mostrando 1–25 de 60 encontros');
    await expect(prev(page)).toBeDisabled();

    await next(page).click();
    await expect(tableRows(page).first()).toContainText('Encontro 26');
    // vínculos buscados só para a página atual, e corretos nela
    await expect(tableRows(page).first()).toContainText('Grupo Alfa');

    await next(page).click();
    await expect(tableRows(page)).toHaveCount(10);
    await expect(tableRows(page).last()).toContainText('Encontro 60');
    await expect(next(page)).toBeDisabled();
  });

  test('filtro por status + busca paginam no servidor', async ({ page, db, loginAs }) => {
    const coord = await db.createUser('coordinator', 'Carla Coordenadora');
    const group = await db.createGroup('Grupo Alfa', coord.id);
    await seedEvents(db, coord.id, group, 60);
    await loginAs(coord);
    await page.goto('/encontros');

    await page.getByRole('button', { name: 'Realizados' }).click();
    await expect(nav(page)).toContainText('Mostrando 1–25 de 30 encontros');
    await expect(tableRows(page).first()).toContainText('Encontro 02');
    await next(page).click();
    await expect(tableRows(page)).toHaveCount(5);
    await expect(tableRows(page).last()).toContainText('Encontro 60');

    // busca dentro do filtro: títulos "Encontro 4x" realizados = 40,42,44,46,48
    await page.getByPlaceholder('Buscar por título...').fill('Encontro 4');
    await expect(tableRows(page)).toHaveCount(5);
    await expect(nav(page)).toHaveCount(0); // cabe em uma página
  });

  test('estado vazio: busca sem resultado', async ({ page, db, loginAs }) => {
    const coord = await db.createUser('coordinator', 'Carla Coordenadora');
    const group = await db.createGroup('Grupo Alfa', coord.id);
    await seedEvents(db, coord.id, group, 60);
    await loginAs(coord);
    await page.goto('/encontros');

    await page.getByPlaceholder('Buscar por título...').fill('zzz');

    await expect(page.getByText('Nenhum encontro encontrado para "zzz".')).toBeVisible();
    await expect(nav(page)).toHaveCount(0);
  });

  test('líder: só os encontros dos seus grupos entram na contagem e nas páginas', async ({ page, db, loginAs }) => {
    const coord = await db.createUser('coordinator', 'Carla Coordenadora');
    const lia = await db.createUser('leader', 'Lia Lider');
    const gLia = await db.createGroup('Grupo da Lia', lia.id);
    const gOutro = await db.createGroup('Grupo Outro', coord.id);
    await db.sql(
      `INSERT INTO events (title, event_date, status, created_by)
       SELECT 'Da Lia ' || lpad(i::text, 2, '0'), now() - (i || ' days')::interval, 'scheduled', $1 FROM generate_series(1, 30) i`, [coord.id]);
    await db.sql(`INSERT INTO event_groups (event_id, group_id) SELECT id, $1 FROM events`, [gLia]);
    await db.sql(
      `INSERT INTO events (title, event_date, status, created_by)
       SELECT 'Alheio ' || i, now() - (i || ' days')::interval, 'scheduled', $1 FROM generate_series(1, 40) i`, [coord.id]);
    await db.sql(`INSERT INTO event_groups (event_id, group_id) SELECT id, $1 FROM events WHERE title LIKE 'Alheio%'`, [gOutro]);
    await loginAs(lia);
    await page.goto('/encontros');

    await expect(page.getByText('30 encontros', { exact: true })).toBeVisible();
    await expect(nav(page)).toContainText('de 30 encontros');
    await expect(page.getByText('Alheio')).toHaveCount(0);
  });

  test('o formulário de encontro lista TODOS os grupos (>1000), não só os primeiros', async ({ page, db, loginAs }) => {
    const coord = await db.createUser('coordinator', 'Carla Coordenadora');
    await db.sql(`INSERT INTO groups (name, leader_id) SELECT 'G ' || lpad(i::text, 4, '0'), $1 FROM generate_series(1, 1020) i`, [coord.id]);
    await loginAs(coord);
    await page.goto('/encontros');

    await page.getByRole('button', { name: 'Novo encontro' }).click();
    await expect(modal(page).getByText('G 1020')).toBeAttached();
  });
});

test.describe('Grupos — paginação', () => {
  test('primeira, seguinte e última página, com a contagem de integrantes vinda do banco', async ({ page, db, loginAs }) => {
    const coord = await db.createUser('coordinator', 'Carla Coordenadora');
    await db.sql(`INSERT INTO groups (name, leader_id) SELECT 'Grupo ' || lpad(i::text, 2, '0'), $1 FROM generate_series(1, 60) i`, [coord.id]);
    const [g1] = await db.sql<{ id: string }>(`SELECT id FROM groups WHERE name = 'Grupo 01'`);
    const [g30] = await db.sql<{ id: string }>(`SELECT id FROM groups WHERE name = 'Grupo 30'`);
    await seedYouth(db, { prefix: 'Integrante', count: 3, groupId: g1.id });
    await seedYouth(db, { prefix: 'Membro', count: 7, groupId: g30.id });
    await loginAs(coord);
    await page.goto('/grupos');

    await expect(page.getByText('60 grupos cadastrados')).toBeVisible();
    await expect(tableRows(page)).toHaveCount(25);
    await expect(tableRows(page).first()).toContainText('Grupo 01');
    await expect(tableRows(page).first().locator('td').nth(2)).toHaveText('3');
    await expect(nav(page)).toContainText('Mostrando 1–25 de 60 grupos');

    await next(page).click();
    await expect(tableRows(page).first()).toContainText('Grupo 26');
    await expect(tableRows(page).filter({ hasText: 'Grupo 30' }).locator('td').nth(2)).toHaveText('7');

    await next(page).click();
    await expect(tableRows(page)).toHaveCount(10);
    await expect(tableRows(page).last()).toContainText('Grupo 60');
    await expect(tableRows(page).last().locator('td').nth(2)).toHaveText('0');
    await expect(next(page)).toBeDisabled();
  });

  test('busca por nome do grupo OU do líder, paginada', async ({ page, db, loginAs }) => {
    const coord = await db.createUser('coordinator', 'Carla Coordenadora');
    const lia = await db.createUser('leader', 'Lia Lider');
    await db.sql(`INSERT INTO groups (name, leader_id) SELECT 'Norte ' || lpad(i::text, 2, '0'), $1 FROM generate_series(1, 30) i`, [lia.id]);
    await db.sql(`INSERT INTO groups (name, leader_id) SELECT 'Sul ' || lpad(i::text, 2, '0'), $1 FROM generate_series(1, 30) i`, [coord.id]);
    await loginAs(coord);
    await page.goto('/grupos');
    await expect(nav(page)).toContainText('de 60 grupos');

    // pelo líder
    await page.getByPlaceholder('Buscar por grupo ou líder...').fill('lia');
    await expect(nav(page)).toContainText('Mostrando 1–25 de 30 grupos');
    await expect(tableRows(page).first()).toContainText('Norte 01');
    await next(page).click();
    await expect(tableRows(page)).toHaveCount(5);

    // pelo nome do grupo
    await page.getByPlaceholder('Buscar por grupo ou líder...').fill('sul 0');
    await expect(tableRows(page)).toHaveCount(9);
    await expect(nav(page)).toHaveCount(0);
  });

  test('estado vazio: busca sem resultado', async ({ page, db, loginAs }) => {
    const coord = await db.createUser('coordinator', 'Carla Coordenadora');
    await db.sql(`INSERT INTO groups (name, leader_id) SELECT 'Grupo ' || i, $1 FROM generate_series(1, 30) i`, [coord.id]);
    await loginAs(coord);
    await page.goto('/grupos');

    await page.getByPlaceholder('Buscar por grupo ou líder...').fill('zzz');

    await expect(page.getByText('Nenhum grupo encontrado para "zzz".')).toBeVisible();
    await expect(nav(page)).toHaveCount(0);
  });

  test('líder: só os próprios grupos, e mais de um podem paginar', async ({ page, db, loginAs }) => {
    const coord = await db.createUser('coordinator', 'Carla Coordenadora');
    const lia = await db.createUser('leader', 'Lia Lider');
    await db.sql(`INSERT INTO groups (name, leader_id) SELECT 'Da Lia ' || lpad(i::text, 2, '0'), $1 FROM generate_series(1, 27) i`, [lia.id]);
    await db.sql(`INSERT INTO groups (name, leader_id) SELECT 'Alheio ' || i, $1 FROM generate_series(1, 30) i`, [coord.id]);
    await loginAs(lia);
    await page.goto('/grupos');

    await expect(nav(page)).toContainText('de 27 grupos');
    await next(page).click();
    await expect(tableRows(page)).toHaveCount(2);
    await expect(page.getByText('Alheio')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Novo grupo' })).toHaveCount(0);
  });
});

test.describe('Tarefas — paginação', () => {
  /** n tarefas abertas (prazo Tarefa 01 = amanhã, crescente) e m encerradas */
  async function seedTasks(db: TestDb, userId: string, open: number, done: number) {
    await db.sql(
      `INSERT INTO tasks (title, status, priority, due_date, created_by, assigned_to, created_at)
       SELECT 'Aberta ' || lpad(i::text, 2, '0'), 'pending', 'medium', current_date + i, $1, $1, now() - (i || ' minutes')::interval
         FROM generate_series(1, $2) i`, [userId, open]);
    await db.sql(
      `INSERT INTO tasks (title, status, priority, created_by, assigned_to, created_at)
       SELECT 'Feita ' || lpad(i::text, 2, '0'), 'done', 'medium', $1, $1, now() - (i || ' minutes')::interval
         FROM generate_series(1, $2) i`, [userId, done]);
  }

  test('abertas: primeira, seguinte e última página, prazo mais próximo primeiro', async ({ page, db, loginAs }) => {
    const coord = await db.createUser('coordinator', 'Carla Coordenadora');
    await seedTasks(db, coord.id, 60, 5);
    await loginAs(coord);
    await page.goto('/tarefas');

    await expect(page.getByText('60 abertas')).toBeVisible(); // cabeçalho = total global de abertas
    await expect(page.locator('main li')).toHaveCount(25);
    await expect(page.locator('main li').first()).toContainText('Aberta 01');
    await expect(page.locator('main li').last()).toContainText('Aberta 25');
    await expect(nav(page)).toContainText('Mostrando 1–25 de 60 tarefas');
    await expect(prev(page)).toBeDisabled();

    await next(page).click();
    await expect(page.locator('main li').first()).toContainText('Aberta 26');

    await next(page).click();
    await expect(page.locator('main li')).toHaveCount(10);
    await expect(page.locator('main li').last()).toContainText('Aberta 60');
    await expect(next(page)).toBeDisabled();
  });

  test('"Todas" continua com abertas primeiro e atravessa a fronteira entre abertas e encerradas', async ({ page, db, loginAs }) => {
    const coord = await db.createUser('coordinator', 'Carla Coordenadora');
    await seedTasks(db, coord.id, 40, 40);
    await loginAs(coord);
    await page.goto('/tarefas');
    await page.getByRole('button', { name: 'Todas' }).click();

    await expect(nav(page)).toContainText('Mostrando 1–25 de 80 tarefas');
    await expect(page.locator('main li').first()).toContainText('Aberta 01');

    // página 2 = 15 abertas (26–40) + 10 encerradas
    await next(page).click();
    const items = page.locator('main li');
    await expect(items).toHaveCount(25);
    await expect(items.nth(0)).toContainText('Aberta 26');
    await expect(items.nth(14)).toContainText('Aberta 40');
    await expect(items.nth(15)).toContainText('Feita 01');
    await expect(items.nth(24)).toContainText('Feita 10');

    // página 3 = só encerradas, sem repetir nem pular nenhuma
    await next(page).click();
    await expect(items.first()).toContainText('Feita 11');
    await expect(items.last()).toContainText('Feita 35');

    await next(page).click();
    await expect(items).toHaveCount(5);
    await expect(items.last()).toContainText('Feita 40');
    await expect(nav(page)).toContainText('Mostrando 76–80 de 80 tarefas');
    await expect(next(page)).toBeDisabled();
  });

  test('encerradas e "só as minhas" paginam no servidor', async ({ page, db, loginAs }) => {
    const coord = await db.createUser('coordinator', 'Carla Coordenadora');
    const lia = await db.createUser('leader', 'Lia Lider');
    await seedTasks(db, coord.id, 10, 30);
    await db.sql(
      `INSERT INTO tasks (title, status, priority, created_by, assigned_to) SELECT 'Da Lia ' || i, 'done', 'medium', $1, $2 FROM generate_series(1, 12) i`,
      [coord.id, lia.id]);
    await loginAs(coord);
    await page.goto('/tarefas');

    await page.getByRole('button', { name: 'Encerradas' }).click();
    await expect(nav(page)).toContainText('de 42 tarefas');

    await page.getByLabel('Só as minhas').check();
    await expect(nav(page)).toContainText('de 30 tarefas'); // as 12 da Lia saem
    await expect(page.getByText('Da Lia')).toHaveCount(0);
    await next(page).click();
    await expect(page.locator('main li')).toHaveCount(5);
  });

  test('busca por título ou nome do jovem, paginada', async ({ page, db, loginAs }) => {
    const coord = await db.createUser('coordinator', 'Carla Coordenadora');
    const ana = await db.createYouth('Ana Souza', null);
    await seedTasks(db, coord.id, 30, 0);
    await db.sql(`UPDATE tasks SET youth_id = $1 WHERE title <= 'Aberta 05'`, [ana]); // 5 tarefas da Ana
    await loginAs(coord);
    await page.goto('/tarefas');
    await expect(nav(page)).toContainText('de 30 tarefas');

    await page.getByPlaceholder('Buscar por título ou jovem...').fill('souza');
    await expect(page.locator('main li')).toHaveCount(5);
    await expect(nav(page)).toHaveCount(0);

    await page.getByPlaceholder('Buscar por título ou jovem...').fill('aberta 2');
    await expect(page.locator('main li')).toHaveCount(10); // Aberta 20..29
  });

  test('estado vazio: busca sem resultado', async ({ page, db, loginAs }) => {
    const coord = await db.createUser('coordinator', 'Carla Coordenadora');
    await seedTasks(db, coord.id, 30, 0);
    await loginAs(coord);
    await page.goto('/tarefas');

    await page.getByPlaceholder('Buscar por título ou jovem...').fill('zzz');

    await expect(page.getByText('Nenhuma tarefa encontrada para "zzz".')).toBeVisible();
    await expect(nav(page)).toHaveCount(0);
  });

  test('concluir a única tarefa da última página leva automaticamente à página anterior', async ({ page, db, loginAs }) => {
    const coord = await db.createUser('coordinator', 'Carla Coordenadora');
    await seedTasks(db, coord.id, 26, 0);
    await loginAs(coord);
    await page.goto('/tarefas');
    await next(page).click();
    await expect(page.locator('main li')).toHaveCount(1);

    await page.locator('main li').getByRole('button', { name: 'Concluir' }).click();

    // 25 abertas restantes cabem em uma página: não sobra uma "página 2" vazia
    await expect(page.locator('main li')).toHaveCount(25);
    await expect(page.locator('main li').first()).toContainText('Aberta 01');
    await expect(nav(page)).toHaveCount(0);
    await expect(page.getByText('25 abertas')).toBeVisible();
  });

  test('cabeçalho mostra abertas e atrasadas globais, independentes da página', async ({ page, db, loginAs }) => {
    const coord = await db.createUser('coordinator', 'Carla Coordenadora');
    await seedTasks(db, coord.id, 40, 0);
    await db.sql(`UPDATE tasks SET due_date = current_date - 3 WHERE title <= 'Aberta 04'`); // 4 atrasadas
    await loginAs(coord);
    await page.goto('/tarefas');

    await expect(page.getByText('40 abertas')).toBeVisible();
    await expect(page.getByText('4 atrasadas')).toBeVisible();
    await expect(page.locator('main li').first().getByTestId('badge-atrasada')).toBeVisible(); // vencidas vêm primeiro
    await next(page).click();
    await expect(page.getByText('4 atrasadas')).toBeVisible();
  });

  test('líder: paginação só sobre as tarefas que o RLS permite', async ({ page, db, loginAs }) => {
    const coord = await db.createUser('coordinator', 'Carla Coordenadora');
    const lia = await db.createUser('leader', 'Lia Lider');
    await seedTasks(db, lia.id, 30, 0);
    await seedTasks(db, coord.id, 50, 0);
    await db.sql(`UPDATE tasks SET title = 'Alheia ' || title WHERE created_by = $1`, [coord.id]);
    await loginAs(lia);
    await page.goto('/tarefas');

    await expect(nav(page)).toContainText('de 30 tarefas');
    await expect(page.getByText('Alheia')).toHaveCount(0);
  });
});

test.describe('Usuários (Configurações) — paginação', () => {
  test('primeira, seguinte e última página; trocar o papel mantém a página', async ({ page, db, loginAs }) => {
    const coord = await db.createUser('coordinator', 'Carla Coordenadora');
    await db.sql(
      `INSERT INTO auth.users (id, email, raw_user_meta_data)
       SELECT gen_random_uuid(), 'u' || i || '@e2e.test', jsonb_build_object('full_name', 'Usuário ' || lpad(i::text, 2, '0'))
         FROM generate_series(1, 30) i`);
    await loginAs(coord);
    await page.goto('/settings');

    // 31 usuários, ordenados por nome: "Carla Coordenadora" vem antes de "Usuário 01"
    await expect(nav(page)).toContainText('Mostrando 1–25 de 31 usuários');
    await expect(page.getByLabel('Papel de Carla Coordenadora')).toHaveValue('coordinator');
    await expect(page.getByLabel('Papel de Usuário 01')).toBeVisible();
    await expect(page.getByLabel('Papel de Usuário 30')).toHaveCount(0);

    await next(page).click();
    await expect(nav(page)).toContainText('Mostrando 26–31 de 31 usuários');
    await expect(page.getByLabel('Papel de Usuário 30')).toBeVisible();
    await expect(next(page)).toBeDisabled();

    // promover alguém da página 2: continua na página 2 e o papel foi gravado
    await page.getByLabel('Papel de Usuário 30').selectOption('coordinator');
    await expect(page.getByLabel('Papel de Usuário 30')).toHaveValue('coordinator');
    await expect(nav(page)).toContainText('Página 2 de 2');
    const roles = await db.sql(`SELECT r.role FROM user_roles r JOIN profiles p ON p.id = r.user_id WHERE p.full_name = 'Usuário 30'`);
    expect(roles).toEqual([{ role: 'coordinator' }]);
    expect(coord.id).toBeTruthy();
  });

  test('poucos usuários: sem paginação', async ({ page, db, loginAs }) => {
    await loginAs(await db.createUser('coordinator', 'Carla Coordenadora'));
    await db.createUser('leader', 'Lia Lider');
    await page.goto('/settings');

    await expect(page.getByLabel('Papel de Lia Lider')).toBeVisible();
    await expect(nav(page)).toHaveCount(0);
  });
});
