// Configurações > Parâmetros de acompanhamento (Fase 7): faltas para gerar alerta, faltas para alerta CRÍTICO (#crit) e
// prazo de carência do acompanhamento (#grace). Validação na tela (espelha os CHECKs do banco), persistência e efeito
// real: o banco recalcula a severidade dos alertas / a situação do jovem e o alerta "sem acompanhamento".
import type { Page } from '@playwright/test';
import { api, daysFromNow, expect, test, type TestDb } from './fixtures.ts';

const absence = (page: Page) => page.getByLabel('Faltas consecutivas para gerar alerta', { exact: true });
const critical = (page: Page) => page.getByLabel('Faltas consecutivas para alerta crítico', { exact: true });
const low = (page: Page) => page.getByLabel('Frequência mínima esperada (%)', { exact: true });
const grace = (page: Page) => page.getByLabel('Prazo de carência do acompanhamento (dias)', { exact: true });
const save = (page: Page) => page.getByRole('button', { name: 'Salvar', exact: true });
const saved = (page: Page) => page.getByText('Configurações salvas. Os alertas foram recalculados.');
const form = (page: Page) => page.locator('form').filter({ has: page.locator('#grace') });

const items = (page: Page) => page.getByTestId('alerta-item');
const byType = (page: Page, tipo: string) => page.locator(`[data-testid="alerta-item"][data-tipo="${tipo}"]`);

const settingsRow = async (db: TestDb) =>
  (await db.sql<{ a: number; c: number; l: number; g: number }>(
    `SELECT absence_alert_threshold AS a, critical_absence_threshold AS c, low_attendance_threshold AS l, followup_grace_days AS g
       FROM app_settings`))[0];

/** Desliga a validação nativa (min/max/step) para exercitar a validação do próprio app. */
const skipNativeValidation = (page: Page) => form(page).evaluate((f: HTMLFormElement) => { f.noValidate = true; });

async function openSettings(page: Page, db: TestDb, loginAs: (u: any) => Promise<void>) {
  const coord = await db.createUser('coordinator', 'Carla Coordenadora');
  await loginAs(coord);
  await page.goto('/settings');
  await expect(grace(page)).toBeVisible();
  return coord;
}

