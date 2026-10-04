import { describe, expect, it } from 'vitest';
import {
  attendanceMarkLabel,
  countAttendance,
  editedRowsToSave,
  filterBySearchAndGroup,
  filterByState,
  formatAttendanceRate,
  nextMark,
  unregisteredIds,
  type AttendanceRow,
} from './attendance';
import { alertTypeLabel } from './labels';

const row = (id: string, name: string, group: string, present: boolean | null, saved = false): AttendanceRow => ({
  youth_id: id,
  full_name: name,
  group_id: group,
  present,
  saved,
});

const rows = [
  row('1', 'Ana Souza', 'g1', true),
  row('2', 'João Lima', 'g1', false),
  row('3', 'José Álvaro', 'g2', null),
  row('4', 'Maria', 'g2', null),
];

describe('countAttendance', () => {
  it('conta estados e calcula percentual sobre registrados', () => {
    expect(countAttendance(rows)).toEqual({
      total: 4, present: 1, absent: 1, unregistered: 2, registered: 2, rate: 50,
    });
  });

  it('não registrado não conta como falta nem entra no percentual', () => {
    const c = countAttendance([row('1', 'A', 'g', true), row('2', 'B', 'g', null)]);
    expect(c.absent).toBe(0);
    expect(c.rate).toBe(100);
  });

  it('ninguém registrado: percentual nulo', () => {
    const c = countAttendance([row('1', 'A', 'g', null)]);
    expect(c.rate).toBeNull();
    expect(formatAttendanceRate(c.rate)).toBe('—');
  });

  it('lista vazia', () => {
    expect(countAttendance([])).toEqual({ total: 0, present: 0, absent: 0, unregistered: 0, registered: 0, rate: null });
  });

  it('arredonda como o banco (35 de 42 = 83%)', () => {
    const list = [
      ...Array.from({ length: 35 }, (_, i) => row(`p${i}`, 'x', 'g', true)),
      ...Array.from({ length: 7 }, (_, i) => row(`a${i}`, 'x', 'g', false)),
    ];
    expect(formatAttendanceRate(countAttendance(list).rate)).toBe('83%');
  });
});

describe('filtros', () => {
  it('busca ignora acento e caixa', () => {
    expect(filterBySearchAndGroup(rows, 'jose', 'all').map((r) => r.youth_id)).toEqual(['3']);
    expect(filterBySearchAndGroup(rows, 'JOÃO', 'all').map((r) => r.youth_id)).toEqual(['2']);
  });

  it('filtra por grupo e combina com a busca', () => {
    expect(filterBySearchAndGroup(rows, '', 'g2').map((r) => r.youth_id)).toEqual(['3', '4']);
    expect(filterBySearchAndGroup(rows, 'maria', 'g1')).toEqual([]);
  });

  it('filtra por estado', () => {
    expect(filterByState(rows, 'all')).toHaveLength(4);
    expect(filterByState(rows, 'unregistered').map((r) => r.youth_id)).toEqual(['3', '4']);
    expect(filterByState(rows, 'present').map((r) => r.youth_id)).toEqual(['1']);
    expect(filterByState(rows, 'absent').map((r) => r.youth_id)).toEqual(['2']);
  });
});

describe('nextMark', () => {
  it('marca a partir de não registrado ou do estado oposto', () => {
    expect(nextMark(null, true, false)).toBe(true);
    expect(nextMark(null, false, false)).toBe(false);
    expect(nextMark(true, false, false)).toBe(false);
    expect(nextMark(false, true, true)).toBe(true);
  });

  it('tocar no estado ativo limpa se não salvo', () => {
    expect(nextMark(true, true, false)).toBeNull();
    expect(nextMark(false, false, false)).toBeNull();
  });

  it('tocar no estado ativo de linha salva não faz nada', () => {
    expect(nextMark(true, true, true)).toBe(true);
    expect(nextMark(false, false, true)).toBe(false);
  });
});

describe('unregisteredIds', () => {
  it('só devolve quem está sem estado (nunca sobrescreve marcados)', () => {
    expect(unregisteredIds(rows)).toEqual(['3', '4']);
    expect(unregisteredIds(filterBySearchAndGroup(rows, 'maria', 'all'))).toEqual(['4']);
  });
});

describe('editedRowsToSave', () => {
  const loaded = {
    '1': row('1', 'Ana', 'g1', true, true),
    '2': row('2', 'João', 'g1', false, true),
    '3': row('3', 'José', 'g2', null),
    '4': row('4', 'Maria', 'g2', null),
  };

  it('sem edições não envia nada (linhas carregadas não são reenviadas)', () => {
    expect(editedRowsToSave(loaded, {})).toEqual([]);
  });

  it('envia só as linhas editadas, com o novo estado', () => {
    const out = editedRowsToSave(loaded, { '2': true, '3': false });
    expect(out.map((r) => [r.youth_id, r.present])).toEqual([['2', true], ['3', false]]);
  });

  it('ignora edição igual ao carregado e limpeza (null)', () => {
    expect(editedRowsToSave(loaded, { '1': true, '4': null, '3': null })).toEqual([]);
  });

  it('ignora ids que não estão na lista carregada', () => {
    expect(editedRowsToSave(loaded, { x: true })).toEqual([]);
  });
});

describe('rótulos', () => {
  it('estado', () => {
    expect(attendanceMarkLabel(null)).toBe('Não registrado');
    expect(attendanceMarkLabel(true)).toBe('Presente');
    expect(attendanceMarkLabel(false)).toBe('Ausente');
  });

  it('tipo de alerta', () => {
    expect(alertTypeLabel('consecutive_absences', 3)).toBe('3 faltas seguidas');
    expect(alertTypeLabel('consecutive_absences', 1)).toBe('1 falta seguida');
    expect(alertTypeLabel('low_attendance')).toBe('Frequência baixa');
    expect(alertTypeLabel('attendance_drop')).toBe('Frequência em queda');
  });
});
