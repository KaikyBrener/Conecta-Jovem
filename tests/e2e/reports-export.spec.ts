// Exportação dos relatórios em CSV e PDF (Fase 7, bloco 7): baixa os arquivos de verdade pelo navegador.
import { readFileSync } from 'node:fs';
import type { Download, Locator, Page } from '@playwright/test';
import { expect, spDay, test, type TestDb } from './fixtures.ts';
import { addFollowUp } from './phase7-helpers.ts';
import { br, seedReportScenario } from './reports-fixtures.ts';

const tab = (page: Page, key: string) => page.getByTestId(`rel-aba-${key}`);

async function grab(page: Page, trigger: Locator): Promise<{ name: string; bytes: Buffer; download: Download }> {
  const [download] = await Promise.all([page.waitForEvent('download'), trigger.click()]);
  const path = await download.path();
  return { name: download.suggestedFilename(), bytes: readFileSync(path), download };
}

const csvText = (bytes: Buffer) => bytes.toString('utf8');
const lines = (bytes: Buffer) => csvText(bytes).replace(/^﻿/, '').split('\r\n');

/** Cenário dos relatórios + um jovem cujo nome e cujo motivo de acompanhamento parecem fórmulas de planilha. */
async function seedWithFormulas(db: TestDb) {
  const s = await seedReportScenario(db);
  const evil = await db.createYouth('=1+1 Teste', s.alfa);
  await db.recordAttendance(s.e.e2, evil, s.alfa, false, s.carla.id);
  await addFollowUp(db, evil, '-2+3 motivo', { responsibleId: s.carla.id, occurredDaysAgo: 1, nextAction: '@soma', dueInDays: 2 });
  return { ...s, evil };
}

