import { describe, expect, it } from 'vitest';
import {
  cancelMessage,
  createdMessage,
  describeRecurrence,
  firstOccurrence,
  groupsMessage,
  hasPendingGroups,
  maxSeriesEnd,
  nthWeekdayOfMonth,
  parseSeriesCancelResult,
  parseSeriesCreateResult,
  parseSeriesGroupsResult,
  previewSentence,
  seriesDates,
  validateExtendEnd,
  validateSeriesInput,
  type SeriesInput,
} from './series';

// 2026-10-03 é sábado (weekday 6)
describe('seriesDates', () => {
  it('semanal inclui a data inicial e a final quando caem no dia da semana', () => {
    expect(seriesDates(6, 'weekly', '2026-10-03', '2026-10-31')).toEqual([
      '2026-10-03', '2026-10-10', '2026-10-17', '2026-10-24', '2026-10-31',
    ]);
  });

  it('a primeira ocorrência é o primeiro dia da semana a partir da data inicial', () => {
    expect(firstOccurrence(6, '2026-10-07')).toBe('2026-10-10');
    expect(seriesDates(6, 'weekly', '2026-10-07', '2026-10-20')).toEqual(['2026-10-10', '2026-10-17']);
  });

  it('quinzenal pula de 14 em 14 dias', () => {
    expect(seriesDates(6, 'biweekly', '2026-10-03', '2026-10-31')).toEqual(['2026-10-03', '2026-10-17', '2026-10-31']);
  });

  it('mensal mantém o N-ésimo dia da semana da primeira ocorrência (2º sábado)', () => {
    expect(seriesDates(6, 'monthly_nth_weekday', '2026-10-10', '2027-01-31')).toEqual([
      '2026-10-10', '2026-11-14', '2026-12-12', '2027-01-09',
    ]);
  });

  it('mensal com N = 5 vale o ÚLTIMO dia da semana do mês (mesmo quando há só 4)', () => {
    // 31/10/2026 é o 5º sábado de outubro
    expect(nthWeekdayOfMonth('2026-10-31')).toBe(5);
    expect(seriesDates(6, 'monthly_nth_weekday', '2026-10-31', '2027-02-28')).toEqual([
      '2026-10-31', '2026-11-28', '2026-12-26', '2027-01-30', '2027-02-27',
    ]);
  });

  it('mensal não gera data anterior à primeira ocorrência nem posterior ao fim', () => {
    // começa no 3º sábado (17/10); o 3º sábado de novembro é 21/11, que passa do fim
    expect(seriesDates(6, 'monthly_nth_weekday', '2026-10-17', '2026-11-20')).toEqual(['2026-10-17']);
  });

  it('período sem nenhuma ocorrência devolve lista vazia', () => {
    expect(seriesDates(6, 'weekly', '2026-10-04', '2026-10-09')).toEqual([]);
    // 05/10/2026 é segunda-feira: 06 a 11/10 não tem nenhuma segunda
    expect(seriesDates(1, 'monthly_nth_weekday', '2026-10-06', '2026-10-11')).toEqual([]);
    expect(seriesDates(1, 'monthly_nth_weekday', '2026-10-04', '2026-10-05')).toEqual(['2026-10-05']);
  });

  it('entradas inválidas devolvem lista vazia', () => {
    expect(seriesDates(7, 'weekly', '2026-10-03', '2026-10-31')).toEqual([]);
    expect(seriesDates(6, 'weekly', '2026-02-30', '2026-10-31')).toEqual([]);
    expect(seriesDates(6, 'weekly', '', '2026-10-31')).toEqual([]);
  });

  it('no máximo 105 ocorrências semanais em 731 dias (limite do banco é 120)', () => {
    const end = maxSeriesEnd('2026-10-03');
    expect(end).toBe('2028-10-03');
    expect(seriesDates(6, 'weekly', '2026-10-03', end).length).toBe(105);
  });
});

describe('describeRecurrence', () => {
  it('descreve cada recorrência', () => {
    expect(describeRecurrence(6, 'weekly', '2026-10-03')).toBe('toda semana (sábado)');
    expect(describeRecurrence(6, 'biweekly', '2026-10-03')).toBe('a cada 14 dias (sábado)');
    expect(describeRecurrence(6, 'monthly_nth_weekday', '2026-10-10')).toBe('2º sábado de cada mês');
    expect(describeRecurrence(6, 'monthly_nth_weekday', '2026-10-31')).toBe('último sábado de cada mês');
  });
});

const base: SeriesInput = {
  name: 'Culto de jovens',
  weekday: 6,
  startTime: '19:30',
  recurrence: 'weekly',
  startDate: '2026-10-03',
  endDate: '2026-12-26',
};

