// Encontros recorrentes (Fase 7, bloco 8): RPCs create/extend/set_series_groups/cancel_event_series_future reais
// (migration 014). Datas fixas em 2030 (sábados: 5, 12, 19 e 26/jan; 2, 9, 16 e 23/fev) para o resultado ser
// determinístico e sempre futuro.
import type { Page } from '@playwright/test';
import { answerConfirmation, api, expect, injectSession, modal, passwordSession, test, type TestDb } from './fixtures.ts';
import { APP_URL } from './env.ts';
import { seedPeople } from './phase7-helpers.ts';

const SERIES = 'Culto de Jovens';

async function openNewSeries(page: Page) {
  await page.goto('/encontros');
  await page.getByTestId('serie-nova').click();
  await expect(modal(page).getByRole('heading', { name: 'Nova série de encontros' })).toBeVisible();
}

interface Form {
  name?: string;
  weekday?: string;
  time?: string;
  recurrence?: string;
  start?: string;
  end?: string;
  groups?: string[] | 'later';
}

async function fillSeries(page: Page, f: Form) {
  const m = modal(page);
  if (f.name !== undefined) await m.getByLabel('Nome da série').fill(f.name);
  if (f.weekday) await m.getByLabel('Dia da semana').selectOption({ label: f.weekday });
  if (f.time) await m.getByLabel('Horário').fill(f.time);
  if (f.recurrence) await m.getByLabel('Recorrência').selectOption({ label: f.recurrence });
  if (f.start) await m.getByLabel('Data inicial').fill(f.start);
  if (f.end) await m.getByLabel('Data final').fill(f.end);
  if (f.groups === 'later') await m.getByLabel('Definir depois').check();
  else if (f.groups) for (const g of f.groups) await m.getByLabel(g, { exact: true }).check();
}

const weekly: Form = { name: SERIES, weekday: 'Sábado', time: '19:00', start: '2030-01-01', end: '2030-01-31' };

async function review(page: Page, f: Form) {
  await fillSeries(page, f);
  await modal(page).getByTestId('serie-revisar').click();
}

async function seed(db: TestDb) {
  const p = await seedPeople(db);
  const ana = await db.createYouth('Ana Souza', p.alfa);
  return { ...p, ana };
}

const seriesEvents = (db: TestDb) =>
  db.sql<{ status: string; series_date: string; hh: string; groups: number }>(
    `SELECT e.status::text AS status, e.series_date::text AS series_date,
            to_char(e.event_date AT TIME ZONE 'America/Sao_Paulo', 'HH24:MI') AS hh,
            (SELECT count(*)::int FROM event_groups g WHERE g.event_id = e.id) AS groups
       FROM events e WHERE e.series_id IS NOT NULL ORDER BY e.series_date`);

