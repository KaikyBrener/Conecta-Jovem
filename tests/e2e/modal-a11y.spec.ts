// Acessibilidade das janelas (componente Modal): Esc, foco preso e devolvido, rolagem travada, clique fora,
// janela de confirmação sobre outra janela. Rótulos dos botões só com ícone.
import { daysFromNow, expect, modal, test } from './fixtures.ts';

const dialog = (page: import('@playwright/test').Page) => page.getByRole('dialog').last();

test.describe('Janelas (Modal) — teclado e foco', () => {
  test.beforeEach(async ({ page, db, loginAs }) => {
    await loginAs(await db.createUser('coordinator', 'Carla Coordenadora'));
    await page.goto('/grupos');
    await expect(page.getByRole('heading', { name: 'Grupos' })).toBeVisible();
  });

  test('Esc fecha a janela e o foco volta ao botão que a abriu', async ({ page }) => {
    const opener = page.getByRole('button', { name: 'Novo grupo' });
    await opener.click();
    await expect(dialog(page)).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(opener).toBeFocused();
  });

  test('o foco entra na janela ao abrir e Tab/Shift+Tab ficam presos nela', async ({ page }) => {
    await page.getByRole('button', { name: 'Novo grupo' }).click();
    const dlg = dialog(page);
    await expect(dlg).toBeVisible();
    // foco inicial: dentro da janela (primeiro campo do formulário)
    await expect.poll(() => dlg.evaluate((el) => el.contains(document.activeElement))).toBe(true);

    for (let i = 0; i < 12; i++) {
      await page.keyboard.press('Tab');
      expect(await dlg.evaluate((el) => el.contains(document.activeElement))).toBe(true);
    }
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press('Shift+Tab');
      expect(await dlg.evaluate((el) => el.contains(document.activeElement))).toBe(true);
    }
  });

  test('o documento não rola enquanto a janela está aberta e volta ao normal ao fechar', async ({ page }) => {
    const overflow = () => page.evaluate(() => document.body.style.overflow);
    expect(await overflow()).not.toBe('hidden');
    await page.getByRole('button', { name: 'Novo grupo' }).click();
    await expect(dialog(page)).toBeVisible();
    expect(await overflow()).toBe('hidden');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(await overflow()).not.toBe('hidden');
  });

  test('clique no fundo fecha; arrastar de dentro para o fundo não fecha', async ({ page }) => {
    await page.getByRole('button', { name: 'Novo grupo' }).click();
    const dlg = dialog(page);
    await expect(dlg).toBeVisible();
    const box = (await dlg.boundingBox())!;

    // começa dentro da janela (ex.: selecionando texto de um campo) e solta no fundo: não fecha
    await page.mouse.move(box.x + 40, box.y + 60);
    await page.mouse.down();
    await page.mouse.move(4, 4);
    await page.mouse.up();
    await expect(dlg).toBeVisible();

    // clique completo no fundo: fecha
    await page.mouse.click(4, 4);
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });
});

test.describe('Janelas (Modal) — confirmação sobre outra janela', () => {
  test('Esc fecha só a confirmação; um segundo Esc fecha a janela de baixo', async ({ page, db, loginAs }) => {
    const coord = await db.createUser('coordinator', 'Carla Coordenadora');
    const g = await db.createGroup('Grupo Alfa', coord.id);
    await db.createEvent('Culto Descartável', daysFromNow(2), [g]);
    await loginAs(coord);
    await page.goto('/encontros');

    await page.getByRole('button', { name: 'Culto Descartável' }).first().click();
    await expect(modal(page).getByRole('heading', { name: 'Detalhes do Encontro' })).toBeVisible();
    await modal(page).getByRole('button', { name: 'Excluir' }).click();
    await expect(page.getByTestId('confirmacao')).toBeVisible();
    await expect(page.getByTestId('confirmacao-cancelar')).toBeFocused();

    await page.keyboard.press('Escape');
    await expect(page.getByTestId('confirmacao')).toHaveCount(0);
    await expect(page.getByRole('dialog', { name: 'Detalhes do Encontro' })).toBeVisible();
    // o evento continua existindo (Esc cancela)
    expect(await db.sql(`SELECT 1 FROM events`)).toHaveLength(1);

    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });
});