test.describe('Relatórios — exportação CSV', () => {
  test('Geral: BOM UTF-8, separador ";", cabeçalhos, valores e nome do arquivo com o período', async ({ page, db, loginAs }) => {
    const s = await seedReportScenario(db);
    await loginAs(s.carla);
    await page.goto('/relatorios');
    await expect(page.getByTestId('rel-frequencia')).toContainText('43%');

    const { name, bytes } = await grab(page, page.getByTestId('exportar-csv'));
    await expect(page.getByText('Arquivo CSV gerado.')).toBeVisible();
    expect(name).toBe(`relatorio-geral_${spDay(-29)}_a_${spDay(0)}.csv`);
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]); // BOM para o Excel abrir com acentos corretos

    const l = lines(bytes);
    expect(l[0]).toBe('Conecta Jovem;Relatório geral');
    expect(l).toContain(`Período;${br(spDay(-29))} a ${br(spDay(0))}`);
    expect(l).toContain('Grupo;Todos os grupos');
    expect(l.some((x) => x.startsWith('Gerado em;'))).toBe(true);
    expect(l).toContain('Resumo;');
    expect(l).toContain('Frequência no período;43%');
    expect(l).toContain('Jovens ativos (agora);3');
    expect(l).toContain('Frequência e encontros');
    expect(l).toContain('Indicador;Valor;Referência');
    expect(l).toContain('Encontros realizados;5;No período');
    expect(l).toContain('Frequência;43%;No período');
    expect(l).toContain('Abertos;2;Situação atual');
    expect(l).toContain('Observações');
    // acentos íntegros no UTF-8
    expect(csvText(bytes)).toContain('Relatório geral');
  });

  test('o período e o grupo escolhidos vão para o arquivo', async ({ page, db, loginAs }) => {
    const s = await seedReportScenario(db);
    await loginAs(s.carla);
    await page.goto('/relatorios');
    await page.getByTestId('rel-periodos').getByRole('button', { name: 'Hoje', exact: true }).click();
    await page.locator('#rel-grupo').selectOption({ label: 'Grupo Beta' });
    await expect(page.getByTestId('rel-periodo')).toHaveText(`Período: ${br(spDay(0))} · Grupo Beta`);
    await expect(page.getByTestId('rel-frequencia')).toContainText('100%');

    const { name, bytes } = await grab(page, page.getByTestId('exportar-csv'));
    expect(name).toBe(`relatorio-geral_${spDay(0)}_a_${spDay(0)}.csv`);
    const l = lines(bytes);
    expect(l).toContain(`Período;${br(spDay(0))}`);
    expect(l).toContain('Grupo;Grupo Beta');
    expect(l).toContain('Frequência no período;100%');
  });

  test('cada aba exporta seu próprio CSV com os cabeçalhos das tabelas', async ({ page, db, loginAs }) => {
    const s = await seedReportScenario(db);
    await loginAs(s.carla);
    await page.goto('/relatorios');
    const range = `${spDay(-29)}_a_${spDay(0)}`;

    await tab(page, 'attendance').click();
    await expect(page.getByTestId('relatorio-frequencia')).toBeVisible();
    let f = await grab(page, page.getByTestId('exportar-csv'));
    expect(f.name).toBe(`relatorio-frequencia_${range}.csv`);
    let l = lines(f.bytes);
    expect(l[0]).toBe('Conecta Jovem;Relatório de frequência');
    expect(l).toContain('Data;Encontro;Situação;Presentes;Faltas;Registros;Frequência');
    expect(l.some((x) => /;Culto E8 Sem Chamada;Realizado;0;0;0;—$/.test(x))).toBe(true);
    expect(l).toContain('Grupo;Encontros;Presentes;Faltas;Registros;Frequência');
    expect(l).toContain('Grupo Alfa;2;1;3;4;25%'); // encontros COM chamada do grupo: E2 e E4 (E8 não teve chamada)
    expect(l).toContain('Grupo Beta;3;2;1;3;67%');
    expect(l).toContain('Jovem;Grupo;Faltas;Registros');

    await tab(page, 'followups').click();
    await expect(page.getByTestId('relatorio-acompanhamento')).toBeVisible();
    f = await grab(page, page.getByTestId('exportar-csv'));
    expect(f.name).toBe(`relatorio-acompanhamento_${range}.csv`);
    l = lines(f.bytes);
    expect(l).toContain('Tipo;Quantidade');
    expect(l).toContain('Conversa;2');
    expect(l).toContain('Prazo;Jovem;Próxima ação;Responsável;Situação');
    expect(l).toContain(`${br(spDay(-1))};Ana Souza;Ligar para os pais;Lia Lider;Vencida`);
    expect(l).toContain(`${br(spDay(5))};Bia Lima;Visitar a família;Carla Coordenadora;No prazo`);

    await tab(page, 'alerts').click();
    await expect(page.getByTestId('relatorio-alertas')).toBeVisible();
    f = await grab(page, page.getByTestId('exportar-csv'));
    expect(f.name).toBe(`relatorio-alertas_${range}.csv`);
    l = lines(f.bytes);
    expect(l).toContain('Tipo;Criados;Resolvidos;Dispensados;Abertos agora');
    expect(l).toContain('Frequência baixa;2;0;1;1');
    expect(l).toContain('Gravidade;Criados;Resolvidos;Dispensados;Abertos agora');
    expect(l).toContain('Atenção;3;0;1;2');

    await tab(page, 'groups').click();
    await expect(page.getByTestId('relatorio-grupos')).toBeVisible();
    f = await grab(page, page.getByTestId('exportar-csv'));
    expect(f.name).toBe(`relatorio-grupos_${range}.csv`);
    l = lines(f.bytes);
    expect(l).toContain('Grupo;Líder;Jovens ativos;Frequência (últimos 8 encontros);Tendência;Jovens em atenção;Ações atrasadas');
    expect(l).toContain('Grupo Alfa;Lia Lider;2;50%;dados insuficientes;1;1');
    expect(l).toContain('Grupo Beta;Davi Lider;1;67%;dados insuficientes;0;0');
    expect(l).toContain('Grupo;Encontros realizados;Registros;Frequência;Acompanhamentos;Alertas criados;Ações concluídas');
    expect(l).toContain('Grupo Alfa;3;4;25%;2;3;0');
  });

  test('neutraliza fórmulas (= + - @) em nomes e textos, sem alterar números', async ({ page, db, loginAs }) => {
    const s = await seedWithFormulas(db);
    await loginAs(s.carla);
    await page.goto('/relatorios');

    // Frequência: jovens com muitas faltas inclui o nome "=1+1 Teste"
    await tab(page, 'attendance').click();
    await page.locator('#rel-min-faltas').selectOption('1');
    await expect(page.getByTestId('tabela-faltas')).toContainText('=1+1 Teste');
    let f = await grab(page, page.getByTestId('exportar-csv'));
    let text = csvText(f.bytes);
    expect(text).toContain("'=1+1 Teste;Grupo Alfa;1;1"); // prefixo ' faz a planilha ler como texto
    expect(text).not.toMatch(/(^|[;\r\n])=1\+1/);

    // Acompanhamento: próxima ação "@soma"
    await tab(page, 'followups').click();
    await expect(page.getByTestId('relatorio-acompanhamento')).toBeVisible();
    f = await grab(page, page.getByTestId('exportar-csv'));
    text = csvText(f.bytes);
    expect(text).toContain("'=1+1 Teste;'@soma");
    expect(text).not.toMatch(/(^|[;\r\n])@soma/);

    // Individual: nome, motivo "-2+3 motivo"; números continuam números
    await tab(page, 'youth').click();
    await page.getByLabel('Buscar jovem por nome').fill('1+1');
    await page.getByTestId('rel-jovem-resultado').click();
    await expect(page.getByTestId('rel-jovem-nome')).toHaveText('=1+1 Teste');
    f = await grab(page, page.getByTestId('exportar-csv'));
    text = csvText(f.bytes);
    expect(text).toContain("Jovem;'=1+1 Teste");
    expect(text).toContain("'-2+3 motivo");
    expect(text).not.toMatch(/(^|[;\r\n])-2\+3/);
    expect(text).toContain('Frequência no período;0%');
    // o nome do jovem NÃO vai no nome do arquivo
    expect(f.name).toBe(`relatorio-individual_${spDay(-29)}_a_${spDay(0)}.csv`);
    expect(f.name).not.toMatch(/teste|1\+1/i);
  });

  test('líder exporta apenas o que o RLS permite, com "Todos os seus grupos"', async ({ page, db, loginAs }) => {
    const s = await seedReportScenario(db);
    await loginAs(s.lia);
    await page.goto('/relatorios');
    await expect(page.getByTestId('rel-frequencia')).toContainText('25%');
    let f = await grab(page, page.getByTestId('exportar-csv'));
    let l = lines(f.bytes);
    expect(l).toContain('Grupo;Todos os seus grupos');
    expect(l).toContain('Frequência no período;25%');
    expect(l).toContain('Jovens ativos (agora);2');

    await tab(page, 'groups').click();
    await expect(page.getByTestId('relatorio-grupos')).toBeVisible();
    f = await grab(page, page.getByTestId('exportar-csv'));
    const text = csvText(f.bytes);
    l = lines(f.bytes);
    expect(l).toContain('Grupos;Todos os seus grupos');
    expect(text).toContain('Grupo Alfa');
    expect(text).not.toContain('Grupo Beta');
    expect(text).not.toContain('Davi');
    expect(text).not.toContain('Caio');
  });

  test('botões ficam indisponíveis sem relatório (erro do servidor ou período inválido)', async ({ page, db, loginAs }) => {
    const s = await seedReportScenario(db);
    await loginAs(s.carla);
    await page.goto('/relatorios');
    await expect(page.getByTestId('exportar-csv')).toBeEnabled();
    await page.getByTestId('rel-periodos').getByRole('button', { name: 'Personalizado', exact: true }).click();
    await page.locator('#rel-de').fill(spDay(-1));
    await page.locator('#rel-ate').fill(spDay(-5));
    await expect(page.getByRole('alert')).toBeVisible();
    await expect(page.getByTestId('exportar-csv')).toHaveCount(0);
    await expect(page.getByTestId('exportar-pdf')).toHaveCount(0);
  });
});

