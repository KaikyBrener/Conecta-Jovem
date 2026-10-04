import { expect, test } from './fixtures.ts';

// Mobile: a lista vira cards e a paginação continua utilizável (alvos de toque, sem rolagem horizontal).
test.describe('Paginação no mobile', () => {
  test.beforeEach(async ({ db, loginAs }) => {
    const coord = await db.createUser('coordinator', 'Carla Coordenadora');
    await db.sql(
      `INSERT INTO youth (full_name, is_active) SELECT 'Jovem ' || lpad(i::text, 3, '0'), true FROM generate_series(1, 60) i`);
    await loginAs(coord);
  });

  test('Jovens: cards, navegação anterior/próxima e totais', async ({ page }) => {
    await page.goto('/jovens');
    const cards = page.locator('main ul li');
    const nav = page.getByRole('navigation', { name: 'Paginação' });

    await expect(cards).toHaveCount(25);
    await expect(cards.first()).toContainText('Jovem 001');
    await expect(page.locator('tbody tr').first()).toBeHidden(); // tabela é só desktop
    await expect(nav).toContainText('Mostrando 1–25 de 60 jovens');

    await nav.getByRole('button', { name: 'Próxima' }).scrollIntoViewIfNeeded();
    await nav.getByRole('button', { name: 'Próxima' }).click();
    await expect(cards.first()).toContainText('Jovem 026');
    await expect(nav).toContainText('Página 2 de 3');

    await nav.getByRole('button', { name: 'Anterior' }).click();
    await expect(cards.first()).toContainText('Jovem 001');
  });

  test('os botões têm área de toque adequada e a página não rola na horizontal', async ({ page }) => {
    await page.goto('/jovens');
    const nav = page.getByRole('navigation', { name: 'Paginação' });
    await expect(nav).toBeVisible();

    for (const name of ['Anterior', 'Próxima']) {
      const box = await nav.getByRole('button', { name }).boundingBox();
      expect(box!.height).toBeGreaterThanOrEqual(36);
    }
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
    expect(overflow).toBe(false);
  });

  test('busca com paginação no mobile', async ({ page }) => {
    await page.goto('/jovens');
    await page.getByPlaceholder('Buscar por nome...').fill('Jovem 05');

    await expect(page.locator('main ul li')).toHaveCount(10); // 050..059
    await expect(page.getByRole('navigation', { name: 'Paginação' })).toHaveCount(0);
  });
});
