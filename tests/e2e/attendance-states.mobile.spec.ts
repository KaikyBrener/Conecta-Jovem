import { chamadaRow, daysFromNow, expect, expectCounters, markAbsent, test } from './fixtures.ts';

// Largura de celular pequeno (iPhone 12/13): a chamada precisa caber sem rolagem horizontal.
test.use({ viewport: { width: 390, height: 844 } });

const hasHorizontalScroll = (page: import('@playwright/test').Page) =>
  page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);

test.describe('Chamada no mobile (390px)', () => {
  test('lista, filtros, ação em lote e salvar funcionam sem rolagem horizontal e com alvos de toque grandes', async ({ page, db, loginAs }) => {
    const coord = await db.createUser('coordinator', 'Carla Coordenadora');
    const group = await db.createGroup('Grupo Alfa', coord.id);
    await db.createYouth('Ana Souza', group);
    await db.createYouth('Bruno Lima', group);
    // nome muito longo: não pode estourar a largura
    await db.createYouth('Maria Aparecida da Conceição Albuquerque de Vasconcelos Neto Filho', group);
    const eventId = await db.createEvent('Culto de Jovens', daysFromNow(-1), [group]);
    await loginAs(coord);

    await page.goto(`/chamada/${eventId}`);
    await expect(page.getByTestId('chamada-jovem')).toHaveCount(3);
    expect(await hasHorizontalScroll(page)).toBe(false);

    // botões Presente/Ausente com área de toque >= 44px
    for (const name of ['Presente: Ana Souza', 'Ausente: Ana Souza']) {
      const box = await page.getByRole('button', { name }).boundingBox();
      expect(box!.height).toBeGreaterThanOrEqual(44);
      expect(box!.width).toBeGreaterThanOrEqual(44);
    }
    // contadores visíveis dentro da tela
    for (const id of ['contador-total', 'contador-presentes', 'contador-ausentes', 'contador-nao-registrados', 'contador-percentual']) {
      const box = await page.getByTestId(id).boundingBox();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(390);
    }

    await markAbsent(page, 'Bruno Lima');
    await page.getByRole('button', { name: 'Marcar não registrados (visíveis) como presentes' }).click();
    await expectCounters(page, { total: 3, presentes: 2, ausentes: 1, naoRegistrados: 0, percentual: '67%' });
    await page.getByRole('button', { name: /^Ausentes \(1\)$/ }).click();
    await expect(page.getByTestId('chamada-jovem')).toHaveText([/Bruno Lima/]);
    await page.getByRole('button', { name: /^Todos \(3\)$/ }).click();
    expect(await hasHorizontalScroll(page)).toBe(false);

    // a barra de salvar fica visível (sticky) acima da bottom-nav, sem cobri-la
    const save = page.getByRole('button', { name: 'Salvar Chamada' });
    await expect(save).toBeInViewport();
    expect((await save.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await save.click();

    const summary = page.getByTestId('chamada-resumo');
    await expect(summary.getByRole('heading', { name: 'Chamada registrada.' })).toBeVisible();
    await expect(page.getByTestId('chamada-resumo-numeros')).toHaveText('3 registrados · 2 presentes · 1 ausente · 67%');
    expect(await hasHorizontalScroll(page)).toBe(false);
    for (const name of ['Continuar editando', 'Voltar aos encontros']) {
      expect((await summary.getByRole('button', { name }).boundingBox())!.height).toBeGreaterThanOrEqual(44);
    }
    expect(await db.sql(`SELECT 1 FROM attendance WHERE event_id = $1`, [eventId])).toHaveLength(3);
  });

  test('o painel de novos alertas cabe na tela e não registrado não gera linha', async ({ page, db, loginAs }) => {
    const coord = await db.createUser('coordinator', 'Carla Coordenadora');
    const group = await db.createGroup('Grupo Alfa', coord.id);
    const ana = await db.createYouth('Ana Souza', group);
    await db.createYouth('Bia Lima', group);
    const e1 = await db.createEvent('Culto 1', daysFromNow(-21), [group], 'completed');
    const e2 = await db.createEvent('Culto 2', daysFromNow(-14), [group], 'completed');
    const e3 = await db.createEvent('Culto 3', daysFromNow(-7), [group]);
    for (const e of [e1, e2]) await db.recordAttendance(e, ana, group, false, coord.id);
    await loginAs(coord);

    await page.goto(`/chamada/${e3}`);
    await markAbsent(page, 'Ana Souza'); // Bia fica sem estado
    await expect(chamadaRow(page, 'Bia Lima')).toHaveAttribute('data-state', 'unregistered');
    await page.getByRole('button', { name: 'Salvar Chamada' }).click();

    const novos = page.getByTestId('chamada-novos-alertas');
    await expect(novos).toContainText('Ana Souza');
    await expect(novos).toContainText('3 faltas seguidas');
    expect(await hasHorizontalScroll(page)).toBe(false);
    const box = await novos.boundingBox();
    expect(box!.x + box!.width).toBeLessThanOrEqual(390);
    expect(await db.sql(`SELECT 1 FROM attendance WHERE event_id = $1`, [e3])).toHaveLength(1); // só a Ana
  });

  test('encontro cancelado no mobile continua somente leitura e sem rolagem horizontal', async ({ page, db, loginAs }) => {
    const coord = await db.createUser('coordinator', 'Carla Coordenadora');
    const group = await db.createGroup('Grupo Alfa', coord.id);
    await db.createYouth('Ana Souza', group);
    const eventId = await db.createEvent('Culto Cancelado', daysFromNow(-1), [group], 'cancelled');
    await loginAs(coord);

    await page.goto(`/chamada/${eventId}`);

    await expect(page.getByText('Este encontro foi cancelado.', { exact: false })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Presente: Ana Souza' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Salvar Chamada' })).toBeDisabled();
    expect(await hasHorizontalScroll(page)).toBe(false);
  });
});
