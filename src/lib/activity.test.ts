import { describe, expect, it } from 'vitest';
import { activityBounds, startOfDaySP } from './activity';
import { ACTIVITY_ACTIONS, ACTIVITY_ACTION_LABEL, activityActionLabel } from './labels';

const custom = { from: '2026-10-01', to: '2026-10-05' };

describe('activityBounds', () => {
  it('todo o período não limita', () => {
    expect(activityBounds('all', '2026-10-03', custom)).toEqual({ from: null, toExclusive: null, error: null });
  });

  it('hoje vai da meia-noite de São Paulo até a meia-noite seguinte (exclusivo)', () => {
    expect(activityBounds('today', '2026-10-03', custom)).toEqual({
      from: '2026-10-03T03:00:00.000Z',
      toExclusive: '2026-10-04T03:00:00.000Z',
      error: null,
    });
  });

  it('um registro às 23h de São Paulo cai no dia certo (já é o dia seguinte em UTC)', () => {
    const b = activityBounds('today', '2026-10-03', custom);
    const occurred = '2026-10-04T02:00:00.000Z'; // 23h do dia 03 em São Paulo
    expect(occurred >= b.from! && occurred < b.toExclusive!).toBe(true);
  });

  it('últimos 30 dias termina hoje, inclusive', () => {
    const b = activityBounds('last30', '2026-10-03', custom);
    expect(b.from).toBe(startOfDaySP('2026-09-04'));
    expect(b.toExclusive).toBe(startOfDaySP('2026-10-04'));
  });

  it('personalizado usa as datas informadas e valida o intervalo', () => {
    const ok = activityBounds('custom', '2026-10-03', custom);
    expect(ok.from).toBe(startOfDaySP('2026-10-01'));
    expect(ok.toExclusive).toBe(startOfDaySP('2026-10-06'));
    expect(activityBounds('custom', '2026-10-03', { from: '2026-10-05', to: '2026-10-01' })).toEqual({
      from: null, toExclusive: null, error: 'A data inicial não pode ser posterior à data final.',
    });
    expect(activityBounds('custom', '2026-10-03', { from: '', to: '' }).error).toBe('Informe a data inicial e a data final.');
  });
});

describe('rótulos do histórico', () => {
  it('cobrem os 12 tipos de ação, sem repetição', () => {
    expect(ACTIVITY_ACTIONS).toHaveLength(12);
    expect(new Set(ACTIVITY_ACTIONS).size).toBe(12);
    for (const a of ACTIVITY_ACTIONS) expect(ACTIVITY_ACTION_LABEL[a]).toBeTruthy();
  });
  it('tipo desconhecido não quebra', () => {
    expect(activityActionLabel('algo_novo')).toBe('Atividade');
    expect(activityActionLabel('task_created')).toBe('Ação criada');
  });
});
