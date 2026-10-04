import { describe, expect, it } from 'vitest';
import {
  buildAlertsDoc,
  buildAttendanceDoc,
  buildFollowUpsDoc,
  buildGeneralDoc,
  buildGroupsDoc,
  buildYouthDoc,
  docToCsv,
  eventRowKey,
  toPdfText,
} from './reportExport';
import type {
  AlertsReport,
  AttendanceReport,
  FollowUpsReport,
  GeneralReport,
  GroupsReport,
  YouthReport,
} from './reportTypes';

const period = { from: '2026-09-04', to: '2026-10-03', days: 30, group_id: null };
const ctx = { groupName: null };

const general: GeneralReport = {
  period,
  active_youth: 42,
  events: { held: 4, cancelled: 1 },
  attendance: { present: 60, absent: 20, registered: 80, rate: 75 },
  alerts: { open_now: 5, created: 3, resolved: 2, dismissed: 1 },
  follow_ups: { total: 9, youth_reached: 7 },
  actions: { open_now: 6, overdue_now: 2, created: 4, completed: 3 },
};

const attendance: AttendanceReport = {
  period,
  summary: { events: 5, events_with_records: 4, events_cancelled: 1, present: 60, absent: 20, registered: 80, rate: 75 },
  by_event: [
    { event_id: 'e1', event_date: '2026-10-03T22:30:00Z', title: 'Culto de jovens', status: 'completed', present: 15, absent: 5, registered: 20, rate: 75 },
    { event_id: 'e2', event_date: '2026-10-10T22:30:00Z', title: 'Encontro futuro', status: 'scheduled', present: 0, absent: 0, registered: 0, rate: null },
  ],
  series: [{ date: '2026-10-03', present: 15, registered: 20, rate: 75 }],
  by_group: [{ group_id: 'g1', name: 'Grupo Ação', events: 4, present: 60, absent: 20, registered: 80, rate: 75 }],
  youth_absences: {
    min_absences: 3,
    total: 51,
    limit: 50,
    items: [{ youth_id: 'y1', full_name: '=CMD|calc', group_name: null, absences: 4, registered: 5 }],
  },
};

