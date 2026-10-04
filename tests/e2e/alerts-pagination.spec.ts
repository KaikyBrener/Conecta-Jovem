// Alertas paginados NO SERVIDOR (25 por página) e contador do menu. Os alertas são inseridos direto no banco
// (cenário de volume), com tipos/severidades/estados misturados e created_at distintos para a ordem ser determinística
// (created_at desc: "Jovem 001" é o mais novo). A tela, o PostgREST falso e o RLS/triggers são os reais.
import type { Page } from '@playwright/test';
import {
  daysFromNow, expect, markAbsent, openYouthSheet, test, type TestDb,
} from './fixtures.ts';
import { bulkYouth } from './phase7-helpers.ts';

const items = (page: Page) => page.getByTestId('alerta-item');
const nav = (page: Page) => page.getByRole('navigation', { name: 'Paginação' });
const next = (page: Page) => nav(page).getByRole('button', { name: 'Próxima' });
const prev = (page: Page) => nav(page).getByRole('button', { name: 'Anterior' });
const type = (page: Page, label: string) => page.getByLabel('Filtrar por tipo').selectOption({ label });
const severity = (page: Page, label: string) => page.getByLabel('Filtrar por severidade').selectOption({ label });
const chip = (page: Page, name: string | RegExp) => page.getByRole('button', { name, exact: typeof name === 'string' });
const sidebarAlerts = (page: Page) => page.locator('aside nav').getByRole('link', { name: /Alertas/ });
/** Número do selo do menu ('' = sem selo). */
const badge = async (page: Page) => (await sidebarAlerts(page).innerText()).replace('Alertas', '').trim();

/**
 * 45 jovens "Jovem 001".."Jovem 045" (grupo Alfa), um alerta cada, do mais novo (001) ao mais antigo:
 *   001-027  faltas seguidas, abertos, CRÍTICO      028-030  faltas seguidas, abertos, atenção
 *   031-034  frequência baixa, abertos              035-037  queda de frequência, abertos
 *   038-043  faltas seguidas, resolvidos            044-045  faltas seguidas, dispensados
 * => 37 abertos (30 de faltas, 27 críticos), 6 resolvidos, 2 dispensados, 45 no total.
 */
async function seedMixedAlerts(db: TestDb) {
  const coord = await db.createUser('coordinator', 'Carla Coordenadora');
  const group = await db.createGroup('Grupo Alfa', coord.id);
  await bulkYouth(db, 'Jovem', 45, group);
  await db.sql(
    `INSERT INTO alerts (youth_id, group_id, type, status, severity, consecutive_absences, attendance_rate, previous_rate,
                         sample_size, created_at, resolved_at)
     SELECT y.id, y.group_id,
            (CASE WHEN y.n <= 30 OR y.n > 37 THEN 'consecutive_absences' WHEN y.n <= 34 THEN 'low_attendance'
                  ELSE 'attendance_drop' END)::alert_type,
            (CASE WHEN y.n <= 37 THEN 'open' WHEN y.n <= 43 THEN 'resolved' ELSE 'dismissed' END)::alert_status,
            (CASE WHEN y.n <= 27 THEN 'critical' ELSE 'attention' END)::alert_severity,
            CASE WHEN y.n <= 30 OR y.n > 37 THEN (CASE WHEN y.n <= 27 THEN 7 ELSE 3 END) ELSE 0 END,
            CASE WHEN y.n BETWEEN 31 AND 34 THEN 40 WHEN y.n BETWEEN 35 AND 37 THEN 25 END,
            CASE WHEN y.n BETWEEN 35 AND 37 THEN 100 END,
            CASE WHEN y.n BETWEEN 31 AND 34 THEN 8 WHEN y.n BETWEEN 35 AND 37 THEN 4 END,
            now() - y.n * interval '1 minute',
            CASE WHEN y.n > 37 THEN now() END
       FROM (SELECT id, group_id, row_number() OVER (ORDER BY full_name)::int AS n FROM youth) y`);
  expect(await db.sql(`SELECT status::text AS s, count(*)::int AS n FROM alerts GROUP BY 1 ORDER BY 1`))
    .toEqual([{ s: 'dismissed', n: 2 }, { s: 'open', n: 37 }, { s: 'resolved', n: 6 }]);
  return { coord, group };
}

