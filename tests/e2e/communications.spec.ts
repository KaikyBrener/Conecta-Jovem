// Comunicação por e-mail com ENVIO REAL pelo servidor (migration 018): alerta/ficha/acompanhamento -> compor -> revisar ->
// "Enviar e-mail" (1 clique) -> Edge Function (handler real) -> PROVEDOR FALSO -> status real no banco e na tela.
// Banco falso com as migrations reais (RLS, guard de estados e triggers de histórico de verdade).
// Falhas do provedor, estados concorrentes, permissões da função e vazamentos: communications-send.spec.ts.
// Nenhum e-mail é enviado de verdade.
import type { Page } from '@playwright/test';
import { answerConfirmation, api, expect, openYouthSheet, test } from './fixtures.ts';
import {
  ANA_EMAIL, FAKE_PROVIDER_KEY, MSG, idemKey, PROVIDER_RAW_TEXT, callSend, collectLeaks, comItems, commRows, composeToReview, goToMessage,
  goToReview, mailCalls, modalCom, seedComm, seedWorld, sendMail, setMail,
} from './communications-helpers.ts';

const alertCard = (page: Page, name: string) => page.getByTestId('alerta-item').filter({ hasText: name });

/** Ficha da Ana aberta, com os alertas abertos já carregados (eles alimentam o seletor de alerta do e-mail). */
async function openAnaSheet(page: Page) {
  const sheet = await openYouthSheet(page, 'Ana Souza');
  await expect(sheet.getByTestId('alertas-abertos-jovem')).toBeVisible();
  return sheet;
}

test.describe('Fluxo completo: compor -> revisar -> Enviar (sucesso)', () => {
  test('alerta: destinatário sugerido, modelo, revisão, UM clique envia ao provedor (texto puro), status sent, selo e histórico sem dados do e-mail', async ({ page, db, loginAs }) => {
    const w = await seedWorld(db);
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

    // edita o texto (caracteres que exigem codificação, e algo que parece HTML) e revisa
    await goToReview(page, MSG);
    await expect(m.getByTestId('comunicacao-revisao-destinatario')).toHaveText(`Ana Souza · ${ANA_EMAIL} (Jovem)`);
    await expect(m.getByTestId('comunicacao-revisao-assunto')).toHaveText(MSG.subject);
    await expect(m.getByTestId('comunicacao-revisao-corpo')).toHaveText(MSG.body);
    await expect(m.getByTestId('comunicacao-aviso-envio')).toContainText('enviada de verdade');
    expect(await commRows(db)).toHaveLength(0);    // nada gravado antes do clique
    expect(await mailCalls()).toHaveLength(0);

    // UM clique: salva o rascunho, chama a função, o provedor falso recebe a mensagem
    await sendMail(page);
    const result = m.getByTestId('comunicacao-resultado');
    await expect(result).toHaveAttribute('data-resultado', 'sent');
    await expect(result).toContainText('E-mail enviado');
    await expect(result).toContainText('Enviado em');
    await expect(page.getByText('E-mail enviado.', { exact: true })).toBeVisible();     // toast

    const calls = await mailCalls();
    expect(calls).toHaveLength(1);
    const [row] = await commRows(db);
    expect(calls[0].payload.to).toEqual([ANA_EMAIL]);
    expect(calls[0].payload.subject).toBe(MSG.subject);
    expect(calls[0].payload.text).toBe(MSG.body);                          // TEXTO PURO, exatamente o que foi revisado
    expect(Object.keys(calls[0].payload).sort()).toEqual(['from', 'reply_to', 'subject', 'text', 'to']);   // sem html/cc/bcc
    expect(calls[0].payload.reply_to).toBe(w.carla.email);
    expect(calls[0].headers['Idempotency-Key']).toBe(idemKey(row.id, ANA_EMAIL, MSG.subject, MSG.body));

    // banco: carimbos do servidor
    expect(row).toMatchObject({
      status: 'sent', subject: MSG.subject, body: MSG.body, recipient_email: ANA_EMAIL, recipient_name: 'Ana Souza',
      recipient_kind: 'youth', alert_id: w.alertId, follow_up_id: null, youth_id: w.ana, created_by: w.carla.id,
      sent_by: w.carla.id, provider: 'resend', attempts: 1, failure_reason: null,
    });
    expect(row.sent_at).not.toBeNull();
    expect(row.provider_message_id).toMatch(/^re_fake_\d+$/);
    expect(await db.sql(`SELECT 1 FROM communications WHERE sent_at BETWEEN now() - interval '2 minutes' AND now()`)).toHaveLength(1);

    // fechar -> selo no cartão do alerta (e depois de recarregar)
    await m.getByTestId('comunicacao-fechar').click();
    await expect(m).toHaveCount(0);
    await expect(card.getByTestId('alerta-email-enviado')).toHaveText('E-mail enviado');
    await page.reload();
    await expect(alertCard(page, 'Ana Souza').getByTestId('alerta-email-enviado')).toBeVisible();

    // histórico operacional (banco): texto fixo, sem assunto/corpo/e-mail/chave; atribuído a quem enviou
    const logs = await db.sql<{ summary: string; meta: unknown; actor_id: string | null }>(
      `SELECT summary, meta, actor_id FROM activity_log WHERE action = 'communication_sent'`);
    expect(logs).toHaveLength(1);
    expect(logs[0].summary).toBe('Comunicação por e-mail enviada.');
    expect(logs[0].actor_id).toBe(w.carla.id);
    const logText = JSON.stringify(logs[0]);
    for (const secret of [ANA_EMAIL, 'Olá & até já', 'Linha 1', 'Linha 4', '100%', row.provider_message_id!, FAKE_PROVIDER_KEY]) {
      expect(logText).not.toContain(secret);
    }

    // ... e na ficha do jovem: histórico recente + item "Enviado" somente leitura, com destinatário, assunto, data, responsável, vínculo
    const sheet = await openYouthSheet(page, 'Ana Souza');
    const recent = sheet.getByTestId('historico-recente');
    await expect(recent).toContainText('E-mail enviado');
    await expect(recent).toContainText('Comunicação por e-mail enviada.');
    await expect(recent).toContainText('por Carla Coordenadora');
    for (const secret of [ANA_EMAIL, MSG.subject, 'Linha 1']) await expect(recent).not.toContainText(secret);
    const items = comItems(page);
    await expect(items).toHaveCount(1);
    const item = items.first();
    await expect(item).toHaveAttribute('data-status', 'sent');
    await expect(item.getByTestId('comunicacao-status')).toContainText('Enviado');
    await expect(item).toContainText(MSG.subject);
    await expect(item).toContainText(`Para: Ana Souza · ${ANA_EMAIL} (Jovem)`);
    await expect(item).toContainText('Enviado em');
    await expect(item).toContainText('Alerta: 3 faltas seguidas');
    await expect(item).toContainText('Responsável: Você');
    // enviado é registro: sem editar/continuar/descartar/reabrir/reenviar/excluir
    for (const id of ['comunicacao-continuar', 'comunicacao-descartar', 'comunicacao-reabrir', 'comunicacao-reenviar', 'comunicacao-excluir']) {
      await expect(item.getByTestId(id), id).toHaveCount(0);
    }

    // nada do e-mail, da chave ou do provedor vazou para o console nem para os avisos
    const all = leaks.console.join('\n');
    for (const secret of [ANA_EMAIL, 'Olá & até já', 'Linha 1', 'Linha 4', FAKE_PROVIDER_KEY, 'api.resend.com', row.provider_message_id!]) {
      expect(all).not.toContain(secret);
    }
    for (const t of await leaks.toasts()) {
      for (const secret of [ANA_EMAIL, 'Olá & até já', 'Linha 1', FAKE_PROVIDER_KEY]) expect(t).not.toContain(secret);
    }
    expect(await mailCalls()).toHaveLength(1);   // nenhum envio extra ao recarregar/abrir telas
  });

  test('acompanhamento: compor com o modelo de retorno e enviar; o vínculo com o acompanhamento fica no registro e no histórico', async ({ page, db, loginAs }) => {
    const w = await seedWorld(db);
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
    const subject = await m.getByTestId('comunicacao-assunto').inputValue();
    const body = await m.getByTestId('comunicacao-corpo').inputValue();
    await goToReview(page);
    await sendMail(page);
    await expect(m.getByTestId('comunicacao-resultado')).toHaveAttribute('data-resultado', 'sent');

    const [call] = await mailCalls();
    expect(call.payload).toMatchObject({ to: [ANA_EMAIL], subject, text: body.replace(/\r\n/g, '\n') });
    const [row] = await commRows(db);
    expect(row).toMatchObject({ status: 'sent', follow_up_id: fu, alert_id: null, youth_id: w.ana, sent_by: w.carla.id, provider: 'resend' });

    await m.getByTestId('comunicacao-fechar').click();
    const item = comItems(page).first();
    await expect(item).toHaveAttribute('data-status', 'sent');
    await expect(item).toContainText('Acompanhamento:');
    await expect(item.getByTestId('comunicacao-status')).toHaveText('Enviado');
    const logs = await db.sql<{ summary: string }>(`SELECT summary FROM activity_log WHERE action = 'communication_sent'`);
    expect(logs.map((l) => l.summary)).toEqual(['Comunicação por e-mail enviada.']);
  });
});