test.describe('Relatórios — exportação PDF', () => {
  test('cada relatório baixa um PDF válido e mostra o aviso de sucesso', async ({ page, db, loginAs }) => {
    const s = await seedReportScenario(db);
    await loginAs(s.carla);
    await page.goto('/relatorios');
    const range = `${spDay(-29)}_a_${spDay(0)}`;
    const cases: [string, string, string][] = [
      ['general', 'relatorio-geral', 'relatorio-geral'],
      ['attendance', 'relatorio-frequencia', 'relatorio-frequencia'],
      ['followups', 'relatorio-acompanhamento', 'relatorio-acompanhamento'],
      ['alerts', 'relatorio-alertas', 'relatorio-alertas'],
      ['groups', 'relatorio-grupos', 'relatorio-grupos'],
    ];
    for (const [key, testId, file] of cases) {
      await tab(page, key).click();
      await expect(page.getByTestId(testId)).toBeVisible();
      const f = await grab(page, page.getByTestId('exportar-pdf'));
      expect(f.name).toBe(`${file}_${range}.pdf`);
      expect(f.bytes.length).toBeGreaterThan(500);
      expect(f.bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
      expect(f.bytes.subarray(-1024).toString('latin1')).toContain('%%EOF');
      await expect(page.getByText('Arquivo PDF gerado.').last()).toBeVisible();
      await expect(page.getByTestId('exportar-pdf')).toBeEnabled();
    }
  });

  test('Individual: PDF sem o nome do jovem no nome do arquivo', async ({ page, db, loginAs }) => {
    const s = await seedWithFormulas(db);
    await loginAs(s.carla);
    await page.goto('/relatorios');
    await tab(page, 'youth').click();
    await page.getByLabel('Buscar jovem por nome').fill('ana');
    await page.getByTestId('rel-jovem-resultado').click();
    await expect(page.getByTestId('rel-jovem-nome')).toHaveText('Ana Souza');

    const f = await grab(page, page.getByTestId('exportar-pdf'));
    expect(f.name).toBe(`relatorio-individual_${spDay(-29)}_a_${spDay(0)}.pdf`);
    expect(f.name.toLowerCase()).not.toContain('ana');
    expect(f.name.toLowerCase()).not.toContain('souza');
    expect(f.bytes.length).toBeGreaterThan(500);
    expect(f.bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    await expect(page.getByText('Arquivo PDF gerado.')).toBeVisible();
  });

  test('falha ao gerar o PDF mostra aviso de erro amigável', async ({ page, db, loginAs }) => {
    const s = await seedReportScenario(db);
    await loginAs(s.carla);
    await page.goto('/relatorios');
    await expect(page.getByTestId('rel-frequencia')).toBeVisible();
    // o módulo do PDF é carregado sob demanda: se o download do módulo falhar, o app avisa sem quebrar
    await page.route('**/src/lib/reportPdf*', (route) => route.abort('failed'));
    await page.getByTestId('exportar-pdf').click();
    // falha ao baixar o módulo é falha de rede ("Failed to fetch dynamically imported module"): mensagem traduzida
    await expect(page.getByRole('alert').filter({ hasText: 'Sem conexão com o servidor. Verifique sua internet e tente novamente.' })).toBeVisible();
    await expect(page.getByTestId('exportar-pdf')).toBeEnabled();
    await expect(page.getByTestId('relatorio-geral')).toBeVisible();
  });
});
