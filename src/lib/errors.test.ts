import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MESSAGES, friendlyErrorMessage, isNetworkError } from './errors';
import { errorMessage } from './format';
import { describeError, logError, sanitizeMessage, setErrorReporter, type ErrorRecord } from './logger';

const FALLBACK = 'Erro ao salvar grupo.';
const pg = (code: string, message: string) => ({ code, message, details: 'Key (id)=(1) is not present in table "groups".', hint: null });

describe('friendlyErrorMessage — nunca expõe texto técnico', () => {
  it('violação de FK não vaza nome de constraint/tabela', () => {
    const msg = friendlyErrorMessage(
      pg('23503', 'insert or update on table "event_groups" violates foreign key constraint "event_groups_group_id_fkey"'), FALLBACK);
    expect(msg).toBe(MESSAGES.relatedMissing);
    expect(msg).not.toMatch(/event_groups|constraint|fkey/i);
  });

  it('RLS vira "sem permissão" (sem nome de tabela/política)', () => {
    const msg = friendlyErrorMessage(pg('42501', 'new row violates row-level security policy for table "groups"'), FALLBACK);
    expect(msg).toBe(MESSAGES.permission);
    expect(msg).not.toMatch(/groups|policy|row-level/i);
    expect(friendlyErrorMessage(pg('42501', 'permission denied for function save_event'), FALLBACK)).toBe(MESSAGES.permission);
  });

  it('duplicado, valor inválido, não encontrado', () => {
    expect(friendlyErrorMessage(pg('23505', 'duplicate key value violates unique constraint "alerts_one_open_idx"'), FALLBACK)).toBe(MESSAGES.duplicate);
    expect(friendlyErrorMessage(pg('22P02', 'invalid input syntax for type uuid: "abc"'), FALLBACK)).toBe(MESSAGES.invalid);
    expect(friendlyErrorMessage(pg('23514', 'new row for relation "app_settings" violates check constraint'), FALLBACK)).toBe(MESSAGES.invalid);
    expect(friendlyErrorMessage(pg('PGRST116', 'JSON object requested, multiple (or no) rows returned'), FALLBACK)).toBe(MESSAGES.notFound);
  });

  it('falha de rede (do PostgREST ou do GoTrue) vira "sem conexão"', () => {
    expect(friendlyErrorMessage({ message: 'TypeError: Failed to fetch', code: '' }, FALLBACK)).toBe(MESSAGES.network);
    expect(friendlyErrorMessage(new TypeError('Failed to fetch'), FALLBACK)).toBe(MESSAGES.network);
    expect(friendlyErrorMessage({ name: 'AuthRetryableFetchError', message: 'x' }, FALLBACK)).toBe(MESSAGES.network);
    expect(friendlyErrorMessage({ message: 'Load failed' }, FALLBACK)).toBe(MESSAGES.network);
    expect(friendlyErrorMessage({ name: 'AuthRetryableFetchError', message: 'x', status: 0 }, FALLBACK)).toBe(MESSAGES.network);
  });

  it('AuthRetryableFetchError com status 5xx é erro do servidor, não de rede (alinhado a isNetworkError)', () => {
    const err = { name: 'AuthRetryableFetchError', message: 'x', status: 503 };
    expect(isNetworkError(err)).toBe(false);
    expect(friendlyErrorMessage(err, FALLBACK)).toBe(MESSAGES.server);
  });

  it('sessão/JWT expirados', () => {
    expect(friendlyErrorMessage({ code: 'PGRST301', message: 'JWT expired' }, FALLBACK)).toBe(MESSAGES.session);
    expect(friendlyErrorMessage({ message: 'JWT expired' }, FALLBACK)).toBe(MESSAGES.session);
  });

  it('migration não aplicada (função/tabela/coluna ausente) vira orientação ao administrador', () => {
    const msg = friendlyErrorMessage(pg('PGRST202', 'Could not find the function public.save_event(...) in the schema cache'), FALLBACK);
    expect(msg).toBe(MESSAGES.outdated);
    expect(msg).not.toMatch(/save_event|schema cache/i);
    expect(friendlyErrorMessage(pg('42P01', 'relation "public.x" does not exist'), FALLBACK)).toBe(MESSAGES.outdated);
  });

  it('5xx vira "problema no servidor"', () => {
    expect(friendlyErrorMessage({ status: 503, message: 'upstream connect error' }, FALLBACK)).toBe(MESSAGES.server);
  });

  it('mensagens escritas por nós no banco (P0001/P0002/42501 customizado) passam, pois são seguras', () => {
    expect(friendlyErrorMessage(pg('P0001', 'Não é possível remover o último coordenador.'), FALLBACK)).toBe('Não é possível remover o último coordenador.');
    expect(friendlyErrorMessage(pg('P0002', 'Encontro não encontrado ou sem permissão.'), FALLBACK)).toBe('Encontro não encontrado ou sem permissão.');
    expect(friendlyErrorMessage(pg('42501', 'Apenas coordenadores podem alterar papéis.'), FALLBACK)).toBe('Apenas coordenadores podem alterar papéis.');
  });

  it('desconhecido usa o fallback da operação — nunca o texto cru', () => {
    expect(friendlyErrorMessage({ message: 'pq: connection to host db-internal-7 failed' }, FALLBACK)).toBe(FALLBACK);
    expect(friendlyErrorMessage(new Error('boom: stack trace here'), FALLBACK)).toBe(FALLBACK);
    expect(friendlyErrorMessage('texto solto', FALLBACK)).toBe(FALLBACK);
    expect(friendlyErrorMessage(null, FALLBACK)).toBe(FALLBACK);
    expect(friendlyErrorMessage(undefined, FALLBACK)).toBe(FALLBACK);
  });
});

