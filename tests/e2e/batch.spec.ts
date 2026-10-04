// Ações em lote em Jovens (Fase 7, bloco 8): RPCs batch_set_youth_group / batch_set_youth_active reais (migration 014).
import { readFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { api, daysFromNow, expect, modal, spDay, test, type TestDb } from './fixtures.ts';
import { bulkYouth, seedPeople } from './phase7-helpers.ts';

async function seed(db: TestDb) {
  const p = await seedPeople(db);
  const ana = await db.createYouth('Ana Souza', p.alfa);
  const bia = await db.createYouth('Bia Lima', p.alfa);
  const caio = await db.createYouth('Caio Alheio', p.beta);
  const duda = await db.createYouth('Duda Semgrupo', null);
  return { ...p, ana, bia, caio, duda };
}

const table = (page: Page) => page.locator('table');
const pick = (page: Page, name: string) => table(page).getByRole('checkbox', { name: `Selecionar ${name}` });
const counter = (page: Page) => page.getByTestId('lote-contador');
const bar = (page: Page) => page.getByTestId('lote-barra');
const groupOf = async (db: TestDb, id: string) => (await db.sql<{ group_id: string | null }>(`SELECT group_id FROM youth WHERE id = $1`, [id]))[0].group_id;
const activeOf = async (db: TestDb, id: string) => (await db.sql<{ is_active: boolean }>(`SELECT is_active FROM youth WHERE id = $1`, [id]))[0].is_active;

test.describe('Lote — seleção', () => {
  test('selecionar linha e página, contador e limpar seleção', async ({ page, db, loginAs }) => {
    const s = await seed(db);
    await loginAs(s.carla);
    await page.goto('/jovens');
    await expect(table(page).locator('tbody tr')).toHaveCount(4);
    await expect(bar(page)).toHaveCount(0);

    await pick(page, 'Ana Souza').check();
    await expect(bar(page)).toBeVisible();
    await expect(counter(page)).toHaveText('1 selecionado');
    await pick(page, 'Bia Lima').check();
    await expect(counter(page)).toHaveText('2 selecionados');
    await expect(table(page).locator('tbody tr', { hasText: 'Ana Souza' })).toHaveClass(/bg-blue-50/);
    await pick(page, 'Bia Lima').uncheck();
    await expect(counter(page)).toHaveText('1 selecionado');

    // selecionar a página inteira: o cabeçalho fica "indeterminado" com seleção parcial
    const all = page.getByTestId('lote-selecionar-pagina');
    expect(await all.evaluate((el: HTMLInputElement) => el.indeterminate)).toBe(true);
    await all.check();
    await expect(counter(page)).toHaveText('4 selecionados');
    await expect(all).toBeChecked();
    await all.uncheck();
    await expect(bar(page)).toHaveCount(0);

    await pick(page, 'Duda Semgrupo').check();
    await page.getByTestId('lote-limpar').click();
    await expect(bar(page)).toHaveCount(0);
    await expect(pick(page, 'Duda Semgrupo')).not.toBeChecked();
  });

  test('a seleção atravessa as páginas e some quando o filtro muda', async ({ page, db, loginAs }) => {
    const p = await seedPeople(db);
    await bulkYouth(db, 'Jovem', 30, p.alfa);
    await loginAs(p.carla);
    await page.goto('/jovens');
    await expect(table(page).locator('tbody tr')).toHaveCount(25);

    await page.getByTestId('lote-selecionar-pagina').check();
    await expect(counter(page)).toHaveText('25 selecionados');
    await page.getByRole('button', { name: 'Próxima' }).click();
    await expect(page.getByText('Página 2 de 2')).toBeVisible();
    await expect(table(page).locator('tbody tr')).toHaveCount(5);
    await expect(counter(page)).toHaveText('25 selecionados'); // continua, mesmo fora da página
    await pick(page, 'Jovem 030').check();
    await expect(counter(page)).toHaveText('26 selecionados');

    await page.getByPlaceholder('Buscar por nome...').fill('Jovem 03');
    await expect(table(page).locator('tbody tr')).toHaveCount(1);
    await expect(bar(page)).toHaveCount(0); // filtro mudou: seleção zerada
  });

  test('limite de 200 jovens por lote', async ({ page, db, loginAs }) => {
    const p = await seedPeople(db);
    await bulkYouth(db, 'Jovem', 201, p.alfa);
    await loginAs(p.carla);
    await page.goto('/jovens');
    await expect(table(page).locator('tbody tr')).toHaveCount(25);

    for (let i = 1; i <= 8; i++) {
      await page.getByTestId('lote-selecionar-pagina').check();
      await expect(counter(page)).toContainText(`${i * 25} selecionados`);
      await page.getByRole('button', { name: 'Próxima' }).click();
      await expect(page.getByText(`Página ${i + 1} de 9`)).toBeVisible();
    }
    await expect(counter(page)).toContainText('200 selecionados');
    await expect(table(page).locator('tbody tr')).toHaveCount(1); // 9ª página: 201º jovem

    await expect(page.getByTestId('lote-selecionar-pagina')).toBeEnabled();
    // o checkbox é controlado: no limite o clique não marca (por isso click, não check)
    await page.getByTestId('lote-selecionar-pagina').click();
    await expect(page.getByText('Limite de 200 jovens por lote: 1 não foi selecionado.')).toBeVisible();
    await expect(counter(page)).toContainText('200 selecionados');
    await expect(counter(page)).toContainText('Limite de 200 por lote.');
    await pick(page, 'Jovem 201').click();
    await expect(page.getByText('Você pode selecionar no máximo 200 jovens por lote.')).toBeVisible();
    await expect(counter(page)).toContainText('200 selecionados');
  });

  test('a API também recusa mais de 200 jovens e lote vazio, sem alterar nada', async ({ page, db, loginAs }) => {
    const p = await seedPeople(db);
    const ids = await bulkYouth(db, 'Jovem', 201, p.alfa);
    await loginAs(p.carla);
    await page.goto('/jovens');
    const tooMany = await api(page, 'POST', 'rpc/batch_set_youth_active', { p_youth_ids: ids, p_active: false });
    expect(tooMany.status).toBe(400);
    expect(tooMany.body.message).toBe('Selecione no máximo 200 jovens por vez.');
    const none = await api(page, 'POST', 'rpc/batch_set_youth_group', { p_youth_ids: [], p_group_id: null });
    expect(none.body.message).toBe('Selecione ao menos um jovem.');
    const [{ n }] = await db.sql<{ n: number }>(`SELECT count(*)::int AS n FROM youth WHERE is_active`);
    expect(n).toBe(201);
  });
});

test.describe('Lote — alterar grupo', () => {
  test('muda o grupo de vários jovens, inclusive para "Sem grupo", e avisa quando nada muda', async ({ page, db, loginAs }) => {
    const s = await seed(db);
    await loginAs(s.carla);
    await page.goto('/jovens');
    await pick(page, 'Ana Souza').check();
    await pick(page, 'Duda Semgrupo').check();
    await page.getByTestId('lote-alterar-grupo').click();

    const m = modal(page);
    await expect(m.getByRole('heading', { name: 'Alterar grupo' })).toBeVisible();
    await expect(m).toContainText('2 jovens selecionados.');
    await expect(m.getByLabel('Novo grupo').locator('option')).toHaveText(['Selecione...', 'Grupo Alfa', 'Grupo Beta', 'Sem grupo']);
    await m.getByTestId('lote-grupo-aplicar').click();
    await expect(m.getByRole('alert')).toHaveText('Escolha o grupo de destino ou "Sem grupo".');
    expect(await groupOf(db, s.ana)).toBe(s.alfa);

    await m.getByLabel('Novo grupo').selectOption({ label: 'Grupo Beta' });
    await expect(m.getByTestId('lote-grupo-aplicar')).toHaveText('Aplicar a 2 jovens');
    await m.getByTestId('lote-grupo-aplicar').click();
    await expect(page.getByText('2 atualizados.')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Alterar grupo' })).toHaveCount(0);
    await expect(bar(page)).toHaveCount(0); // seleção limpa
    expect(await groupOf(db, s.ana)).toBe(s.beta);
    expect(await groupOf(db, s.duda)).toBe(s.beta);
    await expect(table(page).locator('tbody tr', { hasText: 'Ana Souza' })).toContainText('Grupo Beta');

    // para "Sem grupo"
    await pick(page, 'Ana Souza').check();
    await page.getByTestId('lote-alterar-grupo').click();
    await modal(page).getByLabel('Novo grupo').selectOption({ label: 'Sem grupo' });
    await modal(page).getByTestId('lote-grupo-aplicar').click();
    await expect(page.getByText('1 atualizado.')).toBeVisible();
    expect(await groupOf(db, s.ana)).toBeNull();
    await expect(table(page).locator('tbody tr', { hasText: 'Ana Souza' })).toContainText('Sem grupo');

    // repetir: ninguém muda -> mensagem explicando que nada mudou
    await pick(page, 'Ana Souza').check();
    await page.getByTestId('lote-alterar-grupo').click();
    await modal(page).getByLabel('Novo grupo').selectOption({ label: 'Sem grupo' });
    await modal(page).getByTestId('lote-grupo-aplicar').click();
    await expect(page.getByText('Nenhuma alteração: os jovens selecionados já estavam nesse estado.')).toBeVisible();

    // histórico: uma entrada por jovem alterado
    const log = await db.sql<{ action: string }>(`SELECT action FROM activity_log WHERE action = 'youth_group_changed'`);
    expect(log).toHaveLength(3);
  });

  test('erro do servidor no lote mostra mensagem amigável no próprio modal', async ({ page, db, loginAs }) => {
    const s = await seed(db);
    await loginAs(s.carla);
    await page.goto('/jovens');
    await page.route('**/rest/v1/rpc/batch_set_youth_group*', (route) =>
      route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ message: 'deadlock em youth' }) }));
    await pick(page, 'Ana Souza').check();
    await page.getByTestId('lote-alterar-grupo').click();
    await modal(page).getByLabel('Novo grupo').selectOption({ label: 'Grupo Beta' });
    await modal(page).getByTestId('lote-grupo-aplicar').click();
    await expect(modal(page).getByRole('alert')).toBeVisible();
    await expect(page.locator('body')).not.toContainText('deadlock');
    expect(await groupOf(db, s.ana)).toBe(s.alfa);
    await expect(counter(page)).toHaveText('1 selecionado'); // a seleção é mantida para tentar de novo
  });
});