describe('validateSeriesInput', () => {
  it('aceita uma série válida', () => {
    expect(validateSeriesInput(base)).toBeNull();
  });

  it('exige nome (e limita o tamanho)', () => {
    expect(validateSeriesInput({ ...base, name: '   ' })).toBe('Informe o nome da série.');
    expect(validateSeriesInput({ ...base, name: 'x'.repeat(121) })).toMatch(/no máximo 120/);
  });

  it('exige horário e dia da semana válidos', () => {
    expect(validateSeriesInput({ ...base, startTime: '' })).toBe('Informe o horário do encontro.');
    expect(validateSeriesInput({ ...base, startTime: '25:00' })).toBe('Informe o horário do encontro.');
    expect(validateSeriesInput({ ...base, weekday: 9 })).toBe('Escolha o dia da semana.');
  });

  it('valida datas: obrigatórias, reais, ordem e limite de 2 anos', () => {
    expect(validateSeriesInput({ ...base, endDate: '' })).toMatch(/data inicial e a data final/);
    expect(validateSeriesInput({ ...base, startDate: '2026-02-30' })).toBe('Informe datas válidas.');
    expect(validateSeriesInput({ ...base, endDate: '2026-10-01' })).toBe('A data final não pode ser anterior à data inicial.');
    expect(validateSeriesInput({ ...base, endDate: '2028-10-03' })).toBeNull(); // 731 dias
    expect(validateSeriesInput({ ...base, endDate: '2028-10-04' })).toBe('O período da série não pode passar de 2 anos.');
  });

  it('recusa período sem nenhuma data para o dia da semana', () => {
    expect(validateSeriesInput({ ...base, startDate: '2026-10-04', endDate: '2026-10-09' })).toMatch(/nenhuma data/);
  });
});

describe('validateExtendEnd', () => {
  const s = { start_date: '2026-10-03', end_date: '2026-12-26' };
  it('exige data posterior à atual e dentro dos 2 anos', () => {
    expect(validateExtendEnd(s, '')).toMatch(/válida/);
    expect(validateExtendEnd(s, '2026-12-26')).toMatch(/posterior/);
    expect(validateExtendEnd(s, '2027-03-27')).toBeNull();
    expect(validateExtendEnd(s, '2028-10-03')).toBeNull();
    expect(validateExtendEnd(s, '2028-10-04')).toMatch(/2 anos/);
  });
});

describe('hasPendingGroups', () => {
  it('só encontros de série, sem grupos e não cancelados', () => {
    expect(hasPendingGroups({ series_id: 's', group_ids: [], status: 'scheduled' })).toBe(true);
    expect(hasPendingGroups({ series_id: 's', group_ids: ['g'], status: 'scheduled' })).toBe(false);
    expect(hasPendingGroups({ series_id: 's', group_ids: [], status: 'cancelled' })).toBe(false);
    expect(hasPendingGroups({ series_id: null, group_ids: [], status: 'scheduled' })).toBe(false);
    expect(hasPendingGroups({ group_ids: [], status: 'scheduled' })).toBe(false);
  });
});

describe('mensagens e resultados das RPCs', () => {
  it('previewSentence concorda no singular', () => {
    expect(previewSentence(1)).toBe('Será criado 1 encontro.');
    expect(previewSentence(12)).toBe('Serão criados 12 encontros.');
  });

  it('parse é defensivo com payload inesperado', () => {
    expect(parseSeriesCreateResult(null)).toEqual({ seriesId: null, created: 0, skipped: 0 });
    expect(parseSeriesCreateResult({ series_id: 'a', created: 12, skipped: 2 })).toEqual({ seriesId: 'a', created: 12, skipped: 2 });
    expect(parseSeriesGroupsResult({ updated: '3', skipped: -1 })).toEqual({ updated: 0, skipped: 0 });
    expect(parseSeriesCancelResult([])).toEqual({ cancelled: 0, skipped: 0 });
  });

  it('createdMessage informa criados e ignorados', () => {
    expect(createdMessage({ created: 12, skipped: 0 }, 'criada')).toBe('Série criada: 12 encontros criados.');
    expect(createdMessage({ created: 1, skipped: 2 }, 'estendida')).toBe(
      'Série estendida: 1 encontro criado. 2 datas já existiam e foram ignoradas.',
    );
    expect(createdMessage({ created: 3, skipped: 1 }, 'criada')).toBe(
      'Série criada: 3 encontros criados. 1 data já existia e foi ignorada.',
    );
  });

  it('groupsMessage informa os editados individualmente', () => {
    expect(groupsMessage({ updated: 8, skipped: 0 })).toBe('Grupos aplicados a 8 próximos encontros.');
    expect(groupsMessage({ updated: 1, skipped: 1 })).toBe(
      'Grupos aplicados a 1 próximo encontro. 1 encontro foi editado individualmente e não foi alterado.',
    );
  });

  it('cancelMessage informa os que mantiveram a chamada', () => {
    expect(cancelMessage({ cancelled: 5, skipped: 0 })).toBe('5 encontros futuros cancelados. Série encerrada.');
    expect(cancelMessage({ cancelled: 1, skipped: 2 })).toBe(
      '1 encontro futuro cancelado. Série encerrada. 2 encontros futuros já têm chamada e foram mantidos.',
    );
  });
});