describe('docs de exportação', () => {
  it('geral: cabeçalho, resumo e tabelas com referência (período x agora)', () => {
    const doc = buildGeneralDoc(general, ctx);
    expect(doc.title).toBe('Relatório geral');
    expect(doc.filenameBase).toBe('relatorio-geral_2026-09-04_a_2026-10-03');
    expect(doc.meta).toEqual([
      { label: 'Período', value: '04/09/2026 a 03/10/2026' },
      { label: 'Grupo', value: 'Todos os grupos' },
    ]);
    expect(doc.summary.find((s) => s.label === 'Frequência no período')?.value).toBe('75%');
    expect(doc.tables[1].rows).toContainEqual(['Abertos', '5', 'Situação atual']);
  });

  it('grupo filtrado e rótulo de líder', () => {
    expect(buildGeneralDoc(general, { groupName: 'Grupo A' }).meta[1].value).toBe('Grupo A');
    expect(buildGeneralDoc(general, { groupName: null, allGroupsLabel: 'Todos os seus grupos' }).meta[1].value).toBe(
      'Todos os seus grupos',
    );
  });

  it('período de um dia mostra uma data só', () => {
    const doc = buildGeneralDoc({ ...general, period: { ...period, from: '2026-10-03', to: '2026-10-03', days: 1 } }, ctx);
    expect(doc.meta[0].value).toBe('03/10/2026');
  });

  it('frequência: data no fuso de São Paulo, sem dado = traço, lista cortada gera observação', () => {
    const doc = buildAttendanceDoc(attendance, ctx);
    expect(doc.tables[0].rows[0][0]).toBe('03/10/2026 19:30');
    expect(doc.tables[0].rows[1].slice(-1)[0]).toBe('—');
    expect(doc.tables[0].rows[1][2]).toBe('Agendado');
    expect(doc.tables[2].note).toContain('Mostrando 1 de 51');
    expect(doc.tables[2].rows[0][1]).toBe('Sem grupo');
  });

  it('acompanhamento e alertas', () => {
    const fu: FollowUpsReport = {
      period,
      total: 3,
      youth_reached: 2,
      by_type: [{ type: 'call', count: 2 }, { type: 'return', count: 1 }],
      by_responsible: [{ responsible_id: null, name: null, count: 3 }],
      transfers: { count: 1, follow_ups: 1 },
      next_actions: {
        pending: 1, overdue: 1, upcoming: 0, limit: 50,
        items: [{ follow_up_id: 'f', youth_id: 'y', youth_name: 'Ana', next_action: null, next_action_due: '2026-10-01', overdue: true, responsible_name: 'Lia' }],
      },
    };
    const d1 = buildFollowUpsDoc(fu, ctx);
    expect(d1.tables[0].rows[0]).toEqual(['Ligação', '2']);
    expect(d1.tables[1].rows[0][0]).toBe('Sem responsável');
    expect(d1.tables[3].rows[0]).toEqual(['01/10/2026', 'Ana', '—', 'Lia', 'Vencida']);

    const al: AlertsReport = {
      period,
      open_now: { total: 3, critical: 1, attention: 2 },
      created: { total: 4, critical: 1, attention: 3 },
      resolved: 2, resolved_automatically: 1, dismissed: 1, avg_resolution_hours: 26.5,
      by_type: [{ type: 'consecutive_absences', created: 4, resolved: 2, dismissed: 1, open_now: 3 }],
      by_severity: [{ severity: 'critical', created: 1, resolved: 0, dismissed: 0, open_now: 1 }],
    };
    const d2 = buildAlertsDoc(al, ctx);
    expect(d2.tables[0].rows[0][0]).toBe('Faltas seguidas');
    expect(d2.tables[1].rows[0][0]).toBe('Crítico');
    expect(d2.summary.find((s) => s.label === 'Tempo médio até resolver')?.value).toBe('26,5 h');
  });

  it('grupos: tendência em texto e sem ranking (ordem do servidor)', () => {
    const gr: GroupsReport = {
      period,
      groups: [
        {
          group_id: 'g1', name: 'A', leader_name: null, active_youth: 5, attendance_rate: 80, trend: 'down', trend_delta: -15,
          youth_in_attention: 1, overdue_actions: 0,
          period: { events_held: 2, events_with_records: 2, present: 8, absent: 2, registered: 10, rate: 80, follow_ups: 1, alerts_created: 0, actions_completed: 1 },
        },
        {
          group_id: 'g2', name: 'B', leader_name: 'Lia', active_youth: 0, attendance_rate: null, trend: null, trend_delta: null,
          youth_in_attention: 0, overdue_actions: 0,
          period: { events_held: 0, events_with_records: 0, present: 0, absent: 0, registered: 0, rate: null, follow_ups: 0, alerts_created: 0, actions_completed: 0 },
        },
      ],
    };
    const doc = buildGroupsDoc(gr, ctx);
    expect(doc.tables[0].rows.map((r) => r[0])).toEqual(['A', 'B']);
    expect(doc.tables[0].rows[0][4]).toBe('em queda (-15 pp)');
    expect(doc.tables[0].rows[1][4]).toBe('dados insuficientes');
    expect(doc.tables[0].rows[1][3]).toBe('—');
  });

  it('individual: só o que veio do servidor; arquivo sem nome do jovem; aviso de confidencialidade', () => {
    const y: YouthReport = {
      period,
      youth: { id: 'y1', full_name: 'Maria Souza', is_active: true, group_id: 'g', group_name: 'Grupo A', leader_name: 'Lia' },
      situation: {
        situation: 'attention', inactive: false, reasons: ['2 faltas seguidas'], consecutive_absences: 2, attendance_rate: 60,
        events_total: 5, last_event: null, open_actions: 1, overdue_actions: 1, last_follow_up: '2026-09-20',
      },
      attendance: {
        present: 3, absent: 2, not_registered: 1, registered: 5, rate: 60,
        events: [{ event_id: 'e', event_date: '2026-10-03T22:30:00Z', title: 'Culto', state: 'not_registered' }],
      },
      follow_ups: { total: 1, limit: 100, items: [{ id: 'f', occurred_at: '2026-09-20', type: 'conversation', reason: 'Faltas', next_action: null, next_action_due: null, responsible_name: null }] },
      actions: { total: 1, limit: 100, items: [{ id: 't', title: 'Ligar', status: 'pending', priority: 'high', due_date: '2026-09-30', overdue: true, completed_at: null }] },
      alerts: { total: 0, limit: 100, items: [] },
    };
    const doc = buildYouthDoc(y);
    expect(doc.filenameBase).not.toMatch(/maria|souza/i);
    expect(doc.meta[0]).toEqual({ label: 'Jovem', value: 'Maria Souza' });
    expect(doc.tables[1].rows[0][2]).toBe('Não registrado');
    expect(doc.tables[1].note).toContain('1 encontro(s) sem chamada');
    expect(doc.tables[3].rows[0][1]).toBe('Pendente (atrasada)');
    expect(doc.tables[4].rows).toEqual([]);
    expect(doc.notes.join(' ')).toContain('menor');
  });
});

