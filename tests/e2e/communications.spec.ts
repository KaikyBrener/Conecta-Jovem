// Comunicação por e-mail ASSISTIDO (Fase 7, bloco 10): alerta/ficha/acompanhamento -> rascunho -> mailto interceptado
// -> confirmação ("Enviei" / "Não consegui" / cancelar / decidir depois). Banco falso com as migrations reais
// (RLS, guard de estados e triggers de histórico de verdade). Nenhum e-mail é enviado nem aberto.
import type { Page } from '@playwright/test';
import { api, expect, openYouthSheet, test } from './fixtures.ts';
import {
  ANA_EMAIL, MSG, captureMailto, collectLeaks, comItems, commRows, composeToReview, goToMessage, goToReview,
  modalCom, openMail, seedComm, seedWorld,
} from './communications-helpers.ts';

const alertCard = (page: Page, name: string) => page.getByTestId('alerta-item').filter({ hasText: name });

/** href esperado, calculado de forma independente do app (RFC 6068: corpo com CRLF, tudo percent-encoded). */
const expectedMailto = (to: string, subject: string, body: string) =>
  `mailto:${to}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body.replace(/\n/g, '\r\n'))}`;

test.describe('Fluxo completo: alerta -> e-mail -> "Enviei"', () => {
  test('destinatário sugerido, modelo, revisão, mailto correto, status sent, selo no alerta e histórico sem dados do e-mail', async ({ page, db, loginAs }) => {
    const w = await seedWorld(db);
    const mailtos = await captureMailto(page);
    const leaks = collectLeaks(page);
    await loginAs(w.carla);
    await page.goto('/alertas');

    const card = alertCard(page, 'Ana Souza');
    await expect(card).toHaveCount(1);
    await expect(card.getByTestId('alerta-email-enviado')).toHaveCount(0);
    await card.getByTestId('alerta-enviar-email').click();

    // passo 1: o e-mail cadastrado do jovem é sugerido
    const m = modalCom(page);
    await expect(m).toHaveAttribute('data-etapa', 'recipient');
    await expect(m.getByTestId('comunicacao-tipo')).toHaveValue('youth');
    await expect(m.getByTestId('comunicacao-email')).toHaveValue(ANA_EMAIL);
    await expect(m.getByTestId('comunicacao-nome')).toHaveValue('Ana Souza');
    await expect(m.getByTestId('comunicacao-sem-email')).toHaveCount(0);
    await m.getByTestId('comunicacao-proximo').click();

    // passo 2: modelo de "faltas seguidas" pré-selecionado, vínculo com o alerta, texto sem números de frequência
    await expect(m).toHaveAttribute('data-etapa', 'message');
    await expect(m.getByTestId('comunicacao-modelo')).toHaveValue('consecutive_absences');
    await expect(m.getByTestId('comunicacao-vinculo')).toContainText('Relacionada ao alerta: 3 faltas seguidas');
    await expect(m.getByTestId('comunicacao-assunto')).toHaveValue('Sentimos sua falta, Ana Souza');
    const modelBody = await m.getByTestId('comunicacao-corpo').inputValue();
    expect(modelBody).toContain('Olá, Ana Souza!');
    expect(modelBody).toContain('Carla Coordenadora');
    expect(modelBody).toContain('Grupo Alfa');
    expect(modelBody).not.toMatch(/\d+\s*%|\b3 faltas\b/);

    // edita o texto (com caracteres que exigem codificação) e revisa
    await goToReview(page, MSG);
    await expect(m.getByTestId('comunicacao-revisao-destinatario')).toHaveText(`Ana Souza · ${ANA_EMAIL} (Jovem)`);
    await expect(m.getByTestId('comunicacao-revisao-assunto')).toHaveText(MSG.subject);
    await expect(m.getByTestId('comunicacao-revisao-corpo')).toHaveText(MSG.body);
    await expect(m.getByTestId('comunicacao-aviso-longo')).toHaveCount(0);
    expect(await commRows(db)).toHaveLength(0); // nada gravado antes de abrir/salvar

    // abrir o e-mail: grava o rascunho e navega para o mailto (interceptado)
    await openMail(page);
    const [draft] = await commRows(db);
    expect(draft).toMatchObject({
      status: 'draft', subject: MSG.subject, body: MSG.body, recipient_email: ANA_EMAIL, recipient_name: 'Ana Souza',
      recipient_kind: 'youth', alert_id: w.alertId, follow_up_id: null, youth_id: w.ana, created_by: w.carla.id,
      sent_at: null, sent_by: null,
    });
    const hrefs = await mailtos();
    expect(hrefs).toHaveLength(1);
    expect(hrefs[0]).toBe(expectedMailto(ANA_EMAIL, MSG.subject, MSG.body));
    expect(hrefs[0]).toContain('%0D%0A');          // corpo com CRLF
    expect(hrefs[0]).not.toMatch(/[\r\n ]/);        // nada cru no link
    expect(hrefs[0]).toContain('subject=Ol%C3%A1%20%26%20at%C3%A9%20j%C3%A1%3A%20100%25%20ok%3F');
    expect(page.url()).toContain('/alertas');       // continuou no app
    // "Abrir novamente" aponta para o mesmo link
    await expect(m.getByTestId('comunicacao-link-mailto')).toHaveAttribute('href', hrefs[0]);
    await expect(card.getByTestId('alerta-email-enviado')).toHaveCount(0); // ainda não foi confirmado

    // "Enviei": o banco carimba quem e quando
    await m.getByTestId('comunicacao-enviei').click();
    await expect(page.getByText('Comunicação registrada como enviada.')).toBeVisible();
    await expect(m).toHaveCount(0);
    const [sent] = await commRows(db);
    expect(sent).toMatchObject({ id: draft.id, status: 'sent', sent_by: w.carla.id, failure_reason: null });
    expect(sent.sent_at).not.toBeNull();
    // carimbado pelo servidor (now()), não pelo cliente
    expect(await db.sql(`SELECT 1 FROM communications WHERE sent_at BETWEEN now() - interval '2 minutes' AND now()`)).toHaveLength(1);

    // selo no cartão do alerta
    await expect(card.getByTestId('alerta-email-enviado')).toHaveText('E-mail enviado');
    await page.reload();
    await expect(alertCard(page, 'Ana Souza').getByTestId('alerta-email-enviado')).toBeVisible();

    // histórico operacional (banco): texto fixo, sem assunto/corpo/e-mail
    const logs = await db.sql<{ summary: string; meta: unknown; actor_id: string | null }>(
      `SELECT summary, meta, actor_id FROM activity_log WHERE action = 'communication_sent'`);
    expect(logs).toHaveLength(1);
    expect(logs[0].summary).toBe('Comunicação por e-mail marcada como enviada.');
    const logText = JSON.stringify(logs[0]);
    for (const secret of [ANA_EMAIL, 'Olá & até já', 'Linha 1', 'Linha 4', '100%']) expect(logText).not.toContain(secret);

    // ... e na ficha do jovem: histórico recente + item "Enviada" somente leitura
    const sheet = await openYouthSheet(page, 'Ana Souza');
    const recent = sheet.getByTestId('historico-recente');
    await expect(recent).toContainText('E-mail enviado');
    await expect(recent).toContainText('Comunicação por e-mail marcada como enviada.');
    await expect(recent).toContainText('por Carla Coordenadora');
    for (const secret of [ANA_EMAIL, MSG.subject, 'Linha 1']) await expect(recent).not.toContainText(secret);
    const items = comItems(page);
    await expect(items).toHaveCount(1);
    await expect(items.first()).toHaveAttribute('data-status', 'sent');
    await expect(items.first().getByTestId('comunicacao-status')).toContainText('Enviada');
    await expect(items.first()).toContainText(MSG.subject);
    await expect(items.first()).toContainText('Alerta: 3 faltas seguidas');
    await expect(items.first()).toContainText('Responsável: Você');
    // enviada é registro: sem editar/continuar/descartar/reabrir/excluir
    for (const id of ['comunicacao-continuar', 'comunicacao-descartar', 'comunicacao-reabrir', 'comunicacao-excluir']) {
      await expect(items.first().getByTestId(id)).toHaveCount(0);
    }
    await expect(items.first().getByRole('button', { name: /editar/i })).toHaveCount(0);

    // nada do e-mail vazou para o console nem para os avisos
    const all = leaks.console.join('\n');
    for (const secret of [ANA_EMAIL, 'Olá & até já', 'Linha 1', 'Linha 4']) expect(all).not.toContain(secret);
    for (const t of await leaks.toasts()) {
      for (const secret of [ANA_EMAIL, 'Olá & até já', 'Linha 1']) expect(t).not.toContain(secret);
    }
    expect(all).not.toMatch(/ERR_UNKNOWN_URL_SCHEME|external protocol/i);
  });
});

