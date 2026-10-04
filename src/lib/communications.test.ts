import { describe, expect, it } from 'vitest';
import {
  BODY_MAX, SENDING_STUCK_MS, SUBJECT_MAX, TEMPLATE_IDS, TEMPLATE_LABEL,
  buildTemplate, fillTemplate, isSingleLineText, isStuckSending, isValidEmail, normalizeBody, normalizeEmail,
  parseSendError, parseSendResponse, resolveSendView, templateForAlert, textLength, toDraftPayload, toFailureReason,
  toSingleLine, validateCommunicationForm, validateMessage, validateRecipient,
} from './communications';
import {
  COMMUNICATION_STATUS_LABEL, FAILURE_REASON_LABEL, FAILURE_REASONS, RECIPIENT_KIND_LABEL, RECIPIENT_KINDS,
  SEND_ERROR_MESSAGE, failureReasonLabel,
} from './labels';
import type { Communication, RecipientKind } from '../types/database.types';

describe('isValidEmail (espelha is_valid_email do banco)', () => {
  it.each([
    'ana@exemplo.com', 'ana.silva+igreja@sub.exemplo.com.br', 'a_b-c+d@x-y.org', 'A@B.CO', 'ana@xn--exemplo.com',
  ])('aceita %s', (e) => expect(isValidEmail(e)).toBe(true));

  it.each([
    '', 'ana', 'ana@', '@exemplo.com', 'ana@exemplo', 'ana@exemplo.c', 'ana@.com', 'ana@exemplo..com', 'ana..x@exemplo.com',
    '.ana@exemplo.com', 'ana.@exemplo.com', 'ana@-exemplo.com', 'ana@exemplo-.com', 'a na@exemplo.com',
    'ana@exemplo.com,outro@exemplo.com', 'ana@exemplo.com;outro@exemplo.com', '"ana"@exemplo.com', 'ana@exemplo.com>',
    'Ana <ana@exemplo.com>', 'ana@exemplo.123', 'ana@exemplo.com?subject=x', 'ana@exemplo.com/x', 'ana@exemplo.com&bcc=x', 'a%0d%0abcc%3dx@y.com',
  ])('rejeita %j', (e) => expect(isValidEmail(e)).toBe(false));

  it('rejeita CR/LF e outros controles (injeção de cabeçalho)', () => {
    expect(isValidEmail('ana@exemplo.com\n')).toBe(false);
    expect(isValidEmail('ana@exemplo.com\r\nBcc: x@y.com')).toBe(false);
    expect(isValidEmail('an\na@exemplo.com')).toBe(false);
    expect(isValidEmail('ana@exemplo.com\u2028')).toBe(false);
    expect(isValidEmail('ana@exemplo.com\0')).toBe(false);
    expect(isValidEmail('ana@exemplo.com\t')).toBe(false);
  });

  it('respeita os tamanhos: local-part até 64 e total até 254', () => {
    expect(isValidEmail(`${'a'.repeat(64)}@exemplo.com`)).toBe(true);
    expect(isValidEmail(`${'a'.repeat(65)}@exemplo.com`)).toBe(false);
    const label = 'b'.repeat(63);
    expect(isValidEmail(`a@${label}.${label}.${label}.com`)).toBe(true); // 2 + 3*64 + 3 = 197
    expect(isValidEmail(`a@${label}.${label}.${label}.${label}.com`)).toBe(false); // 261 > 254
    expect(isValidEmail(`a@${'b'.repeat(64)}.com`)).toBe(false);
  });

  it('aceita espaços nas pontas (como o btrim do banco) mas não no meio; normaliza para minúsculas', () => {
    expect(isValidEmail('  ana@exemplo.com  ')).toBe(true);
    expect(normalizeEmail('  Ana@Exemplo.COM ')).toBe('ana@exemplo.com');
  });

  it('não trava com entrada hostil (sem backtracking catastrófico)', () => {
    const t = Date.now();
    expect(isValidEmail(`${'a'.repeat(5000)}@${'b.'.repeat(2500)}`)).toBe(false);
    expect(isValidEmail(`a@${'a-'.repeat(2000)}`)).toBe(false);
    expect(Date.now() - t).toBeLessThan(500);
  });
});