describe('encontro de outro grupo (event_id nulo)', () => {
  it('chave de linha usa posição e data quando não há id', () => {
    expect(eventRowKey({ event_id: 'e1', event_date: '2026-10-03T22:30:00Z' }, 0)).toBe('e1');
    const a = eventRowKey({ event_id: null, event_date: '2026-10-03T22:30:00Z' }, 0);
    const b = eventRowKey({ event_id: null, event_date: '2026-10-03T22:30:00Z' }, 1);
    expect(a).not.toBe(b);
    expect(a).toContain('2026-10-03');
  });

  it('frequência por encontro exporta a linha sem id', () => {
    const doc = buildAttendanceDoc({
      ...attendance,
      by_event: [{ event_id: null, event_date: '2026-10-03T22:30:00Z', title: 'Encontro de outro grupo', status: 'completed', present: 0, absent: 0, registered: 0, rate: null }],
    }, ctx);
    expect(doc.tables[0].rows[0]).toContain('Encontro de outro grupo');
    expect(docToCsv(doc, new Date('2026-10-03T13:05:00Z'))).toContain('Encontro de outro grupo');
  });

  it('individual exporta a presença em encontro sem id', () => {
    const report: YouthReport = {
      period,
      youth: { id: 'y1', full_name: 'Maria', is_active: true, group_id: 'g', group_name: 'Grupo A', leader_name: null },
      situation: {
        situation: 'normal', inactive: false, reasons: [], consecutive_absences: 0, attendance_rate: 100,
        events_total: 1, last_event: null, open_actions: 0, overdue_actions: 0, last_follow_up: null,
      },
      attendance: {
        present: 1, absent: 0, not_registered: 0, registered: 1, rate: 100,
        events: [{ event_id: null, event_date: '2026-10-03T22:30:00Z', title: 'Encontro de outro grupo', state: 'present' }],
      },
      follow_ups: { total: 0, limit: 100, items: [] },
      actions: { total: 0, limit: 100, items: [] },
      alerts: { total: 0, limit: 100, items: [] },
    };
    const doc = buildYouthDoc(report);
    expect(doc.tables[1].rows[0][1]).toBe('Encontro de outro grupo');
  });
});

describe('docToCsv', () => {
  const at = new Date('2026-10-03T13:05:00Z'); // 10:05 em São Paulo

  it('tem cabeçalho, carimbo, resumo, tabelas e neutraliza fórmulas', () => {
    const csv = docToCsv(buildAttendanceDoc(attendance, { groupName: 'Grupo Ação' }), at);
    const lines = csv.split('\r\n');
    expect(lines[0]).toBe('Conecta Jovem;Relatório de frequência');
    expect(lines).toContain('Período;04/09/2026 a 03/10/2026');
    expect(lines).toContain('Grupo;Grupo Ação');
    expect(lines).toContain('Gerado em;03/10/2026 10:05');
    expect(lines).toContain('Frequência;75%');
    expect(lines).toContain('Jovem;Grupo;Faltas;Registros');
    // célula que começaria com "=" vira texto (apóstrofo)
    expect(csv).toContain("'=CMD|calc;Sem grupo;4;5");
    expect(csv).not.toMatch(/(^|;)=CMD/m);
    // observação de lista cortada
    expect(csv).toContain('Mostrando 1 de 51 jovens');
  });

  it('tabela vazia mostra o texto de vazio', () => {
    const csv = docToCsv(buildAttendanceDoc({ ...attendance, by_group: [] }, ctx), at);
    expect(csv).toContain('Nenhum registro de chamada por grupo no período.');
  });
});

describe('toPdfText', () => {
  it('preserva todos os acentos do português', () => {
    const s = 'ÁÀÂÃÄ áàâãä ÉÊ éê Í í ÓÔÕ óôõ Ú ú Ç ç ü ñ º ª';
    expect(toPdfText(s)).toBe(s);
  });
  it('troca o que a fonte não desenha, sem lançar erro', () => {
    expect(toPdfText('“Olá” — ação…')).toBe('“Olá” — ação…');
    expect(toPdfText('a → b − c')).toBe('a -> b - c');
    expect(toPdfText('Kőrösi')).toBe('Korösi'); // acento fora do Latin-1 -> letra base
    expect(toPdfText('Łukasz')).toBe('?ukasz'); // sem decomposição possível
    expect(toPdfText('Paz 🙏')).toBe('Paz ?');
    expect(toPdfText('a\u0000b')).toBe('ab');
  });
});