/** Ficha da Ana aberta, com os alertas abertos já carregados (eles alimentam o seletor de alerta do e-mail). */
async function openAnaSheet(page: Page) {
  const sheet = await openYouthSheet(page, 'Ana Souza');
  await expect(sheet.getByTestId('alertas-abertos-jovem')).toBeVisible();
  return sheet;
}

test.describe('Não consegui enviar / reabrir / cancelar / decidir depois', () => {
  const REASONS = [
    ['client_not_opened', 'O aplicativo de e-mail não abriu'],
    ['invalid_address', 'O endereço de e-mail está incorreto'],
    ['bounced', 'O e-mail foi devolvido'],
    ['other', 'Outro motivo'],
  ] as const;

  for (const [reason, label] of REASONS) {
    test(`"Não consegui enviar" com o motivo ${reason} vira failed e pode ser reaberto como rascunho`, async ({ page, db, loginAs }) => {
      const w = await seedWorld(db);
      await captureMailto(page);
      await loginAs(w.carla);
      await page.goto('/jovens');
      const sheet = await openAnaSheet(page);
      await sheet.getByTestId('jovem-enviar-email').click();
      const m = modalCom(page);
      await goToMessage(page);
      // da ficha, o alerta aberto do jovem é oferecido e já vem escolhido (modelo de faltas seguidas)
      await expect(m.getByTestId('comunicacao-alerta')).toHaveValue(w.alertId);
      await expect(m.getByTestId('comunicacao-modelo')).toHaveValue('consecutive_absences');
      await goToReview(page, MSG);
      await openMail(page);

      await m.getByTestId('comunicacao-nao-consegui').click();
      await expect(m.getByTestId(`comunicacao-motivo-client_not_opened`)).toBeChecked();
      await m.getByTestId(`comunicacao-motivo-${reason}`).check();
      await m.getByTestId('comunicacao-confirmar-falha').click();
      await expect(page.getByText('Comunicação registrada como não enviada.')).toBeVisible();
      await expect(m).toHaveCount(0);

      const [row] = await commRows(db);
      expect(row).toMatchObject({ status: 'failed', failure_reason: reason, sent_at: null, sent_by: null, alert_id: w.alertId });
      expect(await db.sql(`SELECT 1 FROM activity_log WHERE action = 'communication_sent'`)).toHaveLength(0);

      const item = comItems(page).first();
      await expect(item).toHaveAttribute('data-status', 'failed');
      await expect(item).toContainText(`Motivo: ${label}`);
      for (const id of ['comunicacao-continuar', 'comunicacao-descartar', 'comunicacao-excluir']) {
        await expect(item.getByTestId(id)).toHaveCount(0);
      }

      // falha não gera selo "E-mail enviado" no alerta
      await page.goto('/alertas');
      await expect(alertCard(page, 'Ana Souza')).toHaveCount(1);
      await expect(alertCard(page, 'Ana Souza').getByTestId('alerta-email-enviado')).toHaveCount(0);

      // reabrir como rascunho: volta a ser editável, com o mesmo conteúdo, direto na revisão
      const sheet2 = await openAnaSheet(page);
      await comItems(page).first().getByTestId('comunicacao-reabrir').click();
      await expect(page.getByText('Comunicação reaberta como rascunho.')).toBeVisible();
      await expect(modalCom(page)).toHaveAttribute('data-etapa', 'review');
      await expect(modalCom(page).getByTestId('comunicacao-revisao-assunto')).toHaveText(MSG.subject);
      await expect(modalCom(page).getByTestId('comunicacao-revisao-corpo')).toHaveText(MSG.body);
      const [reopened] = await commRows(db);
      expect(reopened).toMatchObject({ id: row.id, status: 'draft', failure_reason: null, sent_at: null });
      await modalCom(page).getByTestId('comunicacao-salvar-rascunho').click();
      await expect(page.getByText('Rascunho salvo.')).toBeVisible();
      await expect(sheet2.getByTestId('secao-comunicacoes').getByTestId('comunicacao-item').first()).toHaveAttribute('data-status', 'draft');
      expect(await commRows(db)).toHaveLength(1);
    });
  }

  test('cancelar pede confirmação; recusar mantém o rascunho e aceitar vira cancelled (coordenador ainda pode excluir)', async ({ page, db, loginAs }) => {
    const w = await seedWorld(db);
    await captureMailto(page);
    await loginAs(w.carla);
    await page.goto('/jovens');
    const sheet = await openAnaSheet(page);
    await sheet.getByTestId('jovem-enviar-email').click();
    const m = modalCom(page);
    await composeToReview(page, MSG);
    await openMail(page);

    page.once('dialog', (d) => { expect(d.message()).toContain('Cancelar esta comunicação?'); void d.dismiss(); });
    await m.getByTestId('comunicacao-cancelar-envio').click();
    await expect(m).toHaveAttribute('data-etapa', 'confirm');
    expect((await commRows(db))[0].status).toBe('draft');

    page.once('dialog', (d) => { void d.accept(); });
    await m.getByTestId('comunicacao-cancelar-envio').click();
    await expect(page.getByText('Comunicação cancelada.')).toBeVisible();
    await expect(m).toHaveCount(0);
    expect((await commRows(db))[0]).toMatchObject({ status: 'cancelled', sent_at: null, failure_reason: null });
    expect(await db.sql(`SELECT 1 FROM activity_log WHERE action = 'communication_sent'`)).toHaveLength(0);

    const item = comItems(page).first();
    await expect(item).toHaveAttribute('data-status', 'cancelled');
    await expect(item.getByTestId('comunicacao-continuar')).toHaveCount(0);
    await expect(item.getByTestId('comunicacao-reabrir')).toHaveCount(0);
    await expect(item.getByTestId('comunicacao-excluir')).toBeVisible();
  });

  test('decidir depois mantém o rascunho; dá para continuar, editar e enviar (mesmo registro, sem duplicar)', async ({ page, db, loginAs }) => {
    const w = await seedWorld(db);
    const mailtos = await captureMailto(page);
    await loginAs(w.carla);
    await page.goto('/jovens');
    const sheet = await openAnaSheet(page);
    await sheet.getByTestId('jovem-enviar-email').click();
    const m = modalCom(page);
    await composeToReview(page, MSG);
    await openMail(page);
    await m.getByTestId('comunicacao-decidir-depois').click();
    await expect(page.getByText(/Mantido como rascunho/)).toBeVisible();
    await expect(m).toHaveCount(0);
    const [first] = await commRows(db);
    expect(first.status).toBe('draft');

    const item = comItems(page).first();
    await expect(item).toHaveAttribute('data-status', 'draft');
    await expect(item.getByTestId('comunicacao-status')).toContainText('Rascunho');
    await item.getByTestId('comunicacao-continuar').click();
    await expect(m).toHaveAttribute('data-etapa', 'review');
    await expect(m.getByTestId('comunicacao-revisao-assunto')).toHaveText(MSG.subject);
    await expect(m.getByTestId('comunicacao-revisao-corpo')).toHaveText(MSG.body);
    await expect(m.getByTestId('comunicacao-revisao-destinatario')).toContainText(ANA_EMAIL);

    // volta, edita o assunto e abre de novo: atualiza o MESMO rascunho
    await m.getByRole('button', { name: 'Voltar e editar' }).click();
    await expect(m).toHaveAttribute('data-etapa', 'message');
    await m.getByTestId('comunicacao-assunto').fill('Assunto revisado');
    await goToReview(page);
    await openMail(page);
    const rows = await commRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: first.id, status: 'draft', subject: 'Assunto revisado', body: MSG.body });
    const hrefs = await mailtos();
    expect(hrefs.at(-1)).toBe(expectedMailto(ANA_EMAIL, 'Assunto revisado', MSG.body));

    await m.getByTestId('comunicacao-enviei').click();
    await expect(page.getByText('Comunicação registrada como enviada.')).toBeVisible();
    expect((await commRows(db))[0]).toMatchObject({ id: first.id, status: 'sent', sent_by: w.carla.id });
    await expect(comItems(page)).toHaveCount(1);
    await expect(comItems(page).first()).toHaveAttribute('data-status', 'sent');
  });

  test('salvar rascunho a partir de um acompanhamento: vínculo, modelo de retorno e nenhum mailto aberto', async ({ page, db, loginAs }) => {
    const w = await seedWorld(db);
    const mailtos = await captureMailto(page);
    const fu = await db.createFollowUp(w.ana, 'Conversa de retorno', { responsibleId: w.carla.id });
    await loginAs(w.carla);
    await page.goto('/jovens');
    const sheet = await openAnaSheet(page);
    await sheet.getByTestId('acompanhamento-item').getByTestId('acompanhamento-escrever-email').click();
    const m = modalCom(page);
    await goToMessage(page);
    await expect(m.getByTestId('comunicacao-vinculo')).toContainText('Relacionada ao acompanhamento:');
    await expect(m.getByTestId('comunicacao-modelo')).toHaveValue('return_after_follow_up');
    await expect(m.getByTestId('comunicacao-assunto')).toHaveValue('Obrigado pela conversa, Ana Souza');
    await goToReview(page);
    await m.getByTestId('comunicacao-salvar-rascunho').click();
    await expect(page.getByText('Rascunho salvo.')).toBeVisible();
    await expect(m).toHaveCount(0);
    expect(await mailtos()).toEqual([]); // salvar não abre o e-mail

    const [row] = await commRows(db);
    expect(row).toMatchObject({ status: 'draft', follow_up_id: fu, alert_id: null, youth_id: w.ana });
    const item = comItems(page).first();
    await expect(item).toHaveAttribute('data-status', 'draft');
    await expect(item).toContainText('Acompanhamento:');
  });

  test('trocar o modelo depois de editar pede confirmação e só então substitui o texto', async ({ page, db, loginAs }) => {
    const w = await seedWorld(db);
    await loginAs(w.carla);
    await page.goto('/jovens');
    const sheet = await openAnaSheet(page);
    await sheet.getByTestId('jovem-enviar-email').click();
    const m = modalCom(page);
    await goToMessage(page);
    await m.getByTestId('comunicacao-assunto').fill('Meu assunto');
    page.once('dialog', (d) => { expect(d.message()).toContain('Trocar o modelo substitui'); void d.dismiss(); });
    await m.getByTestId('comunicacao-modelo').selectOption('free');
    await expect(m.getByTestId('comunicacao-modelo')).toHaveValue('consecutive_absences');
    await expect(m.getByTestId('comunicacao-assunto')).toHaveValue('Meu assunto');
    page.once('dialog', (d) => { void d.accept(); });
    await m.getByTestId('comunicacao-modelo').selectOption('free');
    await expect(m.getByTestId('comunicacao-modelo')).toHaveValue('free');
    await expect(m.getByTestId('comunicacao-assunto')).toHaveValue('Mensagem do ministério jovem');
  });
});