describe('texto de uma linha e corpo', () => {
  it('isSingleLineText', () => {
    expect(isSingleLineText('Olá, mundo')).toBe(true);
    for (const bad of ['a\nb', 'a\rb', 'a\tb', 'a\u0000b', 'a\u007fb', 'a\u0085b', 'a\u2028b', 'a\u2029b']) {
      expect(isSingleLineText(bad)).toBe(false);
    }
  });
  it('toSingleLine troca controles por espaço', () => {
    expect(toSingleLine('  Oi\r\nBcc: x@y.com\tfim  ')).toBe('Oi Bcc: x@y.com fim');
  });
  it('normalizeBody padroniza quebras e remove controles proibidos, mantendo \\n e TAB', () => {
    expect(normalizeBody('a\r\nb\rc\nd\te\u0000f\u0007g\u007fh')).toBe('a\nb\nc\nd\tefgh');
  });
  it('textLength conta pontos de código (emoji = 1), como o banco', () => {
    expect(textLength('olá')).toBe(3);
    expect(textLength('🙂🙂')).toBe(2);
  });
});

describe('validações do formulário', () => {
  it('destinatário', () => {
    expect(validateRecipient('', '')).toBe('Informe o e-mail do destinatário.');
    expect(validateRecipient('ana', '')).toMatch(/e-mail válido/);
    expect(validateRecipient('ana@exemplo.com', 'A\nB')).toMatch(/quebras de linha/);
    expect(validateRecipient('ana@exemplo.com', 'x'.repeat(121))).toMatch(/120/);
    expect(validateRecipient('ana@exemplo.com', 'x'.repeat(120))).toBeNull();
    expect(validateRecipient('ana@exemplo.com', '')).toBeNull();
  });

  it('assunto: obrigatório, uma linha, até 200', () => {
    expect(validateMessage('', 'corpo')).toBe('Informe o assunto.');
    expect(validateMessage('   ', 'corpo')).toBe('Informe o assunto.');
    expect(validateMessage('a\nb', 'corpo')).toMatch(/quebras de linha/);
    expect(validateMessage('a\r\nBcc: x@y.com', 'corpo')).toMatch(/quebras de linha/);
    expect(validateMessage('x'.repeat(SUBJECT_MAX), 'corpo')).toBeNull();
    expect(validateMessage('x'.repeat(SUBJECT_MAX + 1), 'corpo')).toMatch(/200/);
  });

  it('corpo: obrigatório (não só espaços/quebras) e até 5000', () => {
    expect(validateMessage('Assunto', '')).toBe('Escreva a mensagem.');
    expect(validateMessage('Assunto', ' \n\t\r\n ')).toBe('Escreva a mensagem.');
    expect(validateMessage('Assunto', 'x'.repeat(BODY_MAX))).toBeNull();
    expect(validateMessage('Assunto', 'x'.repeat(BODY_MAX + 1))).toMatch(/5000/);
    expect(validateMessage('Assunto', '🙂'.repeat(BODY_MAX))).toBeNull(); // pontos de código, não unidades UTF-16
  });

  it('validateCommunicationForm devolve o primeiro problema, na ordem destinatário -> mensagem', () => {
    expect(validateCommunicationForm({ recipientEmail: 'x', recipientName: '', subject: '', body: '' })).toMatch(/e-mail válido/);
    expect(validateCommunicationForm({ recipientEmail: 'a@b.com', recipientName: '', subject: '', body: '' })).toBe('Informe o assunto.');
    expect(validateCommunicationForm({ recipientEmail: 'a@b.com', recipientName: '', subject: 'S', body: 'C' })).toBeNull();
  });

  it('toDraftPayload normaliza e-mail, nome vazio e corpo', () => {
    expect(toDraftPayload({ recipientEmail: ' ANA@Exemplo.com ', recipientName: '  ', subject: ' Oi ', body: 'a\r\nb' })).toEqual({
      recipient_email: 'ana@exemplo.com', recipient_name: null, subject: 'Oi', body: 'a\nb',
    });
    expect(toDraftPayload({ recipientEmail: 'a@b.com', recipientName: ' Ana ', subject: 'S', body: 'C' }).recipient_name).toBe('Ana');
  });
});

