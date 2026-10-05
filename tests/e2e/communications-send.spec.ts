// Envio REAL de e-mail (migration 018 + Edge Function send-communication): falhas do provedor, "Tentar novamente",
// permissões da função, estados concorrentes, limite de envios, resposta perdida e vazamentos.
// O handler da função é o código real; o provedor é FALSO (tests/e2e/fake-supabase/server.ts) e registra o que recebe.
// Nenhum e-mail é enviado de verdade.
import type { Page } from '@playwright/test';
import { ANON_KEY, APP_URL, SUPABASE_URL } from './env.ts';
import { api, expect, openYouthSheet, test, type TestUser } from './fixtures.ts';
import {
  ANA_EMAIL, FAKE_PROVIDER_KEY, MSG, idemKey, PROVIDER_RAW_TEXT, callSend, collectLeaks, comItems, commRows, composeToReview, mailCalls,
  modalCom, seedComm, seedWorld, sendMail, setMail, type MailMode, type World,
} from './communications-helpers.ts';

const MSG_FALHA = {
  provider_rejected: 'O serviço de e-mail recusou o envio. Confira os dados e tente novamente mais tarde.',
  unknown: 'Não foi possível enviar o e-mail. Tente novamente.',
  network: 'Houve um problema de conexão durante o envio. Tente novamente.',
  timeout: 'O servidor demorou demais para responder. Tente novamente em instantes.',
  provider_not_configured: 'O envio de e-mail ainda não está configurado no servidor. Fale com o administrador.',
} as const;

/** Coordenadora logada, ficha da Ana aberta e o assistente na etapa de revisão. */
async function startReview(page: Page, w: World, loginAs: (u: TestUser) => Promise<void>, msg = MSG) {
  await loginAs(w.carla);
  const sheet = await openYouthSheet(page, 'Ana Souza');
  await expect(sheet.getByTestId('alertas-abertos-jovem')).toBeVisible();
  await sheet.getByTestId('jovem-enviar-email').click();
  await composeToReview(page, msg);
  return { sheet, m: modalCom(page) };
}

