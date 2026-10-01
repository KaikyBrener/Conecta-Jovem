import { describe, expect, it } from 'vitest';
import { toCsv } from './csv';
import { formatPercent, isOverdue, errorMessage, toDateInput, translateAuthError } from './format';
import {
  belowThreshold, overallRate, rate, summarizeByEvent, summarizeByGroup, summarizeByYouth, validRecords,
  type AttendanceRecord, type ReportEvent,
} from './reports';

const events: ReportEvent[] = [
  { id: 'e1', title: 'Encontro 1', event_date: '2026-09-01T22:00:00Z', status: 'completed' },
  { id: 'e2', title: 'Encontro 2', event_date: '2026-09-08T22:00:00Z', status: 'completed' },
  { id: 'e3', title: 'Cancelado', event_date: '2026-09-15T22:00:00Z', status: 'cancelled' },
];
const groups = [{ id: 'gA', name: 'Grupo A' }, { id: 'gB', name: 'Grupo B' }];
const youth = [
  { id: 'y1', full_name: 'Ana', group_id: 'gA', is_active: true },
  { id: 'y2', full_name: 'Bruno', group_id: 'gA', is_active: true },
  { id: 'y3', full_name: 'Carla', group_id: 'gB', is_active: false },
  { id: 'y4', full_name: 'Davi', group_id: null, is_active: true },
];
const records: AttendanceRecord[] = [
  { event_id: 'e1', youth_id: 'y1', group_id: 'gA', present: true },
  { event_id: 'e1', youth_id: 'y2', group_id: 'gA', present: false },
  { event_id: 'e2', youth_id: 'y1', group_id: 'gA', present: true },
  { event_id: 'e2', youth_id: 'y2', group_id: 'gA', present: true },
  { event_id: 'e2', youth_id: 'y3', group_id: 'gB', present: false },
  { event_id: 'e3', youth_id: 'y1', group_id: 'gA', present: false },
];

describe('reports', () => {
  const valid = validRecords(records, events);

  it('ignora encontros cancelados', () => {
    expect(valid).toHaveLength(5);
  });

  it('rate e overallRate', () => {
    expect(rate(0, 0)).toBeNull();
    expect(rate(1, 4)).toBe(25);
    expect(overallRate(valid)).toBe(60);
  });

  it('por encontro, mais recente primeiro', () => {
    const s = summarizeByEvent(valid, events);
    expect(s.map((e) => [e.event_id, e.present, e.total])).toEqual([['e2', 2, 3], ['e1', 1, 2]]);
  });

  it('por grupo', () => {
    const s = summarizeByGroup(valid, groups);
    expect(s).toEqual([
      { group_id: 'gA', name: 'Grupo A', events: 2, present: 3, total: 4, rate: 75 },
      { group_id: 'gB', name: 'Grupo B', events: 1, present: 0, total: 1, rate: 0 },
    ]);
  });

  it('por jovem, menor frequência primeiro, e abaixo do limite', () => {
    const s = summarizeByYouth(valid, youth, groups);
    expect(s.map((y) => [y.name, y.rate])).toEqual([['Carla', 0], ['Bruno', 50], ['Ana', 100]]);
    expect(belowThreshold(s, 70).map((y) => y.name)).toEqual(['Carla', 'Bruno']);
  });
});

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

  it('toDateInput e errorMessage', () => {
    expect(toDateInput(new Date(2026, 0, 5))).toBe('2026-01-05');
    expect(errorMessage({ message: 'falhou' })).toBe('falhou');
    expect(errorMessage(null, 'x')).toBe('x');
  });

  it('toCsv escapa separador, aspas e quebras', () => {
    expect(toCsv(['a', 'b'], [['x;y', 'diz "oi"'], [1, null]])).toBe('a;b\r\n"x;y";"diz ""oi"""\r\n1;');
  });

  it('translateAuthError traduz mensagens conhecidas e nunca vaza texto em inglês', () => {
    expect(translateAuthError('Invalid login credentials')).toBe('E-mail ou senha inválidos.');
    expect(translateAuthError('Email not confirmed')).toMatch(/confirmado/);
    expect(translateAuthError('Some unexpected GoTrue internal error')).not.toMatch(/[A-Za-z]{4,}(internal|error|credentials)/i);
  });
});
