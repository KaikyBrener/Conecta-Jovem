// Relatórios (Fase 7, bloco 7): RPCs report_* reais (migration 013) sobre um cenário com números conhecidos
// (ver reports-fixtures.ts). Períodos, validações, filtro de grupo, RLS e estados de erro.
import type { Page } from '@playwright/test';
import { api, expect, spDay, test } from './fixtures.ts';
import { br, expectedFrequency, monthRange, seedReportScenario, weekRange } from './reports-fixtures.ts';

const tab = (page: Page, key: string) => page.getByTestId(`rel-aba-${key}`);
const period = (page: Page) => page.getByTestId('rel-periodo');
const chip = (page: Page, label: string) => page.getByTestId('rel-periodos').getByRole('button', { name: label, exact: true });
const stat = (page: Page) => page.getByTestId('rel-frequencia');

async function setCustom(page: Page, from: string, to: string) {
  await chip(page, 'Personalizado').click();
  await page.locator('#rel-de').fill(from);
  await page.locator('#rel-ate').fill(to);
}

test.describe('Relatórios — Geral e períodos', () => {
  test('padrão: últimos 30 dias, com os números do cenário e as 4 abas de resumo', async ({ page, db, loginAs }) => {
    const s = await seedReportScenario(db);
    await loginAs(s.carla);
    await page.goto('/relatorios');

    await expect(page.getByRole('heading', { name: 'Relatórios' })).toBeVisible();
    await expect(chip(page, 'Últimos 30 dias')).toHaveAttribute('aria-pressed', 'true');
    await expect(period(page)).toHaveText(`Período: ${br(spDay(-29))} a ${br(spDay(0))} · todos os grupos`);
    for (const [key, label] of [['general', 'Geral'], ['attendance', 'Frequência'], ['followups', 'Acompanhamento'], ['alerts', 'Alertas'], ['youth', 'Individual'], ['groups', 'Grupos']]) {
      await expect(tab(page, key)).toHaveText(label);
    }
    await expect(tab(page, 'general')).toHaveAttribute('aria-selected', 'true');

    const general = page.getByTestId('relatorio-geral');
    await expect(stat(page)).toContainText('43%');
    await expect(stat(page)).toContainText('7 registros de chamada');
    await expect(general).toContainText('Encontros realizados5');
    await expect(general).toContainText('1 cancelado(s)');
    await expect(general).toContainText('Alertas abertos agora2');
    await expect(general).toContainText('3 criado(s) no período');
    await expect(general).toContainText('Ações atrasadas agora1');
    await expect(general).toContainText('3 jovens ativos agora'); // Zé está inativo

    // as tabelas mostram exatamente o que será exportado
    const freq = page.getByRole('table', { name: 'Frequência e encontros' });
    await expect(freq.getByRole('row', { name: /Presenças 3/ })).toBeVisible();
    await expect(freq.getByRole('row', { name: /Faltas 4/ })).toBeVisible();
    await expect(freq.getByRole('row', { name: /Registros de chamada 7/ })).toBeVisible();
    await expect(freq.getByRole('row', { name: /Frequência 43%/ })).toBeVisible();
    const alerts = page.getByRole('table', { name: 'Alertas' });
    await expect(alerts.getByRole('row', { name: /Abertos 2 Situação atual/ })).toBeVisible();
    await expect(alerts.getByRole('row', { name: /Criados 3 No período/ })).toBeVisible();
    await expect(alerts.getByRole('row', { name: /Dispensados 1 No período/ })).toBeVisible();
    const acomp = page.getByRole('table', { name: 'Acompanhamento' });
    await expect(acomp.getByRole('row', { name: /Acompanhamentos registrados 3 No período/ })).toBeVisible();
    await expect(acomp.getByRole('row', { name: /Jovens alcançados 3/ })).toBeVisible();
    await expect(acomp.getByRole('row', { name: /Ações atrasadas 1 Situação atual/ })).toBeVisible();
  });

  test('cada período pronto mostra o intervalo certo e a frequência do banco', async ({ page, db, loginAs }) => {
    const s = await seedReportScenario(db);
    await loginAs(s.carla);
    await page.goto('/relatorios');
    await expect(stat(page)).toContainText('43%');
    const today = spDay(0);

    // Hoje: só o encontro E6 (presente) => 100%
    await chip(page, 'Hoje').click();
    await expect(period(page)).toHaveText(`Período: ${br(today)} · todos os grupos`);
    await expect(stat(page)).toContainText('100%');
    await expect(stat(page)).toContainText('1 registros de chamada');
    expect((await expectedFrequency(db, today, today)).text).toBe('100%');

    // Semana: segunda a domingo da semana atual (inclui dias que ainda virão)
    const week = weekRange(today);
    await chip(page, 'Semana').click();
    await expect(period(page)).toHaveText(`Período: ${br(week.from)} a ${br(week.to)} · todos os grupos`);
    const w = await expectedFrequency(db, week.from, week.to);
    await expect(stat(page)).toContainText(w.text);

    // Mês: do dia 1 ao último dia do mês atual
    const month = monthRange(today);
    await chip(page, 'Mês').click();
    await expect(period(page)).toHaveText(`Período: ${br(month.from)} a ${br(month.to)} · todos os grupos`);
    await expect(stat(page)).toContainText((await expectedFrequency(db, month.from, month.to)).text);

    // 30 dias: hoje e os 29 anteriores (E3, a 30 dias, fica de fora); 90 dias inclui E1 e E3
    await chip(page, 'Últimos 30 dias').click();
    await expect(period(page)).toHaveText(`Período: ${br(spDay(-29))} a ${br(today)} · todos os grupos`);
    await expect(stat(page)).toContainText('43%');
    await chip(page, 'Últimos 90 dias').click();
    await expect(period(page)).toHaveText(`Período: ${br(spDay(-89))} a ${br(today)} · todos os grupos`);
    await expect(stat(page)).toContainText('55%');
    await expect(stat(page)).toContainText('11 registros de chamada');
    await expect(page.getByTestId('relatorio-geral')).toContainText('Encontros realizados7');
  });

  test('período personalizado tem limites inclusivos nas duas pontas', async ({ page, db, loginAs }) => {
    const s = await seedReportScenario(db);
    await loginAs(s.carla);
    await page.goto('/relatorios');
    await expect(stat(page)).toContainText('43%');

    // só o 1º dia da janela de 30 dias (E2: 1 presença, 1 falta)
    await setCustom(page, spDay(-29), spDay(-29));
    await expect(period(page)).toHaveText(`Período: ${br(spDay(-29))} · todos os grupos`);
    await expect(stat(page)).toContainText('50%');
    await expect(stat(page)).toContainText('2 registros de chamada');

    // só o dia anterior (E3: duas presenças)
    await setCustom(page, spDay(-30), spDay(-30));
    await expect(stat(page)).toContainText('100%');
    await expect(stat(page)).toContainText('2 registros de chamada');

    // do dia -30 ao -29 (as duas pontas incluídas): 4 registros, 3 presenças
    await setCustom(page, spDay(-30), spDay(-29));
    await expect(stat(page)).toContainText('75%');
    await expect(stat(page)).toContainText('4 registros de chamada');

    // dia do cancelado e do encontro sem chamada: nenhum registro
    await setCustom(page, spDay(-6), spDay(-5));
    await expect(stat(page)).toContainText('—');
    await expect(stat(page)).toContainText('sem chamadas no período');
    await expect(page.getByTestId('relatorio-geral')).toContainText('Encontros realizados1'); // E8 (sem chamada) é realizado
    await expect(page.getByTestId('relatorio-geral')).toContainText('1 cancelado(s)');
  });

  test('validações do período personalizado, com as mensagens exatas', async ({ page, db, loginAs }) => {
    const s = await seedReportScenario(db);
    await loginAs(s.carla);
    await page.goto('/relatorios');
    await expect(stat(page)).toContainText('43%');
    let rpcs = 0;
    await page.route('**/rest/v1/rpc/report_*', (route) => { rpcs += 1; return route.continue(); });

    // inicial depois da final
    await setCustom(page, spDay(-1), spDay(-5));
    await expect(page.getByRole('alert')).toHaveText('A data inicial não pode ser posterior à data final.');
    await expect(page.getByTestId('rel-periodo')).toHaveCount(0);
    await expect(page.getByTestId('relatorio-geral')).toHaveCount(0);

    // mais de 400 dias (401 contando as duas pontas)
    await page.locator('#rel-de').fill(spDay(-400));
    await page.locator('#rel-ate').fill(spDay(0));
    await expect(page.getByRole('alert')).toHaveText('O período pode ter no máximo 400 dias.');
    await expect(page.locator('#rel-de')).toHaveAttribute('aria-invalid', 'true');

    // data vazia (os estados intermediários da digitação podem ter sido válidos; daqui em diante o período é inválido)
    await page.waitForTimeout(500);
    const before = rpcs;
    await page.locator('#rel-de').fill('');
    await expect(page.getByRole('alert')).toHaveText('Informe a data inicial e a data final.');
    await page.waitForTimeout(500);
    expect(rpcs).toBe(before); // nada foi consultado enquanto o período estava inválido

    // exatamente 400 dias (limite) é aceito
    await page.locator('#rel-de').fill(spDay(-399));
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(period(page)).toHaveText(`Período: ${br(spDay(-399))} a ${br(spDay(0))} · todos os grupos`);
    await expect(stat(page)).toContainText('55%');

    // voltar a um período pronto limpa o erro
    await page.locator('#rel-de').fill(spDay(-1));
    await page.locator('#rel-ate').fill(spDay(-5));
    await expect(page.getByRole('alert')).toBeVisible();
    await chip(page, 'Hoje').click();
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(stat(page)).toContainText('100%');
  });

  test('sem nenhum dado: frequência "—" e mensagens de vazio, sem erro', async ({ page, db, loginAs }) => {
    await loginAs(await db.createUser('coordinator', 'Carla Coordenadora'));
    await page.goto('/relatorios');
    await expect(stat(page)).toContainText('—');
    await expect(stat(page)).toContainText('sem chamadas no período');
    await expect(page.getByTestId('relatorio-geral')).toContainText('0 jovens ativos agora');
    await tab(page, 'attendance').click();
    await expect(page.getByText('Nenhum encontro no período.')).toBeVisible();
    await expect(page.getByText('Nenhum jovem com 3 ou mais faltas no período.')).toBeVisible();
    await tab(page, 'followups').click();
    await expect(page.getByText('Nenhuma próxima ação pendente.')).toBeVisible();
    await tab(page, 'groups').click();
    await expect(page.getByText('Nenhum grupo.').first()).toBeVisible();
    await expect(page.getByRole('alert')).toHaveCount(0);
  });
});