test.describe('Alertas — paginação no servidor', () => {
  test('1ª, próxima e última página dos abertos; contador "Abertos" = selo do menu = total', async ({ page, db, loginAs }) => {
    const s = await seedMixedAlerts(db);
    await loginAs(s.coord);
    const listRequests: string[] = [];
    page.on('request', (r) => {
      if (r.method() === 'GET' && /\/rest\/v1\/alerts\?/.test(r.url()) && !r.url().includes('head=true')) {
        listRequests.push(decodeURIComponent(r.url()));
      }
    });
    await page.goto('/alertas');

    await expect(items(page)).toHaveCount(25);
    await expect(items(page).first()).toContainText('Jovem 001');
    await expect(items(page).last()).toContainText('Jovem 025');
    await expect(nav(page)).toContainText('Mostrando 1–25 de 37 alertas');
    await expect(nav(page)).toContainText('Página 1 de 2');
    await expect(prev(page)).toBeDisabled();
    await expect(chip(page, 'Abertos (37)')).toBeVisible();
    await expect.poll(() => badge(page)).toBe('37');

    await next(page).click();
    await expect(nav(page)).toContainText('Página 2 de 2');
    await expect(nav(page)).toContainText('Mostrando 26–37 de 37 alertas');
    await expect(items(page)).toHaveCount(12);
    await expect(items(page).first()).toContainText('Jovem 026');
    await expect(items(page).last()).toContainText('Jovem 037');
    await expect(next(page)).toBeDisabled();
    // o contador do cabeçalho e o do menu NÃO dependem da página nem dos filtros
    await expect(chip(page, 'Abertos (37)')).toBeVisible();
    expect(await badge(page)).toBe('37');

    await prev(page).click();
    await expect(items(page)).toHaveCount(25);
    await expect(items(page).first()).toContainText('Jovem 001');

    // a paginação é do servidor: cada página foi pedida com limit/offset (e não fatiada no cliente)
    expect(listRequests.some((u) => /[?&]limit=25(&|$)/.test(u) && /[?&]offset=0(&|$)/.test(u)), listRequests.join('\n')).toBe(true);
    expect(listRequests.some((u) => /[?&]offset=25(&|$)/.test(u)), listRequests.join('\n')).toBe(true);
  });

  test('filtro de tipo + paginação: o total e as páginas refletem o filtro', async ({ page, db, loginAs }) => {
    const s = await seedMixedAlerts(db);
    await loginAs(s.coord);
    await page.goto('/alertas');
    await expect(items(page)).toHaveCount(25);

    await type(page, 'Faltas seguidas');
    await expect(nav(page)).toContainText('Mostrando 1–25 de 30 alertas');
    await next(page).click();
    await expect(items(page)).toHaveCount(5);
    await expect(items(page).first()).toContainText('Jovem 026');
    await expect(items(page).last()).toContainText('Jovem 030'); // 031+ são de outros tipos
    await expect(chip(page, 'Abertos (37)')).toBeVisible(); // o contador ignora os filtros de tipo/severidade
    expect(await badge(page)).toBe('37');

    await type(page, 'Frequência baixa');
    await expect(items(page)).toHaveCount(4);
    await expect(nav(page)).toHaveCount(0); // cabe em uma página: sem paginação
    await type(page, 'Frequência em queda');
    await expect(items(page)).toHaveCount(3);
  });

  test('filtro de severidade + paginação, combinável com tipo', async ({ page, db, loginAs }) => {
    const s = await seedMixedAlerts(db);
    await loginAs(s.coord);
    await page.goto('/alertas');

    await severity(page, 'Crítico');
    await expect(nav(page)).toContainText('Mostrando 1–25 de 27 alertas');
    for (const row of await items(page).all()) await expect(row).toHaveAttribute('data-severidade', 'critical');
    await next(page).click();
    await expect(items(page)).toHaveCount(2);
    await expect(items(page).last()).toContainText('Jovem 027');

    await severity(page, 'Atenção');
    await expect(items(page)).toHaveCount(10); // 028-030 (faltas) + 031-034 (baixa) + 035-037 (queda)
    await expect(nav(page)).toHaveCount(0);
    for (const row of await items(page).all()) await expect(row).toHaveAttribute('data-severidade', 'attention');

    await type(page, 'Faltas seguidas');
    await expect(items(page)).toHaveCount(3);
    await expect(items(page).first()).toContainText('Jovem 028');
    await type(page, 'Todos os tipos');
    await severity(page, 'Qualquer severidade');
    await expect(nav(page)).toContainText('de 37 alertas');
  });

  test('status: Resolvidos, Dispensados e Todos paginam o histórico; mudar o filtro volta à página 1', async ({ page, db, loginAs }) => {
    const s = await seedMixedAlerts(db);
    await loginAs(s.coord);
    await page.goto('/alertas');

    await chip(page, 'Resolvidos').click();
    await expect(items(page)).toHaveCount(6);
    await expect(items(page).first()).toContainText('Jovem 038');
    await expect(items(page).first()).toContainText('Resolvido');
    await chip(page, 'Dispensados').click();
    await expect(items(page)).toHaveCount(2);

    await chip(page, 'Todos').click();
    await expect(nav(page)).toContainText('Mostrando 1–25 de 45 alertas');
    await next(page).click();
    await expect(nav(page)).toContainText('Página 2 de 2');
    await expect(items(page)).toHaveCount(20);
    await expect(items(page).last()).toContainText('Jovem 045');
    await expect(items(page).last()).toContainText('Dispensado');

    // mudar QUALQUER filtro (status, tipo ou severidade) volta à página 1
    await type(page, 'Faltas seguidas');
    await expect(nav(page)).toContainText('Página 1 de 2');
    await expect(nav(page)).toContainText('de 38 alertas'); // 30 abertos + 6 resolvidos + 2 dispensados
    await next(page).click();
    await expect(nav(page)).toContainText('Página 2 de 2');
    await severity(page, 'Crítico');
    await expect(nav(page)).toContainText('Página 1 de 2');
    await expect(nav(page)).toContainText('de 27 alertas');
    await next(page).click();
    await chip(page, /^Abertos/).click();
    await expect(nav(page)).toContainText('Página 1 de 2');
    await expect(items(page).first()).toContainText('Jovem 001');
  });

  test('estado vazio: filtro sem resultado mostra a mensagem e some a paginação', async ({ page, db, loginAs }) => {
    const s = await seedMixedAlerts(db);
    await loginAs(s.coord);
    await page.goto('/alertas');
    await next(page).click();
    await expect(nav(page)).toContainText('Página 2 de 2');

    await type(page, 'Ação atrasada');
    await expect(items(page)).toHaveCount(0);
    await expect(page.getByText('Nenhum alerta encontrado.')).toBeVisible();
    await expect(nav(page)).toHaveCount(0);
    await expect(chip(page, 'Abertos (37)')).toBeVisible();

    await type(page, 'Todos os tipos');
    await expect(nav(page)).toContainText('Página 1 de 2'); // voltou à 1ª, não à página 2 de antes
  });

  test('sem nenhum alerta: "Tudo em dia!", contador 0 e nenhum selo no menu', async ({ page, db, loginAs }) => {
    await loginAs(await db.createUser('coordinator', 'Carla Coordenadora'));
    await page.goto('/alertas');
    await expect(page.getByText('Nenhum alerta aberto. Tudo em dia!')).toBeVisible();
    await expect(chip(page, 'Abertos (0)')).toBeVisible();
    await expect(nav(page)).toHaveCount(0);
    expect(await badge(page)).toBe('');
  });

  test('a página que esvazia volta para a última existente (resolver o único alerta da última página)', async ({ page, db, loginAs }) => {
    const coord = await db.createUser('coordinator', 'Carla Coordenadora');
    const group = await db.createGroup('Grupo Alfa', coord.id);
    await bulkYouth(db, 'Jovem', 26, group);
    await db.sql(
      `INSERT INTO alerts (youth_id, group_id, type, status, severity, consecutive_absences, created_at)
       SELECT y.id, y.group_id, 'consecutive_absences', 'open', 'attention', 3, now() - y.n * interval '1 minute'
         FROM (SELECT id, group_id, row_number() OVER (ORDER BY full_name)::int AS n FROM youth) y`);
    await loginAs(coord);
    await page.goto('/alertas');

    await expect(nav(page)).toContainText('de 26 alertas');
    await next(page).click();
    await expect(items(page)).toHaveCount(1);
    await expect(items(page)).toContainText('Jovem 026');

    await items(page).getByRole('button', { name: 'Resolver' }).click();
    await page.getByLabel('Observações').fill('Tratado.');
    await page.getByRole('button', { name: 'Confirmar' }).click();
    await expect(page.getByText('Alerta resolvido.')).toBeVisible();

    // página 2 ficou vazia: vai para a única página que sobrou, com 25 alertas, sem paginação
    await expect(items(page)).toHaveCount(25);
    await expect(items(page).first()).toContainText('Jovem 001');
    await expect(nav(page)).toHaveCount(0);
    await expect(chip(page, 'Abertos (25)')).toBeVisible();
    await expect.poll(() => badge(page)).toBe('25');
    expect(await db.sql(`SELECT 1 FROM alerts WHERE status = 'open'`)).toHaveLength(25);
  });

  test('ao esvaziar a última página com 3 páginas, volta para a página 2 (a última que existe)', async ({ page, db, loginAs }) => {
    const coord = await db.createUser('coordinator', 'Carla Coordenadora');
    const group = await db.createGroup('Grupo Alfa', coord.id);
    await bulkYouth(db, 'Jovem', 51, group);
    await db.sql(
      `INSERT INTO alerts (youth_id, group_id, type, status, severity, consecutive_absences, created_at)
       SELECT y.id, y.group_id, 'consecutive_absences', 'open', 'attention', 3, now() - y.n * interval '1 minute'
         FROM (SELECT id, group_id, row_number() OVER (ORDER BY full_name)::int AS n FROM youth) y`);
    await loginAs(coord);
    await page.goto('/alertas');
    await next(page).click();
    await next(page).click();
    await expect(nav(page)).toContainText('Página 3 de 3');
    await expect(items(page)).toHaveCount(1);

    await items(page).getByRole('button', { name: 'Dispensar' }).click();
    await page.getByLabel('Observações').fill('Viajou.');
    await page.getByRole('button', { name: 'Confirmar' }).click();
    await expect(page.getByText('Alerta dispensado.')).toBeVisible();

    await expect(nav(page)).toContainText('Página 2 de 2');
    await expect(nav(page)).toContainText('Mostrando 26–50 de 50 alertas');
    await expect(items(page)).toHaveCount(25);
    await expect(items(page).first()).toContainText('Jovem 026');
  });

  test('líder: pagina e conta só os alertas do próprio grupo (RLS), inclusive o selo do menu', async ({ page, db, loginAs }) => {
    const carla = await db.createUser('coordinator', 'Carla Coordenadora');
    const lia = await db.createUser('leader', 'Lia Lider');
    const davi = await db.createUser('leader', 'Davi Lider');
    const alfa = await db.createGroup('Grupo Alfa', lia.id);
    const beta = await db.createGroup('Grupo Beta', davi.id);
    await bulkYouth(db, 'Alfa', 30, alfa);
    await bulkYouth(db, 'Beta', 40, beta);
    await db.sql(
      `INSERT INTO alerts (youth_id, group_id, type, status, severity, consecutive_absences, created_at)
       SELECT y.id, y.group_id, 'consecutive_absences', 'open', 'attention', 3,
              now() - row_number() OVER (ORDER BY full_name) * interval '1 minute'
         FROM youth y`);
    expect(carla).toBeTruthy();
    await loginAs(lia);
    await page.goto('/alertas');

    await expect(nav(page)).toContainText('Mostrando 1–25 de 30 alertas');
    await expect(chip(page, 'Abertos (30)')).toBeVisible();
    await expect.poll(() => badge(page)).toBe('30');
    await next(page).click();
    await expect(items(page)).toHaveCount(5);
    await expect(page.getByText(/Beta \d{3}/)).toHaveCount(0);
  });
});

