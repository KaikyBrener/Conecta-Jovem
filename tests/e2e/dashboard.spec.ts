// Painel inicial (Fase 7, bloco 6): RPC dashboard_overview real (migration 012) sobre dados criados no banco.
import { daysFromNow, expect, test, type TestDb } from './fixtures.ts';
import { addFollowUp, bulkYouth, overdueTask, pastEvent, seedPeople } from './phase7-helpers.ts';

/**
 * Cenário rico (coordenador enxerga tudo):
 * - Grupo Alfa (Lia): Ana (3 faltas seguidas + ação atrasada), Bia (presente sempre);
 * - Grupo Beta (Davi): Caio (6 faltas seguidas = crítico);
 * - Duda sem grupo; acompanhamentos com prazo (vencido, em 3 dias, em 30 dias); encontros futuros.
 * Frequência dos últimos 30 dias: Ana 0/3, Bia 3/3, Caio 0/6 => 3 presenças em 12 registros = 25%.
 */
async function seedRich(db: TestDb) {
  const p = await seedPeople(db);
  const ana = await db.createYouth('Ana Souza', p.alfa);
  const bia = await db.createYouth('Bia Lima', p.alfa);
  const caio = await db.createYouth('Caio Alheio', p.beta);
  const duda = await db.createYouth('Duda Semgrupo', null);
  for (const [i, d] of [21, 14, 7].entries()) {
    const ev = await pastEvent(db, `Culto Alfa ${i + 1}`, d, [p.alfa]);
    await db.recordAttendance(ev, ana, p.alfa, false, p.carla.id);
    await db.recordAttendance(ev, bia, p.alfa, true, p.carla.id);
  }
  for (const [i, d] of [28, 26, 24, 22, 20, 18].entries()) {
    const ev = await pastEvent(db, `Culto Beta ${i + 1}`, d, [p.beta]);
    await db.recordAttendance(ev, caio, p.beta, false, p.carla.id);
  }
  await overdueTask(db, 'Ligar para Ana', ana, p.carla);
  await addFollowUp(db, duda, 'Primeiro contato', { responsibleId: p.carla.id, occurredDaysAgo: 5, nextAction: 'Convidar para o culto', dueInDays: -2 });
  await addFollowUp(db, bia, 'Conversa sobre a escola', { responsibleId: p.lia.id, nextAction: 'Visitar a família', dueInDays: 3 });
  await addFollowUp(db, caio, 'Retorno distante', { responsibleId: p.davi.id, nextAction: 'Ligar no mês que vem', dueInDays: 30 });
  const futuro = await db.createEvent('Culto Futuro', daysFromNow(3), [p.alfa]);
  const retiro = await db.createEvent('Retiro de Jovens', daysFromNow(10), [p.alfa, p.beta]);
  await db.createEvent('Encontro Cancelado', daysFromNow(4), [p.alfa], 'cancelled');
  return { ...p, ana, bia, caio, duda, futuro, retiro };
}

test.describe('Painel — estado vazio', () => {
  test('sem nenhum dado mostra zeros e mensagens de vazio, sem erro', async ({ page, db, loginAs }) => {
    await loginAs(await db.createUser('coordinator', 'Carla Coordenadora'));
    await page.goto('/');

    await expect(page.getByRole('heading', { name: 'Visão geral' })).toBeVisible();
    await expect(page.getByText('Olá, Carla!')).toBeVisible();
    await expect(page.getByTestId('dash-alertas')).toContainText('0');
    await expect(page.getByTestId('dash-alertas')).toContainText('nenhum alerta aberto');
    await expect(page.getByTestId('dash-acoes-atrasadas')).toContainText('nenhuma atrasada');
    await expect(page.getByTestId('dash-frequencia')).toContainText('—');
    await expect(page.getByTestId('dash-frequencia')).toContainText('sem registros de chamada no período');
    await expect(page.getByTestId('dash-sem-grupo')).toContainText('todos têm grupo');
    await expect(page.getByTestId('dash-atencao-total')).toHaveText('(0)');
    await expect(page.getByTestId('dash-atencao-vazio')).toHaveText('Nenhum jovem precisa de atenção agora.');
    await expect(page.getByText('Nenhum acompanhamento vencido ou com prazo nos próximos 14 dias.')).toBeVisible();
    await expect(page.getByText('Nenhum encontro agendado.')).toBeVisible();
    await expect(page.getByTestId('dash-grafico')).toHaveCount(0);
    await expect(page.getByRole('alert')).toHaveCount(0);
  });
});