test.describe('Lote — ativar e desativar', () => {
  test('desativar pede confirmação e resolve os alertas abertos; ativar reverte o status', async ({ page, db, loginAs }) => {
    const s = await seed(db);
    // Ana: 3 faltas seguidas => alerta aberto
    for (let i = 0; i < 3; i++) {
      const ev = await db.createEvent(`Culto ${i}`, daysFromNow(-21 + i * 7), [s.alfa], 'completed');
      await db.recordAttendance(ev, s.ana, s.alfa, false, s.carla.id);
    }
    const open = () => db.sql<{ status: string }>(`SELECT status::text FROM alerts WHERE youth_id = $1 AND type = 'consecutive_absences'`, [s.ana]);
    expect((await open()).map((a) => a.status)).toEqual(['open']);

    await loginAs(s.carla);
    await page.goto('/jovens');
    await pick(page, 'Ana Souza').check();
    await pick(page, 'Bia Lima').check();

    // cancelar a confirmação não altera nada
    let message = '';
    page.once('dialog', (d) => { message = d.message(); void d.dismiss(); });
    await page.getByTestId('lote-desativar').click();
    await expect.poll(() => message).toBe('Desativar 2 jovens? Os alertas abertos desses jovens serão resolvidos automaticamente.');
    expect(await activeOf(db, s.ana)).toBe(true);
    await expect(counter(page)).toHaveText('2 selecionados');

    page.once('dialog', (d) => void d.accept());
    await page.getByTestId('lote-desativar').click();
    await expect(page.getByText('2 atualizados.')).toBeVisible();
    expect(await activeOf(db, s.ana)).toBe(false);
    expect(await activeOf(db, s.bia)).toBe(false);
    expect((await open()).map((a) => a.status)).toEqual(['resolved']); // alerta resolvido automaticamente
    await expect(table(page).locator('tbody tr')).toHaveCount(2); // lista de ativos: sobraram Caio e Duda

    // ativar de novo (filtro Inativos)
    await page.getByRole('button', { name: 'Inativos', exact: true }).click();
    await expect(table(page).locator('tbody tr')).toHaveCount(2);
    await pick(page, 'Ana Souza').check();
    page.once('dialog', (d) => { message = d.message(); void d.accept(); });
    await page.getByTestId('lote-ativar').click();
    await expect(page.getByText('1 atualizado.')).toBeVisible();
    expect(message).toBe('Ativar 1 jovem?');
    expect(await activeOf(db, s.ana)).toBe(true);
    expect(await activeOf(db, s.bia)).toBe(false);

    // histórico de ativação/desativação
    const log = await db.sql<{ action: string; n: number }>(
      `SELECT action, count(*)::int AS n FROM activity_log WHERE action IN ('youth_activated', 'youth_deactivated') GROUP BY action ORDER BY action`);
    expect(log).toEqual([{ action: 'youth_activated', n: 1 }, { action: 'youth_deactivated', n: 2 }]);
  });
});