describe('resposta do envio (Edge Function send-communication)', () => {
  it('HTTP 200 com status sent/failed vira o resultado correspondente', () => {
    expect(parseSendResponse({ status: 'sent', communication_id: 'x', sent_at: '2026-10-03T12:00:00Z' }))
      .toEqual({ kind: 'sent', sentAt: '2026-10-03T12:00:00Z' });
    expect(parseSendResponse({ status: 'sent' })).toEqual({ kind: 'sent', sentAt: null });
    expect(parseSendResponse({ status: 'failed', failure_reason: 'provider_not_configured' }))
      .toEqual({ kind: 'failed', reason: 'provider_not_configured' });
  });

  it('motivo de falha desconhecido (ou ausente) vira unknown', () => {
    expect(parseSendResponse({ status: 'failed', failure_reason: 'smtp 550 user@x.com' })).toEqual({ kind: 'failed', reason: 'unknown' });
    expect(parseSendResponse({ status: 'failed' })).toEqual({ kind: 'failed', reason: 'unknown' });
    expect(toFailureReason('bounced')).toBe('unknown'); // código antigo, já aposentado
    for (const r of FAILURE_REASONS) expect(toFailureReason(r)).toBe(r);
  });

  it('aceita o corpo como texto JSON; lixo ou status desconhecido = não confirmado (nunca "enviado")', () => {
    expect(parseSendResponse('{"status":"sent","sent_at":"2026-10-03T12:00:00Z"}')).toEqual({ kind: 'sent', sentAt: '2026-10-03T12:00:00Z' });
    for (const bad of [null, undefined, '', 'ok', 42, [], {}, { status: 'sending' }, { status: 'SENT' }, '{"status":'])
      expect(parseSendResponse(bad)).toEqual({ kind: 'unconfirmed' });
  });

  it('erros da requisição: código conhecido, com fallback pelo HTTP e genérico para o resto', () => {
    expect(parseSendError(409, { error: 'already_sent_or_in_progress' })).toEqual({ kind: 'rejected', code: 'already_sent_or_in_progress' });
    expect(parseSendError(422, { error: 'invalid_communication' })).toEqual({ kind: 'rejected', code: 'invalid_communication' });
    expect(parseSendError(404, '{"error":"not_found"}')).toEqual({ kind: 'rejected', code: 'not_found' });
    expect(parseSendError(401, null)).toEqual({ kind: 'rejected', code: 'unauthorized' });
    expect(parseSendError(429, {})).toEqual({ kind: 'rejected', code: 'rate_limited' });
    expect(parseSendError(500, { error: 'boom: smtp.provedor.com' })).toEqual({ kind: 'rejected', code: 'unknown' });
    expect(parseSendError(null, undefined)).toEqual({ kind: 'rejected', code: 'unknown' });
    // 'unknown' vindo do servidor não é um código "conhecido" próprio: cai no mesmo genérico
    expect(parseSendError(400, { error: 'unknown' })).toEqual({ kind: 'rejected', code: 'unknown' });
  });

  const row = (status: Communication['status'], extra: Partial<Communication> = {}) =>
    ({ status, failure_reason: null, sent_at: null, ...extra });

  it('o estado do banco manda sobre a resposta (e-mail pode ter saído com a resposta perdida)', () => {
    expect(resolveSendView({ kind: 'unconfirmed' }, row('sent', { sent_at: '2026-10-03T12:00:00Z' })))
      .toEqual({ kind: 'sent', sentAt: '2026-10-03T12:00:00Z' });
    expect(resolveSendView({ kind: 'unconfirmed' }, row('failed', { failure_reason: 'timeout' })))
      .toEqual({ kind: 'failed', reason: 'timeout' });
    expect(resolveSendView({ kind: 'unconfirmed' }, row('sending'))).toEqual({ kind: 'in_progress' });
    expect(resolveSendView({ kind: 'rejected', code: 'already_sent_or_in_progress' }, row('sent', { sent_at: 'x' })).kind).toBe('sent');
    // falha com motivo antigo/desconhecido no banco não quebra a tela
    expect(resolveSendView({ kind: 'unconfirmed' }, row('failed', { failure_reason: 'bounced' as never })))
      .toEqual({ kind: 'failed', reason: 'unknown' });
  });

  it('sem a linha (ou ainda rascunho) vale a resposta do servidor', () => {
    expect(resolveSendView({ kind: 'sent', sentAt: 'T' }, null)).toEqual({ kind: 'sent', sentAt: 'T' });
    expect(resolveSendView({ kind: 'failed', reason: 'network' }, null)).toEqual({ kind: 'failed', reason: 'network' });
    expect(resolveSendView({ kind: 'unconfirmed' }, null)).toEqual({ kind: 'unconfirmed' });
    expect(resolveSendView({ kind: 'rejected', code: 'invalid_communication' }, row('draft')))
      .toEqual({ kind: 'rejected', message: SEND_ERROR_MESSAGE.invalid_communication });
  });

  it('o cliente jamais mostra "enviado" sem o servidor dizer (resposta perdida + banco ainda rascunho)', () => {
    expect(resolveSendView({ kind: 'unconfirmed' }, row('draft')).kind).toBe('unconfirmed');
  });
});

