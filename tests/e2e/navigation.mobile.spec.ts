import { expect, test } from './fixtures.ts';

test.describe('Navegação no mobile', () => {
  test.beforeEach(async ({ db, loginAs }) => {
    await loginAs(await db.createUser('leader', 'Lia Lider'));
  });

  test('usa bottom-nav (sem sidebar) e o menu "Mais" dá acesso às demais páginas', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('aside')).toBeHidden();
    const bottomNav = page.locator('nav.fixed');
    await expect(bottomNav).toBeVisible();

    await bottomNav.getByRole('link', { name: 'Jovens' }).click();
    await expect(page).toHaveURL(/\/jovens$/);

    await bottomNav.getByRole('button', { name: 'Mais' }).click();
    await expect(page.getByRole('link', { name: 'Tarefas' })).toBeVisible();
    await page.getByRole('link', { name: 'Configurações' }).click();
    await expect(page).toHaveURL(/\/settings$/);
    await expect(page.getByRole('heading', { name: 'Configurações' })).toBeVisible();
  });

  test('tema escuro funciona e persiste no mobile', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Ativar modo escuro' }).click();
    await expect(page.locator('html')).toHaveClass(/dark/);
    await page.reload();
    await expect(page.locator('html')).toHaveClass(/dark/);
  });
});

test.describe('Login no mobile', () => {
  test('não gera rolagem horizontal e mantém alvos de toque grandes', async ({ page }) => {
    await page.goto('/login');
    await expect(page.getByRole('button', { name: 'Entrar' })).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
    expect(overflow).toBe(false);
    for (const target of [page.getByLabel('E-mail'), page.getByLabel('Senha', { exact: true }), page.getByRole('button', { name: 'Entrar' })]) {
      const box = await target.boundingBox();
      expect(box!.height).toBeGreaterThanOrEqual(44);
    }
  });
});