test.describe('Relatórios — abas', () => {
  test('Frequência: resumo, por encontro, por grupo e jovens com muitas faltas', async ({ page, db, loginAs }) => {
    const s = await seedReportScenario(db);
    await loginAs(s.carla);
    await page.goto('/relatorios');
    await tab(page, 'attendance').click();

    const root = page.getByTestId('relatorio-frequencia');
    await expect(stat(page)).toContainText('43%');
    await expect(stat(page)).toContainText('3 presenças · 4 faltas');
    await expect(root).toContainText('Registros de chamada7');
    await expect(root).toContainText('Encontros com chamada4 de 5'); // E8 não teve chamada
    await expect(root).toContainText('Encontros cancelados1');

    // por encontro: o sem chamada aparece como tal; o cancelado também, sem contar
    const byEvent = page.getByTestId('tabela-encontros');
    await expect(byEvent.getByRole('row', { name: /Culto E8 Sem Chamada.*sem chamada/ })).toBeVisible();
    await expect(byEvent.getByRole('row', { name: /Culto E4.*1\/3/ })).toBeVisible();
    await expect(byEvent.getByRole('row', { name: /Culto E2.*1\/2/ })).toBeVisible();
    await expect(byEvent).not.toContainText('Culto E1 ');
    await expect(byEvent).not.toContainText('Culto E3');

    // por grupo (jovens que estão hoje no grupo, em encontros dele)
    const byGroup = page.getByTestId('tabela-grupos-freq');
    await expect(byGroup.getByRole('row', { name: /Grupo Alfa.*1\/4.*25%/ })).toBeVisible();
    await expect(byGroup.getByRole('row', { name: /Grupo Beta.*2\/3.*67%/ })).toBeVisible();

    // jovens com muitas faltas: padrão 3 (ninguém), com 2 só a Ana (2 faltas de 2)
    await expect(page.getByText('Nenhum jovem com 3 ou mais faltas no período.')).toBeVisible();
    await page.locator('#rel-min-faltas').selectOption('2');
    const faltas = page.getByTestId('tabela-faltas');
    await expect(faltas.getByRole('row', { name: /Ana Souza.*Grupo Alfa.*2 de 2/ })).toBeVisible();
    await expect(faltas.locator('tbody tr')).toHaveCount(1);
    await page.locator('#rel-min-faltas').selectOption('1');
    await expect(faltas.locator('tbody tr')).toHaveCount(3); // Ana, Bia e Caio (o inativo não conta)
    await expect(faltas).not.toContainText('Zé Inativo');
  });

  test('Acompanhamento: totais, por tipo/responsável e próximas ações com vencida destacada', async ({ page, db, loginAs }) => {
    const s = await seedReportScenario(db);
    await loginAs(s.carla);
    await page.goto('/relatorios');
    await tab(page, 'followups').click();

    const root = page.getByTestId('relatorio-acompanhamento');
    await expect(root).toContainText('Acompanhamentos3');
    await expect(root).toContainText('Jovens alcançados3');
    await expect(root).toContainText('Próximas ações pendentes2');
    await expect(root).toContainText('1 no prazo · agora');
    await expect(root).toContainText('Próximas ações vencidas1');
    await expect(root.getByRole('table', { name: 'Por tipo de acompanhamento' }).getByRole('row', { name: /Conversa 2/ })).toBeVisible();
    await expect(root.getByRole('table', { name: 'Por tipo de acompanhamento' }).getByRole('row', { name: /Ligação 1/ })).toBeVisible();
    const resp = root.getByRole('table', { name: 'Por responsável' });
    await expect(resp.getByRole('row', { name: /Lia Lider 1/ })).toBeVisible();
    await expect(resp.getByRole('row', { name: /Carla Coordenadora 1/ })).toBeVisible();
    await expect(resp.getByRole('row', { name: /Davi Lider 1/ })).toBeVisible();
    await expect(root).toContainText('0 transferências de responsável no período (0 acompanhamentos).');

    const next = page.getByTestId('tabela-proximas-acoes').locator('tbody tr');
    await expect(next).toHaveCount(2);
    await expect(next.nth(0)).toContainText(br(spDay(-1)));
    await expect(next.nth(0)).toContainText('vencida');
    await expect(next.nth(0)).toContainText('Ana Souza');
    await expect(next.nth(0)).toContainText('Ligar para os pais');
    await expect(next.nth(0)).toContainText('Lia Lider');
    await expect(next.nth(0).locator('[data-vencida="true"]')).toBeVisible();
    await expect(next.nth(1)).toContainText(br(spDay(5)));
    await expect(next.nth(1)).toContainText('Bia Lima');
    await expect(next.nth(1).locator('[data-vencida="false"]')).toBeVisible();
    await expect(next.nth(1)).not.toContainText('vencida');
  });

  test('Alertas: abertos agora, criados, resolvidos e dispensados no período', async ({ page, db, loginAs }) => {
    const s = await seedReportScenario(db);
    await loginAs(s.carla);
    await page.goto('/relatorios');
    await tab(page, 'alerts').click();

    const root = page.getByTestId('relatorio-alertas');
    await expect(root).toContainText('Abertos agora2');
    await expect(root).toContainText('Criados no período3');
    await expect(root).toContainText('Resolvidos no período0');
    await expect(root).toContainText('Dispensados no período1');
    await expect(root).toContainText('sem alertas resolvidos para medir o tempo');
    const [al] = await db.sql<{ open: number; created: number; dismissed: number }>(
      `SELECT (count(*) FILTER (WHERE status = 'open'))::int AS open, count(*)::int AS created,
              (count(*) FILTER (WHERE status = 'dismissed'))::int AS dismissed FROM alerts`);
    expect(al).toEqual({ open: 2, created: 3, dismissed: 1 });
    await expect(root.getByRole('table', { name: 'Por gravidade' })).toBeVisible();
    await expect(root.getByRole('table', { name: 'Por tipo de alerta' })).toBeVisible();
    await expect(root).toContainText('situação de hoje e não depende do período escolhido');

    // período sem alertas criados (dias antigos): "abertos agora" não muda
    await setCustom(page, spDay(-60), spDay(-50));
    await expect(root).toContainText('Abertos agora2');
    await expect(root).toContainText('Criados no período0');
  });

  test('Individual: busca por nome, ficha do período e "não registrado" fora das faltas', async ({ page, db, loginAs }) => {
    const s = await seedReportScenario(db);
    await loginAs(s.carla);
    await page.goto('/relatorios');
    await tab(page, 'youth').click();
    await expect(page.locator('#rel-grupo')).toHaveCount(0); // filtro de grupo não se aplica aqui
    await expect(page.getByText('Escolha um jovem para ver a ficha')).toBeVisible();

    const search = page.getByLabel('Buscar jovem por nome');
    await search.fill('a'); // menos de 2 letras: não busca
    await expect(page.getByTestId('rel-jovem-resultado')).toHaveCount(0);
    await search.fill('zzzz');
    await expect(page.getByTestId('rel-jovem-sem-resultado')).toHaveText('Nenhum jovem encontrado.');
    await search.fill('ana');
    await expect(page.getByTestId('rel-jovem-resultado')).toHaveCount(1);
    await expect(page.getByTestId('rel-jovem-resultado')).toContainText('Ana Souza');
    await expect(page.getByTestId('rel-jovem-resultado')).toContainText('Grupo Alfa');
    await page.getByTestId('rel-jovem-resultado').click();

    await expect(page.getByTestId('rel-jovem-escolhido')).toContainText('Ana Souza');
    const root = page.getByTestId('relatorio-individual');
    await expect(page.getByTestId('rel-jovem-nome')).toHaveText('Ana Souza');
    await expect(root).toContainText('Grupo Alfa · Líder: Lia Lider');
    await expect(root).toContainText('Atenção');
    await expect(root).toContainText('Frequência baixa (50% nos últimos 4 registros)');
    await expect(stat(page)).toContainText('0%');
    await expect(stat(page)).toContainText('0 presenças · 2 faltas'); // E8 (sem chamada) NÃO é falta
    await expect(root).toContainText('Faltas seguidas agora2');
    await expect(root).toContainText('Ações abertas1');
    await expect(root).toContainText('1 atrasada(s)');
    await expect(root).toContainText(`Último acompanhamento${br(spDay(-5))}`);

    const presence = root.getByRole('table', { name: 'Presença nos encontros' });
    await expect(presence.getByRole('row', { name: /Culto E2.*Falta/ })).toBeVisible();
    await expect(presence.getByRole('row', { name: /Culto E4.*Falta/ })).toBeVisible();
    await expect(presence.getByRole('row', { name: /Culto E8 Sem Chamada.*Não registrado/ })).toBeVisible();
    await expect(presence).not.toContainText('Culto E7'); // cancelado
    await expect(root).toContainText('1 encontro(s) sem chamada registrada: não contam como falta.');
    const fups = root.getByRole('table', { name: 'Acompanhamentos' });
    await expect(fups).toContainText('Faltas recentes');
    await expect(fups).not.toContainText('Conversa antiga'); // fora do período
    await expect(root).toContainText('Contém dados pessoais de jovem');

    // mudar o período recalcula a ficha: 90 dias traz E1 e E3 (duas presenças)
    await chip(page, 'Últimos 90 dias').click();
    await expect(stat(page)).toContainText('50%');
    await expect(stat(page)).toContainText('2 presenças · 2 faltas');
    await expect(fups).toContainText('Conversa antiga');

    // trocar de jovem volta à busca
    await page.getByRole('button', { name: 'Trocar jovem' }).click();
    await expect(search).toBeVisible();
    await expect(page.getByTestId('relatorio-individual')).toHaveCount(0);
  });

  test('Grupos: situação atual e movimento no período, em ordem alfabética', async ({ page, db, loginAs }) => {
    const s = await seedReportScenario(db);
    await loginAs(s.carla);
    await page.goto('/relatorios');
    await tab(page, 'groups').click();
    await expect(page.locator('#rel-grupo')).toHaveCount(0);

    const root = page.getByTestId('relatorio-grupos');
    await expect(root).toContainText('Grupos2');
    await expect(root).toContainText('Jovens ativos nos grupos3');
    const current = page.getByTestId('tabela-grupos-atual').locator('tbody tr');
    await expect(current).toHaveCount(2);
    await expect(current.nth(0)).toContainText('Grupo Alfa');
    await expect(current.nth(0)).toContainText('Líder: Lia Lider');
    // Alfa: 4 encontros com chamada (8 registros, 4 presenças), Ana em atenção (baixa frequência), 1 ação atrasada
    await expect(current.nth(0).getByTestId('grupo-rate')).toHaveText('50%');
    await expect(current.nth(0).getByTestId('grupo-trend')).toHaveText('dados insuficientes');
    await expect(current.nth(0).getByTestId('grupo-attention')).toHaveText('1');
    await expect(current.nth(0).getByTestId('grupo-overdue')).toHaveText('1');
    await expect(current.nth(1).getByTestId('grupo-rate')).toHaveText('67%');
    await expect(current.nth(1).getByTestId('grupo-attention')).toHaveText('0');
    await expect(current.nth(1).getByTestId('grupo-overdue')).toHaveText('0');
    await expect(current.nth(1)).toContainText('Grupo Beta');
    await expect(current.nth(1)).toContainText('Davi Lider');
    await expect(current.nth(1)).toContainText('dados insuficientes'); // só 3 encontros com chamada

    const moved = page.getByTestId('tabela-grupos-periodo').locator('tbody tr');
    await expect(moved).toHaveCount(2);
    // Encontros realizados | Frequência (presentes/registros) | Acompanhamentos | Alertas criados | Ações concluídas
    await expect(moved.nth(0)).toContainText('Grupo Alfa');
    await expect(moved.nth(0).locator('td').nth(1)).toHaveText('3'); // E2, E4, E8
    await expect(moved.nth(0).locator('td').nth(2)).toHaveText('25% (1/4)');
    await expect(moved.nth(0).locator('td').nth(3)).toHaveText('2');
    await expect(moved.nth(0).locator('td').nth(4)).toHaveText('3');
    await expect(moved.nth(0).locator('td').nth(5)).toHaveText('0');
    await expect(moved.nth(1)).toContainText('Grupo Beta');
    await expect(moved.nth(1).locator('td').nth(1)).toHaveText('3'); // E4, E5, E6
    await expect(moved.nth(1).locator('td').nth(2)).toHaveText('67% (2/3)');
    await expect(moved.nth(1).locator('td').nth(3)).toHaveText('1');
    await expect(moved.nth(1).locator('td').nth(4)).toHaveText('0');
  });
});