test.describe('Séries — criar', () => {
  test('semanal: prévia, confirmação, encontros com selo "Série: nome" e grupos aplicados', async ({ page, db, loginAs }) => {
    const s = await seed(db);
    await loginAs(s.carla);
    await openNewSeries(page);
    await review(page, { ...weekly, groups: ['Grupo Alfa'] });

    const m = modal(page);
    await expect(m.getByTestId('serie-previa-total')).toHaveText('Serão criados 4 encontros.');
    await expect(m).toContainText('toda semana (sábado) às 19:00');
    await expect(m).toContainText('De 05/01/2030 a 26/01/2030');
    await expect(m.getByRole('list', { name: 'Datas dos encontros' }).locator('li')).toHaveText([
      'sáb, 05/01/2030', 'sáb, 12/01/2030', 'sáb, 19/01/2030', 'sáb, 26/01/2030',
    ]);
    await expect(m).toContainText('Grupos: Grupo Alfa.');
    // nada foi criado ainda
    expect(await seriesEvents(db)).toHaveLength(0);

    await m.getByTestId('serie-confirmar').click();
    await expect(page.getByText('Série criada: 4 encontros criados.')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Nova série de encontros' })).toHaveCount(0);

    const rows = await seriesEvents(db);
    expect(rows.map((r) => r.series_date)).toEqual(['2030-01-05', '2030-01-12', '2030-01-19', '2030-01-26']);
    expect(rows.every((r) => r.status === 'scheduled' && r.hh === '19:00' && r.groups === 1)).toBe(true);

    // lista: 4 encontros com o selo, sem "Grupos pendentes"
    await page.getByPlaceholder('Buscar por título...').fill(SERIES);
    const lines = page.locator('tbody tr');
    await expect(lines).toHaveCount(4);
    await expect(lines.first()).toContainText(`Série: ${SERIES}`);
    await expect(lines.first()).toContainText('Grupo Alfa');
    await expect(page.getByText('Grupos pendentes')).toHaveCount(0);

    // histórico registra uma entrada da série
    const log = await db.sql(`SELECT action FROM activity_log WHERE action = 'event_series_created'`);
    expect(log).toHaveLength(1);
  });

  test('quinzenal e mensal (1º sábado do mês): prévias e datas do banco', async ({ page, db, loginAs }) => {
    const s = await seed(db);
    await loginAs(s.carla);

    await openNewSeries(page);
    await review(page, { ...weekly, name: 'Quinzenal', recurrence: 'Quinzenal', groups: ['Grupo Alfa'] });
    await expect(modal(page).getByTestId('serie-previa-total')).toHaveText('Serão criados 2 encontros.');
    await expect(modal(page)).toContainText('a cada 14 dias (sábado)');
    await modal(page).getByTestId('serie-confirmar').click();
    await expect(page.getByText('Série criada: 2 encontros criados.')).toBeVisible();

    await openNewSeries(page);
    await review(page, {
      name: 'Mensal', weekday: 'Sábado', time: '10:30', recurrence: 'Mensal (N-ésimo dia da semana)',
      start: '2030-01-01', end: '2030-04-30', groups: ['Grupo Beta'],
    });
    await expect(modal(page).getByTestId('serie-previa-total')).toHaveText('Serão criados 4 encontros.');
    await expect(modal(page)).toContainText('1º sábado de cada mês');
    await expect(modal(page).getByRole('list', { name: 'Datas dos encontros' }).locator('li')).toHaveText([
      'sáb, 05/01/2030', 'sáb, 02/02/2030', 'sáb, 02/03/2030', 'sáb, 06/04/2030',
    ]);
    await modal(page).getByTestId('serie-confirmar').click();
    await expect(page.getByText('Série criada: 4 encontros criados.')).toBeVisible();

    const q = await db.sql<{ name: string; dates: string; hh: string }>(
      `SELECT s.name, string_agg(e.series_date::text, ',' ORDER BY e.series_date) AS dates,
              min(to_char(e.event_date AT TIME ZONE 'America/Sao_Paulo', 'HH24:MI')) AS hh
         FROM events e JOIN event_series s ON s.id = e.series_id GROUP BY s.name ORDER BY s.name`);
    expect(q).toEqual([
      { name: 'Mensal', dates: '2030-01-05,2030-02-02,2030-03-02,2030-04-06', hh: '10:30' },
      { name: 'Quinzenal', dates: '2030-01-05,2030-01-19', hh: '19:00' },
    ]);
  });

  test('uma única data usa o singular', async ({ page, db, loginAs }) => {
    const s = await seed(db);
    await loginAs(s.carla);
    await openNewSeries(page);
    await review(page, { ...weekly, end: '2030-01-05', groups: ['Grupo Alfa'] });
    await expect(modal(page).getByTestId('serie-previa-total')).toHaveText('Será criado 1 encontro.');
    await expect(modal(page).getByTestId('serie-confirmar')).toHaveText('Confirmar e criar 1 encontro');
  });

  test('validações do formulário, na ordem, e "Voltar" mantém os dados', async ({ page, db, loginAs }) => {
    const s = await seed(db);
    await loginAs(s.carla);
    await openNewSeries(page);
    const m = modal(page);
    const go = () => m.getByTestId('serie-revisar').click();
    const error = () => m.getByRole('alert');

    await go();
    await expect(error()).toHaveText('Informe o nome da série.');
    await fillSeries(page, { name: SERIES });
    await go();
    await expect(error()).toHaveText('Escolha o dia da semana.');
    await fillSeries(page, { weekday: 'Sábado' });
    await go();
    await expect(error()).toHaveText('Informe o horário do encontro.');
    await fillSeries(page, { time: '19:00', start: '2030-01-01', end: '' });
    await go();
    await expect(error()).toHaveText('Informe a data inicial e a data final da série.');
    await fillSeries(page, { end: '2029-12-01' });
    await go();
    await expect(error()).toHaveText('A data final não pode ser anterior à data inicial.');
    await fillSeries(page, { end: '2033-01-01' });
    await go();
    await expect(error()).toHaveText('O período da série não pode passar de 2 anos.');
    await fillSeries(page, { end: '2030-01-03' }); // 1º a 3/jan/2030 não tem sábado
    await go();
    await expect(error()).toHaveText('O período informado não contém nenhuma data para este dia da semana.');
    await fillSeries(page, { end: '2030-01-31' });
    await go();
    await expect(error()).toHaveText('Escolha ao menos um grupo ou marque "Definir depois".');
    expect(await seriesEvents(db)).toHaveLength(0);

    await fillSeries(page, { groups: 'later' });
    await go();
    await expect(m.getByTestId('serie-previa-total')).toBeVisible();
    await expect(m).toContainText('Grupos: a definir depois.');
    await m.getByRole('button', { name: 'Voltar' }).click();
    await expect(m.getByLabel('Nome da série')).toHaveValue(SERIES);
    await expect(m.getByLabel('Horário')).toHaveValue('19:00');
    await expect(m.getByLabel('Data final')).toHaveValue('2030-01-31');
  });

  test('erro do servidor ao criar mostra mensagem amigável e não fecha o formulário', async ({ page, db, loginAs }) => {
    const s = await seed(db);
    await loginAs(s.carla);
    await page.route('**/rest/v1/rpc/create_event_series*', (route) =>
      route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ message: 'deadlock detectado em event_series' }) }));
    await openNewSeries(page);
    await review(page, { ...weekly, groups: ['Grupo Alfa'] });
    await modal(page).getByTestId('serie-confirmar').click();
    await expect(modal(page).getByRole('alert')).toHaveText('Erro ao criar a série de encontros.');
    await expect(page.locator('body')).not.toContainText('deadlock');
    await expect(modal(page).getByTestId('serie-confirmar')).toBeEnabled();
  });
});