async function openAna(page: Page) {
  const sheet = await openYouthSheet(page, 'Ana Souza');
  await expect(sheet.getByTestId('alertas-abertos-jovem')).toBeVisible();
  return sheet;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

test.describe('Falha do provedor: permanece "Falhou", nunca vira "Enviado"', () => {
  const CASES: [MailMode, keyof typeof MSG_FALHA, number][] = [
    ['http4xx', 'provider_rejected', 1],
    ['http5xx', 'unknown', 1],
    ['network', 'network', 1],
    ['timeout', 'timeout', 1],
    ['unconfigured', 'provider_not_configured', 0],   // NÃO configurado: a função nem tenta chamar o provedor
  ];

  for (const [mode, reason, providerCalls] of CASES) {
    test(`${mode} -> failed/${reason}; mensagem amigável sem texto do provedor; histórico "Falhou"`, async ({ page, db, loginAs }) => {
      const w = await seedWorld(db);
      const leaks = collectLeaks(page);
      await setMail(mode);
      const { m } = await startReview(page, w, loginAs);
      await sendMail(page);

      const result = m.getByTestId('comunicacao-resultado');
      await expect(result).toHaveAttribute('data-resultado', 'failed');
      await expect(result).toContainText('O e-mail não foi enviado');
      await expect(m.getByTestId('comunicacao-motivo-falha')).toHaveText(MSG_FALHA[reason]);
      await expect(result).not.toContainText('E-mail enviado');
      await expect(page.getByText('E-mail enviado.', { exact: true })).toHaveCount(0);   // sem toast de sucesso
      await expect(m.getByTestId('comunicacao-tentar-novamente')).toBeVisible();
      await expect(m.getByTestId('comunicacao-editar-mensagem')).toBeVisible();

      expect(await mailCalls()).toHaveLength(providerCalls);
      const [row] = await commRows(db);
      expect(row).toMatchObject({
        status: 'failed', failure_reason: reason, sent_at: null, sent_by: null, provider_message_id: null, attempts: 1,
        subject: MSG.subject, body: MSG.body, recipient_email: ANA_EMAIL,
      });
      if (mode !== 'unconfigured') expect(row.provider).toBe('resend');
      expect(await db.sql(`SELECT 1 FROM activity_log WHERE action = 'communication_sent'`)).toHaveLength(0);

      // fechar -> o histórico mostra "Falhou" com o motivo; recarregar não muda; nunca vira Enviado sozinho
      await m.getByTestId('comunicacao-fechar').click();
      for (let i = 0; i < 2; i++) {
        const item = comItems(page).first();
        await expect(item).toHaveAttribute('data-status', 'failed');
        await expect(item.getByTestId('comunicacao-status')).toHaveText('Falhou');
        await expect(item.getByTestId('comunicacao-motivo-falha')).toHaveText(`Motivo: ${MSG_FALHA[reason]}`);
        await expect(item.getByTestId('comunicacao-reenviar')).toBeVisible();
        await expect(item).not.toContainText('Enviado em');
        if (i === 0) { await page.reload(); await openAna(page); }
      }
      await page.goto('/alertas');
      await expect(page.getByTestId('alerta-item').filter({ hasText: 'Ana Souza' })).toHaveCount(1);
      await expect(page.getByTestId('alerta-email-enviado')).toHaveCount(0);       // falha não gera selo

      // nada do provedor/chave/e-mail vaza para a tela, o console ou os avisos
      await expect(page.getByText(new RegExp(`${PROVIDER_RAW_TEXT}|${FAKE_PROVIDER_KEY}|resend|api\\.`, 'i'))).toHaveCount(0);
      const all = leaks.console.join('\n');
      for (const secret of [PROVIDER_RAW_TEXT, FAKE_PROVIDER_KEY, 'api.resend.com', ANA_EMAIL, 'Olá & até já', 'Linha 1']) {
        expect(all, secret).not.toContain(secret);
      }
      for (const t of await leaks.toasts()) {
        for (const secret of [PROVIDER_RAW_TEXT, FAKE_PROVIDER_KEY, ANA_EMAIL, 'Linha 1']) expect(t).not.toContain(secret);
      }
    });
  }
});

test.describe('"Tentar novamente" reenvia a MESMA comunicação', () => {
  test('no assistente: falha 5xx, depois sucesso -> mesma linha (attempts 2), 3 chamadas ao provedor com a MESMA Idempotency-Key (conteúdo igual)', async ({ page, db, loginAs }) => {
    const w = await seedWorld(db);
    await setMail('http5xx');
    const { m } = await startReview(page, w, loginAs);
    await sendMail(page);
    await expect(m.getByTestId('comunicacao-resultado')).toHaveAttribute('data-resultado', 'failed');
    const [failed] = await commRows(db);
    expect(failed).toMatchObject({ status: 'failed', attempts: 1 });

    // falha de novo (4xx): continua Falhou, motivo atualizado, mesma linha
    await setMail('http4xx');
    await m.getByTestId('comunicacao-tentar-novamente').click();
    await expect(m.getByTestId('comunicacao-motivo-falha')).toHaveText(MSG_FALHA.provider_rejected);
    await expect(m.getByTestId('comunicacao-resultado')).toHaveAttribute('data-resultado', 'failed');
    expect((await commRows(db))[0]).toMatchObject({ id: failed.id, status: 'failed', failure_reason: 'provider_rejected', attempts: 2, sent_at: null });

    // sucesso: a MESMA linha vira Enviado
    await setMail('success');
    await m.getByTestId('comunicacao-tentar-novamente').click();
    await expect(m.getByTestId('comunicacao-resultado')).toHaveAttribute('data-resultado', 'sent');
    await expect(page.getByText('E-mail enviado.', { exact: true })).toBeVisible();
    const rows = await commRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: failed.id, status: 'sent', failure_reason: null, attempts: 3, sent_by: w.carla.id, provider: 'resend',
      subject: MSG.subject, body: MSG.body,
    });
    expect(rows[0].sent_at).not.toBeNull();
    expect(rows[0].provider_message_id).toMatch(/^re_fake_\d+$/);
    const calls = await mailCalls();
    // mesma mensagem = mesma chave (o provedor deduplica o retry); a chave é por conteúdo, não por tentativa
    const key = idemKey(failed.id, ANA_EMAIL, MSG.subject, MSG.body);
    expect(calls.map((c) => c.headers['Idempotency-Key'])).toEqual([key, key, key]);
    expect(new Set(calls.map((c) => c.payload.text)).size).toBe(1);
    expect(await db.sql(`SELECT 1 FROM activity_log WHERE action = 'communication_sent'`)).toHaveLength(1);   // só o sucesso vira histórico
    await expect(m.getByTestId('comunicacao-tentar-novamente')).toHaveCount(0);

    await m.getByTestId('comunicacao-fechar').click();
    await expect(comItems(page)).toHaveCount(1);
    await expect(comItems(page).first()).toHaveAttribute('data-status', 'sent');
  });

  test('no histórico: "Tentar novamente" pede confirmação (recusar não envia) e envia a mesma comunicação', async ({ page, db, loginAs }) => {
    const w = await seedWorld(db);
    await setMail('network');
    const { m } = await startReview(page, w, loginAs);
    await sendMail(page);
    await m.getByTestId('comunicacao-fechar').click();
    const [failed] = await commRows(db);
    expect(failed.status).toBe('failed');
    expect(await mailCalls()).toHaveLength(1);

    await setMail('success');
    const item = comItems(page).first();
    page.once('dialog', (d) => { expect(d.message()).toContain('Enviar este e-mail agora?'); void d.dismiss(); });
    await item.getByTestId('comunicacao-reenviar').click();
    await expect(item).toHaveAttribute('data-status', 'failed');
    expect(await mailCalls()).toHaveLength(1);                       // recusar a confirmação não envia

    page.once('dialog', (d) => { void d.accept(); });
    await item.getByTestId('comunicacao-reenviar').click();
    await expect(page.getByText('E-mail enviado.', { exact: true })).toBeVisible();
    await expect(item).toHaveAttribute('data-status', 'sent');
    await expect(item.getByTestId('comunicacao-reenviar')).toHaveCount(0);
    const rows = await commRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: failed.id, status: 'sent', attempts: 2, failure_reason: null });
    const key = idemKey(failed.id, ANA_EMAIL, MSG.subject, MSG.body);
    expect((await mailCalls()).map((c) => c.headers['Idempotency-Key'])).toEqual([key, key]);
  });

  test('no histórico: falha de novo mostra o motivo em aviso e a linha continua "Falhou"', async ({ page, db, loginAs }) => {
    const w = await seedWorld(db);
    await setMail('http5xx');
    const { m } = await startReview(page, w, loginAs);
    await sendMail(page);
    await m.getByTestId('comunicacao-fechar').click();
    const item = comItems(page).first();
    page.once('dialog', (d) => { void d.accept(); });
    await item.getByTestId('comunicacao-reenviar').click();
    await expect(page.getByText(MSG_FALHA.unknown).first()).toBeVisible();
    await expect(item).toHaveAttribute('data-status', 'failed');
    expect((await commRows(db))[0]).toMatchObject({ status: 'failed', attempts: 2, sent_at: null });
    await expect(page.getByText('E-mail enviado.', { exact: true })).toHaveCount(0);
  });

  test('"Editar mensagem" volta a rascunho; a correção é enviada na mesma linha', async ({ page, db, loginAs }) => {
    const w = await seedWorld(db);
    await setMail('http4xx');
    const { m } = await startReview(page, w, loginAs);
    await sendMail(page);
    const [failed] = await commRows(db);
    await m.getByTestId('comunicacao-editar-mensagem').click();
    await expect(m).toHaveAttribute('data-etapa', 'message');
    expect((await commRows(db))[0]).toMatchObject({ id: failed.id, status: 'draft', failure_reason: null, attempts: 1 });

    await setMail('success');
    await m.getByTestId('comunicacao-assunto').fill('Assunto corrigido');
    await m.getByTestId('comunicacao-proximo').click();
    await expect(m).toHaveAttribute('data-etapa', 'review');
    await sendMail(page);
    await expect(m.getByTestId('comunicacao-resultado')).toHaveAttribute('data-resultado', 'sent');
    const rows = await commRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: failed.id, status: 'sent', subject: 'Assunto corrigido', attempts: 2 });
    const calls = await mailCalls();
    expect(calls).toHaveLength(2);
    expect(calls[0].payload.subject).toBe(MSG.subject);
    expect(calls[1].payload.subject).toBe('Assunto corrigido');
    // conteúdo editado => chave nova (não é tratado como retry do mesmo e-mail)
    expect(calls[0].headers['Idempotency-Key']).toBe(idemKey(failed.id, ANA_EMAIL, MSG.subject, MSG.body));
    expect(calls[1].headers['Idempotency-Key']).toBe(idemKey(failed.id, ANA_EMAIL, 'Assunto corrigido', MSG.body));
    expect(calls[1].headers['Idempotency-Key']).not.toBe(calls[0].headers['Idempotency-Key']);
  });
});