test.describe('Selo de alertas do menu acompanha mudanças feitas em outras telas (sem recarregar)', () => {
  /** Ana e Dani com 3 faltas seguidas cada (alerta de faltas aberto para as duas); Bia sempre presente. */
  async function seedTwoAlerts(db: TestDb) {
    const coord = await db.createUser('coordinator', 'Carla Coordenadora');
    const group = await db.createGroup('Grupo Alfa', coord.id);
    await db.sql(`UPDATE app_settings SET low_attendance_threshold = 0`); // só alertas de faltas
    const ana = await db.createYouth('Ana Souza', group);
    const dani = await db.createYouth('Dani Rocha', group);
    const bia = await db.createYouth('Bia Lima', group);
    const events: string[] = [];
    for (let i = 0; i < 3; i++) {
      const ev = await db.createEvent(`Culto ${i + 1}`, daysFromNow(-21 + i * 7), [group], 'completed');
      events.push(ev);
      await db.recordAttendance(ev, ana, group, false, coord.id);
      await db.recordAttendance(ev, dani, group, false, coord.id);
      await db.recordAttendance(ev, bia, group, true, coord.id);
    }
    expect(await db.sql(`SELECT 1 FROM alerts WHERE status = 'open'`)).toHaveLength(2);
    return { coord, group, ana, dani, bia, events };
  }

  test('desativar um jovem resolve o alerta dele e o selo cai de 2 para 1; reativar não o recria sozinho', async ({ page, db, loginAs }) => {
    const s = await seedTwoAlerts(db);
    await loginAs(s.coord);
    await page.goto('/jovens');
    await expect.poll(() => badge(page)).toBe('2');

    const sheet = await openYouthSheet(page, 'Ana Souza');
    await sheet.getByRole('button', { name: 'Desativar' }).click();
    await expect(page.getByText('Jovem desativado.')).toBeVisible();

    // mesma página, sem recarregar: o selo recontou
    await expect.poll(() => badge(page)).toBe('1');
    const rows = await db.sql<{ name: string; status: string }>(
      `SELECT y.full_name AS name, a.status::text AS status FROM alerts a JOIN youth y ON y.id = a.youth_id ORDER BY y.full_name`);
    expect(rows).toEqual([{ name: 'Ana Souza', status: 'resolved' }, { name: 'Dani Rocha', status: 'open' }]);

    // o selo é o mesmo número da tela de Alertas
    await sidebarAlerts(page).click();
    await expect(chip(page, 'Abertos (1)')).toBeVisible();
    await expect(items(page)).toHaveCount(1);
    await expect(items(page)).toContainText('Dani Rocha');
  });

  test('cancelar um encontro (editando o status) recalcula as faltas e o selo atualiza na hora', async ({ page, db, loginAs }) => {
    const s = await seedTwoAlerts(db);
    await loginAs(s.coord);
    await page.goto('/encontros');
    await expect.poll(() => badge(page)).toBe('2');

    // cancelar o último encontro: Ana e Dani passam a ter só 2 faltas seguidas (< limite 3) e os alertas se resolvem
    await page.getByRole('button', { name: 'Culto 3' }).first().click();
    await page.locator('div.fixed.inset-0').last().getByRole('button', { name: 'Editar', exact: true }).click();
    const form = page.locator('div.fixed.inset-0').last();
    await expect(form.getByRole('heading', { name: 'Editar Encontro' })).toBeVisible();
    await form.locator('select').first().selectOption({ label: 'Cancelado' });
    await form.getByRole('button', { name: 'Salvar alterações' }).click();
    await expect(page.getByRole('heading', { name: 'Editar Encontro' })).toBeHidden();

    await expect.poll(() => badge(page)).toBe('');
    expect(await db.sql(`SELECT status::text AS s FROM alerts ORDER BY id`)).toEqual([{ s: 'resolved' }, { s: 'resolved' }]);
    await sidebarAlerts(page).click();
    await expect(page.getByText('Nenhum alerta aberto. Tudo em dia!')).toBeVisible();
  });

  test('salvar uma chamada que completa o limite faz o selo subir de 0 para 1 sem recarregar', async ({ page, db, loginAs }) => {
    const coord = await db.createUser('coordinator', 'Carla Coordenadora');
    const group = await db.createGroup('Grupo Alfa', coord.id);
    await db.sql(`UPDATE app_settings SET low_attendance_threshold = 0`);
    const eva = await db.createYouth('Eva Costa', group);
    for (const d of [-14, -7]) {
      const ev = await db.createEvent(`Culto ${d}`, daysFromNow(d), [group], 'completed');
      await db.recordAttendance(ev, eva, group, false, coord.id);
    }
    const e3 = await db.createEvent('Culto de hoje', daysFromNow(-1), [group], 'scheduled');
    await loginAs(coord);
    await page.goto(`/chamada/${e3}`);
    await expect(page.getByTestId('chamada-jovem')).toHaveCount(1);
    expect(await badge(page)).toBe('');

    await markAbsent(page, 'Eva Costa');
    await page.getByRole('button', { name: 'Salvar Chamada' }).click();
    await expect(page.getByTestId('chamada-novos-alertas')).toContainText('Eva Costa');
    await expect.poll(() => badge(page)).toBe('1');
  });
});
