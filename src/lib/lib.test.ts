import { describe, expect, it } from 'vitest';
import { toCsv } from './csv';
import { parseAuthLinkHash } from './authLink';
import { setErrorReporter } from './logger';
import { MESSAGES } from './errors';
import { formatPercent, isOverdue, errorMessage, translateAuthError, recoverErrorMessage, RECOVER_NEUTRAL_MESSAGE } from './format';

describe('format / csv', () => {
  it('formatPercent', () => {
    expect(formatPercent(null)).toBe('—');
    expect(formatPercent(66.6)).toBe('67%');
  });

  it('isOverdue', () => {
    expect(isOverdue('2026-09-01', 'pending', '2026-09-30')).toBe(true);
    expect(isOverdue('2026-09-01', 'done', '2026-09-30')).toBe(false);
    expect(isOverdue('2026-09-30', 'pending', '2026-09-30')).toBe(false);
    expect(isOverdue(null, 'pending', '2026-09-30')).toBe(false);
  });

  it('errorMessage', () => {
    setErrorReporter(() => {}); // o teste não precisa poluir o console
    // texto cru de erro técnico NUNCA vai para a tela (ver errors.test.ts)
    expect(errorMessage({ message: 'falhou' })).toBe('Ocorreu um erro inesperado.');
    expect(errorMessage(null, 'x')).toBe('x');
  });

  it('toCsv escapa separador, aspas e quebras', () => {
    expect(toCsv(['a', 'b'], [['x;y', 'diz "oi"'], [1, null]])).toBe('a;b\r\n"x;y";"diz ""oi"""\r\n1;');
  });

  it('translateAuthError traduz mensagens conhecidas e nunca vaza texto em inglês', () => {
    expect(translateAuthError('Invalid login credentials')).toBe('E-mail ou senha incorretos.');
    expect(translateAuthError('Email not confirmed')).toMatch(/confirmado/);
    expect(translateAuthError('Some unexpected GoTrue internal error')).not.toMatch(/[A-Za-z]{4,}(internal|error|credentials)/i);
  });
});

describe('translateAuthError (cobertura ampliada)', () => {
  it('traduz erros de troca/definição de senha', () => {
    expect(translateAuthError('New password should be different from the old password.')).toMatch(/diferente/);
    expect(translateAuthError('Password should be at least 8 characters.')).toBe('A senha deve ter pelo menos 8 caracteres.');
    expect(translateAuthError('Auth session missing!')).toMatch(/sessão expirou/);
    expect(translateAuthError('Password is known to be weak and easy to guess, please choose a different one.')).toMatch(/fraca/);
  });
  it('traduz o limite de pedidos de e-mail com o tempo de espera', () => {
    expect(translateAuthError('For security purposes, you can only request this after 52 seconds.')).toBe(
      'Por segurança, aguarde 52 segundos antes de tentar novamente.');
  });
  it('falha de rede (AuthRetryableFetchError) vira mensagem de rede, não de credencial', () => {
    const net = { name: 'AuthRetryableFetchError', message: 'Failed to fetch', status: 0 };
    expect(translateAuthError(net)).toBe(MESSAGES.network);
    expect(translateAuthError(net, 'Não foi possível salvar.')).toBe(MESSAGES.network);
    expect(translateAuthError({ message: 'TypeError: Failed to fetch' })).toBe(MESSAGES.network);
    expect(translateAuthError('Failed to fetch')).toBe(MESSAGES.network);
    // credencial inválida com o objeto completo continua sendo credencial
    expect(translateAuthError({ name: 'AuthApiError', message: 'Invalid login credentials', status: 400 })).toBe('E-mail ou senha incorretos.');
  });
  it('limite de requisições (429 / over_*_rate_limit / "rate limit") vira "Muitas tentativas"', () => {
    const msg = 'Muitas tentativas. Aguarde alguns minutos e tente novamente.';
    expect(translateAuthError({ message: 'qualquer coisa', status: 429 })).toBe(msg);
    expect(translateAuthError({ message: 'x', code: 'over_request_rate_limit' })).toBe(msg);
    expect(translateAuthError({ message: 'x', code: 'over_email_send_rate_limit' })).toBe(msg);
    expect(translateAuthError('request rate limit reached')).toBe(msg);
    // com tempo de espera informado, a mensagem mais específica vence
    expect(translateAuthError({ message: 'For security purposes, you can only request this after 30 seconds.', status: 429 })).toBe(
      'Por segurança, aguarde 30 segundos antes de tentar novamente.');
  });
  it('busca no dicionário ignora maiúsculas/minúsculas', () => {
    expect(translateAuthError('email rate limit exceeded')).toMatch(/Muitas tentativas/);
    expect(translateAuthError('INVALID LOGIN CREDENTIALS')).toBe('E-mail ou senha incorretos.');
    expect(translateAuthError('auth session missing!')).toMatch(/sessão expirou/);
  });
  it('erro 5xx do provedor vira mensagem de servidor', () => {
    expect(translateAuthError({ message: 'boom', status: 500 })).toBe(MESSAGES.server);
  });
  it('desconhecido usa o fallback informado e nunca o texto cru', () => {
    expect(translateAuthError('boom: internal gotrue failure', 'Não foi possível alterar a senha.')).toBe('Não foi possível alterar a senha.');
    expect(translateAuthError('boom')).toMatch(/Não foi possível entrar/);
  });
});

