import { describe, expect, it, vi } from 'vitest';
import { ALERT_SEVERITY_LABEL, ALERT_TYPES, ALERT_TYPE_NAME, alertDescription, alertTypeLabel, suggestedTaskTitle } from './labels';
import { notifyAlertsChanged, shouldSync, SYNC_MIN_INTERVAL_MS, subscribeAlertsChanged } from './alertsBus';
import { appToday, isOverdue } from './format';

const alert = (over: Partial<Parameters<typeof alertDescription>[0]>) => ({
  type: 'consecutive_absences' as const,
  consecutive_absences: 0,
  attendance_rate: null,
  previous_rate: null,
  sample_size: null,
  ...over,
});

describe('alertDescription', () => {
  it('faltas seguidas', () => {
    expect(alertDescription(alert({ consecutive_absences: 3 }))).toBe('3 faltas seguidas');
    expect(alertDescription(alert({ consecutive_absences: 1 }))).toBe('1 falta seguida');
  });

  it('frequência baixa usa taxa e amostra', () => {
    expect(alertDescription(alert({ type: 'low_attendance', attendance_rate: 40, sample_size: 8 })))
      .toBe('Frequência 40% nos últimos 8 encontros');
    expect(alertDescription(alert({ type: 'low_attendance' }))).toBe('Frequência baixa');
  });

  it('queda de frequência mostra de/para', () => {
    expect(alertDescription(alert({ type: 'attendance_drop', attendance_rate: 25, previous_rate: 100, sample_size: 8 })))
      .toBe('Frequência caiu de 100% para 25% (últimos 4 encontros)');
    expect(alertDescription(alert({ type: 'attendance_drop', attendance_rate: 25 }))).toBe('Frequência em queda');
  });

  it('sem acompanhamento e ações atrasadas', () => {
    expect(alertDescription(alert({ type: 'no_followup', sample_size: 9 }))).toBe('Sem acompanhamento há 9 dias');
    expect(alertDescription(alert({ type: 'no_followup', sample_size: 1 }))).toBe('Sem acompanhamento há 1 dia');
    expect(alertDescription(alert({ type: 'overdue_action', sample_size: 2 }))).toBe('2 ações atrasadas');
    expect(alertDescription(alert({ type: 'overdue_action', sample_size: 1 }))).toBe('1 ação atrasada');
  });
});

describe('rótulos', () => {
  it('os 5 tipos têm nome e as severidades estão em pt-BR', () => {
    expect(ALERT_TYPES).toHaveLength(5);
    for (const t of ALERT_TYPES) expect(ALERT_TYPE_NAME[t]).toBeTruthy();
    expect(alertTypeLabel('no_followup')).toBe('Sem acompanhamento');
    expect(alertTypeLabel('overdue_action')).toBe('Ação atrasada');
    expect(ALERT_SEVERITY_LABEL).toEqual({ attention: 'Atenção', critical: 'Crítico' });
  });

  it('título sugerido da ação depende do tipo do alerta', () => {
    expect(suggestedTaskTitle('consecutive_absences', 'Ana', 3)).toBe('Contatar Ana (3 faltas)');
    expect(suggestedTaskTitle('no_followup', 'Ana')).toBe('Acompanhar Ana');
    expect(suggestedTaskTitle('overdue_action', 'Ana')).toBe('Resolver ações atrasadas de Ana');
    expect(suggestedTaskTitle('low_attendance', 'Ana')).toBe('Conversar com Ana sobre a frequência');
  });
});

describe('aviso "alertas mudaram"', () => {
  it('notifica quem assinou e para depois de cancelar', () => {
    const fn = vi.fn();
    const off = subscribeAlertsChanged(fn);
    notifyAlertsChanged();
    notifyAlertsChanged();
    expect(fn).toHaveBeenCalledTimes(2);
    off();
    notifyAlertsChanged();
    expect(fn).toHaveBeenCalledTimes(2);
  });
});

describe('shouldSync', () => {
  it('sincroniza na primeira vez e depois só após o intervalo', () => {
    expect(shouldSync(null, 1000)).toBe(true);
    expect(shouldSync(1000, 1000 + SYNC_MIN_INTERVAL_MS - 1)).toBe(false);
    expect(shouldSync(1000, 1000 + SYNC_MIN_INTERVAL_MS)).toBe(true);
    expect(shouldSync(5000, 1000)).toBe(true); // relógio voltou
  });
});

describe('ação atrasada (mesma regra do banco)', () => {
  it('appToday usa o fuso de São Paulo', () => {
    // 02:00 UTC de 3/out ainda é 2/out às 23h em São Paulo
    expect(appToday(new Date('2026-10-03T02:00:00Z'))).toBe('2026-10-02');
    expect(appToday(new Date('2026-10-03T12:00:00Z'))).toBe('2026-10-03');
  });

  it('só abertas com prazo anterior a hoje; sem prazo nunca atrasa', () => {
    expect(isOverdue('2026-10-02', 'pending', '2026-10-03')).toBe(true);
    expect(isOverdue('2026-10-02', 'in_progress', '2026-10-03')).toBe(true);
    expect(isOverdue('2026-10-03', 'pending', '2026-10-03')).toBe(false);
    expect(isOverdue('2026-10-02', 'done', '2026-10-03')).toBe(false);
    expect(isOverdue('2026-10-02', 'cancelled', '2026-10-03')).toBe(false);
    expect(isOverdue(null, 'pending', '2026-10-03')).toBe(false);
  });
});