test.describe('Função send-communication: autenticação e escopo (API direta)', () => {
  const draftFor = async (page: Page, w: World, over: Record<string, unknown> = {}) => {
    const res = await api(page, 'POST', 'communications', {
      youth_id: w.ana, recipient_email: ANA_EMAIL, recipient_kind: 'youth', subject: 'Assunto API', body: 'Corpo API', created_by: w.carla.id, ...over,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body[0].id as string;
  };

  test('sem JWT, JWT inválido, assinatura adulterada e chave anônima -> 401; método e corpo inválidos -> 405/400; nada é enviado', async ({ page, db, loginAs }) => {
    const w = await seedWorld(db);
    await loginAs(w.carla);
    await page.goto('/jovens');
    const id = await draftFor(page, w);
    const session = await page.evaluate(() => JSON.parse(localStorage.getItem(Object.keys(localStorage).find((k) => k.endsWith('-auth-token'))!)!));
    const [h, p, s] = (session.access_token as string).split('.');
    const forged = `${h}.${p}.${s.slice(0, -2)}${s.endsWith('AA') ? 'BB' : 'AA'}`;
    const otherPayload = `${h}.${Buffer.from(JSON.stringify({ sub: w.caio.id, role: 'authenticated', exp: 9999999999 })).toString('base64url')}.${s}`;

    for (const [what, token] of [
      ['sem Authorization', null], ['lixo', 'isto-nao-e-um-jwt'], ['assinatura adulterada', forged], ['payload trocado (outro sub)', otherPayload],
      ['chave anônima', ANON_KEY],
    ] as [string, string | null][]) {
      const res = await callSend(page, id, { token });
      expect(res.status, `${what}: ${res.text}`).toBe(401);
      expect(res.body).toEqual({ error: 'unauthorized' });
    }
    // outros métodos: o navegador nem passa do preflight (Allow-Methods = POST, OPTIONS); direto no servidor a função responde 405
    for (const method of ['GET', 'PUT', 'DELETE', 'PATCH']) {
      const r = await fetch(`${SUPABASE_URL}/functions/v1/send-communication`, {
        method, headers: { authorization: `Bearer ${session.access_token}`, 'content-type': 'application/json' },
        body: method === 'GET' ? undefined : JSON.stringify({ communication_id: id }),
      });
      expect(r.status, method).toBe(405);
      expect(await r.json()).toEqual({ error: 'method_not_allowed' });
    }
    for (const raw of ['{', '', 'null', '[]', '{}', '{"communication_id":123}', '{"communication_id":"nao-e-uuid"}', JSON.stringify({ communication_id: id, pad: 'x'.repeat(2000) })]) {
      const res = await callSend(page, null, { raw });
      expect(res.status, raw.slice(0, 40)).toBe(400);
      expect(res.body).toEqual({ error: 'invalid_request' });
    }
    expect((await callSend(page, '00000000-0000-4000-8000-000000000000')).status).toBe(404);
    expect(await mailCalls()).toEqual([]);
    expect((await commRows(db))[0]).toMatchObject({ id, status: 'draft', attempts: 0 });
  });

  test('o destinatário, o assunto e o corpo vêm SÓ do registro validado: campos extras no pedido são ignorados', async ({ page, db, loginAs }) => {
    const w = await seedWorld(db);
    await loginAs(w.carla);
    await page.goto('/jovens');
    const id = await draftFor(page, w);
    const res = await callSend(page, id, {
      extra: { to: 'atacante@exemplo.com', recipient_email: 'atacante@exemplo.com', subject: 'Forjado', body: 'Forjado', bcc: ['x@y.com'], from: 'ceo@exemplo.com' },
    });
    expect(res.status, res.text).toBe(200);
    const [call] = await mailCalls();
    expect(call.payload).toMatchObject({ to: [ANA_EMAIL], subject: 'Assunto API', text: 'Corpo API' });
    expect(JSON.stringify(call.payload)).not.toMatch(/atacante|Forjado|ceo@exemplo/);
    expect(call.payload.from).toBe('Conecta Jovem <no-reply@e2e.test>');
  });

  test('escopo: líder só envia o que criou, do jovem do seu grupo; alheio, de outro grupo ou jovem que mudou de grupo -> 404', async ({ page, db, loginAs }) => {
    const w = await seedWorld(db);
    const carlaOnAna = await seedComm(db, { youthId: w.ana, createdBy: w.carla, subject: 'Da Carla' });
    const liaOnZeca = await seedComm(db, { youthId: w.zeca, createdBy: w.lia, subject: 'Da Lia no jovem alheio' });
    const carlaOnZeca = await seedComm(db, { youthId: w.zeca, createdBy: w.carla, subject: 'Da Carla no Zeca' });
    const liaOnAna = await seedComm(db, { youthId: w.ana, createdBy: w.lia, subject: 'Da Lia na Ana' });
    await loginAs(w.lia);
    await page.goto('/jovens');

    for (const [what, target] of [['comunicação da coordenadora (visível, mas não criada por ela)', carlaOnAna],
      ['jovem de outro grupo (invisível)', carlaOnZeca], ['criada por ela mas jovem de outro grupo', liaOnZeca]] as [string, string][]) {
      const res = await callSend(page, target);
      expect(res.status, what).toBe(404);
      expect(res.body, what).toEqual({ error: 'not_found' });
    }
    expect(await mailCalls()).toEqual([]);
    expect((await commRows(db)).filter((r) => r.status !== 'draft')).toEqual([]);

    // a que ela criou, do jovem do seu grupo: envia
    const ok = await callSend(page, liaOnAna);
    expect(ok.status, ok.text).toBe(200);
    expect(ok.body).toMatchObject({ status: 'sent' });
    expect(await mailCalls()).toHaveLength(1);

    // o jovem muda de grupo (a líder perde o escopo): outra comunicação dela sobre ele deixa de ser enviável
    const later = await seedComm(db, { youthId: w.ana, createdBy: w.lia, subject: 'Depois da mudança' });
    await db.sql(`UPDATE youth SET group_id = $2 WHERE id = $1`, [w.ana, w.beta]);
    const moved = await callSend(page, later);
    expect(moved.status).toBe(404);
    expect(await mailCalls()).toHaveLength(1);
    expect((await commRows(db)).find((r) => r.id === later)).toMatchObject({ status: 'draft', attempts: 0 });
  });

  test('coordenador envia comunicação de outro usuário (sent_by é quem clicou); líder de outro grupo recebe 404', async ({ page, db, loginAs }) => {
    const w = await seedWorld(db);
    const liaOnAna = await seedComm(db, { youthId: w.ana, createdBy: w.lia, subject: 'Rascunho da Lia' });

    await loginAs(w.lia);          // injeta a sessão da Lia; Davi (líder do Beta) vem pelo token abaixo
    await page.goto('/jovens');
    const daviSession = await (await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
      method: 'POST', headers: { 'content-type': 'application/json', apikey: ANON_KEY },
      body: JSON.stringify({ email: w.davi.email, password: w.davi.password }),
    })).json() as { access_token: string };
    const davi = await callSend(page, liaOnAna, { token: daviSession.access_token });
    expect(davi.status).toBe(404);
    expect(await mailCalls()).toEqual([]);

    const caioSession = await (await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
      method: 'POST', headers: { 'content-type': 'application/json', apikey: ANON_KEY },
      body: JSON.stringify({ email: w.caio.email, password: w.caio.password }),
    })).json() as { access_token: string };
    const caio = await callSend(page, liaOnAna, { token: caioSession.access_token });
    expect(caio.status, caio.text).toBe(200);
    const [row] = await commRows(db);
    expect(row).toMatchObject({ id: liaOnAna, status: 'sent', created_by: w.lia.id, sent_by: w.caio.id });
    const [call] = await mailCalls();
    expect(call.payload.reply_to).toBe(w.caio.email);
  });

  test('coordenador envia a destinatário livre (terceiro/responsável); o provedor recebe exatamente o gravado', async ({ page, db, loginAs }) => {
    const w = await seedWorld(db);
    await loginAs(w.carla);
    await page.goto('/jovens');
    const id = await draftFor(page, w, { recipient_email: 'Terceiro@Exemplo.com', recipient_kind: 'other', recipient_name: 'Terceiro' });
    const res = await callSend(page, id);
    expect(res.status, res.text).toBe(200);
    const [call] = await mailCalls();
    expect(call.payload.to).toEqual(['terceiro@exemplo.com']);
    expect(call.headers['Idempotency-Key']).toBe(idemKey(id, 'terceiro@exemplo.com', 'Assunto API', 'Corpo API'));
  });

  test('as respostas da função nunca trazem chave, texto do provedor, e-mail, assunto ou corpo (sucesso e cada tipo de falha)', async ({ page, db, loginAs }) => {
    const w = await seedWorld(db);
    await loginAs(w.carla);
    await page.goto('/jovens');
    const forbidden = [FAKE_PROVIDER_KEY, PROVIDER_RAW_TEXT, 'api.resend.com', 'resend', ANA_EMAIL, 'Assunto API', 'Corpo API', 'no-reply@e2e.test', 'Bearer'];
    const modes: [MailMode, Record<string, unknown>][] = [
      ['success', { status: 'sent' }], ['http4xx', { status: 'failed', failure_reason: 'provider_rejected' }],
      ['http5xx', { status: 'failed', failure_reason: 'unknown' }], ['network', { status: 'failed', failure_reason: 'network' }],
      ['timeout', { status: 'failed', failure_reason: 'timeout' }], ['unconfigured', { status: 'failed', failure_reason: 'provider_not_configured' }],
    ];
    for (const [mode, expected] of modes) {
      await setMail(mode);
      const id = await draftFor(page, w);
      const res = await callSend(page, id);
      expect(res.status, `${mode}: ${res.text}`).toBe(200);
      expect(res.body).toMatchObject({ ...expected, communication_id: id });
      expect(Object.keys(res.body).sort(), mode).toEqual(
        mode === 'success' ? ['communication_id', 'sent_at', 'status'] : ['communication_id', 'failure_reason', 'status']);
      for (const secret of forbidden) expect(res.text.toLowerCase(), `${mode}: ${secret}`).not.toContain(secret.toLowerCase());
      expect(JSON.stringify(res.body)).not.toMatch(/re_fake/);   // nem o id da mensagem do provedor
    }
    // respostas de erro também
    for (const res of [await callSend(page, null, { raw: '{' }), await callSend(page, null, { token: null }), await callSend(page, '00000000-0000-4000-8000-000000000000')]) {
      for (const secret of forbidden) expect(res.text.toLowerCase()).not.toContain(secret.toLowerCase());
    }
  });

  test('CORS: só a origem do app é aceita (preflight e resposta); origem estranha não recebe Access-Control-Allow-Origin', async () => {
    const url = `${SUPABASE_URL}/functions/v1/send-communication`;
    const ok = await fetch(url, {
      method: 'OPTIONS',
      headers: { origin: APP_URL, 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization, content-type, apikey, x-client-info' },
    });
    expect(ok.status).toBe(204);
    expect(ok.headers.get('access-control-allow-origin')).toBe(APP_URL);
    expect(ok.headers.get('access-control-allow-methods')).toContain('POST');
    const evil = await fetch(url, { method: 'OPTIONS', headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' } });
    expect(evil.headers.get('access-control-allow-origin')).toBeNull();
    const evilPost = await fetch(url, { method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'application/json' }, body: '{}' });
    expect(evilPost.status).toBe(401);
    expect(evilPost.headers.get('access-control-allow-origin')).toBeNull();
    expect(await mailCalls()).toEqual([]);
  });
});

