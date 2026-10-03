// Lógica pura da chamada com 3 estados.
// present: true = presente, false = ausente, null = não registrado (sem linha no banco; NÃO é falta).

export type AttendanceMark = boolean | null;
export type AttendanceFilter = 'all' | 'unregistered' | 'present' | 'absent';

export interface AttendanceRow {
  youth_id: string;
  group_id: string;
  full_name: string;
  present: AttendanceMark;
  /** Já existe linha no banco (o banco ignora null, então não dá para "desregistrar") */
  saved: boolean;
}

export interface AttendanceCounts {
  total: number;
  present: number;
  absent: number;
  unregistered: number;
  registered: number;
  /** Presentes / registrados, 0-100 (arredondado); null se ninguém foi registrado */
  rate: number | null;
}

export function countAttendance(rows: readonly Pick<AttendanceRow, 'present'>[]): AttendanceCounts {
  let present = 0;
  let absent = 0;
  for (const r of rows) {
    if (r.present === true) present++;
    else if (r.present === false) absent++;
  }
  const registered = present + absent;
  return {
    total: rows.length,
    present,
    absent,
    unregistered: rows.length - registered,
    registered,
    rate: registered === 0 ? null : Math.round((100 * present) / registered),
  };
}

export function formatAttendanceRate(rate: number | null): string {
  return rate === null ? '—' : `${rate}%`;
}

function normalize(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

export function matchesAttendanceFilter(present: AttendanceMark, filter: AttendanceFilter): boolean {
  switch (filter) {
    case 'all': return true;
    case 'unregistered': return present === null;
    case 'present': return present === true;
    case 'absent': return present === false;
  }
}

/** Filtra por nome (sem acento/caixa) e grupo ('all' = todos). O filtro de estado é aplicado à parte. */
export function filterBySearchAndGroup<T extends Pick<AttendanceRow, 'full_name' | 'group_id'>>(
  rows: readonly T[],
  search: string,
  groupId: string,
): T[] {
  const q = normalize(search);
  return rows.filter(
    (r) => (groupId === 'all' || r.group_id === groupId) && (q === '' || normalize(r.full_name).includes(q)),
  );
}

export function filterByState<T extends Pick<AttendanceRow, 'present'>>(
  rows: readonly T[],
  filter: AttendanceFilter,
): T[] {
  return rows.filter((r) => matchesAttendanceFilter(r.present, filter));
}

/**
 * Próximo estado ao tocar em "Presente" (target = true) ou "Ausente" (target = false).
 * - estado diferente do tocado: passa para o tocado;
 * - tocar no estado ativo: linha não salva volta a "não registrado"; linha salva não muda
 *   (o banco ignora null, então não há como desfazer um registro já gravado).
 */
export function nextMark(current: AttendanceMark, target: boolean, saved: boolean): AttendanceMark {
  if (current !== target) return target;
  return saved ? current : null;
}

/** Ids dos jovens SEM estado entre as linhas dadas (nunca inclui quem já está marcado). */
export function unregisteredIds(rows: readonly Pick<AttendanceRow, 'youth_id' | 'present'>[]): string[] {
  return rows.filter((r) => r.present === null).map((r) => r.youth_id);
}

export function attendanceMarkLabel(present: AttendanceMark): string {
  if (present === true) return 'Presente';
  if (present === false) return 'Ausente';
  return 'Não registrado';
}
