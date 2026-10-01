// Agregações puras de frequência usadas no Dashboard e em Relatórios.
// Recebem dados já filtrados pelo RLS e pelo período.

export interface AttendanceRecord {
  event_id: string;
  youth_id: string;
  group_id: string;
  present: boolean;
}

export interface ReportEvent {
  id: string;
  title: string;
  event_date: string;
  status: string;
}

export interface Named {
  id: string;
  name: string;
}

export interface YouthRef {
  id: string;
  full_name: string;
  group_id: string | null;
  is_active: boolean;
}

export interface EventSummary {
  event_id: string;
  title: string;
  event_date: string;
  present: number;
  total: number;
  rate: number | null;
}

export interface GroupSummary {
  group_id: string;
  name: string;
  events: number;
  present: number;
  total: number;
  rate: number | null;
}

export interface YouthSummary {
  youth_id: string;
  name: string;
  group_name: string;
  is_active: boolean;
  present: number;
  absent: number;
  total: number;
  rate: number | null;
}

/** Percentual 0–100, ou null quando não há registros */
export function rate(present: number, total: number): number | null {
  return total === 0 ? null : (present / total) * 100;
}

/** Remove registros de encontros cancelados ou fora da lista de encontros */
export function validRecords(records: AttendanceRecord[], events: ReportEvent[]): AttendanceRecord[] {
  const ok = new Set(events.filter((e) => e.status !== 'cancelled').map((e) => e.id));
  return records.filter((r) => ok.has(r.event_id));
}

export function overallRate(records: AttendanceRecord[]): number | null {
  return rate(records.filter((r) => r.present).length, records.length);
}

export function summarizeByEvent(records: AttendanceRecord[], events: ReportEvent[]): EventSummary[] {
  const acc = new Map<string, { present: number; total: number }>();
  for (const r of records) {
    const s = acc.get(r.event_id) ?? { present: 0, total: 0 };
    s.total += 1;
    if (r.present) s.present += 1;
    acc.set(r.event_id, s);
  }
  return events
    .filter((e) => e.status !== 'cancelled' && acc.has(e.id))
    .map((e) => {
      const s = acc.get(e.id)!;
      return { event_id: e.id, title: e.title, event_date: e.event_date, ...s, rate: rate(s.present, s.total) };
    })
    .sort((a, b) => b.event_date.localeCompare(a.event_date));
}

export function summarizeByGroup(records: AttendanceRecord[], groups: Named[]): GroupSummary[] {
  const acc = new Map<string, { events: Set<string>; present: number; total: number }>();
  for (const r of records) {
    const s = acc.get(r.group_id) ?? { events: new Set<string>(), present: 0, total: 0 };
    s.events.add(r.event_id);
    s.total += 1;
    if (r.present) s.present += 1;
    acc.set(r.group_id, s);
  }
  const names = new Map(groups.map((g) => [g.id, g.name]));
  return [...acc.entries()]
    .map(([group_id, s]) => ({
      group_id,
      name: names.get(group_id) ?? '—',
      events: s.events.size,
      present: s.present,
      total: s.total,
      rate: rate(s.present, s.total),
    }))
    .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
}

/** Frequência por jovem, ordenada da menor para a maior */
export function summarizeByYouth(records: AttendanceRecord[], youth: YouthRef[], groups: Named[]): YouthSummary[] {
  const acc = new Map<string, { present: number; total: number }>();
  for (const r of records) {
    const s = acc.get(r.youth_id) ?? { present: 0, total: 0 };
    s.total += 1;
    if (r.present) s.present += 1;
    acc.set(r.youth_id, s);
  }
  const groupNames = new Map(groups.map((g) => [g.id, g.name]));
  return youth
    .filter((y) => acc.has(y.id))
    .map((y) => {
      const s = acc.get(y.id)!;
      return {
        youth_id: y.id,
        name: y.full_name,
        group_name: (y.group_id && groupNames.get(y.group_id)) || 'Sem grupo',
        is_active: y.is_active,
        present: s.present,
        absent: s.total - s.present,
        total: s.total,
        rate: rate(s.present, s.total),
      };
    })
    .sort((a, b) => (a.rate ?? 0) - (b.rate ?? 0) || a.name.localeCompare(b.name, 'pt-BR'));
}

/** Jovens com frequência abaixo do limite (%) */
export function belowThreshold(summaries: YouthSummary[], threshold: number): YouthSummary[] {
  return summaries.filter((s) => s.rate !== null && s.rate < threshold);
}