test.describe('Rascunho, descartar e reabrir', () => {
  test('salvar rascunho não envia nada; continuar, editar e enviar usa o MESMO registro (sem duplicar)', async ({ page, db, loginAs }) => {
    const w = await seedWorld(db);
    await loginAs(w.carla);
    await page.goto('/jovens');
    const sheet = await openAnaSheet(page);
    await sheet.getByTestId('jovem-enviar-email').click();
    const m = modalCom(page);
    await composeToReview(page, MSG);
    await m.getByTestId('comunicacao-salvar-rascunho').click();
    await expect(page.getByText('Rascunho salvo.')).toBeVisible();
    await expect(m).toHaveCount(0);
    expect(await mailCalls()).toEqual([]);          // salvar rascunho nunca envia
    const [first] = await commRows(db);
    expect(first).toMatchObject({ status: 'draft', sent_at: null, sent_by: null, attempts: 0, provider: null, subject: MSG.subject });

    const item = comItems(page).first();
    await expect(item).toHaveAttribute('data-status', 'draft');
    await expect(item.getByTestId('comunicacao-status')).toContainText('Rascunho');
    await item.getByTestId('comunicacao-continuar').click();
    await expect(m).toHaveAttribute('data-etapa', 'review');
    await expect(m.getByTestId('comunicacao-revisao-assunto')).toHaveText(MSG.subject);
    await expect(m.getByTestId('comunicacao-revisao-corpo')).toHaveText(MSG.body);
    await expect(m.getByTestId('comunicacao-revisao-destinatario')).toContainText(ANA_EMAIL);

    // volta, edita o assunto e envia: atualiza o MESMO rascunho e o provedor recebe o texto editado
    await m.getByRole('button', { name: 'Voltar e editar' }).click();
    await expect(m).toHaveAttribute('data-etapa', 'message');
    await m.getByTestId('comunicacao-assunto').fill('Assunto revisado');
    await goToReview(page);
    await sendMail(page);
    await expect(m.getByTestId('comunicacao-resultado')).toHaveAttribute('data-resultado', 'sent');
    const rows = await commRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: first.id, status: 'sent', subject: 'Assunto revisado', body: MSG.body, sent_by: w.carla.id });
    const calls = await mailCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0].payload).toMatchObject({ to: [ANA_EMAIL], subject: 'Assunto revisado', text: MSG.body });
    await m.getByTestId('comunicacao-fechar').click();
    await expect(comItems(page)).toHaveCount(1);
    await expect(comItems(page).first()).toHaveAttribute('data-status', 'sent');
  });

  test('descartar pede confirmação (recusar mantém o rascunho; aceitar cancela sem enviar) e só o coordenador exclui', async ({ page, db, loginAs }) => {
    const w = await seedWorld(db);
    await loginAs(w.carla);
    await page.goto('/jovens');
    const sheet = await openAnaSheet(page);
    await sheet.getByTestId('jovem-enviar-email').click();
    await composeToReview(page, MSG);
    await modalCom(page).getByTestId('comunicacao-salvar-rascunho').click();
    await expect(page.getByText('Rascunho salvo.')).toBeVisible();

    const item = comItems(page).first();
    await item.getByTestId('comunicacao-descartar').click();
    expect(await answerConfirmation(page, false)).toContain('Descartar este rascunho?');
    await expect(item).toHaveAttribute('data-status', 'draft');
    expect((await commRows(db))[0].status).toBe('draft');

    await item.getByTestId('comunicacao-descartar').click();
    await answerConfirmation(page, true);
    await expect(page.getByText('Comunicação descartada.')).toBeVisible();
    await expect(item).toHaveAttribute('data-status', 'cancelled');
    expect((await commRows(db))[0]).toMatchObject({ status: 'cancelled', sent_at: null, failure_reason: null, sent_by: null });
    expect(await mailCalls()).toEqual([]);
    expect(await db.sql(`SELECT 1 FROM activity_log WHERE action = 'communication_sent'`)).toHaveLength(0);
    for (const id of ['comunicacao-continuar', 'comunicacao-reabrir', 'comunicacao-reenviar']) await expect(item.getByTestId(id)).toHaveCount(0);
    await expect(item.getByTestId('comunicacao-excluir')).toBeVisible();

    // cancelada é terminal: a função se recusa a enviar (409 not_sendable)
    const res = await callSend(page, (await commRows(db))[0].id);
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'not_sendable' });
    expect(await mailCalls()).toEqual([]);
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
    await m.getByTestId('comunicacao-modelo').selectOption('free');
    expect(await answerConfirmation(page, false)).toContain('Trocar o modelo substitui');
    await expect(m.getByTestId('comunicacao-modelo')).toHaveValue('consecutive_absences');
    await expect(m.getByTestId('comunicacao-assunto')).toHaveValue('Meu assunto');
    await m.getByTestId('comunicacao-modelo').selectOption('free');
    await answerConfirmation(page, true);
    await expect(m.getByTestId('comunicacao-modelo')).toHaveValue('free');
    await expect(m.getByTestId('comunicacao-assunto')).toHaveValue('Mensagem do ministério jovem');
  });
});

