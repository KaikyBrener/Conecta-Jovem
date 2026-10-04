import { expect, modal, test } from './fixtures.ts';

test.describe('Grupos — coordenador', () => {
  test('estado vazio oferece criar o primeiro grupo', async ({ page, db, loginAs }) => {
    await loginAs(await db.createUser('coordinator', 'Carla Coordenadora'));
    await page.goto('/grupos');

    await expect(page.getByText('Nenhum grupo cadastrado ainda.')).toBeVisible();
    await expect(page.getByText('0 grupos cadastrados')).toBeVisible();
    await page.getByRole('button', { name: 'Criar o primeiro grupo' }).click();
    await expect(page.getByRole('heading', { name: 'Novo Grupo' })).toBeVisible();
  });

  test('valida campos obrigatórios e cria um grupo', async ({ page, db, loginAs }) => {
    const coord = await db.createUser('coordinator', 'Carla Coordenadora');
    await db.createUser('leader', 'Lia Lider');
    await loginAs(coord);
    await page.goto('/grupos');

    await page.getByRole('button', { name: 'Novo grupo' }).click();
    const form = modal(page);
    await expect(form.getByRole('heading', { name: 'Novo Grupo' })).toBeVisible();

    // 1) sem nome
    await form.getByRole('button', { name: 'Criar grupo' }).click();
    await expect(form.getByText('Nome é obrigatório.')).toBeVisible();

    // 2) com nome, sem líder
    await form.getByPlaceholder('Ex.: Grupo Esperança').fill('Grupo Esperança');
    await form.getByRole('button', { name: 'Criar grupo' }).click();
    await expect(form.getByText('Líder responsável é obrigatório.')).toBeVisible();

    // 3) completo
    await form.locator('select').selectOption({ label: 'Lia Lider' });
    await form.getByPlaceholder('Informações adicionais sobre o grupo...').fill('Jovens do bairro norte');
    await form.getByRole('button', { name: 'Criar grupo' }).click();

    await expect(page.getByRole('heading', { name: 'Novo Grupo' })).toBeHidden();
    const row = page.locator('tbody tr', { hasText: 'Grupo Esperança' });
    await expect(row).toContainText('Lia Lider');
    await expect(page.getByText('1 grupo cadastrado')).toBeVisible();

    const rows = await db.sql(`SELECT name, description FROM groups`);
    expect(rows).toEqual([{ name: 'Grupo Esperança', description: 'Jovens do bairro norte' }]);
  });

  test('líderes disponíveis no formulário vêm do banco (sem dados fixos)', async ({ page, db, loginAs }) => {
    const coord = await db.createUser('coordinator', 'Carla Coordenadora');
    await db.createUser('leader', 'Lia Lider');
    await db.createUser('leader', 'Davi Lider');
    await loginAs(coord);
    await page.goto('/grupos');

    await page.getByRole('button', { name: 'Novo grupo' }).click();
    const options = await modal(page).locator('select option').allTextContents();
    expect(options[0]).toBe('Selecionar líder');
    // coordenadora não é "líder": só aparecem usuários com papel leader
    expect(options.slice(1).sort()).toEqual(['Davi Lider', 'Lia Lider']);
  });

  test('edita nome e líder de um grupo existente', async ({ page, db, loginAs }) => {
    const coord = await db.createUser('coordinator', 'Carla Coordenadora');
    const lia = await db.createUser('leader', 'Lia Lider');
    await db.createUser('leader', 'Davi Lider');
    await db.createGroup('Grupo Alfa', lia.id);
    await loginAs(coord);
    await page.goto('/grupos');

    await page.locator('tbody tr', { hasText: 'Grupo Alfa' }).getByTitle('Editar grupo').click();
    const form = modal(page);
    await expect(form.getByRole('heading', { name: 'Editar Grupo' })).toBeVisible();
    await expect(form.getByPlaceholder('Ex.: Grupo Esperança')).toHaveValue('Grupo Alfa');

    // erro de formulário na edição
    await form.getByPlaceholder('Ex.: Grupo Esperança').fill('   ');
    await form.getByRole('button', { name: 'Salvar alterações' }).click();
    await expect(form.getByText('Nome é obrigatório.')).toBeVisible();

    await form.getByPlaceholder('Ex.: Grupo Esperança').fill('Grupo Beta');
    await form.locator('select').selectOption({ label: 'Davi Lider' });
    await form.getByRole('button', { name: 'Salvar alterações' }).click();

    await expect(page.getByRole('heading', { name: 'Editar Grupo' })).toBeHidden();
    const row = page.locator('tbody tr', { hasText: 'Grupo Beta' });
    await expect(row).toContainText('Davi Lider');
    await expect(page.locator('tbody tr', { hasText: 'Grupo Alfa' })).toHaveCount(0);
  });

  test('busca filtra por grupo ou líder e mostra estado de "sem resultado"', async ({ page, db, loginAs }) => {
    const coord = await db.createUser('coordinator', 'Carla Coordenadora');
    const lia = await db.createUser('leader', 'Lia Lider');
    const davi = await db.createUser('leader', 'Davi Lider');
    await db.createGroup('Grupo Alfa', lia.id);
    await db.createGroup('Grupo Beta', davi.id);
    await loginAs(coord);
    await page.goto('/grupos');
    await expect(page.locator('tbody tr')).toHaveCount(2);

    await page.getByPlaceholder('Buscar por grupo ou líder...').fill('davi');
    await expect(page.locator('tbody tr')).toHaveCount(1);
    await expect(page.locator('tbody tr')).toContainText('Grupo Beta');

    await page.getByPlaceholder('Buscar por grupo ou líder...').fill('zzz');
    await expect(page.getByText('Nenhum grupo encontrado para "zzz".')).toBeVisible();
  });

  test('mostra o estado de carregamento enquanto a lista é buscada', async ({ page, db, loginAs }) => {
    const coord = await db.createUser('coordinator', 'Carla Coordenadora');
    await db.createGroup('Grupo Alfa', coord.id);
    await loginAs(coord);
    await page.route('**/rest/v1/groups*', async (route) => {
      await new Promise((r) => setTimeout(r, 800));
      await route.continue();
    });

    await page.goto('/grupos');
    await expect(page.locator('main .animate-spin').first()).toBeVisible();
    await expect(page.locator('tbody tr', { hasText: 'Grupo Alfa' })).toBeVisible();
  });

  test('erro do servidor aparece em um banner, sem quebrar a página', async ({ page, db, loginAs }) => {
    await loginAs(await db.createUser('coordinator', 'Carla Coordenadora'));
    await page.route('**/rest/v1/groups*', (route) =>
      route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ message: 'falha simulada' }) }));

    await page.goto('/grupos');

    await expect(page.getByText('Erro ao carregar grupos.')).toBeVisible();
    await expect(page.getByText('falha simulada')).toHaveCount(0); // texto cru do servidor nunca vai à tela
    await expect(page.getByRole('heading', { name: 'Grupos' })).toBeVisible();
  });
});