test.describe('Séries — grupos pendentes', () => {
  test('"Definir depois" marca os encontros, a Chamada avisa e definir os grupos resolve', async ({ page, db, loginAs }) => {
    const s = await seed(db);
    await loginAs(s.carla);
    await openNewSeries(page);
    await review(page, { ...weekly, groups: 'later' });
    await modal(page).getByTestId('serie-confirmar').click();
    await expect(page.getByText('Série criada: 4 encontros criados.')).toBeVisible();
    expect((await seriesEvents(db)).every((r) => r.groups === 0)).toBe(true);

    // lista: selo "Grupos pendentes" em todos
    await page.getByPlaceholder('Buscar por título...').fill(SERIES);
    const lines = page.locator('tbody tr');
    await expect(lines).toHaveCount(4);
    await expect(lines.locator(':text("Grupos pendentes")')).toHaveCount(4);

    // a Chamada avisa que falta vincular grupos
    const [first] = await db.sql<{ id: string }>(`SELECT id FROM events ORDER BY event_date LIMIT 1`);
    await page.goto(`/chamada/${first.id}`);
    await expect(page.getByText('Nenhum grupo vinculado a este encontro. Edite o encontro e selecione os grupos participantes.')).toBeVisible();
    await expect(page.getByText('Ana Souza')).toHaveCount(0);

    // Gerenciar séries: card com "Grupos pendentes" -> definir grupos dos próximos encontros
    await page.goto('/encontros');
    await page.getByTestId('series-gerenciar').click();
    const card = modal(page).getByTestId('serie-item');
    await expect(card).toHaveCount(1);
    await expect(card).toContainText(SERIES);
    await expect(card).toContainText('Ativa');
    await expect(card).toContainText('Grupos pendentes');
    await expect(card).toContainText('Toda semana (sábado) às 19:00');
    await expect(card).toContainText('01/01/2030 a 31/01/2030');
    await card.getByTestId('serie-definir-grupos').click();
    await card.getByTestId('serie-painel-grupos').getByLabel('Grupo Alfa').check();
    await card.getByTestId('serie-aplicar-grupos').click();
    await expect(page.getByText('Grupos aplicados a 4 próximos encontros.')).toBeVisible();
    await expect(card).not.toContainText('Grupos pendentes');
    await expect(card).toContainText('Grupo Alfa');
    expect((await seriesEvents(db)).every((r) => r.groups === 1)).toBe(true);

    // fecha o painel: a lista não tem mais selos pendentes e a chamada lista os jovens do grupo
    await modal(page).getByRole('button', { name: 'Fechar', exact: true }).last().click();
    await page.getByPlaceholder('Buscar por título...').fill(SERIES);
    await expect(page.locator('tbody tr')).toHaveCount(4);
    await expect(page.getByText('Grupos pendentes')).toHaveCount(0);
    await page.goto(`/chamada/${first.id}`);
    await expect(page.getByText('Nenhum grupo vinculado a este encontro.')).toHaveCount(0);
    await expect(page.getByText('Ana Souza')).toBeVisible();
  });

  test('encontro editado individualmente não é alterado ao aplicar grupos à série', async ({ page, db, loginAs }) => {
    const s = await seed(db);
    await loginAs(s.carla);
    await openNewSeries(page);
    await review(page, { ...weekly, groups: 'later' });
    await modal(page).getByTestId('serie-confirmar').click();
    await expect(page.getByText('Série criada: 4 encontros criados.')).toBeVisible();

    // o coordenador edita o 1º encontro pela tela (título novo) => "editado individualmente"
    await page.getByPlaceholder('Buscar por título...').fill(SERIES);
    await page.locator('tbody tr').first().getByRole('button').first().click();
    await modal(page).getByRole('button', { name: 'Editar', exact: true }).click();
    await modal(page).locator('input[type="text"]').first().fill('Culto Especial');
    await modal(page).getByRole('button', { name: 'Salvar alterações' }).click();
    await expect(page.getByText('Encontro atualizado.')).toBeVisible();

    await page.getByTestId('series-gerenciar').click();
    const card = modal(page).getByTestId('serie-item');
    await card.getByTestId('serie-definir-grupos').click();
    await card.getByTestId('serie-painel-grupos').getByLabel('Grupo Alfa').check();
    await card.getByTestId('serie-aplicar-grupos').click();
    await expect(page.getByText('Grupos aplicados a 3 próximos encontros. 1 encontro foi editado individualmente e não foi alterado.')).toBeVisible();
    const rows = await db.sql<{ title: string; groups: number }>(
      `SELECT e.title, (SELECT count(*)::int FROM event_groups g WHERE g.event_id = e.id) AS groups FROM events e ORDER BY e.event_date`);
    // a lista começa pelo encontro mais distante: o editado é identificado pelo título
    expect(rows.filter((r) => r.title === 'Culto Especial').map((r) => r.groups)).toEqual([0]);
    expect(rows.filter((r) => r.title === SERIES).map((r) => r.groups)).toEqual([1, 1, 1]);
  });
});

