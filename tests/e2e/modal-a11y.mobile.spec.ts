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

  test('folha com formulário alterado: "Fechar janela" pergunta antes de descartar', async ({ page }) => {
    await page.goto('/jovens');
    await page.getByRole('button', { name: 'Novo jovem', exact: true }).click();
    const folha = page.getByRole('dialog', { name: 'Novo Jovem' });
    await folha.getByLabel(/Nome/).first().fill('Rascunho Mobile');

    await folha.getByRole('button', { name: 'Fechar janela' }).click();
    const pergunta = page.getByRole('dialog', { name: 'Descartar alterações?' });
    await expect(pergunta).toBeVisible();
    // os dois botões da pergunta são alvos de toque de pelo menos 44px
    for (const id of ['confirmacao-cancelar', 'confirmacao-confirmar']) {
      expect((await page.getByTestId(id).boundingBox())!.height).toBeGreaterThanOrEqual(44);
    }
    await page.getByTestId('confirmacao-cancelar').click();
    await expect(folha.getByLabel(/Nome/).first()).toHaveValue('Rascunho Mobile');

    await folha.getByRole('button', { name: 'Fechar janela' }).click();
    await page.getByTestId('confirmacao-confirmar').click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });
});