test.describe('Configurações — campos novos (crítico e carência)', () => {
  test('mostra os padrões, o texto de ajuda e os limites dos dois campos', async ({ page, db, loginAs }) => {
    await openSettings(page, db, loginAs);

    await expect(absence(page)).toHaveValue('3');
    await expect(critical(page)).toHaveValue('6');
    await expect(low(page)).toHaveValue('70');
    await expect(grace(page)).toHaveValue('7');
    await expect(critical(page)).toHaveAttribute('id', 'crit');
    await expect(grace(page)).toHaveAttribute('id', 'grace');
    await expect(critical(page)).toHaveAttribute('min', '1');
    await expect(critical(page)).toHaveAttribute('max', '50');
    await expect(grace(page)).toHaveAttribute('min', '1');
    await expect(grace(page)).toHaveAttribute('max', '90');
    // o texto de ajuda está ligado ao campo (acessível)
    await expect(page.locator('#crit-help')).toContainText('Deve ser igual ou maior que o limite para gerar alerta.');
    await expect(page.locator('#grace-help')).toContainText('entre 1 e 90');
    await expect(critical(page)).toHaveAttribute('aria-describedby', 'crit-help');
    await expect(grace(page)).toHaveAttribute('aria-describedby', 'grace-help');
  });

  test('crítico menor que o limite para gerar alerta é recusado com mensagem; igual é aceito; nada é gravado na recusa', async ({ page, db, loginAs }) => {
    await openSettings(page, db, loginAs);

    await absence(page).fill('5');
    await critical(page).fill('4');
    await save(page).click();
    await expect(page.getByRole('alert')).toHaveText(
      'Faltas para alerta crítico: o valor deve ser igual ou maior que as faltas consecutivas para gerar alerta.');
    await expect(saved(page)).toHaveCount(0);
    expect(await settingsRow(db)).toEqual({ a: 3, c: 6, l: 70, g: 7 });

    // igual ao limite: aceito
    await critical(page).fill('5');
    await save(page).click();
    await expect(saved(page)).toBeVisible();
    await expect(page.getByRole('alert')).toHaveCount(0); // o erro anterior sumiu
    await expect.poll(() => settingsRow(db)).toEqual({ a: 5, c: 5, l: 70, g: 7 });

    // sobe só o limite acima do crítico salvo: recusado (o banco usaria GREATEST e ignoraria o crítico em silêncio)
    await absence(page).fill('8');
    await save(page).click();
    await expect(page.getByRole('alert')).toContainText('igual ou maior que as faltas consecutivas');
    expect(await settingsRow(db)).toEqual({ a: 5, c: 5, l: 70, g: 7 });

    // persistência: recarrega e os valores gravados voltam
    await page.reload();
    await expect(absence(page)).toHaveValue('5');
    await expect(critical(page)).toHaveValue('5');
    await expect(grace(page)).toHaveValue('7');
  });

  test('limites: carência 1..90 e crítico 1..50 (barreira do navegador e validação do app); nada é gravado fora deles', async ({ page, db, loginAs }) => {
    await openSettings(page, db, loginAs);
    const untouched = { a: 3, c: 6, l: 70, g: 7 };

    // 1) navegador: valor fora de min/max nem chega ao envio
    await grace(page).fill('91');
    await save(page).click();
    expect(await grace(page).evaluate((el: HTMLInputElement) => el.validity.rangeOverflow)).toBe(true);
    await grace(page).fill('0');
    await save(page).click();
    expect(await grace(page).evaluate((el: HTMLInputElement) => el.validity.rangeUnderflow)).toBe(true);
    await critical(page).fill('51');
    await save(page).click();
    expect(await critical(page).evaluate((el: HTMLInputElement) => el.validity.rangeOverflow)).toBe(true);
    await expect(saved(page)).toHaveCount(0);
    expect(await settingsRow(db)).toEqual(untouched);

    // 2) app: mesmo sem a validação nativa, a tela recusa com a mensagem certa
    await critical(page).fill('6');
    await skipNativeValidation(page);
    for (const value of ['91', '0', '-3', '2.5', '']) {
      await grace(page).fill(value);
      await save(page).click();
      await expect(page.getByRole('alert'), `carência "${value}"`).toHaveText(
        'Prazo de carência do acompanhamento: informe um número inteiro de dias entre 1 e 90.');
    }
    await grace(page).fill('7');
    await critical(page).fill('51');
    await save(page).click();
    await expect(page.getByRole('alert')).toHaveText('Faltas para alerta crítico: informe um número inteiro entre 1 e 50.');
    await critical(page).fill('');
    await save(page).click();
    await expect(page.getByRole('alert')).toHaveText('Faltas para alerta crítico: informe um número inteiro entre 1 e 50.');
    await expect(saved(page)).toHaveCount(0);
    expect(await settingsRow(db)).toEqual(untouched);

    // 3) as bordas são aceitas e persistem
    await critical(page).fill('6');
    await grace(page).fill('1');
    await save(page).click();
    await expect(saved(page)).toBeVisible();
    await expect.poll(() => settingsRow(db)).toEqual({ ...untouched, g: 1 });
    await grace(page).fill('90');
    await critical(page).fill('50');
    await save(page).click();
    await expect.poll(() => settingsRow(db)).toEqual({ ...untouched, c: 50, g: 90 });
    await page.reload();
    await expect(critical(page)).toHaveValue('50');
    await expect(grace(page)).toHaveValue('90');
  });

  test('erro do servidor ao salvar mostra mensagem amigável, sem "salvo" e sem texto cru', async ({ page, db, loginAs }) => {
    await openSettings(page, db, loginAs);
    await page.route('**/rest/v1/app_settings*', (route) => {
      if (route.request().method() !== 'PATCH') return route.continue();
      return route.fulfill({
        status: 500, contentType: 'application/json',
        body: JSON.stringify({ code: 'XX000', message: 'relation "app_settings" corrompida' }),
      });
    });
    await grace(page).fill('10');
    await save(page).click();

    await expect(page.getByRole('alert').first()).toBeVisible();
    await expect(page.locator('body')).not.toContainText('corrompida');
    await expect(saved(page)).toHaveCount(0);
    expect((await settingsRow(db)).g).toBe(7);
  });

  test('líder não vê os parâmetros e a API recusa a alteração direta', async ({ page, db, loginAs }) => {
    await db.createUser('coordinator', 'Carla Coordenadora');
    await loginAs(await db.createUser('leader', 'Lia Lider'));
    await page.goto('/settings');
    await expect(page.getByRole('heading', { name: 'Meu perfil' })).toBeVisible();
    await expect(critical(page)).toHaveCount(0);
    await expect(grace(page)).toHaveCount(0);

    const res = await api(page, 'PATCH', 'app_settings?id=eq.true', { critical_absence_threshold: 1, followup_grace_days: 1 });
    expect(res.status >= 400 || (Array.isArray(res.body) && res.body.length === 0)).toBe(true); // recusado ou 0 linhas (RLS)
    expect(await settingsRow(db)).toEqual({ a: 3, c: 6, l: 70, g: 7 });
  });
});

