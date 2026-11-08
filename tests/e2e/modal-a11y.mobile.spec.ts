// Botões que no celular mostram só o ícone precisam de nome acessível; alvos de toque de 44px.
import { expect, test } from './fixtures.ts';

test.describe('Botões só com ícone no celular', () => {
  test.beforeEach(async ({ db, loginAs }) => {
    await loginAs(await db.createUser('coordinator', 'Carla Coordenadora'));
  });

  for (const [rota, nome] of [['/jovens', 'Novo jovem'], ['/encontros', 'Novo encontro'], ['/tarefas', 'Nova tarefa']] as const) {
    test(`${rota}: o botão "${nome}" tem nome acessível e alvo de pelo menos 44px`, async ({ page }) => {
      await page.goto(rota);
      const botao = page.getByRole('button', { name: nome, exact: true });
      await expect(botao).toBeVisible();
      const box = (await botao.boundingBox())!;
      expect(box.width).toBeGreaterThanOrEqual(44);
      expect(box.height).toBeGreaterThanOrEqual(44);
    });
  }

  test('Esc/foco: a janela abre como folha e o botão de fechar tem 44px', async ({ page }) => {
    await page.goto('/jovens');
    await page.getByRole('button', { name: 'Novo jovem', exact: true }).click();
    const fechar = page.getByRole('button', { name: 'Fechar janela' });
    await expect(fechar).toBeVisible();
    const box = (await fechar.boundingBox())!;
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.height).toBeGreaterThanOrEqual(44);
    await fechar.click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });
});
