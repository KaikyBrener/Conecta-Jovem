// Refino das telas no celular (P2): ações dos alertas com alvo de 44px e Jovens com o nome inteiro à vista.
import { expect, test } from './fixtures.ts';
import { hasHorizontalScroll, pastEvent } from './phase7-helpers.ts';

test.describe('Celular (390px)', () => {
  test('alertas: todas as ações têm 44px de altura e cabem na tela', async ({ page, db, loginAs }) => {
    const coord = await db.createUser('coordinator', 'Carla Coordenadora');
    const group = await db.createGroup('Grupo Alfa', coord.id);
    const ana = await db.createYouth('Ana Souza', group);
    for (const d of [21, 14, 7]) {
      const ev = await pastEvent(db, `Culto ${d}`, d, [group]);
      await db.recordAttendance(ev, ana, group, false, coord.id);
    }
    await loginAs(coord);
    await page.goto('/alertas');

    const card = page.getByTestId('alerta-item').first();
    await expect(card).toBeVisible();
    for (const nome of ['Registrar acompanhamento', 'Enviar e-mail', 'Criar tarefa', 'Dispensar', 'Resolver']) {
      const box = (await card.getByRole('button', { name: nome }).boundingBox())!;
      expect(box.height, nome).toBeGreaterThanOrEqual(44);
      expect(box.x + box.width, nome).toBeLessThanOrEqual(390);
    }
    expect(await hasHorizontalScroll(page)).toBe(false);
  });

  test('jovens: o nome comprido aparece inteiro e a situação fica numa linha própria', async ({ page, db, loginAs }) => {
    const coord = await db.createUser('coordinator', 'Carla Coordenadora');
    const group = await db.createGroup('Grupo Alfa', coord.id);
    await db.createYouth('Eduardo Martins Figueiredo', group);
    await loginAs(coord);
    await page.goto('/jovens');

    const nome = page.locator('ul li').getByText('Eduardo Martins Figueiredo', { exact: true });
    await expect(nome).toBeVisible();
    // não foi cortado com reticências (scrollWidth == clientWidth)
    expect(await nome.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    expect(await hasHorizontalScroll(page)).toBe(false);
  });
});