test.describe('Configurações — efeito real nos alertas e na situação', () => {
  /** Ana falta 4 vezes seguidas (padrão: atenção, pois o crítico é 6); Bia sempre presente. */
  async function seedFourAbsences(db: TestDb) {
    const coord = await db.createUser('coordinator', 'Carla Coordenadora');
    const group = await db.createGroup('Grupo Alfa', coord.id);
    await db.sql(`UPDATE app_settings SET low_attendance_threshold = 0`); // isola o critério das faltas
    const ana = await db.createYouth('Ana Souza', group);
    const bia = await db.createYouth('Bia Lima', group);
    for (let i = 0; i < 4; i++) {
      const ev = await db.createEvent(`Culto ${i + 1}`, daysFromNow(-28 + i * 7), [group], 'completed');
      await db.recordAttendance(ev, ana, group, false, coord.id);
      await db.recordAttendance(ev, bia, group, true, coord.id);
    }
    return { coord, group, ana, bia };
  }
  const selo = (page: Page, name: string) => page.locator('tbody tr', { hasText: name }).getByTestId('situacao-selo');

  test('mudar o limite crítico muda a severidade do alerta e a situação do jovem (e voltar desfaz)', async ({ page, db, loginAs }) => {
    const s = await seedFourAbsences(db);
    await loginAs(s.coord);

    // padrão (crítico = 6): 4 faltas = Atenção
    await page.goto('/alertas');
    await expect(items(page)).toHaveCount(1);
    await expect(byType(page, 'consecutive_absences')).toHaveAttribute('data-severidade', 'attention');
    await expect(byType(page, 'consecutive_absences')).toContainText('Atenção');
    await page.goto('/jovens');
    await expect(selo(page, 'Ana Souza')).toHaveAttribute('data-situacao', 'attention');

    // crítico = 4: o MESMO alerta passa a Crítico (não é recriado)
    const [before] = await db.sql<{ id: string }>(`SELECT id FROM alerts`);
    await page.goto('/settings');
    await critical(page).fill('4');
    await save(page).click();
    await expect(saved(page)).toBeVisible();
    await expect.poll(async () => (await db.sql(`SELECT severity::text AS s FROM alerts`))[0].s).toBe('critical');
    expect(await db.sql<{ id: string }>(`SELECT id FROM alerts`)).toEqual([{ id: before.id }]);

    await page.goto('/alertas');
    await expect(byType(page, 'consecutive_absences')).toHaveAttribute('data-severidade', 'critical');
    await expect(byType(page, 'consecutive_absences')).toContainText('Crítico');
    await page.goto('/jovens');
    await expect(selo(page, 'Ana Souza')).toHaveAttribute('data-situacao', 'critical');
    await expect(selo(page, 'Ana Souza')).toHaveText('Crítico');
    await expect(selo(page, 'Bia Lima')).toHaveAttribute('data-situacao', 'normal');

    // sobe o crítico de volta para 5: 4 faltas deixam de ser críticas
    await page.goto('/settings');
    await critical(page).fill('5');
    await save(page).click();
    await expect(saved(page)).toBeVisible();
    await expect.poll(async () => (await db.sql(`SELECT severity::text AS s FROM alerts`))[0].s).toBe('attention');
    await page.goto('/jovens');
    await expect(selo(page, 'Ana Souza')).toHaveAttribute('data-situacao', 'attention');
  });

  test('subir o limite para gerar alerta acima das faltas resolve o alerta aberto e o menu atualiza sem recarregar', async ({ page, db, loginAs }) => {
    const s = await seedFourAbsences(db);
    await loginAs(s.coord);
    await page.goto('/settings');
    const alertasLink = page.locator('aside nav').getByRole('link', { name: /Alertas/ });
    await expect(alertasLink).toContainText('1');

    // 5 faltas para gerar alerta (crítico acompanha em 6): a Ana tem 4 -> sem alerta
    await absence(page).fill('5');
    await save(page).click();
    await expect(saved(page)).toBeVisible();
    await expect.poll(async () => (await db.sql(`SELECT status::text AS s FROM alerts`))[0].s).toBe('resolved');
    await expect(alertasLink).not.toContainText('1');
    await page.goto('/jovens');
    await expect(selo(page, 'Ana Souza')).toHaveAttribute('data-situacao', 'normal');

    // desce de novo para 4: o alerta volta (um novo, porque o anterior foi encerrado)
    await page.goto('/settings');
    await absence(page).fill('4');
    await critical(page).fill('6');
    await save(page).click();
    await expect(saved(page)).toBeVisible();
    await expect.poll(async () => (await db.sql(`SELECT 1 FROM alerts WHERE status = 'open'`)).length).toBe(1);
    await expect(alertasLink).toContainText('1');
  });

  test('a carência define quando nasce o "sem acompanhamento": reduzir cria, aumentar encerra', async ({ page, db, loginAs }) => {
    const s = await seedFourAbsences(db);
    await db.ageAlerts('consecutive_absences', 4); // alerta de faltas aberto há 4 dias
    await loginAs(s.coord);

    // carência padrão = 7 dias: 4 dias ainda estão dentro
    await page.goto('/alertas');
    await expect(items(page)).toHaveCount(1);
    await expect(byType(page, 'no_followup')).toHaveCount(0);

    // carência = 3: o banco cria o "sem acompanhamento há 4 dias" já ao salvar (sem esperar a próxima varredura)
    await page.goto('/settings');
    await grace(page).fill('3');
    await save(page).click();
    await expect(saved(page)).toBeVisible();
    await expect.poll(async () => (await db.sql(`SELECT 1 FROM alerts WHERE type = 'no_followup' AND status = 'open'`)).length).toBe(1);

    await page.locator('aside nav').getByRole('link', { name: /Alertas/ }).click();
    await expect(items(page)).toHaveCount(2);
    await expect(byType(page, 'no_followup').getByTestId('alerta-descricao')).toHaveText('Sem acompanhamento há 4 dias');
    await expect(page.locator('aside nav').getByRole('link', { name: /Alertas/ })).toContainText('2');

    // carência = 10: a condição deixa de valer e o alerta é encerrado automaticamente
    await page.locator('aside nav').getByRole('link', { name: /Configurações/ }).click();
    await grace(page).fill('10');
    await save(page).click();
    await expect(saved(page)).toBeVisible();
    await expect.poll(async () => (await db.sql(`SELECT status::text AS s FROM alerts WHERE type = 'no_followup'`))[0].s).toBe('resolved');
    await page.locator('aside nav').getByRole('link', { name: /Alertas/ }).click();
    await expect(items(page)).toHaveCount(1);
    await expect(byType(page, 'no_followup')).toHaveCount(0);
  });
});