test.describe('Relatórios — filtro de grupo', () => {
  test('o filtro vale para Geral, Frequência, Acompanhamento e Alertas, e aparece no cabeçalho do período', async ({ page, db, loginAs }) => {
    const s = await seedReportScenario(db);
    await loginAs(s.carla);
    await page.goto('/relatorios');
    await expect(stat(page)).toContainText('43%');
    await expect(page.locator('#rel-grupo option')).toHaveText(['Todos os grupos', 'Grupo Alfa', 'Grupo Beta']);

    await page.locator('#rel-grupo').selectOption({ label: 'Grupo Beta' });
    await expect(period(page)).toHaveText(`Período: ${br(spDay(-29))} a ${br(spDay(0))} · Grupo Beta`);
    await expect(stat(page)).toContainText('67%');
    await expect(stat(page)).toContainText('3 registros de chamada');
    expect((await expectedFrequency(db, spDay(-29), spDay(0), s.beta)).text).toBe('67%');

    await page.locator('#rel-grupo').selectOption({ label: 'Grupo Alfa' });
    await expect(stat(page)).toContainText('25%');
    await expect(stat(page)).toContainText('4 registros de chamada');
    expect((await expectedFrequency(db, spDay(-29), spDay(0), s.alfa)).text).toBe('25%');

    // a escolha acompanha as abas que usam o filtro
    await tab(page, 'followups').click();
    await expect(page.locator('#rel-grupo')).toHaveValue(s.alfa);
    await expect(page.getByTestId('relatorio-acompanhamento')).toContainText('Acompanhamentos2'); // Ana e Bia, não o Caio
    await tab(page, 'alerts').click();
    await expect(page.getByTestId('relatorio-alertas')).toContainText('Criados no período3');
    await page.locator('#rel-grupo').selectOption({ label: 'Grupo Beta' });
    await expect(page.getByTestId('relatorio-alertas')).toContainText('Criados no período0');
    await expect(page.getByTestId('relatorio-alertas')).toContainText('Abertos agora0');
  });
});