test.describe('Painel — coordenador com dados', () => {
  test('cartões e listas batem com o banco; críticos primeiro; vencidos destacados', async ({ page, db, loginAs }) => {
    const s = await seedRich(db);
    await loginAs(s.carla);
    await page.goto('/');

    // espera o painel carregar (a sincronização de alertas por tempo roda ANTES da RPC)
    await expect(page.getByTestId('dash-atencao-item')).toHaveCount(2);

    // alertas abertos: exatamente o que há no banco (inclui os criados pela sincronização por tempo)
    const [al] = await db.sql<{ total: number; crit: number; att: number }>(
      `SELECT count(*)::int AS total,
              (count(*) FILTER (WHERE severity = 'critical'))::int AS crit,
              (count(*) FILTER (WHERE severity = 'attention'))::int AS att
         FROM alerts WHERE status = 'open'`);
    expect(al.total).toBeGreaterThanOrEqual(2); // Ana (3 faltas) e Caio (6 faltas)
    const alertCard = page.getByTestId('dash-alertas');
    await expect(alertCard).toContainText(String(al.total));
    await expect(alertCard).toContainText(`${al.crit} crítico(s) · ${al.att} em atenção`);

    // ações atrasadas: 1 (a tarefa da Ana), em vermelho
    const overdueCard = page.getByTestId('dash-acoes-atrasadas');
    await expect(overdueCard).toContainText('1');
    await expect(overdueCard).toContainText('passaram do prazo');
    await expect(overdueCard.locator('p.text-red-600')).toHaveText('1');

    // frequência média: 3 presenças / 12 registros
    await expect(page.getByTestId('dash-frequencia')).toContainText('25%');
    await expect(page.getByTestId('dash-frequencia')).toContainText('12 registros');

    // jovens sem grupo (só a Duda)
    await expect(page.getByTestId('dash-sem-grupo')).toContainText('1');
    await expect(page.getByTestId('dash-sem-grupo')).toContainText('ativos, sem grupo');

    // "precisam de atenção": Caio (crítico) antes da Ana (atenção); sem "e mais"
    await expect(page.getByTestId('dash-atencao-total')).toHaveText('(2)');
    const items = page.getByTestId('dash-atencao-item');
    await expect(items.nth(0)).toContainText('Caio Alheio');
    await expect(items.nth(0)).toHaveAttribute('data-situacao', 'critical');
    await expect(items.nth(0)).toContainText('Grupo Beta');
    await expect(items.nth(0)).toContainText('6 faltas seguidas');
    await expect(items.nth(0)).toContainText('Crítico');
    await expect(items.nth(1)).toContainText('Ana Souza');
    await expect(items.nth(1)).toHaveAttribute('data-situacao', 'attention');
    await expect(items.nth(1)).toContainText('3 faltas seguidas');
    await expect(items.nth(1)).toContainText('1 ação atrasada');
    await expect(page.getByTestId('dash-atencao-mais')).toHaveCount(0);

    // próximos acompanhamentos: vencido (Duda) primeiro e destacado; Bia no prazo; o de 30 dias fica de fora
    const fups = page.getByTestId('dash-acompanhamento-item');
    await expect(fups).toHaveCount(2);
    await expect(fups.nth(0)).toContainText('Duda Semgrupo');
    await expect(fups.nth(0)).toContainText('Convidar para o culto');
    await expect(fups.nth(0)).toContainText('Responsável: Carla Coordenadora');
    await expect(fups.nth(0)).toContainText('· vencido');
    await expect(fups.nth(0)).toHaveAttribute('data-vencido', 'true');
    await expect(fups.nth(0).locator('span.text-red-600')).toBeVisible();
    await expect(fups.nth(1)).toContainText('Bia Lima');
    await expect(fups.nth(1)).toContainText('Visitar a família');
    await expect(fups.nth(1)).toContainText('Responsável: Lia Lider');
    await expect(fups.nth(1)).toHaveAttribute('data-vencido', 'false');
    await expect(fups.nth(1)).not.toContainText('vencido');
    await expect(page.getByTestId('dash-acompanhamentos')).not.toContainText('Caio Alheio');

    // próximos encontros: agendados, por data; cancelado e passados não aparecem
    const events = page.getByTestId('dash-encontro-item');
    await expect(events).toHaveCount(2);
    await expect(events.nth(0)).toContainText('Culto Futuro');
    await expect(events.nth(0)).toContainText('Grupo Alfa');
    await expect(events.nth(1)).toContainText('Retiro de Jovens');
    await expect(events.nth(1)).toContainText('Grupo Alfa, Grupo Beta');
    await expect(page.getByTestId('dash-encontros')).not.toContainText('Encontro Cancelado');
    await expect(page.getByTestId('dash-encontros')).not.toContainText('Culto Alfa');

    // gráfico de frequência dos últimos 30 dias aparece quando há chamadas
    await expect(page.getByTestId('dash-grafico')).toBeVisible();
    await expect(page.getByRole('alert')).toHaveCount(0);
  });

  test('links: ficha do jovem, ações atrasadas, alertas e chamada do encontro', async ({ page, db, loginAs }) => {
    const s = await seedRich(db);
    await loginAs(s.carla);
    await page.goto('/');
    await expect(page.getByTestId('dash-atencao-item')).toHaveCount(2);

    // jovem em atenção -> /jovens?ficha=<id> abre a ficha
    const anaLink = page.getByTestId('dash-atencao-item').filter({ hasText: 'Ana Souza' });
    await expect(anaLink).toHaveAttribute('href', `/jovens?ficha=${s.ana}`);
    await anaLink.click();
    await expect(page).toHaveURL(new RegExp(`/jovens\\?ficha=${s.ana}`));
    await expect(page.getByRole('heading', { name: 'Detalhes do Jovem' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Ana Souza' })).toBeVisible();

    // acompanhamento -> ficha do jovem (Duda não tem grupo, mas a ficha abre)
    await page.goto('/');
    await page.getByTestId('dash-acompanhamento-item').filter({ hasText: 'Duda Semgrupo' }).click();
    await expect(page.getByRole('heading', { name: 'Detalhes do Jovem' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Duda Semgrupo' })).toBeVisible();

    // ações atrasadas -> /tarefas?filtro=atrasadas já filtrado
    await page.goto('/');
    await page.getByTestId('dash-acoes-atrasadas').click();
    await expect(page).toHaveURL(/\/tarefas\?filtro=atrasadas/);
    await expect(page.getByText('Ligar para Ana')).toBeVisible();

    // alertas abertos -> /alertas
    await page.goto('/');
    await page.getByTestId('dash-alertas').click();
    await expect(page).toHaveURL(/\/alertas$/);

    // frequência -> relatórios; encontro -> chamada
    await page.goto('/');
    await page.getByTestId('dash-frequencia').click();
    await expect(page).toHaveURL(/\/relatorios$/);
    await page.goto('/');
    await page.getByTestId('dash-encontro-item').filter({ hasText: 'Culto Futuro' }).click();
    await expect(page).toHaveURL(new RegExp(`/chamada/${s.futuro}`));
  });

  test('mais de 10 jovens em atenção: lista cortada em 10 e "e mais N" (singular e plural)', async ({ page, db, loginAs }) => {
    const p = await seedPeople(db);
    const ids = await bulkYouth(db, 'Atencao', 11, p.alfa);
    for (const [i, id] of ids.entries()) await overdueTask(db, `Tarefa atrasada ${i + 1}`, id, p.carla);
    await loginAs(p.carla);

    await page.goto('/');
    await expect(page.getByTestId('dash-atencao-item')).toHaveCount(10);
    await expect(page.getByTestId('dash-atencao-total')).toHaveText('(11)');
    await expect(page.getByTestId('dash-atencao-mais')).toHaveText('e mais 1 jovem em atenção');
    // ordem alfabética dentro da mesma gravidade
    await expect(page.getByTestId('dash-atencao-item').first()).toContainText('Atencao 001');
    await expect(page.getByTestId('dash-atencao-item').last()).toContainText('Atencao 010');

    const more = await bulkYouth(db, 'Extra', 2, p.alfa);
    for (const [i, id] of more.entries()) await overdueTask(db, `Tarefa extra ${i + 1}`, id, p.carla);
    await page.reload();
    await expect(page.getByTestId('dash-atencao-total')).toHaveText('(13)');
    await expect(page.getByTestId('dash-atencao-mais')).toHaveText('e mais 3 jovens em atenção');
    await page.getByTestId('dash-atencao-mais').click();
    await expect(page).toHaveURL(/\/jovens$/);
  });
});

test.describe('Painel — líder (escopo)', () => {
  test('vê só os números dos seus grupos e não vê "Jovens sem grupo"', async ({ page, db, loginAs }) => {
    const s = await seedRich(db);
    await loginAs(s.lia);
    await page.goto('/');

    await expect(page.getByTestId('dash-atencao-item')).toHaveCount(1);
    await expect(page.getByTestId('dash-atencao-item')).toContainText('Ana Souza');
    await expect(page.getByTestId('dash-atencao-total')).toHaveText('(1)');
    await expect(page.locator('main')).not.toContainText('Caio Alheio');
    await expect(page.locator('main')).not.toContainText('Duda Semgrupo');

    // sem o cartão de jovens sem grupo (grade de 3 colunas)
    await expect(page.getByTestId('dash-sem-grupo')).toHaveCount(0);
    await expect(page.getByText('Jovens sem grupo')).toHaveCount(0);
    await expect(page.getByText('nos seus grupos.')).toBeVisible();

    // alertas só da Ana; frequência só Ana + Bia (3 de 6 = 50%)
    const [al] = await db.sql<{ total: number }>(`SELECT count(*)::int AS total FROM alerts WHERE status = 'open' AND youth_id = $1`, [s.ana]);
    await expect(page.getByTestId('dash-alertas')).toContainText(String(al.total));
    await expect(page.getByTestId('dash-frequencia')).toContainText('50%');
    await expect(page.getByTestId('dash-frequencia')).toContainText('6 registros');
    await expect(page.getByTestId('dash-acoes-atrasadas')).toContainText('1');

    // acompanhamentos: só o da Bia (o da Duda é sem grupo, o do Caio é do outro grupo)
    await expect(page.getByTestId('dash-acompanhamento-item')).toHaveCount(1);
    await expect(page.getByTestId('dash-acompanhamento-item')).toContainText('Bia Lima');

    // encontros: o Retiro lista só o grupo do líder
    const events = page.getByTestId('dash-encontro-item');
    await expect(events).toHaveCount(2);
    await expect(events.nth(1)).toContainText('Retiro de Jovens');
    await expect(events.nth(1)).toContainText('Grupo Alfa');
    await expect(events.nth(1)).not.toContainText('Grupo Beta');
  });

  test('líder sem grupos vê o painel vazio, sem erro', async ({ page, db, loginAs }) => {
    await loginAs(await db.createUser('leader', 'Lia Lider'));
    await page.goto('/');
    await expect(page.getByTestId('dash-atencao-vazio')).toBeVisible();
    await expect(page.getByTestId('dash-sem-grupo')).toHaveCount(0);
    await expect(page.getByRole('alert')).toHaveCount(0);
  });
});

test.describe('Painel — falhas', () => {
  test('falha da RPC dashboard_overview mostra um banner amigável, sem texto cru do servidor', async ({ page, db, loginAs }) => {
    await loginAs(await db.createUser('coordinator', 'Carla Coordenadora'));
    await page.route('**/rest/v1/rpc/dashboard_overview*', (route) =>
      route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ code: 'XX000', message: 'relation "segredo_interno" does not exist', details: 'stack interna', hint: null }),
      }));

    await page.goto('/');
    await expect(page.getByRole('alert')).toContainText('Erro ao carregar o painel.');
    await expect(page.locator('body')).not.toContainText('segredo_interno');
    await expect(page.locator('body')).not.toContainText('stack interna');
    await expect(page.locator('body')).not.toContainText('relation');
    await expect(page.getByRole('heading', { name: 'Visão geral' })).toBeVisible();
    await expect(page.getByTestId('dash-alertas')).toHaveCount(0);
  });

  test('queda de rede na RPC também vira mensagem amigável', async ({ page, db, loginAs }) => {
    await loginAs(await db.createUser('coordinator', 'Carla Coordenadora'));
    await page.route('**/rest/v1/rpc/dashboard_overview*', (route) => route.abort('connectionrefused'));
    await page.goto('/');
    await expect(page.getByRole('alert')).toBeVisible();
    await expect(page.getByRole('alert')).not.toContainText(/fetch|TypeError|Failed/i);
    await expect(page.getByRole('heading', { name: 'Visão geral' })).toBeVisible();
  });

  test('falha do gráfico (report_attendance) não derruba o painel', async ({ page, db, loginAs }) => {
    const s = await seedRich(db);
    await loginAs(s.carla);
    await page.route('**/rest/v1/rpc/report_attendance*', (route) =>
      route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ message: 'falha do grafico' }) }));
    await page.goto('/');
    await expect(page.getByTestId('dash-atencao-item')).toHaveCount(2);
    await expect(page.getByTestId('dash-grafico')).toHaveCount(0);
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(page.locator('body')).not.toContainText('falha do grafico');
  });
});
