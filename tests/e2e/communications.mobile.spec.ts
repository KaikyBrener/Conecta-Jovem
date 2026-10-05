// E-mail com envio real em celular pequeno (390px): o assistente em passos, a revisão, o resultado (enviado e falha) e o
// histórico cabem na tela, sem rolagem horizontal, e os botões ficam alcançáveis (o clique falharia se a bottom-nav cobrisse o modal).
import type { Locator, Page } from '@playwright/test';
import { expect, test } from './fixtures.ts';
import {
  ANA_EMAIL, MSG, commRows, comItems, goToMessage, goToReview, mailCalls, modalCom, seedWorld, sendMail, setMail,
} from './communications-helpers.ts';

test.use({ viewport: { width: 390, height: 844 } });

const hasHorizontalScroll = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);

async function fitsWidth(locator: Locator) {
  await locator.scrollIntoViewIfNeeded();
  const box = (await locator.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(390);
}

test.describe('E-mail com envio real no mobile (390px)', () => {
  test('alerta -> destinatário -> mensagem -> revisão -> Enviar -> resultado "Enviado" cabe na tela', async ({ page, db, loginAs }) => {
    const w = await seedWorld(db);
    await loginAs(w.carla);
    await page.goto('/alertas');
    const card = page.getByTestId('alerta-item').filter({ hasText: 'Ana Souza' });
    await expect(card).toHaveCount(1);
    expect(await hasHorizontalScroll(page)).toBe(false);
    await card.getByTestId('alerta-enviar-email').scrollIntoViewIfNeeded();
    await card.getByTestId('alerta-enviar-email').click();

    const m = modalCom(page);
    await expect(m).toHaveAttribute('data-etapa', 'recipient');
    for (const id of ['comunicacao-tipo', 'comunicacao-nome', 'comunicacao-email']) await fitsWidth(m.getByTestId(id));
    await expect(m.getByTestId('comunicacao-email')).toHaveValue(ANA_EMAIL);
    expect(await hasHorizontalScroll(page)).toBe(false);

    await goToMessage(page);
    for (const id of ['comunicacao-modelo', 'comunicacao-assunto', 'comunicacao-corpo']) await fitsWidth(m.getByTestId(id));
    await goToReview(page, MSG);
    await fitsWidth(m.getByTestId('comunicacao-revisao-corpo'));
    await fitsWidth(m.getByTestId('comunicacao-aviso-envio'));
    await fitsWidth(m.getByTestId('comunicacao-enviar'));
    await fitsWidth(m.getByTestId('comunicacao-salvar-rascunho'));
    expect(await hasHorizontalScroll(page)).toBe(false);

    await sendMail(page);
    await expect(m.getByTestId('comunicacao-resultado')).toHaveAttribute('data-resultado', 'sent');
    await fitsWidth(m.getByTestId('comunicacao-resultado'));
    await fitsWidth(m.getByTestId('comunicacao-fechar'));
    expect(await hasHorizontalScroll(page)).toBe(false);
    expect(await mailCalls()).toHaveLength(1);
    expect((await commRows(db))[0]).toMatchObject({ status: 'sent', sent_by: w.carla.id, alert_id: w.alertId, provider: 'resend' });

    await m.getByTestId('comunicacao-fechar').click();
    await expect(card.getByTestId('alerta-email-enviado')).toBeVisible();
    expect(await hasHorizontalScroll(page)).toBe(false);
  });

  test('falha do provedor: resultado "não foi enviado", "Tentar novamente" e "Editar mensagem" alcançáveis; sucesso depois reenvia a mesma linha', async ({ page, db, loginAs }) => {
    const w = await seedWorld(db);
    await setMail('http5xx');
    await loginAs(w.carla);
    await page.goto('/alertas');
    const card = page.getByTestId('alerta-item').filter({ hasText: 'Ana Souza' });
    await card.getByTestId('alerta-enviar-email').scrollIntoViewIfNeeded();
    await card.getByTestId('alerta-enviar-email').click();
    const m = modalCom(page);
    await goToMessage(page);
    await goToReview(page, MSG);
    await sendMail(page);

    await expect(m.getByTestId('comunicacao-resultado')).toHaveAttribute('data-resultado', 'failed');
    await expect(m.getByTestId('comunicacao-motivo-falha')).toHaveText('Não foi possível enviar o e-mail. Tente novamente.');
    for (const id of ['comunicacao-resultado', 'comunicacao-motivo-falha', 'comunicacao-tentar-novamente', 'comunicacao-editar-mensagem', 'comunicacao-fechar']) {
      await fitsWidth(m.getByTestId(id));
    }
    expect(await hasHorizontalScroll(page)).toBe(false);
    await expect(page.getByText('E-mail enviado.', { exact: true })).toHaveCount(0);
    const [failed] = await commRows(db);
    expect(failed).toMatchObject({ status: 'failed', failure_reason: 'unknown', sent_at: null, attempts: 1 });

    await setMail('success');
    await m.getByTestId('comunicacao-tentar-novamente').click();
    await expect(m.getByTestId('comunicacao-resultado')).toHaveAttribute('data-resultado', 'sent');
    await fitsWidth(m.getByTestId('comunicacao-fechar'));
    const rows = await commRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: failed.id, status: 'sent', attempts: 2 });
    expect(await mailCalls()).toHaveLength(2);
    expect(await hasHorizontalScroll(page)).toBe(false);
  });

  test('ficha do jovem: histórico com Falhou/Enviando cabe na tela e os botões do item ficam alcançáveis', async ({ page, db, loginAs }) => {
    const w = await seedWorld(db);
    await setMail('network');
    await loginAs(w.carla);
    await page.goto('/jovens');
    await page.getByRole('button', { name: /Ana Souza/ }).first().click();
    const sheet = page.locator('div.fixed.inset-0').first();
    await expect(sheet.getByTestId('alertas-abertos-jovem')).toBeVisible();
    await sheet.getByTestId('jovem-enviar-email').scrollIntoViewIfNeeded();
    await sheet.getByTestId('jovem-enviar-email').click();
    const m = modalCom(page);
    await goToMessage(page);
    await goToReview(page, MSG);
    await sendMail(page);
    await m.getByTestId('comunicacao-fechar').click();

    const item = comItems(page).first();
    await expect(item).toHaveAttribute('data-status', 'failed');
    await fitsWidth(item);
    for (const id of ['comunicacao-motivo-falha', 'comunicacao-reenviar', 'comunicacao-reabrir']) await fitsWidth(item.getByTestId(id));
    expect(await hasHorizontalScroll(page)).toBe(false);
  });
});
