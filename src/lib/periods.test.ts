import { describe, expect, it } from 'vitest';
import { MAX_PERIOD_DAYS, periodDays, resolvePeriod, shiftDate, validateRange } from './periods';

describe('shiftDate / periodDays', () => {
  it('atravessa virada de mês, de ano e ano bissexto', () => {
    expect(shiftDate('2026-03-01', -1)).toBe('2026-02-28');
    expect(shiftDate('2028-03-01', -1)).toBe('2028-02-29');
    expect(shiftDate('2026-12-31', 1)).toBe('2027-01-01');
    expect(shiftDate('2027-01-01', -1)).toBe('2026-12-31');
  });
  it('conta os dois extremos', () => {
    expect(periodDays({ from: '2026-10-03', to: '2026-10-03' })).toBe(1);
    expect(periodDays({ from: '2026-10-01', to: '2026-10-31' })).toBe(31);
    expect(periodDays({ from: '2026-12-25', to: '2027-01-05' })).toBe(12);
  });
});

describe('resolvePeriod', () => {
  it('hoje', () => {
    expect(resolvePeriod('today', '2026-10-03')).toEqual({ from: '2026-10-03', to: '2026-10-03' });
  });

  it('semana vai de segunda a domingo (hoje = sábado)', () => {
    // 2026-10-03 é sábado
    expect(resolvePeriod('week', '2026-10-03')).toEqual({ from: '2026-09-28', to: '2026-10-04' });
  });
  it('semana: segunda e domingo são os limites inclusivos', () => {
    expect(resolvePeriod('week', '2026-09-28')).toEqual({ from: '2026-09-28', to: '2026-10-04' }); // segunda
    expect(resolvePeriod('week', '2026-10-04')).toEqual({ from: '2026-09-28', to: '2026-10-04' }); // domingo
    expect(resolvePeriod('week', '2026-10-05')).toEqual({ from: '2026-10-05', to: '2026-10-11' }); // próxima segunda
  });
  it('semana na virada de ano', () => {
    // 2027-01-01 é sexta
    expect(resolvePeriod('week', '2027-01-01')).toEqual({ from: '2026-12-28', to: '2027-01-03' });
  });

  it('mês atual, do dia 1 ao último dia', () => {
    expect(resolvePeriod('month', '2026-10-03')).toEqual({ from: '2026-10-01', to: '2026-10-31' });
    expect(resolvePeriod('month', '2026-02-28')).toEqual({ from: '2026-02-01', to: '2026-02-28' });
    expect(resolvePeriod('month', '2028-02-10')).toEqual({ from: '2028-02-01', to: '2028-02-29' });
    expect(resolvePeriod('month', '2026-12-31')).toEqual({ from: '2026-12-01', to: '2026-12-31' });
    expect(resolvePeriod('month', '2027-01-01')).toEqual({ from: '2027-01-01', to: '2027-01-31' });
  });

  it('últimos 30 e 90 dias incluem hoje e têm exatamente 30/90 dias', () => {
    const r30 = resolvePeriod('last30', '2026-10-03');
    expect(r30).toEqual({ from: '2026-09-04', to: '2026-10-03' });
    expect(periodDays(r30)).toBe(30);
    const r90 = resolvePeriod('last90', '2026-03-01');
    expect(r90.to).toBe('2026-03-01');
    expect(periodDays(r90)).toBe(90);
    expect(r90.from).toBe('2025-12-02');
  });

  it('personalizado devolve o intervalo informado', () => {
    expect(resolvePeriod('custom', '2026-10-03', { from: '2026-01-01', to: '2026-02-01' })).toEqual({
      from: '2026-01-01',
      to: '2026-02-01',
    });
  });
});

describe('validateRange', () => {
  it('aceita intervalo de um dia e o limite de 400 dias', () => {
    expect(validateRange({ from: '2026-10-03', to: '2026-10-03' })).toBeNull();
    const to = shiftDate('2026-01-01', MAX_PERIOD_DAYS - 1);
    expect(periodDays({ from: '2026-01-01', to })).toBe(400);
    expect(validateRange({ from: '2026-01-01', to })).toBeNull();
  });
  it('rejeita 401 dias', () => {
    const to = shiftDate('2026-01-01', MAX_PERIOD_DAYS);
    expect(validateRange({ from: '2026-01-01', to })).toBe('O período pode ter no máximo 400 dias.');
  });
  it('rejeita início depois do fim', () => {
    expect(validateRange({ from: '2026-10-04', to: '2026-10-03' })).toBe(
      'A data inicial não pode ser posterior à data final.',
    );
  });
  it('rejeita vazio e datas inexistentes', () => {
    expect(validateRange({ from: '', to: '2026-10-03' })).toBe('Informe a data inicial e a data final.');
    expect(validateRange({ from: '2026-02-30', to: '2026-03-03' })).toBe('Informe datas válidas.');
  });
});