test.describe('Estados: duplo envio, envio em andamento, envio preso e limite', () => {
  test('duplo clique em "Enviar e-mail": um único envio, indicador "Enviando" e botão travado', async ({ page, db, loginAs }) => {
    const w = await seedWorld(db);
    await setMail('success', 800);
    const { m } = await startReview(page, w, loginAs);
    const enviar = m.getByTestId('comunicacao-enviar');
    await enviar.dblclick();
    await expect(m.getByTestId('comunicacao-enviando')).toContainText('Enviando e-mail');
    await expect(enviar).toBeDisabled();
    await expect(m.getByTestId('comunicacao-salvar-rascunho')).toBeDisabled();
    await expect(m).toHaveAttribute('data-etapa', 'resultado');
    await expect(m.getByTestId('comunicacao-resultado')).toHaveAttribute('data-resultado', 'sent');
    expect(await mailCalls()).toHaveLength(1);
    const rows = await commRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'sent', attempts: 1 });
  });

  test('duas chamadas simultâneas à função: uma envia (200), a outra recebe 409 in_progress; depois 409 already_sent; um único e-mail', async ({ page, db, loginAs }) => {
    const w = await seedWorld(db);
    await setMail('success', 900);
    await loginAs(w.carla);
    await page.goto('/jovens');
    const created = await api(page, 'POST', 'communications', {
      youth_id: w.ana, recipient_email: ANA_EMAIL, recipient_kind: 'youth', subject: 'Concorrente', body: 'Corpo', created_by: w.carla.id });
    const id = created.body[0].id as string;

    const first = callSend(page, id);
    await expect.poll(async () => (await commRows(db))[0].status).toBe('sending');   // a 1ª já iniciou
    const second = await callSend(page, id);
    expect(second.status, second.text).toBe(409);
    expect(second.body).toEqual({ error: 'in_progress' });
    const firstRes = await first;
    expect(firstRes.status, firstRes.text).toBe(200);
    expect(firstRes.body).toMatchObject({ status: 'sent' });

    const third = await callSend(page, id);
    expect(third.status).toBe(409);
    expect(third.body).toEqual({ error: 'already_sent' });
    expect(await mailCalls()).toHaveLength(1);
    expect((await commRows(db))[0]).toMatchObject({ status: 'sent', attempts: 1 });
  });

  test('aba desatualizada: o rascunho já foi enviado em outro lugar -> a tela mostra o estado real e o provedor recebe um único e-mail', async ({ page, db, loginAs }) => {
    const w = await seedWorld(db);
    await loginAs(w.carla);
    const sheet = await openAna(page);
    await sheet.getByTestId('jovem-enviar-email').click();
    await composeToReview(page, MSG);
    const m = modalCom(page);
    await m.getByTestId('comunicacao-salvar-rascunho').click();
    await expect(page.getByText('Rascunho salvo.')).toBeVisible();
    await comItems(page).first().getByTestId('comunicacao-continuar').click();
    await expect(m).toHaveAttribute('data-etapa', 'review');

    const [row] = await commRows(db);
    const other = await callSend(page, row.id);          // "outra aba" envia primeiro
    expect(other.status, other.text).toBe(200);

    await m.getByTestId('comunicacao-enviar').click();     // a tela antiga ainda acha que é rascunho
    await expect(m).toHaveAttribute('data-etapa', 'resultado');
    await expect(m.getByTestId('comunicacao-resultado')).toHaveAttribute('data-resultado', 'sent');   // estado real do banco
    expect(await mailCalls()).toHaveLength(1);
    expect((await commRows(db))[0]).toMatchObject({ id: row.id, status: 'sent', attempts: 1 });
  });

  test('"Enviando" recente: 409 na função, selo e "Atualizar status" na tela, sem "Tentar novamente"; ao concluir mostra o resultado real', async ({ page, db, loginAs }) => {
    const w = await seedWorld(db);
    const id = await seedComm(db, { youthId: w.ana, createdBy: w.carla, status: 'sending', minutesAgo: 1, subject: 'Em andamento' });
    await loginAs(w.carla);
    await page.goto('/jovens');
    await openAna(page);

    const item = comItems(page).first();
    await expect(item).toHaveAttribute('data-status', 'sending');
    await expect(item.getByTestId('comunicacao-status')).toHaveText('Enviando');
    await expect(item.getByTestId('comunicacao-enviando-item')).toContainText('Envio em andamento');
    await expect(item.getByTestId('comunicacao-envio-sem-resposta')).toHaveCount(0);
    await expect(item.getByTestId('comunicacao-reenviar')).toHaveCount(0);
    await expect(item.getByTestId('comunicacao-continuar')).toHaveCount(0);
    await expect(item.getByTestId('comunicacao-excluir')).toHaveCount(0);

    const res = await callSend(page, id);
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'in_progress' });
    expect(await mailCalls()).toEqual([]);
    expect((await commRows(db))[0]).toMatchObject({ status: 'sending', attempts: 1 });

    // o "servidor" conclui por fora; "Atualizar status" mostra o resultado real
    await db.sql(`UPDATE communications SET status = 'sent', sent_at = now(), provider = 'resend', provider_message_id = 're_x' WHERE id = $1`, [id]);
    await item.getByTestId('comunicacao-atualizar').click();
    await expect(item).toHaveAttribute('data-status', 'sent');
    await expect(item.getByTestId('comunicacao-status')).toHaveText('Enviado');
    await expect(item.getByTestId('comunicacao-atualizar')).toHaveCount(0);
  });

  test('"Enviando" há mais de 5 min fica retomável: aviso "sem resposta" e "Tentar novamente" reenvia a mesma linha (attempts 2)', async ({ page, db, loginAs }) => {
    const w = await seedWorld(db);
    const id = await seedComm(db, { youthId: w.ana, createdBy: w.carla, status: 'sending', minutesAgo: 6, subject: 'Preso' });
    await loginAs(w.carla);
    await page.goto('/jovens');
    await openAna(page);

    const item = comItems(page).first();
    await expect(item.getByTestId('comunicacao-envio-sem-resposta')).toContainText('Envio sem resposta');
    await expect(item.getByTestId('comunicacao-enviando-item')).toHaveCount(0);
    page.once('dialog', (d) => { void d.accept(); });
    await item.getByTestId('comunicacao-reenviar').click();
    await expect(page.getByText('E-mail enviado.', { exact: true })).toBeVisible();
    await expect(item).toHaveAttribute('data-status', 'sent');
    const rows = await commRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id, status: 'sent', attempts: 2, sent_by: w.carla.id, provider: 'resend' });
    const calls = await mailCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0].headers['Idempotency-Key']).toBe(idemKey(id, ANA_EMAIL, 'Preso', 'Corpo de teste'));
  });

  test('"Enviando" preso: o líder que não criou a comunicação não vê "Tentar novamente"; a função também recusa (404)', async ({ page, db, loginAs }) => {
    const w = await seedWorld(db);
    const id = await seedComm(db, { youthId: w.ana, createdBy: w.carla, status: 'sending', minutesAgo: 10 });
    await loginAs(w.lia);
    await page.goto('/jovens');
    await openAna(page);
    const item = comItems(page).first();
    await expect(item.getByTestId('comunicacao-envio-sem-resposta')).toBeVisible();
    await expect(item.getByTestId('comunicacao-reenviar')).toHaveCount(0);
    await expect(item.getByTestId('comunicacao-atualizar')).toBeVisible();
    expect((await callSend(page, id)).status).toBe(404);
    expect(await mailCalls()).toEqual([]);
  });

  test('limite de 20 envios por hora por usuário: 429 com mensagem amigável, rascunho preservado, sem chamar o provedor; outro usuário não é afetado', async ({ page, db, loginAs }) => {
    const w = await seedWorld(db);
    const anchor = await seedComm(db, { youthId: w.ana, createdBy: w.carla, status: 'sent', subject: 'Âncora do log' });
    await db.sql(`INSERT INTO communication_send_log (user_id, communication_id) SELECT $1, $2 FROM generate_series(1, 20)`, [w.carla.id, anchor]);
    const { m } = await startReview(page, w, loginAs);

    await m.getByTestId('comunicacao-enviar').click();
    await expect(m.getByTestId('comunicacao-erro-envio')).toHaveText(/Limite de envios por hora atingido. Tente novamente/);
    await expect(m).toHaveAttribute('data-etapa', 'review');
    await expect(m.getByTestId('comunicacao-enviar')).toBeEnabled();
    expect(await mailCalls()).toEqual([]);
    const draft = (await commRows(db)).find((r) => r.id !== anchor)!;
    expect(draft).toMatchObject({ status: 'draft', attempts: 0, sent_at: null });

    // API: 429 + Retry-After; nada muda de estado
    const res = await callSend(page, draft.id);
    expect(res.status).toBe(429);
    expect(res.body.error).toBe('rate_limited');
    expect(res.body.window).toBe('hour');
    expect(res.body.retry_after_seconds).toBeGreaterThanOrEqual(1);
    expect((await commRows(db)).find((r) => r.id === draft.id)).toMatchObject({ status: 'draft', attempts: 0 });

    // o limite é por usuário: o Caio (coordenador) continua enviando a mesma comunicação
    const caioSession = await (await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
      method: 'POST', headers: { 'content-type': 'application/json', apikey: ANON_KEY },
      body: JSON.stringify({ email: w.caio.email, password: w.caio.password }),
    })).json() as { access_token: string };
    const other = await callSend(page, draft.id, { token: caioSession.access_token });
    expect(other.status, other.text).toBe(200);
    expect(await mailCalls()).toHaveLength(1);

    // limite exato: com 19 envios iniciados na última hora, o 20º ainda passa (e o 21º não)
    await db.sql(`DELETE FROM communication_send_log`);
    await db.sql(`INSERT INTO communication_send_log (user_id, communication_id) SELECT $1, $2 FROM generate_series(1, 19)`, [w.carla.id, anchor]);
    const d2 = await api(page, 'POST', 'communications', {
      youth_id: w.ana, recipient_email: ANA_EMAIL, recipient_kind: 'youth', subject: 'Limite', body: 'Corpo', created_by: w.carla.id });
    const d3 = await api(page, 'POST', 'communications', {
      youth_id: w.ana, recipient_email: ANA_EMAIL, recipient_kind: 'youth', subject: 'Limite 2', body: 'Corpo', created_by: w.carla.id });
    expect((await callSend(page, d2.body[0].id)).status).toBe(200);
    expect((await callSend(page, d3.body[0].id)).status).toBe(429);
    expect(await mailCalls()).toHaveLength(2);
  });
});