test.describe('Lote — exportar CSV', () => {
  test('baixa só os selecionados, em ordem alfabética, com BOM, ";" e fórmulas neutralizadas', async ({ page, db, loginAs }) => {
    const s = await seed(db);
    const evil = await db.createYouth('=CMD Perigoso', s.beta);
    await db.sql(`UPDATE youth SET phone = '(11) 99999-0000', email = 'ana@e2e.test' WHERE id = $1`, [s.ana]);
    await db.sql(`UPDATE youth SET is_active = false WHERE id = $1`, [s.duda]);
    await loginAs(s.carla);
    await page.goto('/jovens');
    await page.getByRole('button', { name: 'Todos', exact: true }).click();
    await expect(table(page).locator('tbody tr')).toHaveCount(5);

    await pick(page, 'Ana Souza').check();
    await pick(page, '=CMD Perigoso').check();
    await pick(page, 'Duda Semgrupo').check();
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('lote-exportar').click()]);
    expect(download.suggestedFilename()).toBe(`jovens-selecionados-${spDay(0)}.csv`);
    const bytes = readFileSync(await download.path());
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const lines = bytes.toString('utf8').replace(/^﻿/, '').split('\r\n');
    expect(lines).toEqual([
      'Nome;Grupo;Telefone;E-mail;Status',
      "'=CMD Perigoso;Grupo Beta;;;Ativo", // "=" ordena antes das letras (ordem pt-BR pelo nome)
      'Ana Souza;Grupo Alfa;(11) 99999-0000;ana@e2e.test;Ativo',
      'Duda Semgrupo;Sem grupo;;;Inativo',
    ]);
    await expect(page.getByText('3 jovens exportados.')).toBeVisible();
    // exportar não altera a seleção nem os dados
    await expect(counter(page)).toHaveText('3 selecionados');
    expect(await groupOf(db, evil)).toBe(s.beta);
  });
});