test.describe('Relatórios — líder (RLS)', () => {
  test('líder só vê dados e grupos dele, inclusive nas chamadas diretas à API', async ({ page, db, loginAs }) => {
    const s = await seedReportScenario(db);
    await loginAs(s.lia);
    await page.goto('/relatorios');

    // só os grupos dele no filtro, e "Todos os seus grupos"
    await expect(page.locator('#rel-grupo option')).toHaveText(['Todos os seus grupos', 'Grupo Alfa']);
    await expect(period(page)).toHaveText(`Período: ${br(spDay(-29))} a ${br(spDay(0))} · todos os seus grupos`);
    // Alfa: E2 (Ana A, Bia P) e E4 (Ana A, Bia A) = 4 registros, 1 presença
    await expect(stat(page)).toContainText('25%');
    await expect(stat(page)).toContainText('4 registros de chamada');
    await expect(page.getByTestId('relatorio-geral')).toContainText('2 jovens ativos agora');
    expect((await expectedFrequency(db, spDay(-29), spDay(0), s.alfa)).text).toBe('25%');

    await tab(page, 'groups').click();
    await expect(page.getByTestId('tabela-grupos-atual').locator('tbody tr')).toHaveCount(1);
    await expect(page.getByTestId('relatorio-grupos')).not.toContainText('Grupo Beta');
    await expect(page.getByTestId('relatorio-grupos')).not.toContainText('Davi');

    await tab(page, 'followups').click();
    await expect(page.getByTestId('relatorio-acompanhamento')).toContainText('Acompanhamentos2');
    await expect(page.getByTestId('relatorio-acompanhamento')).not.toContainText('Caio');

    // jovem de outro grupo não aparece na busca do relatório individual
    await tab(page, 'youth').click();
    await page.getByLabel('Buscar jovem por nome').fill('caio');
    await expect(page.getByTestId('rel-jovem-sem-resultado')).toBeVisible();
    await page.getByLabel('Buscar jovem por nome').fill('ana');
    await expect(page.getByTestId('rel-jovem-resultado')).toHaveCount(1);

    // API adulterada: grupo alheio e jovem alheio são recusados com a mensagem do banco, sem vazar dados
    const range = { p_from: spDay(-29), p_to: spDay(0) };
    const groupCall = await api(page, 'POST', 'rpc/report_general', { ...range, p_group_id: s.beta });
    expect(groupCall.status).toBe(400);
    expect(groupCall.body.message).toBe('Grupo não encontrado ou sem permissão.');
    const youthCall = await api(page, 'POST', 'rpc/report_youth', { ...range, p_youth_id: s.caio });
    expect(youthCall.status).toBe(400);
    expect(youthCall.body.message).toBe('Jovem não encontrado ou sem permissão.');
    const ownCall = await api(page, 'POST', 'rpc/report_general', { ...range, p_group_id: s.alfa });
    expect(ownCall.status).toBe(200);
    expect(ownCall.body.attendance.registered).toBe(4);
  });

  test('Individual de jovem alheio (requisição adulterada na tela) mostra erro amigável', async ({ page, db, loginAs }) => {
    const s = await seedReportScenario(db);
    await loginAs(s.lia);
    await page.goto('/relatorios');
    await tab(page, 'youth').click();
    // a tela só oferece jovens dele; a requisição do relatório é trocada para o id do Caio (outro grupo)
    await page.route('**/rest/v1/rpc/report_youth*', (route) => {
      const body = JSON.parse(route.request().postData() ?? '{}');
      return route.continue({ postData: JSON.stringify({ ...body, p_youth_id: s.caio }) });
    });
    await page.getByLabel('Buscar jovem por nome').fill('ana');
    await page.getByTestId('rel-jovem-resultado').click();

    await expect(page.getByRole('alert')).toHaveText('Jovem não encontrado ou sem permissão.');
    await expect(page.getByTestId('relatorio-individual')).toHaveCount(0);
    await expect(page.locator('body')).not.toContainText('Caio Alheio');
  });

  test('coordenador vê todos os grupos; líder sem grupos vê o relatório vazio', async ({ page, db, loginAs }) => {
    await loginAs(await db.createUser('leader', 'Lia Lider'));
    await page.goto('/relatorios');
    await expect(stat(page)).toContainText('—');
    await expect(page.getByTestId('relatorio-geral')).toContainText('0 jovens ativos agora');
    await expect(page.locator('#rel-grupo option')).toHaveText(['Todos os seus grupos']);
    await expect(page.getByRole('alert')).toHaveCount(0);
  });
});