test.describe('Séries — estender e cancelar', () => {
  async function createViaUi(page: Page) {
    await openNewSeries(page);
    await review(page, { ...weekly, groups: ['Grupo Alfa'] });
    await modal(page).getByTestId('serie-confirmar').click();
    await expect(page.getByText('Série criada: 4 encontros criados.')).toBeVisible();
  }

  test('estender cria só as datas novas; repetir a chamada não duplica', async ({ page, db, loginAs }) => {
    const s = await seed(db);
    await loginAs(s.carla);
    await createViaUi(page);

    await page.getByTestId('series-gerenciar').click();
    const card = modal(page).getByTestId('serie-item');
    await card.getByTestId('serie-estender').click();
    const panel = card.getByTestId('serie-painel-estender');

    // validações: não pode ser igual/anterior ao fim atual, nem passar de 2 anos
    await panel.getByLabel('Nova data final').fill('2030-01-31');
    await panel.getByTestId('serie-confirmar-extensao').click();
    await expect(panel.getByRole('alert')).toHaveText('A nova data final precisa ser posterior à data final atual.');
    await panel.getByLabel('Nova data final').fill('2033-06-01');
    await panel.getByTestId('serie-confirmar-extensao').click();
    await expect(panel.getByRole('alert')).toHaveText('O período da série não pode passar de 2 anos.');
    expect(await seriesEvents(db)).toHaveLength(4);

    await panel.getByLabel('Nova data final').fill('2030-02-28');
    await panel.getByTestId('serie-confirmar-extensao').click();
    await expect(page.getByText('Série estendida: 4 encontros criados.')).toBeVisible();
    let rows = await seriesEvents(db);
    expect(rows.map((r) => r.series_date)).toEqual([
      '2030-01-05', '2030-01-12', '2030-01-19', '2030-01-26', '2030-02-02', '2030-02-09', '2030-02-16', '2030-02-23',
    ]);
    expect(rows.every((r) => r.groups === 1)).toBe(true); // as novas datas herdam os grupos da série
    await expect(card).toContainText('01/01/2030 a 28/02/2030');
    await expect(card.getByText('Encontros', { exact: true }).locator('xpath=following-sibling::dd[1]')).toHaveText('8');

    // repetir (mesma data final) não cria nada; estender de novo para a mesma data também não
    const again = await api(page, 'POST', 'rpc/extend_event_series', {
      p_series_id: (await db.sql<{ id: string }>(`SELECT id FROM event_series`))[0].id, p_new_end_date: '2030-02-28',
    });
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ created: 0, skipped: 0 });
    rows = await seriesEvents(db);
    expect(rows).toHaveLength(8);
    const dup = await db.sql(`SELECT series_id, series_date FROM events WHERE series_id IS NOT NULL GROUP BY 1, 2 HAVING count(*) > 1`);
    expect(dup).toHaveLength(0);
  });

  test('cancelar próximos: pede confirmação, cancela os sem chamada e preserva a chamada já feita', async ({ page, db, loginAs }) => {
    const s = await seed(db);
    await loginAs(s.carla);
    await createViaUi(page);
    const [withCall] = await db.sql<{ id: string }>(`SELECT id FROM events WHERE series_id IS NOT NULL ORDER BY event_date LIMIT 1`);
    await db.recordAttendance(withCall.id, s.ana, s.alfa, true, s.carla.id);

    await page.getByTestId('series-gerenciar').click();
    const card = modal(page).getByTestId('serie-item');

    // recusar a confirmação não muda nada
    await card.getByTestId('serie-cancelar-proximos').click();
    await answerConfirmation(page, false);
    expect((await seriesEvents(db)).filter((r) => r.status === 'cancelled')).toHaveLength(0);

    await card.getByTestId('serie-cancelar-proximos').click();
    const message = await answerConfirmation(page, true);
    await expect(page.getByText('3 encontros futuros cancelados. Série encerrada. 1 encontro futuro já tem chamada e foi mantido.')).toBeVisible();
    expect(message).toContain('Cancelar próximos encontros?');
    expect(message).toContain(`Cancelar os próximos encontros de “${SERIES}”?`);
    expect(message).toContain('Chamadas já feitas não são afetadas');

    const rows = await seriesEvents(db);
    expect(rows.map((r) => r.status)).toEqual(['scheduled', 'cancelled', 'cancelled', 'cancelled']);
    const [att] = await db.sql<{ n: number }>(`SELECT count(*)::int AS n FROM attendance WHERE event_id = $1`, [withCall.id]);
    expect(att.n).toBe(1); // a chamada já feita continua lá

    // a série fica "Encerrada", sem ações de gerenciamento
    await expect(card).toContainText('Encerrada');
    await expect(card.getByTestId('serie-cancelar-proximos')).toHaveCount(0);
    await expect(card.getByTestId('serie-estender')).toHaveCount(0);

    // encerrada: nem a API deixa estender
    const [{ id }] = await db.sql<{ id: string }>(`SELECT id FROM event_series`);
    const ext = await api(page, 'POST', 'rpc/extend_event_series', { p_series_id: id, p_new_end_date: '2030-03-31' });
    expect(ext.status).toBe(400);
    expect(ext.body.message).toBe('Esta série foi encerrada e não pode ser estendida.');

    // a lista mostra 3 cancelados
    await modal(page).getByRole('button', { name: 'Fechar', exact: true }).last().click();
    await page.getByRole('button', { name: 'Cancelados', exact: true }).click();
    await page.getByPlaceholder('Buscar por título...').fill(SERIES);
    await expect(page.locator('tbody tr')).toHaveCount(3);
  });

  test('sem séries, o gerenciador mostra o estado vazio e atalho para criar', async ({ page, db, loginAs }) => {
    const s = await seed(db);
    await loginAs(s.carla);
    await page.goto('/encontros');
    await page.getByTestId('series-gerenciar').click();
    await expect(modal(page).getByText('Nenhuma série de encontros criada ainda.')).toBeVisible();
    await modal(page).getByRole('button', { name: 'Criar a primeira série' }).click();
    await expect(modal(page).getByRole('heading', { name: 'Nova série de encontros' })).toBeVisible();
  });
});

