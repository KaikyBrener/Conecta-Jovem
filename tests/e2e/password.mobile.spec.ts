import { expect, test } from './fixtures.ts';

test.describe('Recuperação de senha no mobile', () => {
  test('a tela não rola na horizontal e os controles têm área de toque adequada', async ({ page }) => {
    await page.goto('/recuperar-senha');
    await expect(page.getByRole('button', { name: 'Enviar link' })).toBeVisible();

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
    expect(overflow).toBe(false);
    for (const target of [page.getByLabel('E-mail'), page.getByRole('button', { name: 'Enviar link' })]) {
      expect((await target.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    }
  });

  test('definir a senha por um link de convite funciona no mobile', async ({ page, db }) => {
    const user = await db.createUser('leader', 'Lia Lider');
    await page.goto(`/${await db.authLink(user.email, 'invite')}`);

    await expect(page.getByRole('heading', { name: 'Defina sua senha' })).toBeVisible();
    await page.getByLabel('Nova senha').fill('MinhaSenha#1');
    await page.getByLabel('Confirmar senha').fill('MinhaSenha#1');
    await page.getByRole('button', { name: 'Definir senha e entrar' }).click();

    await expect(page).toHaveURL('/');
    await expect(page.locator('nav.fixed')).toBeVisible();
  });
});