test.describe('Limites por papel (hora e dia)', () => {
  const tokenFor = async (u: { email: string; password: string }) =>
    ((await (await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
      method: 'POST', headers: { 'content-type': 'application/json', apikey: ANON_KEY }, body: JSON.stringify({ email: u.email, password: u.password }),
    })).json()) as { access_token: string }).access_token;

  /** n envios já iniciados por userId, espalhados a partir de `ageHours` atrás (minutos distintos) */
  const logRows = (db: Parameters<typeof commRows>[0], userId: string, n: number, anchor: string, ageHours = 0) =>
    db.sql(`INSERT INTO communication_send_log (user_id, communication_id, started_at)
            SELECT $1, $2, now() - make_interval(hours => $3::int) - make_interval(mins => g) FROM generate_series(1, $4::int) g`,
      [userId, anchor, ageHours, n]);

  test('líder: 10 por hora (o 10º passa, o 11º dá 429 window=hour) e 30 por dia (window=day); a UI mostra a mensagem amigável', async ({ page, db, loginAs }) => {
    const w = await seedWorld(db);
    const anchor = await seedComm(db, { youthId: w.ana, createdBy: w.lia, status: 'sent', subject: 'Âncora' });
    const mk = (subject: string) => seedComm(db, { youthId: w.ana, createdBy: w.lia, subject });
    await loginAs(w.lia);
    await page.goto('/jovens');

    await logRows(db, w.lia.id, 9, anchor);
    const tenth = await callSend(page, await mk('décimo'));
    expect(tenth.status, tenth.text).toBe(200);
    const eleventh = await callSend(page, await mk('décimo primeiro'));
    expect(eleventh.status).toBe(429);
    expect(eleventh.body).toMatchObject({ error: 'rate_limited', window: 'hour' });
    // (o navegador não lê Retry-After: o handler não o expõe via Access-Control-Expose-Headers; o corpo traz retry_after_seconds)
    const direct = await fetch(`${SUPABASE_URL}/functions/v1/send-communication`, {
      method: 'POST', headers: { authorization: `Bearer ${await tokenFor(w.lia)}`, 'content-type': 'application/json' },
      body: JSON.stringify({ communication_id: await mk('para o cabeçalho') }),
    });
    expect(direct.status).toBe(429);
    expect(Number(direct.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
    expect(eleventh.body.retry_after_seconds).toBeGreaterThanOrEqual(1);
    expect(eleventh.body.retry_after_seconds).toBeLessThanOrEqual(3600);
    expect(await mailCalls()).toHaveLength(1);

    // janela diária: 29 envios entre 2 h e ~2,5 h atrás (nenhum na última hora); o 30º passa e o 31º não
    await db.sql(`DELETE FROM communication_send_log`);
    await logRows(db, w.lia.id, 29, anchor, 2);
    const t30 = await callSend(page, await mk('trigésimo'));
    expect(t30.status, t30.text).toBe(200);
    const t31 = await callSend(page, await mk('trigésimo primeiro'));
    expect(t31.status).toBe(429);
    expect(t31.body).toMatchObject({ error: 'rate_limited', window: 'day' });
    expect(t31.body.retry_after_seconds).toBeGreaterThanOrEqual(1);
    expect(await mailCalls()).toHaveLength(2);

    // pela tela: mensagem amigável, rascunho preservado
    await page.reload();
    const sheet = await openAna(page);
    await sheet.getByTestId('jovem-enviar-email').click();
    const m = modalCom(page);
    await composeToReview(page, MSG);
    await m.getByTestId('comunicacao-enviar').click();
    await expect(m.getByTestId('comunicacao-erro-envio')).toHaveText(/Limite de envios/);
    expect(await mailCalls()).toHaveLength(2);
  });

  test('o log de envios sobrevive à exclusão da comunicação: criar -> enviar -> excluir não zera a contagem', async ({ page, db, loginAs }) => {
    const w = await seedWorld(db);
    await loginAs(w.carla);
    await page.goto('/jovens');
    const anchor = await seedComm(db, { youthId: w.ana, createdBy: w.carla, status: 'cancelled', subject: 'Âncora' });
    await logRows(db, w.carla.id, 19, anchor);
    const id = await seedComm(db, { youthId: w.ana, createdBy: w.carla, subject: 'Vigésimo' });
    expect((await callSend(page, id)).status).toBe(200);          // 20º envio iniciado
    await db.sql(`DELETE FROM communications WHERE id IN ($1, $2)`, [id, anchor]);   // apagar as comunicações...
    expect(await db.sql(`SELECT 1 FROM communication_send_log WHERE user_id = $1`, [w.carla.id])).toHaveLength(20);  // ...não apaga o log
    const next = await seedComm(db, { youthId: w.ana, createdBy: w.carla, subject: 'Vigésimo primeiro' });
    const res = await callSend(page, next);
    expect(res.status).toBe(429);
    expect(res.body).toMatchObject({ error: 'rate_limited', window: 'hour' });
    expect(await mailCalls()).toHaveLength(1);
  });

  test('coordenador: 20 por hora e 100 por dia (window=day); outro coordenador não é afetado', async ({ page, db, loginAs }) => {
    const w = await seedWorld(db);
    await loginAs(w.carla);
    await page.goto('/jovens');
    const anchor = await seedComm(db, { youthId: w.ana, createdBy: w.carla, status: 'sent', subject: 'Âncora' });
    await logRows(db, w.carla.id, 99, anchor, 2);                // 99 nas últimas horas (nenhum na última hora)
    expect((await callSend(page, await seedComm(db, { youthId: w.ana, createdBy: w.carla, subject: 'c100' }))).status).toBe(200);
    const over = await callSend(page, await seedComm(db, { youthId: w.ana, createdBy: w.carla, subject: 'c101' }));
    expect(over.status).toBe(429);
    expect(over.body).toMatchObject({ error: 'rate_limited', window: 'day' });
    const caio = await callSend(page, await seedComm(db, { youthId: w.ana, createdBy: w.carla, subject: 'do caio' }), { token: await tokenFor(w.caio) });
    expect(caio.status, caio.text).toBe(200);
  });
});