describe('parseAuthLinkHash', () => {
  it('reconhece recuperação e convite como "precisa definir senha"', () => {
    expect(parseAuthLinkHash('#access_token=a&refresh_token=b&type=recovery')).toEqual({ type: 'recovery', errorCode: null, needsPassword: true });
    expect(parseAuthLinkHash('#access_token=a&type=invite').needsPassword).toBe(true);
  });
  it('link inválido/expirado traz o código do erro', () => {
    const info = parseAuthLinkHash('#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired');
    expect(info).toEqual({ type: null, errorCode: 'otp_expired', needsPassword: true });
  });
  it('fragmentos comuns (vazio, âncoras) não disparam nada', () => {
    expect(parseAuthLinkHash('')).toEqual({ type: null, errorCode: null, needsPassword: false });
    expect(parseAuthLinkHash('#secao')).toEqual({ type: null, errorCode: null, needsPassword: false });
  });
  it('outros tipos (signup, magiclink) não pedem senha', () => {
    expect(parseAuthLinkHash('#access_token=a&type=magiclink').needsPassword).toBe(false);
  });
});

describe('recoverErrorMessage (pedido de redefinição de senha)', () => {
  const SEND_FAILED = 'Não foi possível enviar o e-mail agora. Aguarde um minuto e tente novamente.';

  it('sucesso e conta inexistente são indistinguíveis: null (a tela mostra a mensagem neutra)', () => {
    expect(recoverErrorMessage(null)).toBeNull();
    expect(recoverErrorMessage(undefined)).toBeNull();
    expect(recoverErrorMessage({ message: 'User not found', status: 404 })).toBeNull();
    expect(recoverErrorMessage({ message: 'x', code: 'user_not_found', status: 400 })).toBeNull();
    expect(recoverErrorMessage('user not found')).toBeNull();
    expect(RECOVER_NEUTRAL_MESSAGE).toBe('Se o e-mail estiver cadastrado, você receberá um link em instantes.');
  });

  it('falha de envio (500) e erro desconhecido viram a mensagem de envio, sem o texto do servidor', () => {
    expect(recoverErrorMessage({ message: 'Error sending recovery email', status: 500, code: 'unexpected_failure' })).toBe(SEND_FAILED);
    expect(recoverErrorMessage({ message: 'boom: internal gotrue failure', status: 502 })).toBe(SEND_FAILED);
    expect(recoverErrorMessage('qualquer coisa')).toBe(SEND_FAILED);
    expect(recoverErrorMessage({})).toBe(SEND_FAILED);
  });

  it('limite de pedidos (429) vira "Muitas tentativas"; com o tempo informado, mostra os segundos', () => {
    const msg = 'Muitas tentativas. Aguarde um pouco.';
    expect(recoverErrorMessage({ message: 'Request rate limit reached', status: 429 })).toBe(msg);
    expect(recoverErrorMessage({ message: 'x', code: 'over_email_send_rate_limit' })).toBe(msg);
    expect(recoverErrorMessage('email rate limit exceeded')).toBe(msg);
    expect(recoverErrorMessage({ message: 'For security purposes, you can only request this after 48 seconds.', status: 429 })).toBe(
      'Por segurança, aguarde 48 segundos antes de tentar novamente.');
  });

  it('rede e e-mail mal formatado têm mensagem própria', () => {
    expect(recoverErrorMessage({ name: 'AuthRetryableFetchError', message: 'Failed to fetch', status: 0 })).toBe(MESSAGES.network);
    expect(recoverErrorMessage('Unable to validate email address: invalid format')).toBe('Informe um e-mail válido.');
  });

  it('nunca devolve o texto cru nem o e-mail informado', () => {
    const out = recoverErrorMessage({ message: 'smtp: 535 auth failed for fulano@exemplo.com', status: 500 });
    expect(out).toBe(SEND_FAILED);
    expect(out).not.toMatch(/smtp|535|fulano/i);
  });
});