test.describe('Lote — líder', () => {
  test('jovem alheio vira "sem permissão" (chamada adulterada) e nada é alterado nele', async ({ page, db, loginAs }) => {
    const s = await seed(db);
    await loginAs(s.lia);
    await page.goto('/jovens');
    await expect(table(page).locator('tbody tr')).toHaveCount(2); // só Ana e Bia
    await expect(page.getByLabel('Filtrar por grupo').locator('option')).toHaveText(['Todos os grupos', 'Grupo Alfa']); // sem "Sem grupo" para líder

    // a tela só oferece os jovens dele; a requisição é adulterada para incluir o Caio (outro grupo)
    await page.route('**/rest/v1/rpc/batch_set_youth_group*', (route) => {
      const body = JSON.parse(route.request().postData() ?? '{}');
      return route.continue({ postData: JSON.stringify({ ...body, p_youth_ids: [...body.p_youth_ids, s.caio] }) });
    });
    await pick(page, 'Ana Souza').check();
    await page.getByTestId('lote-alterar-grupo').click();
    await expect(modal(page).getByLabel('Novo grupo').locator('option')).toHaveText(['Selecione...', 'Grupo Alfa', 'Sem grupo']);
    await modal(page).getByLabel('Novo grupo').selectOption({ label: 'Sem grupo' });
    await modal(page).getByTestId('lote-grupo-aplicar').click();

    await expect(page.getByText('1 atualizado, 1 sem permissão.')).toBeVisible();
    expect(await groupOf(db, s.ana)).toBeNull();
    expect(await groupOf(db, s.caio)).toBe(s.beta); // intacto
  });

  test('só jovem alheio: aviso de erro "sem permissão" e API devolve os ids ignorados', async ({ page, db, loginAs }) => {
    const s = await seed(db);
    await loginAs(s.lia);
    await page.goto('/jovens');
    await page.route('**/rest/v1/rpc/batch_set_youth_active*', (route) => {
      const body = JSON.parse(route.request().postData() ?? '{}');
      return route.continue({ postData: JSON.stringify({ ...body, p_youth_ids: [s.caio] }) });
    });
    await pick(page, 'Ana Souza').check();
    page.once('dialog', (d) => void d.accept());
    await page.getByTestId('lote-desativar').click();
    await expect(page.getByRole('alert').filter({ hasText: '1 sem permissão.' })).toBeVisible();
    expect(await activeOf(db, s.caio)).toBe(true);
    expect(await activeOf(db, s.ana)).toBe(true);

    // direto na API (sem a adulteração da tela): desativar e mover jovem alheio
    await page.unroute('**/rest/v1/rpc/batch_set_youth_active*');
    const act = await api(page, 'POST', 'rpc/batch_set_youth_active', { p_youth_ids: [s.caio, s.ana], p_active: false });
    expect(act.status).toBe(200);
    expect(act.body).toMatchObject({ requested: 2, updated: 1, unchanged: 0, skipped: [s.caio] });
    expect(await activeOf(db, s.caio)).toBe(true);
    const move = await api(page, 'POST', 'rpc/batch_set_youth_group', { p_youth_ids: [s.bia], p_group_id: s.beta });
    expect(move.status).toBe(400);
    expect(move.body.message).toBe('Grupo não encontrado ou sem permissão.');
    expect(await groupOf(db, s.bia)).toBe(s.alfa);
    const steal = await api(page, 'POST', 'rpc/batch_set_youth_group', { p_youth_ids: [s.caio], p_group_id: s.alfa });
    expect(steal.body).toMatchObject({ updated: 0, skipped: [s.caio] });
    expect(await groupOf(db, s.caio)).toBe(s.beta);
  });
});
