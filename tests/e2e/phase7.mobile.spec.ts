// Fase 7 (blocos 6-9) em tela de 390px: painel, indicadores de grupos, relatórios, busca global, lote e histórico
// precisam caber na tela, sem rolagem horizontal, com tabelas viradas em cartões.
import type { Page } from '@playwright/test';
import { api, daysFromNow, expect, modal, test } from './fixtures.ts';
import { addFollowUp, bulkYouth, hasHorizontalScroll, overdueTask, pastEvent, seedPeople } from './phase7-helpers.ts';
import { seedReportScenario } from './reports-fixtures.ts';

test.use({ viewport: { width: 390, height: 844 } });

async function fitsWidth(locator: ReturnType<Page['locator']>) {
  const box = (await locator.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(390.5);
}

test.describe('Painel e grupos no mobile', () => {
  test('painel com dados: cartões e listas cabem, sem rolagem horizontal', async ({ page, db, loginAs }) => {
    const p = await seedPeople(db);
    const ana = await db.createYouth('Ana Souza com um nome bastante comprido para testar quebra', p.alfa);
    const duda = await db.createYouth('Duda Semgrupo', null);
    for (const [i, d] of [21, 14, 7].entries()) {
      const ev = await pastEvent(db, `Culto Alfa ${i + 1}`, d, [p.alfa]);
      await db.recordAttendance(ev, ana, p.alfa, false, p.carla.id);
    }
    await overdueTask(db, 'Ligar para Ana', ana, p.carla);
    await addFollowUp(db, duda, 'Primeiro contato', { responsibleId: p.carla.id, occurredDaysAgo: 5, nextAction: 'Convidar para o culto', dueInDays: -2 });
    await db.createEvent('Retiro de Jovens com título longo para quebrar linha', daysFromNow(10), [p.alfa, p.beta]);
    await loginAs(p.carla);

    await page.goto('/');
    await expect(page.getByTestId('dash-atencao-item')).toHaveCount(1);
    await expect(page.getByTestId('dash-acompanhamento-item')).toHaveCount(1);
    await expect(page.getByTestId('dash-encontro-item')).toHaveCount(1);
    await fitsWidth(page.getByTestId('dash-alertas'));
    await fitsWidth(page.getByTestId('dash-atencao'));
    await fitsWidth(page.getByTestId('dash-acompanhamentos'));
    expect(await hasHorizontalScroll(page)).toBe(false);
  });

  test('lista de grupos em cartões mostra os indicadores', async ({ page, db, loginAs }) => {
    const p = await seedPeople(db);
    const ana = await db.createYouth('Ana Souza', p.alfa);
    for (const [i, d] of [70, 63, 56, 49, 42, 35, 28, 21].entries()) {
      const ev = await pastEvent(db, `Culto ${i}`, d, [p.alfa]);
      await db.recordAttendance(ev, ana, p.alfa, i >= 4, p.carla.id);
    }
    await loginAs(p.carla);
    await page.goto('/grupos');
    const card = page.getByTestId('grupo-card').filter({ hasText: 'Grupo Alfa' });
    await expect(card.getByTestId('grupo-rate')).toHaveText('50%');
    await expect(card.getByTestId('grupo-trend')).toContainText('em alta');
    await expect(card.getByTestId('grupo-attention')).toHaveText('1');
    await expect(card.getByTestId('grupo-overdue')).toHaveText('0');
    await expect(page.getByTestId('grupo-card').filter({ hasText: 'Grupo Beta' }).getByTestId('grupo-rate')).toHaveText('sem chamadas');
    await expect(page.locator('table')).toBeHidden();
    await fitsWidth(card);
    expect(await hasHorizontalScroll(page)).toBe(false);
  });
});

test.describe('Relatórios no mobile', () => {
  test('abas, filtros e tabelas viram cartões, sem rolagem horizontal em nenhuma aba', async ({ page, db, loginAs }) => {
    const s = await seedReportScenario(db);
    await loginAs(s.carla);
    await page.goto('/relatorios');
    await expect(page.getByTestId('rel-frequencia')).toContainText('43%');
    for (const key of ['general', 'attendance', 'followups', 'alerts', 'youth', 'groups']) await fitsWidth(page.getByTestId(`rel-aba-${key}`));
    expect(await hasHorizontalScroll(page)).toBe(false);

    // Geral: tabelas de indicadores como cartões
    await expect(page.locator('table:visible')).toHaveCount(0);
    await expect(page.getByRole('list', { name: 'Frequência e encontros' })).toBeVisible();
    await expect(page.getByRole('list', { name: 'Frequência e encontros' }).locator('li').first()).toContainText('Encontros realizados');
    expect(await hasHorizontalScroll(page)).toBe(false);

    // período personalizado: campos empilhados e dentro da tela
    await page.getByRole('button', { name: 'Personalizado', exact: true }).click();
    await fitsWidth(page.locator('#rel-de'));
    await fitsWidth(page.locator('#rel-ate'));
    expect(await hasHorizontalScroll(page)).toBe(false);
    await page.getByRole('button', { name: 'Últimos 30 dias', exact: true }).click();

    await page.getByTestId('rel-aba-attendance').click();
    await expect(page.getByTestId('tabela-encontros-cartoes')).toBeVisible();
    await expect(page.getByTestId('tabela-encontros')).toBeHidden();
    await expect(page.getByTestId('tabela-encontros-cartoes').locator('li').first()).toContainText('Culto');
    expect(await hasHorizontalScroll(page)).toBe(false);

    await page.getByTestId('rel-aba-followups').click();
    await expect(page.getByTestId('tabela-proximas-acoes-cartoes').locator('li')).toHaveCount(2);
    expect(await hasHorizontalScroll(page)).toBe(false);

    await page.getByTestId('rel-aba-alerts').click();
    await expect(page.getByTestId('relatorio-alertas')).toBeVisible();
    expect(await hasHorizontalScroll(page)).toBe(false);

    await page.getByTestId('rel-aba-groups').click();
    await expect(page.getByTestId('tabela-grupos-atual-cartoes').locator('li')).toHaveCount(2);
    await expect(page.getByTestId('tabela-grupos-periodo-cartoes').locator('li')).toHaveCount(2);
    expect(await hasHorizontalScroll(page)).toBe(false);

    await page.getByTestId('rel-aba-youth').click();
    await page.getByLabel('Buscar jovem por nome').fill('ana');
    await page.getByTestId('rel-jovem-resultado').click();
    await expect(page.getByTestId('relatorio-individual')).toBeVisible();
    await fitsWidth(page.getByTestId('relatorio-individual'));
    expect(await hasHorizontalScroll(page)).toBe(false);
    await expect(page.getByTestId('exportar-csv')).toBeVisible();
    await fitsWidth(page.getByTestId('exportar-pdf'));
  });
});

test.describe('Busca global, lote e histórico no mobile', () => {
  test('busca global ocupa a tela, navega pelo toque e fecha', async ({ page, db, loginAs }) => {
    const p = await seedPeople(db);
    await db.createYouth('José Almeida', p.alfa);
    await loginAs(p.carla);
    await page.goto('/');
    await page.getByTestId('busca-global-abrir-mobile').click();
    const dialog = page.getByRole('dialog', { name: 'Busca global' });
    await expect(dialog).toBeVisible();
    const box = (await dialog.boundingBox())!;
    expect(box.width).toBeGreaterThanOrEqual(389);
    expect(box.height).toBeGreaterThanOrEqual(840); // tela cheia
    await page.getByTestId('busca-global-input').fill('jose');
    await expect(page.getByTestId('busca-global-youth')).toContainText('José Almeida');
    expect(await hasHorizontalScroll(page)).toBe(false);
    await page.getByTestId('busca-global-youth').click();
    await expect(page).toHaveURL(/\/jovens\?ficha=/);
    await expect(page.getByRole('heading', { name: 'Detalhes do Jovem' })).toBeVisible();

    await page.goto('/');
    await page.getByTestId('busca-global-abrir-mobile').click();
    await page.getByRole('button', { name: 'Fechar busca' }).click();
    await expect(page.getByTestId('busca-global-overlay')).toHaveCount(0);
  });

  test('barra de lote fica visível acima da navegação e o seletor de grupo cabe na tela', async ({ page, db, loginAs }) => {
    const p = await seedPeople(db);
    await bulkYouth(db, 'Jovem', 3, p.alfa);
    await loginAs(p.carla);
    await page.goto('/jovens');
    await page.getByTestId('lote-selecionar-pagina-mobile').check();
    const bar = page.getByTestId('lote-barra');
    await expect(bar).toBeVisible();
    await expect(page.getByTestId('lote-contador')).toHaveText('3 selecionados');
    await fitsWidth(bar);
    expect(await hasHorizontalScroll(page)).toBe(false);
    // o botão do lote não fica coberto pela navegação inferior (o clique falharia se estivesse)
    await page.getByTestId('lote-alterar-grupo').click();
    await expect(modal(page).getByRole('heading', { name: 'Alterar grupo' })).toBeVisible();
    await modal(page).getByLabel('Novo grupo').selectOption({ label: 'Grupo Beta' });
    await modal(page).getByTestId('lote-grupo-aplicar').click();
    await expect(page.getByText('3 atualizados.')).toBeVisible();
  });

  test('histórico em cartões, com filtros que cabem na tela', async ({ page, db, loginAs }) => {
    const p = await seedPeople(db);
    const ids = await bulkYouth(db, 'Jovem', 3, p.alfa);
    await loginAs(p.carla);
    await page.goto('/historico');
    expect((await api(page, 'POST', 'rpc/batch_set_youth_group', { p_youth_ids: ids, p_group_id: p.beta })).status).toBe(200);
    await page.goto('/historico');
    await expect(page.getByTestId('historico-card')).toHaveCount(3);
    await expect(page.getByTestId('historico-card').first()).toContainText('Grupo do jovem alterado');
    await expect(page.getByTestId('historico-card').first()).toContainText('por Carla Coordenadora');
    await expect(page.getByTestId('historico-tabela')).toBeHidden();
    await fitsWidth(page.getByTestId('historico-card').first());
    await fitsWidth(page.getByLabel('Filtrar por tipo de ação'));
    expect(await hasHorizontalScroll(page)).toBe(false);
  });

  test('nova série: formulário e confirmação cabem na tela', async ({ page, db, loginAs }) => {
    const p = await seedPeople(db);
    await loginAs(p.carla);
    await page.goto('/encontros');
    await page.getByTestId('serie-nova').click();
    const m = modal(page);
    await expect(m.getByRole('heading', { name: 'Nova série de encontros' })).toBeVisible();
    await m.getByLabel('Nome da série').fill('Culto de Jovens');
    await m.getByLabel('Dia da semana').selectOption({ label: 'Sábado' });
    await m.getByLabel('Horário').fill('19:00');
    await m.getByLabel('Data inicial').fill('2030-01-01');
    await m.getByLabel('Data final').fill('2030-01-31');
    await m.getByLabel('Definir depois').check();
    expect(await hasHorizontalScroll(page)).toBe(false);
    await m.getByTestId('serie-revisar').click();
    await expect(m.getByTestId('serie-previa-total')).toHaveText('Serão criados 4 encontros.');
    await fitsWidth(m.getByTestId('serie-confirmacao'));
    await m.getByTestId('serie-confirmar').click();
    await expect(page.getByText('Série criada: 4 encontros criados.')).toBeVisible();
    await expect(page.getByText('Grupos pendentes').locator('visible=true').first()).toBeVisible();
    expect(await hasHorizontalScroll(page)).toBe(false);
  });
});
