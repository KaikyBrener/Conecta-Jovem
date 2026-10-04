// Formato (JSON) devolvido pelas RPCs do servidor: dashboard_overview, group_indicators e report_*
// (migrations 012 e 013). O cálculo é todo no banco; o frontend só apresenta e exporta.

export type SituationLevel = 'critical' | 'attention';
export type TrendKind = 'up' | 'down' | 'stable';

export interface ReportPeriodInfo {
  from: string;
  to: string;
  days: number;
  group_id: string | null;
}

// ── report_general ──────────────────────────────────────────────────────────
export interface GeneralReport {
  period: ReportPeriodInfo;
  active_youth: number;
  events: { held: number; cancelled: number };
  attendance: { present: number; absent: number; registered: number; rate: number | null };
  alerts: { open_now: number; created: number; resolved: number; dismissed: number };
  follow_ups: { total: number; youth_reached: number };
  actions: { open_now: number; overdue_now: number; created: number; completed: number };
}

// ── report_attendance ───────────────────────────────────────────────────────
export interface AttendanceByEvent {
  /** null quando o encontro é de outro grupo (líder): o servidor não expõe o id nem o título real */
  event_id: string | null;
  event_date: string;
  title: string;
  status: string;
  present: number;
  absent: number;
  registered: number;
  rate: number | null;
}

export interface AttendanceSeriesPoint {
  date: string;
  present: number;
  registered: number;
  rate: number;
}

export interface AttendanceByGroup {
  group_id: string | null;
  name: string;
  events: number;
  present: number;
  absent: number;
  registered: number;
  rate: number | null;
}

export interface AttendanceAbsenceItem {
  youth_id: string;
  full_name: string;
  group_name: string | null;
  absences: number;
  registered: number;
}

export interface AttendanceReport {
  period: ReportPeriodInfo;
  summary: {
    events: number;
    events_with_records: number;
    events_cancelled: number;
    present: number;
    absent: number;
    registered: number;
    rate: number | null;
  };
  by_event: AttendanceByEvent[];
  series: AttendanceSeriesPoint[];
  by_group: AttendanceByGroup[];
  youth_absences: { min_absences: number; total: number; limit: number; items: AttendanceAbsenceItem[] };
}

// ── report_followups ────────────────────────────────────────────────────────
export interface FollowUpsReport {
  period: ReportPeriodInfo;
  total: number;
  youth_reached: number;
  by_type: { type: string; count: number }[];
  by_responsible: { responsible_id: string | null; name: string | null; count: number }[];
  transfers: { count: number; follow_ups: number };
  next_actions: {
    pending: number;
    overdue: number;
    upcoming: number;
    limit: number;
    items: {
      follow_up_id: string;
      youth_id: string;
      youth_name: string;
      next_action: string | null;
      next_action_due: string;
      overdue: boolean;
      responsible_name: string | null;
    }[];
  };
}

// ── report_alerts ───────────────────────────────────────────────────────────
export interface AlertsBreakdownRow {
  created: number;
  resolved: number;
  dismissed: number;
  open_now: number;
}

export interface AlertsReport {
  period: ReportPeriodInfo;
  open_now: { total: number; critical: number; attention: number };
  created: { total: number; critical: number; attention: number };
  resolved: number;
  resolved_automatically: number;
  dismissed: number;
  avg_resolution_hours: number | null;
  by_type: (AlertsBreakdownRow & { type: string })[];
  by_severity: (AlertsBreakdownRow & { severity: string })[];
}

// ── report_youth ────────────────────────────────────────────────────────────
export interface YouthReport {
  period: ReportPeriodInfo;
  youth: {
    id: string;
    full_name: string;
    is_active: boolean;
    group_id: string | null;
    group_name: string | null;
    leader_name: string | null;
  };
  situation: {
    situation: 'normal' | 'attention' | 'critical';
    inactive: boolean;
    reasons: string[];
    consecutive_absences: number;
    attendance_rate: number | null;
    events_total: number;
    last_event: string | null;
    open_actions: number;
    overdue_actions: number;
    last_follow_up: string | null;
  };
  attendance: {
    present: number;
    absent: number;
    not_registered: number;
    registered: number;
    rate: number | null;
    events: { event_id: string | null; event_date: string; title: string; state: 'present' | 'absent' | 'not_registered' }[];
  };
  follow_ups: {
    total: number;
    limit: number;
    items: {
      id: string;
      occurred_at: string;
      type: string;
      reason: string | null;
      next_action: string | null;
      next_action_due: string | null;
      responsible_name: string | null;
    }[];
  };
  actions: {
    total: number;
    limit: number;
    items: {
      id: string;
      title: string;
      status: string;
      priority: string;
      due_date: string | null;
      overdue: boolean;
      completed_at: string | null;
    }[];
  };
  alerts: {
    total: number;
    limit: number;
    items: {
      id: string;
      type: string;
      severity: string;
      status: string;
      created_at: string;
      resolved_at: string | null;
      consecutive_absences: number | null;
      attendance_rate: number | null;
    }[];
  };
}

// ── report_groups / group_indicators ────────────────────────────────────────
export interface GroupIndicator {
  group_id: string;
  name: string;
  leader_name: string | null;
  active_youth: number;
  attendance_rate: number | null;
  trend: TrendKind | null;
  trend_delta: number | null;
  youth_in_attention: number;
  overdue_actions: number;
}

export interface GroupsReportRow extends GroupIndicator {
  period: {
    events_held: number;
    events_with_records: number;
    present: number;
    absent: number;
    registered: number;
    rate: number | null;
    follow_ups: number;
    alerts_created: number;
    actions_completed: number;
  };
}

export interface GroupsReport {
  period: ReportPeriodInfo;
  groups: GroupsReportRow[];
}

// ── dashboard_overview ──────────────────────────────────────────────────────
export interface DashboardAttentionItem {
  youth_id: string;
  full_name: string;
  group_name: string | null;
  situation: SituationLevel;
  reasons: string[];
}

export interface DashboardFollowUp {
  follow_up_id: string;
  youth_id: string;
  youth_name: string;
  next_action: string | null;
  next_action_due: string;
  responsible_name: string | null;
}

export interface DashboardEvent {
  id: string;
  title: string;
  event_date: string;
  groups: { id: string; name: string }[];
}

export interface DashboardOverview {
  attention: DashboardAttentionItem[];
  attention_total: number;
  open_alerts: { total: number; critical: number; attention: number };
  overdue_actions: number;
  upcoming_follow_ups: DashboardFollowUp[];
  youth_without_group: number;
  upcoming_events: DashboardEvent[];
  avg_attendance: number | null;
  avg_attendance_records: number;
  active_youth: number;
}