test.describe('Destinatário: sem e-mail, outros tipos e validações', () => {
  test('jovem sem e-mail: aviso, bloqueia o avanço e aceita digitação manual (guardado em minúsculas)', async ({ page, db, loginAs }) => {
    const w = await seedWorld(db);
    await loginAs(w.carla);
    await page.goto('/jovens');
    const sheet = await openYouthSheet(page, 'Bia Lima');
    await sheet.getByTestId('jovem-enviar-email').click();
    const m = modalCom(page);
    await expect(m.getByTestId('comunicacao-sem-email')).toContainText('não tem e-mail cadastrado');
    await expect(m.getByTestId('comunicacao-email')).toHaveValue('');
    await m.getByTestId('comunicacao-proximo').click();
    await expect(m.getByTestId('comunicacao-erro')).toHaveText('Informe o e-mail do destinatário.');
    await expect(m).toHaveAttribute('data-etapa', 'recipient');

    await m.getByTestId('comunicacao-tipo').selectOption('guardian');
    await expect(m.getByText('O sistema não guarda o e-mail de responsáveis')).toBeVisible();
    await expect(m.getByTestId('comunicacao-sem-email')).toHaveCount(0);
    await goToMessage(page, { name: 'Mãe da Bia', email: 'Mae.Bia@Exemplo.com' });
    await expect(m.getByTestId('comunicacao-modelo')).toHaveValue('free'); // Bia não tem alerta
    await expect(m.getByTestId('comunicacao-corpo')).toHaveValue(/a respeito de Bia Lima/);
    await goToReview(page);
    await expect(m.getByTestId('comunicacao-revisao-destinatario')).toHaveText('Mãe da Bia · mae.bia@exemplo.com (Responsável)');
    await m.getByTestId('comunicacao-salvar-rascunho').click();
    await expect(page.getByText('Rascunho salvo.')).toBeVisible();
    const [row] = await commRows(db);
    expect(row).toMatchObject({
      recipient_email: 'mae.bia@exemplo.com', recipient_name: 'Mãe da Bia', recipient_kind: 'guardian', status: 'draft', alert_id: null,
    });
  });

  test('e-mails inválidos e tentativas de injeção de cabeçalho são barrados na tela e nada é gravado', async ({ page, db, loginAs }) => {
    const w = await seedWorld(db);
    const mailtos = await captureMailto(page);
    await loginAs(w.carla);
    await page.goto('/jovens');
    const sheet = await openAnaSheet(page);
    await sheet.getByTestId('jovem-enviar-email').click();
    const m = modalCom(page);
    const email = m.getByTestId('comunicacao-email');
    const invalid = [
      'semarroba', 'a@b', 'a b@c.com', 'a@b.com,x@y.com', 'a@b.com;x@y.com', 'a..b@c.com', '.a@b.com', '<a@b.com>',
      'a@b.com\r\nBcc:x@y.com',       // o navegador remove as quebras; o que sobra ("a@b.comBcc:x@y.com") continua inválido
      'a@b.com%0d%0aBcc:x@y.com', 'a@b.com?cc=x@y.com',
      // '%' no local-part (migration 016): percent-decoding no mailto: injetaria cabeçalhos
      'a%0d%0abcc%3dx@y.com', 'a%0abcc@y.com', '%@y.com', 'X_Y%z@y.com',
    ];
    for (const bad of invalid) {
      await email.fill(bad);
      // o campo type=email nunca guarda CR/LF
      expect(await email.inputValue()).not.toMatch(/[\r\n]/);
      await m.getByTestId('comunicacao-proximo').click();
      await expect(m.getByTestId('comunicacao-erro'), `e-mail "${JSON.stringify(bad)}"`).toHaveText('Informe um e-mail válido, por exemplo nome@exemplo.com.');
      await expect(m).toHaveAttribute('data-etapa', 'recipient');
    }
    // nome com separador de linha Unicode (o navegador não o remove): barrado
    await email.fill(ANA_EMAIL);
    await m.getByTestId('comunicacao-nome').fill('Ana Bcc: x@y.com');
    await m.getByTestId('comunicacao-proximo').click();
    await expect(m.getByTestId('comunicacao-erro')).toHaveText('O nome do destinatário não pode ter quebras de linha.');
    await m.getByTestId('comunicacao-nome').fill('Ana');

    // assunto: sem texto, com separador Unicode, grande demais; corpo vazio / grande demais
    await goToMessage(page);
    const proximo = m.getByTestId('comunicacao-proximo');
    const assunto = m.getByTestId('comunicacao-assunto');
    const corpo = m.getByTestId('comunicacao-corpo');
    await assunto.fill('   ');
    await proximo.click();
    await expect(m.getByTestId('comunicacao-erro')).toHaveText('Informe o assunto.');
    await assunto.fill('Oi Bcc: x@y.com');
    await proximo.click();
    await expect(m.getByTestId('comunicacao-erro')).toHaveText('O assunto não pode ter quebras de linha.');
    await assunto.fill('a'.repeat(201));
    await proximo.click();
    await expect(m.getByTestId('comunicacao-erro')).toHaveText('O assunto pode ter até 200 caracteres.');
    await assunto.fill('Assunto ok');
    await corpo.fill('  \n ');
    await proximo.click();
    await expect(m.getByTestId('comunicacao-erro')).toHaveText('Escreva a mensagem.');
    await corpo.fill('b'.repeat(5001));
    await proximo.click();
    await expect(m.getByTestId('comunicacao-erro')).toHaveText('A mensagem pode ter até 5000 caracteres.');
    await expect(m).toHaveAttribute('data-etapa', 'message');
    expect(await commRows(db)).toHaveLength(0);
    expect(await mailtos()).toEqual([]);

    // quebra de linha digitada no assunto: o campo de uma linha a descarta; nem o rascunho nem o mailto a carregam
    await assunto.fill('Assunto\r\nBcc: x@y.com');
    expect(await assunto.inputValue()).not.toMatch(/[\r\n]/);
    await corpo.fill('Corpo\nlinha 2');
    await goToReview(page);
    await openMail(page);
    const [row] = await commRows(db);
    expect(row.subject).not.toMatch(/[\r\n]/);
    expect(row.body).toBe('Corpo\nlinha 2');
    const [href] = await mailtos();
    const subjectPart = href.split('?subject=')[1].split('&body=')[0];
    expect(subjectPart).not.toMatch(/%0[AD]/i);
    expect(href.split('&body=')[1]).toBe('Corpo%0D%0Alinha%202');
    expect(href).not.toMatch(/bcc=/i);
    expect(href.split('?')[0]).toBe(`mailto:${ANA_EMAIL}`);
  });

  test('mensagem longa mostra o aviso de tamanho do mailto e oferece copiar o texto', async ({ page, db, loginAs, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    const w = await seedWorld(db);
    const mailtos = await captureMailto(page);
    await loginAs(w.carla);
    await page.goto('/jovens');
    const sheet = await openAnaSheet(page);
    await sheet.getByTestId('jovem-enviar-email').click();
    const m = modalCom(page);
    const longBody = 'palavra '.repeat(300).trim(); // ~2400 caracteres -> link bem acima de 1800
    await composeToReview(page, { subject: 'Mensagem longa', body: longBody });
    await expect(m.getByTestId('comunicacao-aviso-longo')).toContainText('A mensagem é longa e alguns aplicativos de e-mail podem cortá-la');
    await expect(m.getByTestId('comunicacao-aviso-envio')).toContainText('só registra como enviado o que você confirmar');
    await m.getByTestId('comunicacao-copiar').click();
    await expect(page.getByText('Texto copiado.')).toBeVisible();
    // (o clipboard do Windows converte \n em \r\n; só essa diferença de plataforma é normalizada)
    expect((await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, '\n')).toBe(`Para: ${ANA_EMAIL}\nAssunto: Mensagem longa\n\n${longBody}`);
    await openMail(page);
    const [href] = await mailtos();
    expect(href.length).toBeGreaterThan(1800);
    expect(href).toBe(expectedMailto(ANA_EMAIL, 'Mensagem longa', longBody));
  });
});

test.describe('Banco: adulteração de payload e imutabilidade (API direta)', () => {
  const base = (w: { ana: string; carla: { id: string } }) => ({
    youth_id: w.ana, recipient_email: ANA_EMAIL, recipient_kind: 'youth', subject: 'Assunto', body: 'Corpo', created_by: w.carla.id,
  });

  test('o banco recusa e-mail/assunto/nome com quebra de linha, controles, tamanhos e status/vínculos indevidos', async ({ page, db, loginAs }) => {
    const w = await seedWorld(db);
    await loginAs(w.carla);
    await page.goto('/jovens');
    const b = base(w);

    const bad: [string, Record<string, unknown>][] = [
      ['e-mail com CRLF + Bcc', { recipient_email: 'a@b.com\r\nBcc:x@y.com' }],
      ['e-mail com LF final', { recipient_email: 'a@b.com\n' }],
      ['e-mail com vírgula (2 destinatários)', { recipient_email: 'a@b.com,x@y.com' }],
      ['e-mail sem domínio', { recipient_email: 'a@b' }],
      // migration 016: '%' no local-part permitia injetar cabeçalhos via percent-decoding do mailto:
      ['e-mail com %0d%0a no local-part (injeção de Bcc)', { recipient_email: 'a%0d%0abcc%3dx@y.com' }],
      ['e-mail com %0a no local-part', { recipient_email: 'a%0abcc@y.com' }],
      ['e-mail só com %', { recipient_email: '%@y.com' }],
      ['e-mail com % entre letras', { recipient_email: 'X_Y%z@y.com' }],
      ['nome com LF', { recipient_name: 'Ana\nBcc: x@y.com' }],
      ['nome com U+2028', { recipient_name: 'Ana x' }],
      ['assunto com CRLF + Bcc', { subject: 'Oi\r\nBcc: x@y.com' }],
      ['assunto com LF', { subject: 'Oi\nBcc: x@y.com' }],
      ['assunto com TAB', { subject: 'Oi\tx' }],
      ['assunto com U+0085', { subject: 'Oi\u0085x' }],
      ['assunto com U+2028', { subject: 'Oi x' }],
      ['assunto vazio', { subject: '   ' }],
      ['assunto com 201 caracteres', { subject: 'a'.repeat(201) }],
      ['corpo com BEL', { body: 'x\u0007y' }],
      ['corpo só com espaços', { body: ' \n\t ' }],
      ['corpo com 5001 caracteres', { body: 'b'.repeat(5001) }],
      ['criar já como enviada', { status: 'sent' }],
      ['canal diferente de e-mail', { channel: 'sms' }],
      ['sem jovem', { youth_id: null }],
      ['tipo de destinatário inválido', { recipient_kind: 'hacker' }],
      ['motivo de falha inválido', { status: 'failed', failure_reason: 'x' }],
    ];
    for (const [what, patch] of bad) {
      const res = await api(page, 'POST', 'communications', { ...b, ...patch });
      expect(res.status, `${what}: ${JSON.stringify(res.body)}`).toBeGreaterThanOrEqual(400);
    }
    expect(await commRows(db), 'nenhuma linha deve ter sido gravada').toHaveLength(0);

    // sanidade: o payload base é aceito (as recusas acima são pelos campos adulterados, não por outro motivo)
    const ok = await api(page, 'POST', 'communications', { ...b, recipient_email: '  ANA.Souza@Exemplo.com  ' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(ok.body[0]).toMatchObject({ status: 'draft', recipient_email: ANA_EMAIL, created_by: w.carla.id });
    const id = ok.body[0].id as string;

    // o mesmo vale para editar o rascunho
    for (const patch of [
      { recipient_email: 'x@y.com\r\nBcc:z@w.com' }, { recipient_email: 'x%0d%0abcc%3dz@w.com' },
      { subject: 'Oi\r\nBcc: x@y.com' }, { recipient_name: 'A\nB' }, { body: 'x\u0007' },
    ]) {
      const res = await api(page, 'PATCH', `communications?id=eq.${id}`, patch);
      expect(res.status, JSON.stringify(patch)).toBeGreaterThanOrEqual(400);
    }
    const [row] = await commRows(db);
    expect(row).toMatchObject({ id, subject: 'Assunto', body: 'Corpo', recipient_email: ANA_EMAIL, recipient_name: null });
  });

  test('"enviada" é imutável: UPDATE direto, troca de status, vínculos e DELETE falham; carimbo de envio é do servidor', async ({ page, db, loginAs }) => {
    const w = await seedWorld(db);
    await loginAs(w.carla);
    await page.goto('/jovens');
    const created = await api(page, 'POST', 'communications', { ...base(w), alert_id: w.alertId });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const id = created.body[0].id as string;

    // tentativa de forjar o carimbo ao enviar por UPDATE direto: sent_at/sent_by são do servidor
    const sent = await api(page, 'PATCH', `communications?id=eq.${id}`, {
      status: 'sent', sent_at: '2000-01-01T00:00:00Z', sent_by: w.caio.id,
    });
    expect(sent.status, JSON.stringify(sent.body)).toBeLessThan(300);
    expect(sent.body[0]).toMatchObject({ status: 'sent', sent_by: w.carla.id });
    expect(new Date(sent.body[0].sent_at).getFullYear()).toBeGreaterThanOrEqual(2026);
    const [before] = await commRows(db);

    const attempts: [string, () => Promise<{ status: number; body: any }>][] = [
      ['assunto', () => api(page, 'PATCH', `communications?id=eq.${id}`, { subject: 'Adulterado' })],
      ['corpo', () => api(page, 'PATCH', `communications?id=eq.${id}`, { body: 'Adulterado' })],
      ['destinatário', () => api(page, 'PATCH', `communications?id=eq.${id}`, { recipient_email: 'outro@exemplo.com' })],
      ['voltar a rascunho', () => api(page, 'PATCH', `communications?id=eq.${id}`, { status: 'draft' })],
      ['falhou', () => api(page, 'PATCH', `communications?id=eq.${id}`, { status: 'failed', failure_reason: 'other' })],
      ['cancelar', () => api(page, 'PATCH', `communications?id=eq.${id}`, { status: 'cancelled' })],
      ['trocar jovem', () => api(page, 'PATCH', `communications?id=eq.${id}`, { youth_id: w.zeca })],
      ['desvincular alerta', () => api(page, 'PATCH', `communications?id=eq.${id}`, { alert_id: null })],
      ['RPC para rascunho', () => api(page, 'POST', 'rpc/mark_communication', { p_id: id, p_status: 'draft' })],
      ['RPC para cancelada', () => api(page, 'POST', 'rpc/mark_communication', { p_id: id, p_status: 'cancelled' })],
      ['RPC para enviada de novo', () => api(page, 'POST', 'rpc/mark_communication', { p_id: id, p_status: 'sent' })],
      ['RPC com status inválido', () => api(page, 'POST', 'rpc/mark_communication', { p_id: id, p_status: 'deleted' })],
    ];
    for (const [what, run] of attempts) {
      const res = await run();
      expect(res.status, `${what}: ${JSON.stringify(res.body)}`).toBeGreaterThanOrEqual(400);
    }
    const del = await api(page, 'DELETE', `communications?id=eq.${id}`);
    expect(del.body, 'DELETE de enviada não remove nada').toEqual([]);
    expect(await commRows(db)).toEqual([before]);
    expect(await db.sql(`SELECT 1 FROM activity_log WHERE action = 'communication_sent'`)).toHaveLength(1);
  });

  test('transições inválidas: failed só volta a rascunho/cancelada; conteúdo e status não mudam na mesma operação', async ({ page, db, loginAs }) => {
    const w = await seedWorld(db);
    await loginAs(w.carla);
    await page.goto('/jovens');
    const created = await api(page, 'POST', 'communications', base(w));
    const id = created.body[0].id as string;

    const mixed = await api(page, 'PATCH', `communications?id=eq.${id}`, { status: 'sent', subject: 'Outro assunto' });
    expect(mixed.status).toBeGreaterThanOrEqual(400);
    expect(mixed.body.message).toContain('operações separadas');
    expect((await commRows(db))[0]).toMatchObject({ status: 'draft', subject: 'Assunto' });

    const failed = await api(page, 'POST', 'rpc/mark_communication', { p_id: id, p_status: 'failed', p_failure_reason: 'bounced' });
    expect(failed.status, JSON.stringify(failed.body)).toBeLessThan(300);
    expect(failed.body).toMatchObject({ status: 'failed', failure_reason: 'bounced', sent_at: null });
    // failed não vai direto para enviada nem aceita edição de conteúdo
    expect((await api(page, 'POST', 'rpc/mark_communication', { p_id: id, p_status: 'sent' })).status).toBeGreaterThanOrEqual(400);
    expect((await api(page, 'PATCH', `communications?id=eq.${id}`, { subject: 'Editado' })).status).toBeGreaterThanOrEqual(400);
    expect((await api(page, 'POST', 'rpc/mark_communication', { p_id: id, p_status: 'failed', p_failure_reason: 'x' })).status).toBeGreaterThanOrEqual(400);
    expect((await commRows(db))[0]).toMatchObject({ status: 'failed', subject: 'Assunto', failure_reason: 'bounced' });
    const back = await api(page, 'POST', 'rpc/mark_communication', { p_id: id, p_status: 'draft' });
    expect(back.body).toMatchObject({ status: 'draft', failure_reason: null });
  });
});

test.describe('Permissões: coordenador x líder', () => {
  test('coordenador exclui só rascunho e cancelada; enviada e falha ficam (UI e API)', async ({ page, db, loginAs }) => {
    const w = await seedWorld(db);
    await seedComm(db, { youthId: w.ana, createdBy: w.carla, status: 'sent', subject: 'Já enviada' });
    await seedComm(db, { youthId: w.ana, createdBy: w.carla, status: 'failed', subject: 'Que falhou' });
    await seedComm(db, { youthId: w.ana, createdBy: w.carla, status: 'cancelled', subject: 'Cancelada' });
    await seedComm(db, { youthId: w.ana, createdBy: w.carla, status: 'draft', subject: 'Rascunho' });
    await loginAs(w.carla);
    await page.goto('/jovens');
    await openAnaSheet(page);
    const byStatus = (s: string) => comItems(page).and(page.locator(`[data-status="${s}"]`));
    await expect(comItems(page)).toHaveCount(4);
    await expect(byStatus('sent').getByTestId('comunicacao-excluir')).toHaveCount(0);
    await expect(byStatus('failed').getByTestId('comunicacao-excluir')).toHaveCount(0);
    await expect(byStatus('failed').getByTestId('comunicacao-reabrir')).toBeVisible();
    await expect(byStatus('draft').getByTestId('comunicacao-excluir')).toBeVisible();
    await expect(byStatus('cancelled').getByTestId('comunicacao-excluir')).toBeVisible();

    page.once('dialog', (d) => { expect(d.message()).toContain('Excluir esta comunicação definitivamente?'); void d.dismiss(); });
    await byStatus('draft').getByTestId('comunicacao-excluir').click();
    await expect(comItems(page)).toHaveCount(4);
    page.once('dialog', (d) => { void d.accept(); });
    await byStatus('draft').getByTestId('comunicacao-excluir').click();
    await expect(page.getByText('Comunicação excluída.')).toBeVisible();
    await expect(comItems(page)).toHaveCount(3);
    page.once('dialog', (d) => { void d.accept(); });
    await byStatus('cancelled').getByTestId('comunicacao-excluir').click();
    await expect(comItems(page)).toHaveCount(2);
    expect((await commRows(db)).map((r) => r.status).sort()).toEqual(['failed', 'sent']);

    // pela API, enviada e falha continuam intocáveis
    for (const r of await commRows(db)) {
      const del = await api(page, 'DELETE', `communications?id=eq.${r.id}`);
      expect(del.body).toEqual([]);
    }
    expect(await commRows(db)).toHaveLength(2);
  });

  test('líder: vê e cria só do seu grupo, vê "Outro usuário" quando não enxerga o autor, não edita nem exclui o alheio', async ({ page, db, loginAs }) => {
    const w = await seedWorld(db);
    const carlaDraft = await seedComm(db, { youthId: w.ana, createdBy: w.carla, subject: 'Rascunho da Carla' });
    const liaDraft = await seedComm(db, { youthId: w.ana, createdBy: w.lia, subject: 'Rascunho da Lia' });
    const zecaDraft = await seedComm(db, { youthId: w.zeca, createdBy: w.carla, subject: 'Do jovem alheio' });
    await loginAs(w.lia);
    await page.goto('/jovens');
    await openYouthSheet(page, 'Ana Souza');
    const items = comItems(page);
    await expect(items).toHaveCount(2);
    const carlas = items.filter({ hasText: 'Rascunho da Carla' });
    const lias = items.filter({ hasText: 'Rascunho da Lia' });
    await expect(carlas).toContainText('Responsável: Outro usuário');
    await expect(lias).toContainText('Responsável: Você');
    // só edita/descarta o que criou; ninguém do papel líder exclui
    for (const id of ['comunicacao-continuar', 'comunicacao-descartar', 'comunicacao-excluir', 'comunicacao-reabrir']) {
      await expect(carlas.getByTestId(id), id).toHaveCount(0);
    }
    await expect(lias.getByTestId('comunicacao-continuar')).toBeVisible();
    await expect(lias.getByTestId('comunicacao-descartar')).toBeVisible();
    await expect(lias.getByTestId('comunicacao-excluir')).toHaveCount(0);
    await expect(carlas.getByRole('button', { name: 'Ver mensagem' })).toBeVisible(); // leitura continua permitida

    // API como líder: jovem alheio é invisível/negado; vínculos e autoria não são forjáveis
    expect((await api(page, 'GET', `communications?youth_id=eq.${w.zeca}`)).body).toEqual([]);
    expect((await api(page, 'GET', 'communications?select=id')).body.map((r: any) => r.id).sort()).toEqual([carlaDraft, liaDraft].sort());
    const forged = await api(page, 'POST', 'communications', {
      youth_id: w.zeca, recipient_email: 'z@exemplo.com', recipient_kind: 'other', subject: 'x', body: 'y', created_by: w.lia.id,
    });
    expect(forged.status, JSON.stringify(forged.body)).toBeGreaterThanOrEqual(400);
    const asCarla = await api(page, 'POST', 'communications', {
      youth_id: w.ana, recipient_email: 'z@exemplo.com', recipient_kind: 'other', subject: 'x', body: 'y', created_by: w.carla.id,
    });
    expect(asCarla.status, JSON.stringify(asCarla.body)).toBe(201);
    expect(asCarla.body[0].created_by, 'autoria vem da sessão, não do payload').toBe(w.lia.id);
    expect((await api(page, 'PATCH', `communications?id=eq.${carlaDraft}`, { subject: 'Adulterado' })).body).toEqual([]);
    expect((await api(page, 'DELETE', `communications?id=eq.${liaDraft}`)).body).toEqual([]);
    for (const target of [carlaDraft, zecaDraft]) {
      const r = await api(page, 'POST', 'rpc/mark_communication', { p_id: target, p_status: 'sent' });
      expect(r.status, JSON.stringify(r.body)).toBeGreaterThanOrEqual(400);
      expect(r.body.message).toBe('Comunicação não encontrada ou sem permissão.');
    }
    expect((await api(page, 'POST', 'rpc/suggest_communication_recipients', { p_youth_id: w.zeca })).body).toEqual([]);
    expect((await api(page, 'POST', 'rpc/suggest_communication_recipients', { p_youth_id: w.ana })).body)
      .toEqual([{ kind: 'youth', name: 'Ana Souza', email: ANA_EMAIL }]);
    const rows = await commRows(db);
    expect(rows.find((r) => r.id === carlaDraft)).toMatchObject({ subject: 'Rascunho da Carla', status: 'draft' });
    expect(rows.find((r) => r.id === liaDraft)).toBeTruthy();
    expect(rows.some((r) => r.youth_id === w.zeca && r.created_by === w.lia.id)).toBe(false);
  });

  test('líder cumpre o fluxo completo pelo alerta do seu grupo e o selo aparece', async ({ page, db, loginAs }) => {
    const w = await seedWorld(db);
    await captureMailto(page);
    await loginAs(w.lia);
    await page.goto('/alertas');
    const card = alertCard(page, 'Ana Souza');
    await card.getByTestId('alerta-enviar-email').click();
    await composeToReview(page, MSG);
    await openMail(page);
    await modalCom(page).getByTestId('comunicacao-enviei').click();
    await expect(page.getByText('Comunicação registrada como enviada.')).toBeVisible();
    await expect(card.getByTestId('alerta-email-enviado')).toBeVisible();
    expect((await commRows(db))[0]).toMatchObject({ status: 'sent', created_by: w.lia.id, sent_by: w.lia.id, alert_id: w.alertId });
  });

  test('histórico sobrevive à exclusão do jovem pelo coordenador (youth_id fica nulo; líder deixa de ver)', async ({ page, db, loginAs }) => {
    const w = await seedWorld(db);
    await loginAs(w.carla);
    await page.goto('/jovens');
    const created = await api(page, 'POST', 'communications', { ...{
      youth_id: w.ana, alert_id: w.alertId, recipient_email: ANA_EMAIL, recipient_kind: 'youth', subject: 'Registro que deve sobreviver',
      body: 'Corpo preservado', created_by: w.carla.id } });
    const id = created.body[0].id as string;
    const sent = await api(page, 'POST', 'rpc/mark_communication', { p_id: id, p_status: 'sent' });
    expect(sent.status, JSON.stringify(sent.body)).toBeLessThan(300);
    const [before] = await commRows(db);
    const logsBefore = await db.sql(`SELECT id FROM activity_log WHERE action = 'communication_sent'`);
    expect(logsBefore).toHaveLength(1);

    const del = await api(page, 'DELETE', `youth?id=eq.${w.ana}`);
    expect(del.status, JSON.stringify(del.body)).toBeLessThan(300);
    expect(await db.sql(`SELECT 1 FROM youth WHERE id = $1`, [w.ana])).toHaveLength(0);

    const [after] = await commRows(db);
    expect(after).toMatchObject({
      id, status: 'sent', subject: 'Registro que deve sobreviver', body: 'Corpo preservado', recipient_email: ANA_EMAIL,
      sent_by: w.carla.id, sent_at: before.sent_at, youth_id: null,
    });
    expect(await db.sql(`SELECT id FROM activity_log WHERE action = 'communication_sent'`)).toEqual(logsBefore);
    // o coordenador ainda lê o registro; o líder (escopo depende do jovem) não
    expect((await api(page, 'GET', `communications?id=eq.${id}`)).body).toHaveLength(1);
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Jovens', exact: true })).toBeVisible();
  });
});

test.describe('Falhas do servidor e vazamento de dados', () => {
  test('erro 500 em mark_communication: mensagem amigável, estado preservado e nada do e-mail no console', async ({ page, db, loginAs }) => {
    const w = await seedWorld(db);
    await captureMailto(page);
    const leaks = collectLeaks(page);
    await loginAs(w.carla);
    await page.goto('/jovens');
    const sheet = await openAnaSheet(page);
    await sheet.getByTestId('jovem-enviar-email').click();
    const m = modalCom(page);
    await composeToReview(page, MSG);
    await openMail(page);

    const RAW = `relation "communications" violates secret internal detail for ${ANA_EMAIL}`;
    let failing = true;
    await page.route('**/rest/v1/rpc/mark_communication*', (route) =>
      failing
        ? route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ code: 'XX000', message: RAW, details: 'stack: boom', hint: null }) })
        : route.continue());

    await m.getByTestId('comunicacao-enviei').click();
    const banner = m.getByRole('alert');
    await expect(banner).toHaveText(/O servidor encontrou um problema|Erro ao atualizar a comunicação\./);
    await expect(page.getByText(/violates|secret internal|stack: boom|XX000/i)).toHaveCount(0);
    // estado preservado: continua na confirmação, botões habilitados, rascunho intacto
    await expect(m).toHaveAttribute('data-etapa', 'confirm');
    await expect(m.getByTestId('comunicacao-enviei')).toBeEnabled();
    expect((await commRows(db))[0]).toMatchObject({ status: 'draft', sent_at: null, subject: MSG.subject, body: MSG.body });

    // falha ao registrar a falha: o painel e o motivo escolhido continuam
    await m.getByTestId('comunicacao-nao-consegui').click();
    await m.getByTestId('comunicacao-motivo-bounced').check();
    await m.getByTestId('comunicacao-confirmar-falha').click();
    await expect(m.getByRole('alert')).toBeVisible();
    await expect(m.getByTestId('comunicacao-motivo-bounced')).toBeChecked();
    expect((await commRows(db))[0].status).toBe('draft');

    // o servidor volta: o mesmo modal conclui o envio
    failing = false;
    await m.getByRole('button', { name: 'Voltar', exact: true }).click();
    await m.getByTestId('comunicacao-enviei').click();
    await expect(page.getByText('Comunicação registrada como enviada.')).toBeVisible();
    expect((await commRows(db))[0]).toMatchObject({ status: 'sent', sent_by: w.carla.id });

    const consoleText = leaks.console.join('\n');
    for (const secret of [ANA_EMAIL, 'Olá & até já', 'Linha 1', 'Linha 4', 'stack: boom']) expect(consoleText).not.toContain(secret);
    expect(consoleText).toContain('[conecta-jovem]'); // o erro foi registrado (sanitizado)
    expect(consoleText).toContain('[e-mail]');
  });

  test('erro 500 ao salvar o rascunho: mensagem amigável e o formulário continua preenchido', async ({ page, db, loginAs }) => {
    const w = await seedWorld(db);
    await captureMailto(page);
    await loginAs(w.carla);
    await page.goto('/jovens');
    const sheet = await openAnaSheet(page);
    await sheet.getByTestId('jovem-enviar-email').click();
    const m = modalCom(page);
    await composeToReview(page, MSG);
    await page.route('**/rest/v1/communications*', (route) =>
      route.request().method() === 'POST'
        ? route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ code: 'XX000', message: 'tabela communications explodiu', details: null, hint: null }) })
        : route.continue());
    await m.getByTestId('comunicacao-abrir-email').click();
    await expect(m.getByRole('alert')).toHaveText(/O servidor encontrou um problema|Erro ao salvar o rascunho\./);
    await expect(page.getByText(/explodiu|communications/i)).toHaveCount(0);
    await expect(m).toHaveAttribute('data-etapa', 'review'); // não avançou para "Você enviou?" sem ter gravado
    await expect(m.getByTestId('comunicacao-revisao-assunto')).toHaveText(MSG.subject);
    expect(await commRows(db)).toHaveLength(0);
  });
});

