// E-mail assistido em celular pequeno (390px): o assistente em passos, a revisão e a confirmação cabem na tela,
// sem rolagem horizontal, e os botões ficam alcançáveis (o clique falharia se a bottom-nav cobrisse o modal).
import type { Locator, Page } from '@playwright/test';
import { expect, test } from './fixtures.ts';
import { ANA_EMAIL, MSG, captureMailto, commRows, goToMessage, goToReview, modalCom, openMail, seedWorld } from './communications-helpers.ts';

test.use({ viewport: { width: 390, height: 844 } });

const hasHorizontalScroll = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);

async function fitsWidth(locator: Locator) {
  await locator.scrollIntoViewIfNeeded();
  const box = (await locator.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(390);
}

test.describe('E-mail assistido no mobile (390px)', () => {
  test('alerta -> destinatário -> mensagem -> revisão -> abrir e-mail -> "Enviei" cabe na tela', async ({ page, db, loginAs }) => {
    const w = await seedWorld(db);
    const mailtos = await captureMailto(page);
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
    await fitsWidth(m.getByTestId('comunicacao-abrir-email'));
    expect(await hasHorizontalScroll(page)).toBe(false);

    await openMail(page);
    expect(await mailtos()).toHaveLength(1);
    await fitsWidth(m.getByTestId('comunicacao-confirmacao'));
    for (const id of ['comunicacao-enviei', 'comunicacao-nao-consegui', 'comunicacao-cancelar-envio', 'comunicacao-decidir-depois']) {
      await fitsWidth(m.getByTestId(id));
    }
    await fitsWidth(m.getByTestId('comunicacao-link-mailto'));
    expect(await hasHorizontalScroll(page)).toBe(false);

    // painel de falha também cabe
    await m.getByTestId('comunicacao-nao-consegui').click();
    for (const r of ['client_not_opened', 'invalid_address', 'bounced', 'other']) await fitsWidth(m.getByTestId(`comunicacao-motivo-${r}`));
    await fitsWidth(m.getByTestId('comunicacao-confirmar-falha'));
    await m.getByRole('button', { name: 'Voltar', exact: true }).click();

    await m.getByTestId('comunicacao-enviei').click();
    await expect(page.getByText('Comunicação registrada como enviada.')).toBeVisible();
    await expect(card.getByTestId('alerta-email-enviado')).toBeVisible();
    expect((await commRows(db))[0]).toMatchObject({ status: 'sent', sent_by: w.carla.id, alert_id: w.alertId });
    expect(await hasHorizontalScroll(page)).toBe(false);
  });
});
