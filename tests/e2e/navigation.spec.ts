import { expect, test } from './fixtures.ts';

const SIDEBAR_KEY = 'conecta-jovem-sidebar-collapsed';
const THEME_KEY = 'conecta-jovem-theme';

test.describe('Navegação e preferências de interface', () => {
  test.beforeEach(async ({ db, loginAs }) => {
    await loginAs(await db.createUser('coordinator', 'Carla Coordenadora'));
  });

  test('navega entre todas as páginas pela sidebar', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Visão geral' })).toBeVisible();

    const pages: { link: string; path: RegExp; heading: string }[] = [
      { link: 'Jovens', path: /\/jovens$/, heading: 'Jovens' },
      { link: 'Grupos', path: /\/grupos$/, heading: 'Grupos' },
      { link: 'Encontros', path: /\/encontros$/, heading: 'Encontros' },
      { link: 'Alertas', path: /\/alertas$/, heading: 'Alertas' },
      { link: 'Tarefas', path: /\/tarefas$/, heading: 'Tarefas' },
      { link: 'Relatórios', path: /\/relatorios$/, heading: 'Relatórios' },
      { link: 'Configurações', path: /\/settings$/, heading: 'Configurações' },
      { link: 'Início', path: /\/$/, heading: 'Visão geral' },
    ];
    for (const p of pages) {
      await page.locator('aside nav').getByRole('link', { name: p.link }).click();
      await expect(page).toHaveURL(p.path);
      await expect(page.getByRole('heading', { name: p.heading, exact: true })).toBeVisible();
    }
  });

  test('item ativo da sidebar acompanha a rota e o breadcrumb', async ({ page }) => {
    await page.goto('/tarefas');
    const link = page.locator('aside nav').getByRole('link', { name: 'Tarefas' });
    await expect(link).toHaveClass(/bg-blue-600/);
    await expect(page.getByText('Início').first()).toBeVisible();
    await expect(page.locator('main').getByText('Tarefas', { exact: true }).first()).toBeVisible();
  });

  test('sidebar recolhe, expande e lembra a preferência após recarregar', async ({ page }) => {
    await page.goto('/');
    const sidebar = page.locator('aside');
    await expect(sidebar).toHaveClass(/w-64/);
    await expect(sidebar.getByText('Encerrar sessão')).toBeVisible();

    await page.getByRole('button', { name: 'Recolher menu lateral' }).click();

    await expect(sidebar).toHaveClass(/w-16/);
    await expect(sidebar.getByText('Encerrar sessão')).toBeHidden();
    await expect(page.getByRole('button', { name: 'Expandir menu lateral' })).toBeVisible();
    expect(await page.evaluate((k) => localStorage.getItem(k), SIDEBAR_KEY)).toBe('1');
    // navegação continua funcionando recolhida (itens têm title)
    await sidebar.getByRole('link', { name: 'Grupos' }).click();
    await expect(page).toHaveURL(/\/grupos$/);

    await page.reload();
    await expect(page.locator('aside')).toHaveClass(/w-16/);

    await page.getByRole('button', { name: 'Expandir menu lateral' }).click();
    await expect(page.locator('aside')).toHaveClass(/w-64/);
    expect(await page.evaluate((k) => localStorage.getItem(k), SIDEBAR_KEY)).toBe('0');
  });

  test('modo escuro alterna, persiste após recarregar e pode ser desfeito', async ({ page }) => {
    await page.goto('/');
    const html = page.locator('html');
    await expect(html).not.toHaveClass(/dark/);

    await page.getByRole('button', { name: 'Ativar modo escuro' }).click();

    await expect(html).toHaveClass(/dark/);
    expect(await page.evaluate((k) => localStorage.getItem(k), THEME_KEY)).toBe('dark');

    await page.reload();
    await expect(html).toHaveClass(/dark/);
    // o toggle agora oferece o caminho de volta
    await page.getByRole('button', { name: 'Ativar modo claro' }).click();
    await expect(html).not.toHaveClass(/dark/);
    expect(await page.evaluate((k) => localStorage.getItem(k), THEME_KEY)).toBe('light');
  });

  test('modo escuro persiste entre páginas e após novo login', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Ativar modo escuro' }).click();
    await page.locator('aside nav').getByRole('link', { name: 'Grupos' }).click();
    await expect(page.locator('html')).toHaveClass(/dark/);

    await page.getByRole('button', { name: 'Encerrar sessão' }).click();
    await expect(page).toHaveURL(/\/login$/);
    // a preferência de tema é do navegador, não da sessão
    await expect(page.locator('html')).toHaveClass(/dark/);
  });
});