test.describe('Séries — líder', () => {
  test('não vê botões de série, vê só os encontros dos seus grupos e a API recusa', async ({ page, browser, db, loginAs }) => {
    const s = await seed(db);
    // coordenador cria uma série com grupos (Alfa) e outra pendente: o líder só enxerga a primeira
    await loginAs(s.carla);
    await openNewSeries(page);
    await review(page, { ...weekly, groups: ['Grupo Alfa'] });
    await modal(page).getByTestId('serie-confirmar').click();
    await expect(page.getByText('Série criada: 4 encontros criados.')).toBeVisible();
    await openNewSeries(page);
    await review(page, { ...weekly, name: 'Série Pendente', groups: 'later' });
    await modal(page).getByTestId('serie-confirmar').click();
    await expect(page.getByText('Série criada: 4 encontros criados.')).toBeVisible();

    // líder em outro contexto do navegador (sessão própria)
    const ctx = await browser.newContext({ baseURL: APP_URL, locale: 'pt-BR', timezoneId: 'America/Sao_Paulo' });
    const leader = await ctx.newPage();
    await injectSession(leader, await passwordSession(s.lia));
    await leader.goto('/encontros');

    await expect(leader.getByRole('heading', { name: 'Encontros' })).toBeVisible();
    await expect(leader.locator('tbody tr')).toHaveCount(4);
    await expect(leader.locator('tbody tr').first()).toContainText(`Série: ${SERIES}`);
    await expect(leader.locator('body')).not.toContainText('Série Pendente');
    await expect(leader.getByTestId('serie-nova')).toHaveCount(0);
    await expect(leader.getByTestId('series-gerenciar')).toHaveCount(0);
    await expect(leader.getByRole('button', { name: /Novo encontro/ })).toHaveCount(0);

    const create = await api(leader, 'POST', 'rpc/create_event_series', {
      p_name: 'Invasão', p_weekday: 6, p_start_time: '19:00', p_recurrence: 'weekly',
      p_start_date: '2030-01-01', p_end_date: '2030-01-31', p_description: null, p_group_ids: [s.alfa],
    });
    expect(create.status).toBe(403);
    expect(create.body.message).toBe('Apenas coordenadores podem criar séries de encontros.');
    const [{ id }] = await db.sql<{ id: string }>(`SELECT id FROM event_series WHERE name = $1`, [SERIES]);
    for (const [fn, args] of [
      ['set_series_groups', { p_series_id: id, p_group_ids: [] }],
      ['extend_event_series', { p_series_id: id, p_new_end_date: '2030-03-31' }],
      ['cancel_event_series_future', { p_series_id: id }],
    ] as const) {
      const r = await api(leader, 'POST', `rpc/${fn}`, args);
      expect(r.status, fn).toBe(403);
    }
    expect((await seriesEvents(db)).filter((r) => r.status === 'cancelled')).toHaveLength(0);
    // o líder lê só a série com os grupos dele
    const list = await api(leader, 'GET', 'event_series?select=name');
    expect(list.body).toEqual([{ name: SERIES }]);
    await ctx.close();
  });
});