test.describe('Resposta perdida: o cliente não sabe se o e-mail saiu; a tela mostra só o que é verdade', () => {
  const FN = '**/functions/v1/send-communication';
  const isRowRead = (u: URL) =>
    u.pathname.endsWith('/rest/v1/communications') && u.searchParams.get('select') === '*' && (u.searchParams.get('id') ?? '').startsWith('eq.');

  test('a requisição nem chega à função: "Não foi possível confirmar o envio", rascunho intacto, nada enviado; tentar de novo funciona', async ({ page, db, loginAs }) => {
    const w = await seedWorld(db);
    const { m } = await startReview(page, w, loginAs);
    await page.route(FN, (route) => route.abort('failed'));
    await m.getByTestId('comunicacao-enviar').click();
    await expect(m.getByTestId('comunicacao-resultado')).toHaveAttribute('data-resultado', 'unconfirmed');
    await expect(m.getByTestId('comunicacao-resultado')).toContainText('Não foi possível confirmar o envio');
    await expect(m.getByTestId('comunicacao-resultado')).not.toContainText('E-mail enviado');
    expect(await mailCalls()).toEqual([]);
    expect((await commRows(db))[0]).toMatchObject({ status: 'draft', attempts: 0 });   // o histórico reflete o estado real

    await m.getByTestId('comunicacao-fechar').click();
    await expect(comItems(page).first()).toHaveAttribute('data-status', 'draft');
    await page.unroute(FN);
    await comItems(page).first().getByTestId('comunicacao-continuar').click();
    await sendMail(page);
    await expect(m.getByTestId('comunicacao-resultado')).toHaveAttribute('data-resultado', 'sent');
    expect(await mailCalls()).toHaveLength(1);
  });

  test('a função conclui mas a resposta é abortada no cliente: a tela relê o banco e mostra o estado REAL (Enviado), sem reenviar', async ({ page, db, loginAs }) => {
    const w = await seedWorld(db);
    const { m } = await startReview(page, w, loginAs);
    await page.route(FN, async (route) => { await route.fetch(); await route.abort('failed'); });
    await m.getByTestId('comunicacao-enviar').click();
    await expect(m).toHaveAttribute('data-etapa', 'resultado');
    await expect(m.getByTestId('comunicacao-resultado')).toHaveAttribute('data-resultado', 'sent');
    expect(await mailCalls()).toHaveLength(1);
    expect((await commRows(db))[0]).toMatchObject({ status: 'sent', attempts: 1 });
    await expect(m.getByTestId('comunicacao-tentar-novamente')).toHaveCount(0);      // não oferece reenviar o que já saiu
    await m.getByTestId('comunicacao-fechar').click();
    await expect(comItems(page).first()).toHaveAttribute('data-status', 'sent');
  });

  test('resposta perdida E releitura falhando: "Não foi possível confirmar o envio"; ao recarregar o histórico mostra Enviado', async ({ page, db, loginAs }) => {
    const w = await seedWorld(db);
    const { m } = await startReview(page, w, loginAs);
    await page.route(FN, async (route) => { await route.fetch(); await route.abort('failed'); });
    await page.route((u) => isRowRead(u), (route) => (route.request().method() === 'GET' ? route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ code: 'XX000', message: 'falha ao reler', details: null, hint: null }) }) : route.continue()));
    await m.getByTestId('comunicacao-enviar').click();
    await expect(m.getByTestId('comunicacao-resultado')).toHaveAttribute('data-resultado', 'unconfirmed');
    await expect(m.getByTestId('comunicacao-resultado')).toContainText('Não foi possível confirmar o envio');
    expect(await mailCalls()).toHaveLength(1);                         // o e-mail saiu de verdade
    await expect(m.getByTestId('comunicacao-tentar-novamente')).toHaveCount(0);   // nunca sugere reenviar no escuro
    await page.unroute(FN);
    await page.reload();
    await openAna(page);
    await expect(comItems(page).first()).toHaveAttribute('data-status', 'sent');
    expect(await mailCalls()).toHaveLength(1);
  });

  test('cliente aborta enquanto o servidor ainda envia: "O e-mail está sendo enviado" (sending real); depois "Atualizar status" mostra Enviado', async ({ page, db, loginAs }) => {
    const w = await seedWorld(db);
    await setMail('success', 1800);
    const { m } = await startReview(page, w, loginAs);
    await page.route(FN, async (route) => {
      void route.fetch().catch(() => {});      // a requisição segue no servidor...
      await sleep(400);
      await route.abort('failed');             // ...mas o navegador desiste da resposta
    });
    await m.getByTestId('comunicacao-enviar').click();
    await expect(m.getByTestId('comunicacao-resultado')).toHaveAttribute('data-resultado', 'in_progress');
    await expect(m.getByTestId('comunicacao-resultado')).toContainText('O e-mail está sendo enviado');
    await expect(m.getByTestId('comunicacao-tentar-novamente')).toHaveCount(0);
    await m.getByTestId('comunicacao-fechar').click();

    const item = comItems(page).first();
    await expect.poll(async () => (await commRows(db))[0].status, { timeout: 10_000 }).toBe('sent');
    await item.getByTestId('comunicacao-atualizar').click().catch(() => {});   // pode já ter recarregado sozinho
    await expect(item).toHaveAttribute('data-status', 'sent');
    expect(await mailCalls()).toHaveLength(1);
    expect((await commRows(db))[0]).toMatchObject({ status: 'sent', attempts: 1 });
  });

  test('erro 500 da própria função: mensagem genérica em pt-BR, nada do corpo cru, rascunho preservado e console sem dados', async ({ page, db, loginAs }) => {
    const w = await seedWorld(db);
    const leaks = collectLeaks(page);
    const { m } = await startReview(page, w, loginAs);
    await page.route(FN, (route) => route.fulfill({
      status: 500, contentType: 'application/json',
      body: JSON.stringify({ error: `boom ${PROVIDER_RAW_TEXT} ${FAKE_PROVIDER_KEY} ${ANA_EMAIL}`, stack: 'at secret.ts:1' }),
    }));
    await m.getByTestId('comunicacao-enviar').click();
    await expect(m.getByTestId('comunicacao-erro-envio')).toHaveText(
      'Não foi possível enviar o e-mail agora. Veja o status no histórico antes de tentar de novo.');
    await expect(m).toHaveAttribute('data-etapa', 'review');
    await expect(page.getByText(new RegExp(`${PROVIDER_RAW_TEXT}|${FAKE_PROVIDER_KEY}|secret\\.ts`))).toHaveCount(0);
    expect((await commRows(db))[0]).toMatchObject({ status: 'draft' });
    const all = leaks.console.join('\n');
    for (const secret of [PROVIDER_RAW_TEXT, FAKE_PROVIDER_KEY, ANA_EMAIL, 'secret.ts', 'Linha 1']) expect(all).not.toContain(secret);
  });
});