describe('isStuckSending (envio preso há mais de 5 min)', () => {
  const NOW = Date.parse('2026-10-03T12:00:00Z');
  const sending = (extra: Partial<Communication> = {}) => ({
    status: 'sending' as const, last_attempt_at: '2026-10-03T11:50:00Z', updated_at: '2026-10-03T11:50:00Z', ...extra,
  });

  it('só conta em sending e depois de 5 minutos', () => {
    expect(SENDING_STUCK_MS).toBe(300_000);
    expect(isStuckSending(sending({ last_attempt_at: '2026-10-03T11:56:00Z' }), NOW)).toBe(false); // 4 min
    expect(isStuckSending(sending({ last_attempt_at: '2026-10-03T11:55:00Z' }), NOW)).toBe(false); // exatamente 5 min
    expect(isStuckSending(sending({ last_attempt_at: '2026-10-03T11:54:59Z' }), NOW)).toBe(true);
    expect(isStuckSending(sending(), new Date(NOW))).toBe(true);
    for (const status of ['draft', 'sent', 'failed', 'cancelled'] as const) expect(isStuckSending(sending({ status }), NOW)).toBe(false);
  });

  it('sem última tentativa usa updated_at; data inválida nunca trava', () => {
    expect(isStuckSending(sending({ last_attempt_at: null, updated_at: '2026-10-03T11:00:00Z' }), NOW)).toBe(true);
    expect(isStuckSending(sending({ last_attempt_at: null, updated_at: '2026-10-03T11:59:00Z' }), NOW)).toBe(false);
    expect(isStuckSending(sending({ last_attempt_at: 'não é data' }), NOW)).toBe(false);
    expect(isStuckSending(sending(), Number.NaN)).toBe(false);
  });
});

