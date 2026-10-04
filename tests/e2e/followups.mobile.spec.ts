import type { Page } from '@playwright/test';
import { daysFromNow, expect, modal, openYouthSheet, test } from './fixtures.ts';

// Largura de celular pequeno: a ficha do jovem (situação + acompanhamento) e seus formulários
// precisam caber na tela, sem rolagem horizontal.
test.use({ viewport: { width: 390, height: 844 } });

const hasHorizontalScroll = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);

/** O elemento fica inteiro dentro da largura da tela. */
async function fitsWidth(_page: Page, locator: ReturnType<Page['locator']>) {
  const box = (await locator.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(390);
}

test.describe('Ficha do jovem e acompanhamento no mobile (390px)', () => {
  test('selo na lista, painel de situação e registro/transferência de acompanhamento cabem na tela', async ({ page, db, loginAs }) => {
    const carla = await db.createUser('coordinator', 'Carla Coordenadora');
    const lia = await db.createUser('leader', 'Lia Lider');
    const alfa = await db.createGroup('Grupo Alfa', lia.id);
    const ana = await db.createYouth('Ana Souza', alfa);
    for (let i = 0; i < 3; i++) {
      const ev = await db.createEvent(`Culto ${i + 1}`, daysFromNow(-21 + i * 7), [alfa], 'completed');
      await db.recordAttendance(ev, ana, alfa, false, carla.id);
    }
    await loginAs(carla);

    // lista em cards: selo de situação visível e sem estouro
    await page.goto('/jovens');
    const card = page.locator('main ul li', { hasText: 'Ana Souza' });
    await expect(card.getByTestId('situacao-selo')).toHaveText('Atenção');
    expect(await hasHorizontalScroll(page)).toBe(false);

    // ficha: painel de situação com motivo e métricas
    const sheet = await openYouthSheet(page, 'Ana Souza');
    const painel = sheet.getByTestId('painel-situacao');
    await expect(painel.getByTestId('situacao-motivos').locator('li')).toHaveText(['3 faltas seguidas']);
    await expect(painel.getByTestId('metrica-faltas')).toHaveText('3');
    await fitsWidth(page, painel);
    expect(await hasHorizontalScroll(page)).toBe(false);

    // novo acompanhamento: formulário cabe na tela e salva (o clique em "Registrar" falharia se a bottom-nav cobrisse o modal)
    await sheet.getByRole('button', { name: 'Novo acompanhamento' }).click();
    const form = modal(page);
    await expect(form.getByRole('heading', { name: 'Novo acompanhamento' })).toBeVisible();
    for (const label of ['Data do contato', 'Motivo', 'Próxima ação', 'Alerta']) {
      const field = form.getByLabel(label, { exact: label === 'Próxima ação' });
      await field.scrollIntoViewIfNeeded();
      await fitsWidth(page, field);
    }
    expect(await hasHorizontalScroll(page)).toBe(false);
    await form.getByLabel('Motivo').fill('Visita rápida');
    await form.getByLabel('Responsável', { exact: true }).selectOption({ label: 'Lia Lider' });
    await form.getByRole('button', { name: 'Registrar acompanhamento' }).click();
    await expect(page.getByText('Acompanhamento registrado.')).toBeVisible();
    const item = page.getByTestId('acompanhamento-item');
    await expect(item).toHaveCount(1);
    await item.scrollIntoViewIfNeeded();
    await fitsWidth(page, item);
    await expect(item.getByTestId('responsavel-atual')).toHaveText('Lia Lider');

    // transferir: modal cabe na tela e o histórico fica legível
    await item.getByRole('button', { name: 'Transferir responsável' }).click();
    const transfer = modal(page);
    await expect(transfer.getByRole('heading', { name: 'Transferir responsável' })).toBeVisible();
    await transfer.getByLabel('Novo responsável').selectOption({ label: 'Carla Coordenadora · Coordenador' });
    await transfer.getByLabel('Motivo da transferência').fill('A coordenação assume o caso');
    await fitsWidth(page, transfer.getByLabel('Motivo da transferência'));
    await transfer.getByRole('button', { name: 'Transferir', exact: true }).click();
    await expect(page.getByText('Responsável transferido.')).toBeVisible();
    await item.getByRole('button', { name: /Transferências \(1\)/ }).click();
    const history = item.getByTestId('historico-transferencias');
    await expect(history).toContainText('Lia Lider → Carla Coordenadora · A coordenação assume o caso');
    await fitsWidth(page, history);
    expect(await hasHorizontalScroll(page)).toBe(false);
    expect(await db.sql(`SELECT responsible_id FROM follow_ups`)).toEqual([{ responsible_id: carla.id }]);
  });
});