test.describe('Destinatário: sem e-mail, outros tipos e validações', () => {
  test('jovem sem e-mail: aviso, bloqueia o avanço e aceita digitação manual (guardado em minúsculas) e o provedor recebe só o digitado', async ({ page, db, loginAs }) => {
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

    // enviar o rascunho: o provedor recebe exatamente o destinatário digitado (normalizado), nada mais
    await comItems(page).first().getByTestId('comunicacao-continuar').click();
    await sendMail(page);
    await expect(m.getByTestId('comunicacao-resultado')).toHaveAttribute('data-resultado', 'sent');
    const calls = await mailCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0].payload.to).toEqual(['mae.bia@exemplo.com']);
  });

  test('e-mails inválidos e injeção de cabeçalho são barrados na tela: nada é gravado nem enviado', async ({ page, db, loginAs }) => {
    const w = await seedWorld(db);
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
    expect(await mailCalls()).toEqual([]);

    // quebra de linha digitada no assunto: o campo de uma linha a descarta; nem o banco nem o provedor a recebem
    await assunto.fill('Assunto\r\nBcc: x@y.com');
    expect(await assunto.inputValue()).not.toMatch(/[\r\n]/);
    await corpo.fill('Corpo\nlinha 2');
    await goToReview(page);
    await sendMail(page);
    await expect(m.getByTestId('comunicacao-resultado')).toHaveAttribute('data-resultado', 'sent');
    const [row] = await commRows(db);
    expect(row.subject).not.toMatch(/[\r\n]/);
    expect(row.body).toBe('Corpo\nlinha 2');
    const [call] = await mailCalls();
    expect(call.payload.subject).not.toMatch(/[\r\n]/);
    expect(call.payload.subject).toBe(row.subject);
    expect(call.payload.to).toEqual([ANA_EMAIL]);
    expect(call.payload).not.toHaveProperty('bcc');
    expect(call.payload).not.toHaveProperty('cc');
  });

  test('mensagem no limite (5000 caracteres, multilinha e símbolos) chega inteira ao provedor, em texto puro', async ({ page, db, loginAs }) => {
    const w = await seedWorld(db);
    await loginAs(w.carla);
    await page.goto('/jovens');
    const sheet = await openAnaSheet(page);
    await sheet.getByTestId('jovem-enviar-email').click();
    const m = modalCom(page);
    const line = 'Linha <i>itálico</i> & "aspas" çã 100% ok';
    const body = Array.from({ length: 200 }, () => line).join('\n').slice(0, 5000);
    expect(body.length).toBe(5000);
    await composeToReview(page, { subject: 'a'.repeat(200), body });
    await sendMail(page);
    await expect(m.getByTestId('comunicacao-resultado')).toHaveAttribute('data-resultado', 'sent');
    const [call] = await mailCalls();
    expect(call.payload.text).toBe(body);
    expect(call.payload.subject).toBe('a'.repeat(200));
    expect(call.payload).not.toHaveProperty('html');
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
      // migration 016: '%' no local-part permitia injetar cabeçalhos via percent-decoding
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
      ['criar já como enviando', { status: 'sending' }],
      ['criar já como falhou', { status: 'failed', failure_reason: 'unknown' }],
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

    // sanidade: o payload base é aceito (as recusas acima são pelos campos adulterados, não por outro motivo);
    // campos que são "fato do servidor" enviados na criação são DESCARTADOS (nada de forjar envio/provedor/tentativas)
    const ok = await api(page, 'POST', 'communications', {
      ...b, recipient_email: '  ANA.Souza@Exemplo.com  ', sent_at: '2000-01-01T00:00:00Z', sent_by: w.caio.id,
      provider: 'forjado', provider_message_id: 'forjado', attempts: 9, last_attempt_at: '2000-01-01T00:00:00Z',
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(ok.body[0]).toMatchObject({
      status: 'draft', recipient_email: ANA_EMAIL, created_by: w.carla.id, sent_at: null, sent_by: null, provider: null,
      provider_message_id: null, attempts: 0, last_attempt_at: null,
    });
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
    expect(await mailCalls()).toEqual([]);
  });

  test('cliente não define sending/sent/failed (UPDATE direto nem mark_communication) e os carimbos do servidor não são forjáveis', async ({ page, db, loginAs }) => {
    const w = await seedWorld(db);
    await loginAs(w.carla);
    await page.goto('/jovens');
    const created = await api(page, 'POST', 'communications', base(w));
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const id = created.body[0].id as string;
    const [before] = await commRows(db);

    const forbidden: [string, () => Promise<{ status: number; body: any }>][] = [
      ['PATCH -> sent', () => api(page, 'PATCH', `communications?id=eq.${id}`, { status: 'sent' })],
      ['PATCH -> sent com carimbos forjados', () => api(page, 'PATCH', `communications?id=eq.${id}`, {
        status: 'sent', sent_at: '2000-01-01T00:00:00Z', sent_by: w.caio.id, provider: 'resend', provider_message_id: 'x' })],
      ['PATCH -> sending', () => api(page, 'PATCH', `communications?id=eq.${id}`, { status: 'sending' })],
      ['PATCH -> failed', () => api(page, 'PATCH', `communications?id=eq.${id}`, { status: 'failed', failure_reason: 'unknown' })],
      ['RPC -> sent', () => api(page, 'POST', 'rpc/mark_communication', { p_id: id, p_status: 'sent' })],
      ['RPC -> sending', () => api(page, 'POST', 'rpc/mark_communication', { p_id: id, p_status: 'sending' })],
      ['RPC -> failed', () => api(page, 'POST', 'rpc/mark_communication', { p_id: id, p_status: 'failed', p_failure_reason: 'bounced' })],
      ['RPC com status inválido', () => api(page, 'POST', 'rpc/mark_communication', { p_id: id, p_status: 'deleted' })],
    ];
    for (const [what, run] of forbidden) {
      const res = await run();
      expect(res.status, `${what}: ${JSON.stringify(res.body)}`).toBeGreaterThanOrEqual(400);
    }
    expect(await commRows(db)).toEqual([before]);

    // campos do servidor enviados junto de uma edição legítima são descartados (a edição vale, os carimbos não)
    const edit = await api(page, 'PATCH', `communications?id=eq.${id}`, {
      subject: 'Assunto novo', sent_at: '2000-01-01T00:00:00Z', sent_by: w.caio.id, provider: 'forjado', provider_message_id: 'forjado',
      attempts: 99, last_attempt_at: '2000-01-01T00:00:00Z', failure_reason: 'unknown', created_by: w.caio.id,
    });
    expect(edit.status, JSON.stringify(edit.body)).toBeLessThan(300);
    expect((await commRows(db))[0]).toMatchObject({
      id, status: 'draft', subject: 'Assunto novo', sent_at: null, sent_by: null, provider: null, provider_message_id: null,
      attempts: 0, last_attempt_at: null, failure_reason: null, created_by: w.carla.id,
    });

    // `sending` recente é intocável para o cliente: nem editar, nem cancelar, nem excluir
    const sending = await seedComm(db, { youthId: w.ana, createdBy: w.carla, status: 'sending', minutesAgo: 0, subject: 'Em envio' });
    const snap = (await commRows(db)).find((r) => r.id === sending)!;
    for (const [what, run] of [
      ['editar', () => api(page, 'PATCH', `communications?id=eq.${sending}`, { subject: 'Adulterado' })],
      ['cancelar (PATCH)', () => api(page, 'PATCH', `communications?id=eq.${sending}`, { status: 'cancelled' })],
      ['voltar a rascunho', () => api(page, 'PATCH', `communications?id=eq.${sending}`, { status: 'draft' })],
      ['cancelar (RPC)', () => api(page, 'POST', 'rpc/mark_communication', { p_id: sending, p_status: 'cancelled' })],
      ['reabrir (RPC)', () => api(page, 'POST', 'rpc/mark_communication', { p_id: sending, p_status: 'draft' })],
    ] as [string, () => Promise<{ status: number; body: any }>][]) {
      const res = await run();
      expect(res.status, `${what}: ${JSON.stringify(res.body)}`).toBeGreaterThanOrEqual(400);
    }
    expect((await api(page, 'DELETE', `communications?id=eq.${sending}`)).body).toEqual([]);
    expect((await commRows(db)).find((r) => r.id === sending)).toEqual(snap);
    expect(await mailCalls()).toEqual([]);
  });

  test('"enviado" (envio real) é imutável: UPDATE, troca de status, vínculos, RPC e DELETE falham; reenviar dá 409 e nenhum e-mail extra', async ({ page, db, loginAs }) => {
    const w = await seedWorld(db);
    await loginAs(w.carla);
    await page.goto('/jovens');
    const created = await api(page, 'POST', 'communications', { ...base(w), alert_id: w.alertId });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const id = created.body[0].id as string;

    const sent = await callSend(page, id);
    expect(sent.status, sent.text).toBe(200);
    expect(sent.body).toMatchObject({ status: 'sent', communication_id: id });
    expect(new Date(sent.body.sent_at).getFullYear()).toBeGreaterThanOrEqual(2026);
    const [before] = await commRows(db);
    expect(before).toMatchObject({ status: 'sent', sent_by: w.carla.id, provider: 'resend', attempts: 1 });

    const attempts: [string, () => Promise<{ status: number; body: any }>][] = [
      ['assunto', () => api(page, 'PATCH', `communications?id=eq.${id}`, { subject: 'Adulterado' })],
      ['corpo', () => api(page, 'PATCH', `communications?id=eq.${id}`, { body: 'Adulterado' })],
      ['destinatário', () => api(page, 'PATCH', `communications?id=eq.${id}`, { recipient_email: 'outro@exemplo.com' })],
      ['voltar a rascunho', () => api(page, 'PATCH', `communications?id=eq.${id}`, { status: 'draft' })],
      ['falhou', () => api(page, 'PATCH', `communications?id=eq.${id}`, { status: 'failed', failure_reason: 'unknown' })],
      ['cancelar', () => api(page, 'PATCH', `communications?id=eq.${id}`, { status: 'cancelled' })],
      ['trocar jovem', () => api(page, 'PATCH', `communications?id=eq.${id}`, { youth_id: w.zeca })],
      ['desvincular alerta', () => api(page, 'PATCH', `communications?id=eq.${id}`, { alert_id: null })],
      ['RPC para rascunho', () => api(page, 'POST', 'rpc/mark_communication', { p_id: id, p_status: 'draft' })],
      ['RPC para cancelada', () => api(page, 'POST', 'rpc/mark_communication', { p_id: id, p_status: 'cancelled' })],
      ['RPC para enviada de novo', () => api(page, 'POST', 'rpc/mark_communication', { p_id: id, p_status: 'sent' })],
    ];
    for (const [what, run] of attempts) {
      const res = await run();
      expect(res.status, `${what}: ${JSON.stringify(res.body)}`).toBeGreaterThanOrEqual(400);
    }
    // carimbos do servidor: um UPDATE "vazio" que tenta forjá-los não muda nada
    await api(page, 'PATCH', `communications?id=eq.${id}`, { sent_at: '2000-01-01T00:00:00Z', provider: 'forjado', attempts: 0 });
    expect((await api(page, 'DELETE', `communications?id=eq.${id}`)).body, 'DELETE de enviado não remove nada').toEqual([]);
    expect(await commRows(db)).toEqual([before]);
    expect(await db.sql(`SELECT 1 FROM activity_log WHERE action = 'communication_sent'`)).toHaveLength(1);

    const again = await callSend(page, id);
    expect(again.status).toBe(409);
    expect(again.body).toEqual({ error: 'already_sent' });
    expect(await mailCalls()).toHaveLength(1);
    expect(await commRows(db)).toEqual([before]);
  });

  test('transições: falha só volta a rascunho/cancelada; conteúdo e status não mudam na mesma operação; falha não é editável', async ({ page, db, loginAs }) => {
    const w = await seedWorld(db);
    await loginAs(w.carla);
    await page.goto('/jovens');
    const id = await seedComm(db, { youthId: w.ana, createdBy: w.carla, status: 'failed', failureReason: 'provider_rejected', subject: 'Assunto' });

    // falha não é editável nem vai para enviada/enviando/falha por ação do cliente
    expect((await api(page, 'PATCH', `communications?id=eq.${id}`, { subject: 'Editado' })).status).toBeGreaterThanOrEqual(400);
    for (const s of ['sent', 'sending', 'failed']) {
      expect((await api(page, 'POST', 'rpc/mark_communication', { p_id: id, p_status: s })).status, s).toBeGreaterThanOrEqual(400);
    }
    const mixed = await api(page, 'PATCH', `communications?id=eq.${id}`, { status: 'draft', subject: 'Outro assunto' });
    expect(mixed.status).toBeGreaterThanOrEqual(400);
    expect(mixed.body.message).toContain('operações separadas');
    expect((await commRows(db))[0]).toMatchObject({ status: 'failed', subject: 'Assunto', failure_reason: 'provider_rejected' });

    // reabrir: volta a rascunho, o motivo some e o histórico de tentativas fica (attempts)
    const back = await api(page, 'POST', 'rpc/mark_communication', { p_id: id, p_status: 'draft' });
    expect(back.status, JSON.stringify(back.body)).toBeLessThan(300);
    expect(back.body).toMatchObject({ status: 'draft', failure_reason: null, sent_at: null, attempts: 1 });
    expect((await api(page, 'PATCH', `communications?id=eq.${id}`, { subject: 'Editado agora' })).status).toBeLessThan(300);
    expect(await mailCalls()).toEqual([]);
  });
});