describe('logger', () => {
  let records: ErrorRecord[];
  beforeEach(() => {
    records = [];
    setErrorReporter((r) => records.push(r));
  });
  afterEach(() => setErrorReporter(null));

  it('sanitizeMessage redige JWT, e-mail e UUID', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcDEF123_-xyz';
    const out = sanitizeMessage(`token ${jwt} de lia@igreja.com id 123e4567-e89b-12d3-a456-426614174000`);
    expect(out).toBe('token [token] de [e-mail] id [id]');
  });

  it('sanitizeMessage trunca mensagens longas', () => {
    expect(sanitizeMessage('x'.repeat(1000))).toHaveLength(300);
  });

  it('describeError guarda só code/status/message (sem details, hint ou stack)', () => {
    const err = Object.assign(new Error('falhou'), { code: '23503', status: 409, details: 'segredo interno', hint: 'dica interna', stack: 'at secret.ts:1' });
    const d = describeError(err);
    expect(d).toEqual({ code: '23503', status: 409, message: 'falhou' });
    expect(JSON.stringify(d)).not.toMatch(/segredo|dica|secret/);
  });

  it('logError entrega ao reporter um registro sanitizado e devolve o id do incidente', () => {
    const id = logError('Erro ao salvar chamada.', { code: '42501', message: 'new row violates row-level security policy; user lia@igreja.com' });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      id, context: 'Erro ao salvar chamada.', code: '42501', status: null,
      message: 'new row violates row-level security policy; user [e-mail]',
    });
    expect(id).toMatch(/^[0-9a-f]{8}$/);
    expect(new Date(records[0].at).toString()).not.toBe('Invalid Date');
  });

  it('um reporter que lança não derruba quem registrou o erro', () => {
    setErrorReporter(() => { throw new Error('reporter quebrado'); });
    expect(() => logError('x', new Error('y'))).not.toThrow();
  });

  it('errorMessage registra o erro e devolve só a mensagem amigável', () => {
    const msg = errorMessage({ code: '23503', message: 'violates foreign key constraint "x_fkey"' }, 'Erro ao salvar grupo.');
    expect(msg).toBe(MESSAGES.relatedMissing);
    expect(records).toHaveLength(1);
    expect(records[0].context).toBe('Erro ao salvar grupo.');
    expect(records[0].code).toBe('23503');
  });
});