describe('modelos de mensagem', () => {
  const vars = { nome: 'Maria', grupo: 'Grupo Alfa', remetente: 'João' };
  const kinds: RecipientKind[] = ['youth', 'guardian', 'leader', 'coordinator', 'other'];

  it('há rótulo para cada modelo, e o modelo de cada tipo de alerta', () => {
    for (const id of TEMPLATE_IDS) expect(TEMPLATE_LABEL[id]).toBeTruthy();
    expect(templateForAlert('consecutive_absences')).toBe('consecutive_absences');
    expect(templateForAlert('low_attendance')).toBe('low_attendance');
    expect(templateForAlert('attendance_drop')).toBe('attendance_drop');
    expect(templateForAlert('no_followup')).toBe('free');
    expect(templateForAlert('overdue_action')).toBe('free');
    expect(templateForAlert(null)).toBe('free');
  });

  it('todos os modelos geram texto válido para o banco, para qualquer tipo de destinatário', () => {
    for (const id of TEMPLATE_IDS) {
      for (const kind of kinds) {
        const t = buildTemplate(id, kind, vars);
        expect(validateMessage(t.subject, t.body)).toBeNull();
        expect(textLength(t.subject)).toBeLessThanOrEqual(SUBJECT_MAX);
        expect(t.body).toContain('Maria');
        expect(t.body).toContain('João');
        expect(t.body).toContain('Grupo Alfa');
        expect(t.body + t.subject).not.toMatch(/[{}]/);
      }
    }
  });

  it('não expõe números nem percentuais, nem fala de outros jovens (sem diagnóstico)', () => {
    for (const id of TEMPLATE_IDS) {
      for (const kind of kinds) {
        const { subject, body } = buildTemplate(id, kind, vars);
        expect(subject + body).not.toMatch(/\d|%/);
        expect(subject + body).not.toMatch(/depress|ansied|doen|transtorno|problema psico/i);
      }
    }
  });

  it('para o jovem fala em segunda pessoa; para os demais fala SOBRE o jovem', () => {
    const direct = buildTemplate('consecutive_absences', 'youth', vars);
    const about = buildTemplate('consecutive_absences', 'guardian', vars);
    expect(direct.body.startsWith('Olá, Maria!')).toBe(true);
    expect(about.body.startsWith('Olá!')).toBe(true);
    expect(about.body).toContain('a respeito de Maria');
  });

  it('sem grupo, a assinatura termina no remetente (sem linha vazia sobrando)', () => {
    const { body } = buildTemplate('low_attendance', 'youth', { nome: 'Maria', remetente: 'João' });
    expect(body.endsWith('Um abraço,\nJoão')).toBe(true);
  });

  it('fillTemplate: variáveis ausentes recebem valor neutro', () => {
    expect(fillTemplate('Oi {nome}, {remetente}', { nome: '', remetente: '' })).toBe('Oi jovem, Equipe do ministério jovem');
  });

  it('fillTemplate: não reinterpreta o valor inserido nem usa padrões especiais de replace', () => {
    expect(fillTemplate('A:{nome} B:{remetente}', { nome: '{remetente}', remetente: 'R' })).toBe('A:{remetente} B:R');
    expect(fillTemplate('{nome}', { nome: "$& $1 $' $$" })).toBe("$& $1 $' $$");
    expect(fillTemplate('{desconhecida} {nome}', { nome: 'X' })).toBe('{desconhecida} X');
  });

  it('fillTemplate: quebra de linha em nome/remetente não vira linha nova nem cabeçalho', () => {
    const out = fillTemplate('Assunto: {nome}', { nome: 'Ana\r\nBcc: x@y.com' });
    expect(out).toBe('Assunto: Ana Bcc: x@y.com');
    expect(isSingleLineText(out)).toBe(true);
    const { subject } = buildTemplate('consecutive_absences', 'youth', { nome: 'Ana\r\nBcc: x@y.com', remetente: 'R' });
    expect(isSingleLineText(subject)).toBe(true);
  });

  it('fillTemplate: nome gigante é limitado (o assunto continua dentro do limite do banco)', () => {
    const { subject } = buildTemplate('consecutive_absences', 'youth', { nome: 'N'.repeat(1000), remetente: 'R' });
    expect(textLength(subject)).toBeLessThanOrEqual(SUBJECT_MAX);
  });

  it('o texto do modelo livre abre com espaço para escrever', () => {
    const { body } = buildTemplate('free', 'youth', vars);
    expect(body).toContain('Olá, Maria!\n\n\n\nUm abraço');
  });
});

describe('rótulos de comunicação', () => {
  it('status, tipos de destinatário e motivos de falha em pt-BR', () => {
    expect(COMMUNICATION_STATUS_LABEL).toEqual({
      draft: 'Rascunho', sending: 'Enviando', sent: 'Enviado', failed: 'Falhou', cancelled: 'Cancelada',
    });
    expect(RECIPIENT_KINDS.map((k) => RECIPIENT_KIND_LABEL[k])).toEqual(['Jovem', 'Responsável', 'Líder', 'Coordenador', 'Outro']);
    expect(FAILURE_REASONS).toEqual(['provider_not_configured', 'provider_rejected', 'invalid_address', 'network', 'timeout', 'unknown']);
    for (const r of FAILURE_REASONS) expect(FAILURE_REASON_LABEL[r]).toBeTruthy();
    expect(FAILURE_REASON_LABEL.provider_not_configured).toBe(
      'O envio de e-mail ainda não está configurado no servidor. Fale com o administrador.',
    );
  });

  it('mensagens de falha e de erro não citam provedor, URL nem endereço', () => {
    const all = [...Object.values(FAILURE_REASON_LABEL), ...Object.values(SEND_ERROR_MESSAGE)].join(' ');
    expect(all).not.toMatch(/https?:|\.com|resend|sendgrid|smtp|mailgun|@/i);
    expect(failureReasonLabel('bounced')).toBe(FAILURE_REASON_LABEL.unknown);
    expect(failureReasonLabel(null)).toBe(FAILURE_REASON_LABEL.unknown);
    expect(failureReasonLabel('timeout')).toBe(FAILURE_REASON_LABEL.timeout);
  });
});
