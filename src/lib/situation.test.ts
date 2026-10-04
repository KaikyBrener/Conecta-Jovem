import { describe, expect, it } from 'vitest';
import { indexSituations, parseSituation, situationCriteriaText, situationDisplay, toSituationLevel } from './situation';

const raw = {
  youth_id: 'y1',
  full_name: 'Ana Souza',
  inactive: false,
  group_id: 'g1',
  group_name: 'Grupo Alfa',
  leader_name: 'Carla',
  attendance_rate: 40,
  consecutive_absences: 3,
  events_total: 8,
  last_event: '2026-09-20T22:00:00+00:00',
  open_actions: 2,
  overdue_actions: 1,
  last_follow_up: '2026-09-25',
  situation: 'attention',
  reasons: ['3 faltas seguidas', '1 ação atrasada'],
};

describe('situationDisplay', () => {
  it('traduz cada nível em rótulo e tom', () => {
    expect(situationDisplay({ situation: 'normal', inactive: false })).toMatchObject({ label: 'Normal', tone: 'green' });
    expect(situationDisplay({ situation: 'attention', inactive: false })).toMatchObject({ label: 'Atenção', tone: 'amber' });
    expect(situationDisplay({ situation: 'critical', inactive: false })).toMatchObject({ label: 'Crítico', tone: 'red' });
  });

  it('jovem inativo não aparece como "Normal"', () => {
    const d = situationDisplay({ situation: 'normal', inactive: true });
    expect(d.label).toBe('Inativo');
    expect(d.tone).toBe('gray');
  });

  it('nível desconhecido vira normal (nunca crítico por engano)', () => {
    expect(toSituationLevel('urgent')).toBe('normal');
    expect(toSituationLevel(undefined)).toBe('normal');
    expect(toSituationLevel('critical')).toBe('critical');
  });
});

describe('parseSituation', () => {
  it('normaliza uma linha da RPC', () => {
    const s = parseSituation(raw)!;
    expect(s.situation).toBe('attention');
    expect(s.attendance_rate).toBe(40);
    expect(s.reasons).toEqual(['3 faltas seguidas', '1 ação atrasada']);
    expect(s.last_follow_up).toBe('2026-09-25');
  });

  it('aceita números como texto, nulos e reasons ausente', () => {
    const s = parseSituation({ youth_id: 'y2', attendance_rate: null, consecutive_absences: '2', reasons: null, situation: 'critical' })!;
    expect(s.attendance_rate).toBeNull();
    expect(s.consecutive_absences).toBe(2);
    expect(s.reasons).toEqual([]);
    expect(s.group_name).toBeNull();
    expect(s.open_actions).toBe(0);
  });

  it('rejeita linhas sem youth_id', () => {
    expect(parseSituation(null)).toBeNull();
    expect(parseSituation({ full_name: 'x' })).toBeNull();
  });
});

describe('indexSituations', () => {
  it('indexa por jovem e ignora lixo', () => {
    const m = indexSituations([raw, { nada: 1 }, { ...raw, youth_id: 'y3', situation: 'critical' }]);
    expect([...m.keys()]).toEqual(['y1', 'y3']);
    expect(m.get('y3')!.situation).toBe('critical');
    expect(indexSituations(null).size).toBe(0);
  });
});

describe('situationCriteriaText', () => {
  it('cita os limites e deixa claro que não é diagnóstico', () => {
    const t = situationCriteriaText({ attention: 3, critical: 6 });
    expect(t).toContain('Crítico = 6 ou mais faltas seguidas');
    expect(t).toContain('3 ou mais faltas seguidas');
    expect(t).toContain('não um diagnóstico');
  });

  it('crítico nunca fica abaixo do limite de atenção', () => {
    expect(situationCriteriaText({ attention: 8, critical: 5 })).toContain('Crítico = 8 ou mais faltas seguidas');
  });

  it('funciona sem limites', () => {
    const t = situationCriteriaText();
    expect(t).toContain('Critério:');
    expect(t).not.toMatch(/\d ou mais/);
  });
});
