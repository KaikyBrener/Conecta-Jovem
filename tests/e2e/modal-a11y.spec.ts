// Acessibilidade das janelas (componente Modal): Esc, foco preso e devolvido, rolagem travada, clique fora,
// janela de confirmação sobre outra janela, proteção ao fechar formulário alterado. Rótulos dos botões só com ícone.
import { answerConfirmation, daysFromNow, expect, modal, test } from './fixtures.ts';

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

test.describe('Janelas (Modal) — proteção contra perda de dados', () => {
  const discard = (page: import('@playwright/test').Page) => page.getByRole('dialog', { name: 'Descartar alterações?' });
  const form = (page: import('@playwright/test').Page) => page.getByRole('dialog', { name: 'Novo Grupo' });

  test.beforeEach(async ({ page, db, loginAs }) => {
    const lia = await db.createUser('leader', 'Lia Lider');
    await db.createGroup('Grupo Alfa', lia.id);
    await loginAs(await db.createUser('coordinator', 'Carla Coordenadora'));
    await page.goto('/grupos');
    await page.getByRole('button', { name: 'Novo grupo' }).click();
    await expect(form(page)).toBeVisible();
  });

  test('Esc com o formulário alterado pergunta; "Continuar editando" mantém o texto e devolve o foco', async ({ page, db }) => {
    const nome = form(page).getByLabel('Nome do grupo');
    await nome.fill('Grupo Esperança');

    await page.keyboard.press('Escape');
    await expect(discard(page)).toBeVisible();
    await expect(page.getByTestId('confirmacao-cancelar')).toBeFocused();   // a ação segura
    const texto = await answerConfirmation(page, false);
    expect(texto).toContain('ainda não salvou');

    await expect(form(page)).toBeVisible();
    await expect(nome).toHaveValue('Grupo Esperança');
    await expect(nome).toBeFocused();

    // Esc na pergunta também é "continuar editando"
    await page.keyboard.press('Escape');
    await expect(discard(page)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(discard(page)).toHaveCount(0);
    await expect(nome).toHaveValue('Grupo Esperança');

    // "Descartar alterações" fecha tudo e nada é gravado
    await page.keyboard.press('Escape');
    await answerConfirmation(page, true);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(await db.sql(`SELECT 1 FROM groups`)).toHaveLength(1);   // só o grupo que já existia
  });

  test('clique fora e o botão "Fechar janela" também perguntam', async ({ page }) => {
    await form(page).getByLabel('Descrição').fill('Reunião às quartas');

    await page.mouse.click(4, 4);
    await answerConfirmation(page, false);
    await expect(form(page)).toBeVisible();

    await form(page).getByRole('button', { name: 'Fechar janela' }).click();
    await answerConfirmation(page, true);
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });

  test('desfazer a edição não conta como alteração; "Cancelar" do formulário fecha direto', async ({ page }) => {
    const nome = form(page).getByLabel('Nome do grupo');
    await nome.fill('Rascunho');
    await nome.fill('');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);

    await page.getByRole('button', { name: 'Novo grupo' }).click();
    await form(page).getByLabel('Nome do grupo').fill('Outro rascunho');
    await form(page).getByRole('button', { name: 'Cancelar' }).click();   // decisão explícita: sem pergunta
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });

  test('uma escolha em lista (select) conta como alteração', async ({ page }) => {
    await form(page).getByLabel('Líder responsável').selectOption({ label: 'Lia Lider' });
    await form(page).getByRole('button', { name: 'Fechar janela' }).click();
    await expect(discard(page)).toBeVisible();
    await answerConfirmation(page, true);
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });

  test('editar sem mexer em nada fecha direto; alterar e voltar ao valor original também', async ({ page }) => {
    await form(page).getByRole('button', { name: 'Cancelar' }).click();
    await page.locator('tbody tr', { hasText: 'Grupo Alfa' }).getByTitle('Editar grupo').click();
    const editar = page.getByRole('dialog', { name: 'Editar Grupo' });
    await expect(editar.getByLabel('Nome do grupo')).toHaveValue('Grupo Alfa');

    // os campos vêm preenchidos pelo sistema: isso não é alteração da pessoa
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);

    await page.locator('tbody tr', { hasText: 'Grupo Alfa' }).getByTitle('Editar grupo').click();
    await editar.getByLabel('Nome do grupo').fill('Grupo Beta');
    await page.keyboard.press('Escape');
    await answerConfirmation(page, false);
    await editar.getByLabel('Nome do grupo').fill('Grupo Alfa');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });
});