test.describe('Grupos — líder (restrições de acesso)', () => {
  test('vê só o próprio grupo, sem criar grupos nem editar os alheios', async ({ page, db, loginAs }) => {
    const lia = await db.createUser('leader', 'Lia Lider');
    const davi = await db.createUser('leader', 'Davi Lider');
    await db.createGroup('Grupo da Lia', lia.id);
    await db.createGroup('Grupo do Davi', davi.id);
    await loginAs(lia);

    await page.goto('/grupos');

    await expect(page.locator('tbody tr')).toHaveCount(1);
    await expect(page.locator('tbody tr')).toContainText('Grupo da Lia');
    await expect(page.getByText('Grupo do Davi')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Novo grupo' })).toHaveCount(0);
    // líder edita o seu próprio grupo
    await expect(page.locator('tbody tr').getByTitle('Editar grupo')).toBeVisible();
  });

  test('líder edita a descrição do próprio grupo mas não troca o líder', async ({ page, db, loginAs }) => {
    const lia = await db.createUser('leader', 'Lia Lider');
    const groupId = await db.createGroup('Grupo da Lia', lia.id);
    await loginAs(lia);
    await page.goto('/grupos');

    await page.locator('tbody tr').getByTitle('Editar grupo').click();
    const form = modal(page);
    // para líder o campo de líder é um input desabilitado, não um select
    await expect(form.locator('select')).toHaveCount(0);
    await expect(form.locator('input[disabled]')).toHaveValue('Você');

    await form.getByPlaceholder('Informações adicionais sobre o grupo...').fill('Reunimos às quartas');
    await form.getByRole('button', { name: 'Salvar alterações' }).click();
    await expect(page.getByRole('heading', { name: 'Editar Grupo' })).toBeHidden();

    const [row] = await db.sql(`SELECT description, leader_id FROM groups WHERE id = $1`, [groupId]);
    expect(row).toEqual({ description: 'Reunimos às quartas', leader_id: lia.id });
  });

  test('líder sem grupos vê o estado vazio, sem opção de criar', async ({ page, db, loginAs }) => {
    const davi = await db.createUser('leader', 'Davi Lider');
    const lia = await db.createUser('leader', 'Lia Lider');
    await db.createGroup('Grupo do Davi', davi.id);
    await loginAs(lia);

    await page.goto('/grupos');

    await expect(page.getByText('Nenhum grupo cadastrado ainda.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Criar o primeiro grupo' })).toHaveCount(0);
  });
});
