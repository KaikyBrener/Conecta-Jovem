import { describe, expect, it } from 'vitest';
import { parseDashboard, parseGroupIndicators, trendDisplay, trendText } from './overview';

describe('parseDashboard', () => {
  it('resposta vazia/inválida vira padrões seguros', () => {
    for (const raw of [null, undefined, 'x', [], {}]) {
      const d = parseDashboard(raw);
      expect(d.attention).toEqual([]);
      expect(d.attention_total).toBe(0);
      expect(d.open_alerts).toEqual({ total: 0, critical: 0, attention: 0 });
      expect(d.avg_attendance).toBeNull();
      expect(d.upcoming_events).toEqual([]);
    }
  });

  it('lê os campos e descarta itens malformados', () => {
    const d = parseDashboard({
      attention: [
        { youth_id: 'y1', full_name: 'Ana', group_name: null, situation: 'critical', reasons: ['3 faltas seguidas', 5] },
        { full_name: 'sem id' },
      ],
      attention_total: 12,
      open_alerts: { total: 4, critical: 1, attention: 3 },
      overdue_actions: 2,
      upcoming_follow_ups: [
        { follow_up_id: 'f1', youth_id: 'y1', youth_name: 'Ana', next_action: null, next_action_due: '2026-10-05', responsible_name: 'Lia' },
        { follow_up_id: 'f2', youth_name: 'sem prazo' },
      ],
      youth_without_group: 3,
      upcoming_events: [{ id: 'e1', title: 'Culto', event_date: '2026-10-10T22:00:00Z', groups: [{ id: 'g', name: 'G1' }] }],
      avg_attendance: 0,
      avg_attendance_records: 40,
      active_youth: 50,
    });
    expect(d.attention).toHaveLength(1);
    expect(d.attention[0]).toMatchObject({ youth_id: 'y1', situation: 'critical', reasons: ['3 faltas seguidas'] });
    expect(d.attention_total).toBe(12);
    expect(d.upcoming_follow_ups).toHaveLength(1);
    expect(d.upcoming_events[0].groups[0].name).toBe('G1');
    // 0% é um valor real, diferente de "sem dados" (null)
    expect(d.avg_attendance).toBe(0);
  });

  it('situação desconhecida nunca vira crítica', () => {
    const d = parseDashboard({ attention: [{ youth_id: 'y', full_name: 'A', situation: 'whatever' }] });
    expect(d.attention[0].situation).toBe('attention');
  });
});

describe('parseGroupIndicators', () => {
  it('indexa por grupo e zera delta sem tendência', () => {
    const m = parseGroupIndicators([
      { group_id: 'g1', name: 'A', leader_name: 'L', active_youth: 5, attendance_rate: 80, trend: 'down', trend_delta: -15, youth_in_attention: 2, overdue_actions: 1 },
      { group_id: 'g2', name: 'B', leader_name: null, active_youth: 0, attendance_rate: null, trend: null, trend_delta: 4, youth_in_attention: 0, overdue_actions: 0 },
      { name: 'sem id' },
    ]);
    expect(m.size).toBe(2);
    expect(m.get('g1')).toMatchObject({ trend: 'down', trend_delta: -15, attendance_rate: 80 });
    expect(m.get('g2')).toMatchObject({ trend: null, trend_delta: null, attendance_rate: null });
    expect(parseGroupIndicators(null).size).toBe(0);
  });
});

describe('trendDisplay', () => {
  it('textos e delta', () => {
    expect(trendDisplay('up', 12)).toEqual({ kind: 'up', label: 'em alta', delta: '+12 pp' });
    expect(trendDisplay('down', -10)).toEqual({ kind: 'down', label: 'em queda', delta: '-10 pp' });
    expect(trendDisplay('stable', 0)).toEqual({ kind: 'stable', label: 'estável', delta: '0 pp' });
    expect(trendDisplay(null, null)).toEqual({ kind: 'insufficient', label: 'dados insuficientes', delta: null });
  });
  it('texto único para exportação', () => {
    expect(trendText('down', -12)).toBe('em queda (-12 pp)');
    expect(trendText(null, null)).toBe('dados insuficientes');
  });
});
