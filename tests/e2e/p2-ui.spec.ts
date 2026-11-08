// Refino das telas (P2): progresso da Chamada, "Fazer chamada" na lista de Encontros e frequência do painel
// comparada ao limite de "frequência baixa" configurado.
import { daysFromNow, expect, markPresent, test } from './fixtures.ts';
import { pastEvent } from './phase7-helpers.ts';

test.describe('Chamada — progresso do registro', () => {
  test('a barra e o texto acompanham quantos jovens já têm registro', async ({ page, db, loginAs }) => {
    const coord = await db.createUser('coordinator', 'Carla Coordenadora');
    const group = await db.createGroup('Grupo Alfa', coord.id);
    await db.createYouth('Ana Souza', group);
    await db.createYouth('Bruno Lima', group);
    const eventId = await db.createEvent('Culto de Jovens', daysFromNow(-1), [group]);
    await loginAs(coord);
    await page.goto(`/chamada/${eventId}`);

    const barra = page.getByRole('progressbar', { name: 'Jovens com presença registrada' });
    await expect(barra).toHaveAttribute('aria-valuemax', '2');
    await expect(barra).toHaveAttribute('aria-valuenow', '0');
    await expect(page.getByTestId('chamada-progresso')).toContainText('0 de 2 com registro');

    await markPresent(page, 'Ana Souza');
    await expect(barra).toHaveAttribute('aria-valuenow', '1');
    await expect(page.getByTestId('chamada-progresso')).toContainText('1 de 2 com registro');
  });

  test('"Marcar encontro como realizado" fica fora da barra de salvar, mas continua marcado por padrão', async ({ page, db, loginAs }) => {
    const coord = await db.createUser('coordinator', 'Carla Coordenadora');
    const group = await db.createGroup('Grupo Alfa', coord.id);
    await db.createYouth('Ana Souza', group);
    const eventId = await db.createEvent('Culto de Jovens', daysFromNow(-1), [group]);
    await loginAs(coord);
    await page.goto(`/chamada/${eventId}`);

    await expect(page.getByLabel('Marcar encontro como realizado')).toBeChecked();
    // a barra de salvar só tem o estado e o botão
    const barra = page.locator('div.sticky', { has: page.getByRole('button', { name: 'Salvar Chamada' }) });
    await expect(barra.getByLabel('Marcar encontro como realizado')).toHaveCount(0);
  });
});

test.describe('Encontros — "Fazer chamada" na linha (desktop)', () => {
  test('aparece em encontro agendado, abre a chamada e some em encontro cancelado', async ({ page, db, loginAs }) => {
    const coord = await db.createUser('coordinator', 'Carla Coordenadora');
    const group = await db.createGroup('Grupo Alfa', coord.id);
    await db.createYouth('Ana Souza', group);
    const ativo = await db.createEvent('Culto Ativo', daysFromNow(2), [group]);
    await db.createEvent('Culto Cancelado', daysFromNow(3), [group], 'cancelled');
    await loginAs(coord);
    await page.goto('/encontros');

    const linhaCancelada = page.locator('tbody tr', { hasText: 'Culto Cancelado' });
    await expect(linhaCancelada).toBeVisible();
    await expect(linhaCancelada.getByRole('link', { name: 'Fazer chamada' })).toHaveCount(0);

    await page.locator('tbody tr', { hasText: 'Culto Ativo' }).getByRole('link', { name: 'Fazer chamada' }).click();
    await expect(page).toHaveURL(new RegExp(`/chamada/${ativo}$`));
    await expect(page.getByRole('heading', { name: 'Chamada' })).toBeVisible();
  });
});

test.describe('Painel — frequência média e o limite de frequência baixa', () => {
  test('abaixo do limite: aviso no cartão e linha tracejada no gráfico; acima: sem aviso', async ({ page, db, loginAs }) => {
    const coord = await db.createUser('coordinator', 'Carla Coordenadora');
    const group = await db.createGroup('Grupo Alfa', coord.id);
    const ana = await db.createYouth('Ana Souza', group);
    const evento = await pastEvent(db, 'Culto Passado', 7, [group]);
    await db.recordAttendance(evento, ana, group, false, coord.id);
    await loginAs(coord);

    await page.goto('/');
    await expect(page.getByTestId('dash-frequencia')).toContainText('0%');
    await expect(page.getByTestId('dash-frequencia')).toContainText('abaixo do limite de 70%');
    // linha horizontal tem altura zero: o Playwright a considera "hidden"; basta estar no DOM
    await expect(page.getByTestId('grafico-limite')).toBeAttached();
    await expect(page.getByTestId('dash-grafico')).toContainText('Limite de frequência baixa: 70%');

    // com presença, a média sobe acima do limite e o aviso some
    await db.sql(`UPDATE attendance SET present = true`);
    await page.reload();
    await expect(page.getByTestId('dash-frequencia')).toContainText('100%');
    await expect(page.getByTestId('dash-frequencia')).not.toContainText('abaixo do limite');
  });
});

test.describe('CSP — sem atributo style (as barras de progresso são SVG)', () => {
  test('Chamada, Painel e Relatórios não têm elementos com atributo style', async ({ page, db, loginAs }) => {
    const coord = await db.createUser('coordinator', 'Carla Coordenadora');
    const group = await db.createGroup('Grupo Alfa', coord.id);
    const ana = await db.createYouth('Ana Souza', group);
    await db.createYouth('Bruno Lima', group);
    const passado = await pastEvent(db, 'Culto Passado', 7, [group]);
    await db.recordAttendance(passado, ana, group, true, coord.id);
    const eventId = await db.createEvent('Culto de Jovens', daysFromNow(-1), [group]);
    await loginAs(coord);

    await page.goto(`/chamada/${eventId}`);
    await markPresent(page, 'Ana Souza');
    const barra = page.getByRole('progressbar', { name: 'Jovens com presença registrada' });
    await expect(barra.locator('svg rect').nth(1)).toHaveAttribute('width', '50%');
    expect(await page.locator('[style]').count(), 'Chamada').toBe(0);

    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Visão geral' })).toBeVisible();
    expect(await page.locator('[style]').count(), 'Painel').toBe(0);

    await page.goto('/relatorios');
    await page.getByTestId('rel-aba-attendance').click();
    await expect(page.locator('main svg rect').first()).toBeAttached();
    expect(await page.locator('[style]').count(), 'Relatórios').toBe(0);
  });
});
