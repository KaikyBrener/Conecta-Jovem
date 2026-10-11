import { describe, expect, it } from 'vitest';
import { ANONYMIZED_YOUTH_NAME, anonymizeConfirmationMatches, isAnonymizedYouth } from './anonymize';
import { friendlyErrorMessage } from './errors';

describe('anonymizeConfirmationMatches', () => {
  it('exige o nome atual do jovem; espaços extras não importam', () => {
    expect(anonymizeConfirmationMatches('Maria Silva', 'Maria Silva')).toBe(true);
    expect(anonymizeConfirmationMatches('  Maria   Silva ', 'Maria Silva')).toBe(true);
  });

  it('nome diferente, parcial, sem acento ou com outra caixa não confirma', () => {
    for (const typed of ['', 'Maria', 'maria silva', 'MARIA SILVA', 'Maria Silv', 'Maria Silva Souza']) {
      expect(anonymizeConfirmationMatches(typed, 'Maria Silva'), typed).toBe(false);
    }
    expect(anonymizeConfirmationMatches('Joao', 'João')).toBe(false);
  });

  it('nome vazio nunca confirma (nem com texto vazio)', () => {
    expect(anonymizeConfirmationMatches('', '')).toBe(false);
    expect(anonymizeConfirmationMatches('   ', '  ')).toBe(false);
  });
});

describe('isAnonymizedYouth', () => {
  it('reconhece o nome gravado pela migration 021', () => {
    expect(ANONYMIZED_YOUTH_NAME).toBe('Jovem anonimizado');
    expect(isAnonymizedYouth('Jovem anonimizado')).toBe(true);
    expect(isAnonymizedYouth('Maria Silva')).toBe(false);
    expect(isAnonymizedYouth(null)).toBe(false);
  });
});

describe('mensagens da RPC anonymize_youth', () => {
  const FALLBACK = 'Erro ao anonimizar os dados do jovem.';

  it('"e-mail em envio" (P0001 do banco) chega como está ao usuário', () => {
    const msg = 'Há um e-mail em envio para este jovem. Aguarde o envio terminar e tente novamente.';
    expect(friendlyErrorMessage({ code: 'P0001', message: msg }, FALLBACK)).toBe(msg);
  });

  it('recusa de papel (42501 customizado) também passa; erro técnico não vaza', () => {
    expect(friendlyErrorMessage({ code: '42501', message: 'Apenas coordenadores podem anonimizar jovens.' }, FALLBACK))
      .toBe('Apenas coordenadores podem anonimizar jovens.');
    expect(friendlyErrorMessage({ code: 'XX000', message: 'relation "communications" does not exist' }, FALLBACK))
      .not.toMatch(/relation|communications/);
  });
});