test.describe('Relatórios — falhas', () => {
  test('erro do servidor vira mensagem amigável (sem texto cru) e outras abas continuam funcionando', async ({ page, db, loginAs }) => {
    const s = await seedReportScenario(db);
    await loginAs(s.carla);
    await page.route('**/rest/v1/rpc/report_general*', (route) =>
      route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ code: 'XX000', message: 'relation "tabela_secreta" failed' }) }));
    await page.goto('/relatorios');

    await expect(page.getByRole('alert')).toHaveText('Erro ao gerar o relatório geral.');
    await expect(page.locator('body')).not.toContainText('tabela_secreta');
    await expect(page.getByTestId('exportar-csv')).toHaveCount(0);

    await tab(page, 'attendance').click();
    await expect(stat(page)).toContainText('43%');
    await expect(page.getByRole('alert')).toHaveCount(0);
  });

  test('queda de rede mostra aviso de conexão', async ({ page, db, loginAs }) => {
    const s = await seedReportScenario(db);
    await loginAs(s.carla);
    await page.route('**/rest/v1/rpc/report_alerts*', (route) => route.abort('connectionrefused'));
    await page.goto('/relatorios');
    await tab(page, 'alerts').click();
    await expect(page.getByRole('alert')).toHaveText('Sem conexão com o servidor. Verifique sua internet e tente novamente.');
  });
});