test.describe('Permissões: coordenador x líder', () => {
  test('coordenador exclui só rascunho e cancelada; enviado, falhou e enviando ficam (UI e API)', async ({ page, db, loginAs }) => {
    const w = await seedWorld(db);
    await seedComm(db, { youthId: w.ana, createdBy: w.carla, status: 'sent', subject: 'Já enviada' });
    await seedComm(db, { youthId: w.ana, createdBy: w.carla, status: 'failed', subject: 'Que falhou' });
    await seedComm(db, { youthId: w.ana, createdBy: w.carla, status: 'sending', subject: 'Em envio' });
    await seedComm(db, { youthId: w.ana, createdBy: w.carla, status: 'cancelled', subject: 'Cancelada' });
    await seedComm(db, { youthId: w.ana, createdBy: w.carla, status: 'draft', subject: 'Rascunho' });
    await loginAs(w.carla);
    await page.goto('/jovens');
    await openAnaSheet(page);
    const byStatus = (s: string) => comItems(page).and(page.locator(`[data-status="${s}"]`));
    await expect(comItems(page)).toHaveCount(5);
    for (const s of ['sent', 'failed', 'sending']) await expect(byStatus(s).getByTestId('comunicacao-excluir'), s).toHaveCount(0);
    await expect(byStatus('failed').getByTestId('comunicacao-reabrir')).toBeVisible();
    await expect(byStatus('draft').getByTestId('comunicacao-excluir')).toBeVisible();
    await expect(byStatus('cancelled').getByTestId('comunicacao-excluir')).toBeVisible();

    await byStatus('draft').getByTestId('comunicacao-excluir').click();
    expect(await answerConfirmation(page, false)).toContain('Excluir esta comunicação definitivamente?');
    await expect(comItems(page)).toHaveCount(5);
    await byStatus('draft').getByTestId('comunicacao-excluir').click();
    await answerConfirmation(page, true);
    await expect(page.getByText('Comunicação excluída.')).toBeVisible();
    await expect(comItems(page)).toHaveCount(4);
    await byStatus('cancelled').getByTestId('comunicacao-excluir').click();
    await answerConfirmation(page, true);
    await expect(comItems(page)).toHaveCount(3);
    expect((await commRows(db)).map((r) => r.status).sort()).toEqual(['failed', 'sending', 'sent']);

    // pela API, enviado, falha e envio em andamento continuam intocáveis
    for (const r of await commRows(db)) {
      const del = await api(page, 'DELETE', `communications?id=eq.${r.id}`);
      expect(del.body, r.status).toEqual([]);
    }
    expect(await commRows(db)).toHaveLength(3);
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
    for (const id of ['comunicacao-continuar', 'comunicacao-descartar', 'comunicacao-excluir', 'comunicacao-reabrir', 'comunicacao-reenviar']) {
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
      youth_id: w.ana, recipient_email: ANA_EMAIL, recipient_kind: 'youth', subject: 'x', body: 'y', created_by: w.carla.id,
    });
    expect(asCarla.status, JSON.stringify(asCarla.body)).toBe(201);
    expect(asCarla.body[0].created_by, 'autoria vem da sessão, não do payload').toBe(w.lia.id);
    expect((await api(page, 'PATCH', `communications?id=eq.${carlaDraft}`, { subject: 'Adulterado' })).body).toEqual([]);
    expect((await api(page, 'DELETE', `communications?id=eq.${liaDraft}`)).body).toEqual([]);
    for (const target of [carlaDraft, zecaDraft]) {
      const r = await api(page, 'POST', 'rpc/mark_communication', { p_id: target, p_status: 'cancelled' });
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
    expect(await mailCalls()).toEqual([]);
  });

  test('líder só envia ao e-mail cadastrado do PRÓPRIO jovem: destinatário alheio é barrado na API (gravar e enviar) e na tela', async ({ page, db, loginAs }) => {
    const w = await seedWorld(db);
    // rascunhos antigos/adulterados gravados fora do app (superusuário) com destinatário que não é o do jovem
    const stranger = await seedComm(db, { youthId: w.ana, createdBy: w.lia, email: 'terceiro@exemplo.com', subject: 'Para terceiro' });
    const asGuardian = await seedComm(db, { youthId: w.ana, createdBy: w.lia, email: ANA_EMAIL, kind: 'guardian', subject: 'Como responsável' });
    await loginAs(w.lia);
    await page.goto('/jovens');
    const base = { youth_id: w.ana, recipient_kind: 'youth', subject: 'Assunto', body: 'Corpo', created_by: w.lia.id };

    // gravar: outro e-mail, outro tipo, e-mail do jovem em maiúsculas é aceito (normalizado)
    for (const [what, patch] of [
      ['e-mail de terceiro', { recipient_email: 'terceiro@exemplo.com' }],
      ['tipo responsável', { recipient_email: ANA_EMAIL, recipient_kind: 'guardian' }],
      ['tipo outro', { recipient_email: ANA_EMAIL, recipient_kind: 'other' }],
      ['e-mail do jovem com sufixo', { recipient_email: 'ana.souza@exemplo.com.br' }],
    ] as [string, Record<string, unknown>][]) {
      const res = await api(page, 'POST', 'communications', { ...base, ...patch });
      expect(res.status, `${what}: ${JSON.stringify(res.body)}`).toBeGreaterThanOrEqual(400);
      expect(JSON.stringify(res.body), what).toContain('Líderes só podem enviar ao e-mail cadastrado do próprio jovem.');
    }
    const ok = await api(page, 'POST', 'communications', { ...base, recipient_email: ' ANA.Souza@Exemplo.com ' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    const mine = ok.body[0].id as string;
    const edit = await api(page, 'PATCH', `communications?id=eq.${mine}`, { recipient_email: 'terceiro@exemplo.com' });
    expect(edit.status, JSON.stringify(edit.body)).toBeGreaterThanOrEqual(400);
    expect((await api(page, 'PATCH', `communications?id=eq.${mine}`, { recipient_kind: 'guardian' })).status).toBeGreaterThanOrEqual(400);

    // enviar (defesa final no begin): 422 field recipient, nada chega ao provedor, estado intacto
    for (const id of [stranger, asGuardian]) {
      const res = await callSend(page, id);
      expect(res.status, res.text).toBe(422);
      expect(res.body).toEqual({ error: 'invalid_content', field: 'recipient' });
    }
    expect(await mailCalls()).toEqual([]);
    expect((await commRows(db)).filter((r) => [stranger, asGuardian].includes(r.id)).map((r) => [r.status, r.attempts])).toEqual([['draft', 0], ['draft', 0]]);

    // e o rascunho válido dela sai normalmente, para o e-mail do jovem
    const sent = await callSend(page, mine);
    expect(sent.status, sent.text).toBe(200);
    expect((await mailCalls()).map((c) => c.payload.to)).toEqual([[ANA_EMAIL]]);
  });

  test('UI do líder: destinatário fixo (e-mail do jovem, somente leitura); jovem sem e-mail cadastrado não pode receber e-mail de líder', async ({ page, db, loginAs }) => {
    const w = await seedWorld(db);
    await loginAs(w.lia);
    const sheet = await openYouthSheet(page, 'Ana Souza');
    await expect(sheet.getByTestId('alertas-abertos-jovem')).toBeVisible();
    await sheet.getByTestId('jovem-enviar-email').click();
    const m = modalCom(page);
    await expect(m.getByTestId('comunicacao-email')).toHaveValue(ANA_EMAIL);
    await expect(m.getByTestId('comunicacao-email')).not.toBeEditable();
    // o seletor de tipo some ou fica travado em "Jovem" para o líder
    if (await m.getByTestId('comunicacao-tipo').count()) {
      await expect(m.getByTestId('comunicacao-tipo')).toHaveValue('youth');
      expect(await m.getByTestId('comunicacao-tipo').evaluate((el: HTMLSelectElement) => el.disabled || el.options.length === 1)).toBe(true);
    }
    await goToMessage(page);
    await goToReview(page, MSG);
    await expect(m.getByTestId('comunicacao-revisao-destinatario')).toContainText(ANA_EMAIL);
    await sendMail(page);
    await expect(m.getByTestId('comunicacao-resultado')).toHaveAttribute('data-resultado', 'sent');
    expect((await mailCalls())[0].payload.to).toEqual([ANA_EMAIL]);
    await m.getByTestId('comunicacao-fechar').click();

    // Bia (sem e-mail): o líder não consegue digitar e-mail nem avançar
    const bia = await openYouthSheet(page, 'Bia Lima');
    await bia.getByTestId('jovem-enviar-email').click();
    const mb = modalCom(page);
    await expect(mb.getByTestId('comunicacao-email')).not.toBeEditable();
    await expect(mb.getByTestId('comunicacao-email')).toHaveValue('');
    await expect(mb.getByTestId('comunicacao-sem-email')).toBeVisible();
    await expect(mb.getByTestId('comunicacao-proximo')).toHaveCount(0);     // não há como avançar
    await expect(mb).toHaveAttribute('data-etapa', 'recipient');
    expect(await commRows(db)).toHaveLength(1);
  });

  test('líder cumpre o fluxo completo pelo alerta do seu grupo: o e-mail sai, o selo aparece e o responsável é ela', async ({ page, db, loginAs }) => {
    const w = await seedWorld(db);
    await loginAs(w.lia);
    await page.goto('/alertas');
    const card = alertCard(page, 'Ana Souza');
    await card.getByTestId('alerta-enviar-email').click();
    await composeToReview(page, MSG);
    await sendMail(page);
    const m = modalCom(page);
    await expect(m.getByTestId('comunicacao-resultado')).toHaveAttribute('data-resultado', 'sent');
    await m.getByTestId('comunicacao-fechar').click();
    await expect(card.getByTestId('alerta-email-enviado')).toBeVisible();
    expect((await commRows(db))[0]).toMatchObject({
      status: 'sent', created_by: w.lia.id, sent_by: w.lia.id, alert_id: w.alertId, provider: 'resend',
    });
    const [call] = await mailCalls();
    expect(call.payload).toMatchObject({ to: [ANA_EMAIL], subject: MSG.subject, text: MSG.body, reply_to: w.lia.email });
    const [log] = await db.sql<{ actor_id: string }>(`SELECT actor_id FROM activity_log WHERE action = 'communication_sent'`);
    expect(log.actor_id).toBe(w.lia.id);
  });

  test('histórico sobrevive à exclusão do jovem pelo coordenador (youth_id fica nulo; sem jovem a comunicação deixa de ser enviável)', async ({ page, db, loginAs }) => {
    const w = await seedWorld(db);
    await loginAs(w.carla);
    await page.goto('/jovens');
    const created = await api(page, 'POST', 'communications', {
      youth_id: w.ana, alert_id: w.alertId, recipient_email: ANA_EMAIL, recipient_kind: 'youth', subject: 'Registro que deve sobreviver',
      body: 'Corpo preservado', created_by: w.carla.id });
    const id = created.body[0].id as string;
    const sent = await callSend(page, id);
    expect(sent.status, sent.text).toBe(200);
    const pending = await seedComm(db, { youthId: w.ana, createdBy: w.carla, subject: 'Rascunho que ficará órfão' });
    const [before] = (await commRows(db)).filter((r) => r.id === id);
    const logsBefore = await db.sql(`SELECT id FROM activity_log WHERE action = 'communication_sent'`);
    expect(logsBefore).toHaveLength(1);

    const del = await api(page, 'DELETE', `youth?id=eq.${w.ana}`);
    expect(del.status, JSON.stringify(del.body)).toBeLessThan(300);
    expect(await db.sql(`SELECT 1 FROM youth WHERE id = $1`, [w.ana])).toHaveLength(0);

    const after = (await commRows(db)).find((r) => r.id === id)!;
    expect(after).toMatchObject({
      id, status: 'sent', subject: 'Registro que deve sobreviver', body: 'Corpo preservado', recipient_email: ANA_EMAIL,
      sent_by: w.carla.id, sent_at: before.sent_at, youth_id: null, provider: 'resend', provider_message_id: before.provider_message_id,
    });
    expect(await db.sql(`SELECT id FROM activity_log WHERE action = 'communication_sent'`)).toEqual(logsBefore);
    expect((await api(page, 'GET', `communications?id=eq.${id}`)).body).toHaveLength(1);

    // o rascunho órfão não é enviável: 422, e o provedor não é chamado
    const orphan = await callSend(page, pending);
    expect(orphan.status).toBe(422);
    expect(orphan.body).toEqual({ error: 'invalid_content', field: 'youth' });
    expect(await mailCalls()).toHaveLength(1);
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Jovens', exact: true })).toBeVisible();
  });
});

test.describe('Falhas do servidor (PostgREST) durante o fluxo', () => {
  test('erro 500 ao salvar o rascunho no envio: mensagem amigável, nada é enviado e o formulário continua preenchido', async ({ page, db, loginAs }) => {
    const w = await seedWorld(db);
    const leaks = collectLeaks(page);
    await loginAs(w.carla);
    await page.goto('/jovens');
    const sheet = await openAnaSheet(page);
    await sheet.getByTestId('jovem-enviar-email').click();
    const m = modalCom(page);
    await composeToReview(page, MSG);
    let failing = true;
    await page.route('**/rest/v1/communications*', (route) =>
      failing && route.request().method() === 'POST'
        ? route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ code: 'XX000', message: `tabela communications explodiu para ${ANA_EMAIL}`, details: 'stack: boom', hint: null }) })
        : route.continue());
    await m.getByTestId('comunicacao-enviar').click();
    await expect(m.getByRole('alert')).toHaveText(/O servidor encontrou um problema|Erro ao salvar o rascunho\./);
    await expect(page.getByText(/explodiu|communications|stack: boom|XX000/i)).toHaveCount(0);
    await expect(m).toHaveAttribute('data-etapa', 'review');          // não foi para o resultado
    await expect(m.getByTestId('comunicacao-enviar')).toBeEnabled();    // dá para tentar de novo
    await expect(m.getByTestId('comunicacao-revisao-assunto')).toHaveText(MSG.subject);
    expect(await commRows(db)).toHaveLength(0);
    expect(await mailCalls()).toEqual([]);                              // sem rascunho gravado, nada foi pedido à função

    // o servidor volta: o mesmo modal conclui o envio
    failing = false;
    await sendMail(page);
    await expect(m.getByTestId('comunicacao-resultado')).toHaveAttribute('data-resultado', 'sent');
    expect((await commRows(db))[0]).toMatchObject({ status: 'sent', sent_by: w.carla.id });
    expect(await mailCalls()).toHaveLength(1);

    const consoleText = leaks.console.join('\n');
    for (const secret of [ANA_EMAIL, 'Olá & até já', 'Linha 1', 'Linha 4', 'stack: boom']) expect(consoleText).not.toContain(secret);
    expect(consoleText).toContain('[conectjovem]'); // o erro foi registrado (sanitizado)
    expect(consoleText).toContain('[e-mail]');
  });

  test('erro 500 em mark_communication ao reabrir uma falha: mensagem amigável, estado preservado, e depois funciona', async ({ page, db, loginAs }) => {
    const w = await seedWorld(db);
    const leaks = collectLeaks(page);
    await setMail('http5xx');
    await loginAs(w.carla);
    await page.goto('/jovens');
    const sheet = await openAnaSheet(page);
    await sheet.getByTestId('jovem-enviar-email').click();
    const m = modalCom(page);
    await composeToReview(page, MSG);
    await sendMail(page);
    await expect(m.getByTestId('comunicacao-resultado')).toHaveAttribute('data-resultado', 'failed');

    const RAW = `relation "communications" violates secret internal detail for ${ANA_EMAIL}`;
    let failing = true;
    await page.route('**/rest/v1/rpc/mark_communication*', (route) =>
      failing
        ? route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ code: 'XX000', message: RAW, details: 'stack: boom', hint: null }) })
        : route.continue());
    await m.getByTestId('comunicacao-editar-mensagem').click();
    await expect(m.getByRole('alert').filter({ hasText: /servidor|Erro ao atualizar/ })).toBeVisible();
    await expect(page.getByText(/violates|secret internal|stack: boom|XX000/i)).toHaveCount(0);
    await expect(m).toHaveAttribute('data-etapa', 'resultado');
    expect((await commRows(db))[0].status).toBe('failed');

    failing = false;
    await m.getByTestId('comunicacao-editar-mensagem').click();
    await expect(m).toHaveAttribute('data-etapa', 'message');
    expect((await commRows(db))[0]).toMatchObject({ status: 'draft', failure_reason: null });

    const consoleText = leaks.console.join('\n');
    for (const secret of [ANA_EMAIL, 'Olá & até já', 'Linha 1', 'stack: boom', PROVIDER_RAW_TEXT]) expect(consoleText).not.toContain(secret);
  });
});
