export type Role = 'coordinator' | 'leader';

export interface Profile {
  id: string;
  full_name: string;
  created_at: string;
}

export interface UserRole {
  user_id: string;
  role: Role;
}

export type Gender = 'male' | 'female' | 'other';

export interface Group {
  id: string;
  name: string;
  leader_id: string;
  leader_name?: string;
  description: string | null;
  created_at: string;
  updated_at: string;
}

export type GroupInsert = Omit<Group, 'id' | 'created_at' | 'updated_at' | 'leader_name'>;
export type GroupUpdate = Partial<Omit<Group, 'id' | 'created_at' | 'updated_at' | 'leader_name'>>;

/** Referência mínima de grupo (id + nome), usada em seletores e filtros */
export interface GroupRef {
  id: string;
  name: string;
}

export interface Youth {
  id: string;
  full_name: string;
  birth_date: string | null;
  gender: Gender | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  notes: string | null;
  is_active: boolean;
  group_id: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export type YouthInsert = Omit<Youth, 'id' | 'created_at' | 'updated_at'>;
export type YouthUpdate = Partial<Omit<Youth, 'id' | 'created_at' | 'updated_at' | 'created_by'>>;

// ── Encontros ────────────────────────────────────────────────────────────────

export type EventStatus = 'scheduled' | 'completed' | 'cancelled';

export interface Event {
  id: string;
  title: string;
  description: string | null;
  event_date: string;       // ISO datetime
  status: EventStatus;
  created_by: string;       // FK → auth.users.id
  created_at: string;
  updated_at: string;
  /** Série de origem (migration 014); ausente/null = encontro avulso */
  series_id?: string | null;
  series_date?: string | null;
  series_customized?: boolean;
}

export type EventInsert = Omit<Event, 'id' | 'created_at' | 'updated_at' | 'series_id' | 'series_date' | 'series_customized'>;
export type EventUpdate = Partial<Omit<Event, 'id' | 'created_at' | 'updated_at' | 'created_by' | 'series_id' | 'series_date' | 'series_customized'>>;

/** Série de encontros recorrentes (migration 014). weekday: 0 = domingo; start_time "HH:MM:SS" local. */
export interface EventSeries {
  id: string;
  name: string;
  weekday: number;
  start_time: string;
  recurrence: 'weekly' | 'biweekly' | 'monthly_nth_weekday';
  start_date: string;       // YYYY-MM-DD
  end_date: string;         // YYYY-MM-DD
  default_description: string | null;
  created_by: string | null;
  created_at: string;
  active: boolean;
}

// ── Histórico operacional (migration 014) ─────────────────────────────────────

export type ActivityAction =
  | 'attendance_recorded'
  | 'follow_up_created'
  | 'follow_up_transferred'
  | 'task_created'
  | 'task_completed'
  | 'alert_resolved'
  | 'alert_dismissed'
  | 'youth_group_changed'
  | 'youth_activated'
  | 'youth_deactivated'
  | 'event_series_created'
  | 'communication_sent';

/** Linha da listagem do histórico. `summary` é sempre texto fixo montado pelo banco (sem dado sensível). */
export interface ActivityEntry {
  id: string;
  occurred_at: string;
  actor_name: string | null;
  action: ActivityAction;
  entity_type: string;
  entity_id: string | null;
  youth_id: string | null;
  group_id: string | null;
  summary: string;
  /** Embed youth:youth_id(full_name); null se a entrada não é de um jovem */
  youth?: { full_name: string } | null;
}

/** Tabela de junção: quais grupos participam de cada encontro */
export interface EventGroup {
  event_id: string;
  group_id: string;
}

// ── Chamada/Presença ──────────────────────────────────────────────────────────

export interface Attendance {
  id: string;
  event_id: string;         // FK → events.id
  youth_id: string;         // FK → youth.id
  group_id: string;         // FK → groups.id (desnormalizado para RLS)
  present: boolean;
  notes: string | null;
  recorded_by: string;      // FK → auth.users.id
  created_at: string;
}

// ── Configurações ─────────────────────────────────────────────────────────────

export interface AppSettings {
  id: boolean;
  absence_alert_threshold: number;
  low_attendance_threshold: number;
  /** Faltas consecutivas a partir das quais o alerta é crítico (migration 010) */
  critical_absence_threshold: number;
  /** Dias de tolerância até o alerta "sem acompanhamento" (migration 011) */
  followup_grace_days: number;
  updated_by: string | null;
  updated_at: string;
}

export type AppSettingsUpdate = Partial<Pick<AppSettings, 'absence_alert_threshold' | 'low_attendance_threshold'>>;

// ── Alertas ──────────────────────────────────────────────────────────────────

export type AlertType =
  | 'consecutive_absences'
  | 'low_attendance'
  | 'attendance_drop'
  | 'no_followup'
  | 'overdue_action';
export type AlertSeverity = 'attention' | 'critical';
export type AlertStatus = 'open' | 'resolved' | 'dismissed';

export interface Alert {
  id: string;
  youth_id: string;
  group_id: string | null;
  type: AlertType;
  severity: AlertSeverity;
  status: AlertStatus;
  consecutive_absences: number;
  attendance_rate: number | null;
  previous_rate: number | null;
  sample_size: number | null;
  episode_ended: boolean;
  last_event_id: string | null;
  resolution_notes: string | null;
  resolved_by: string | null;
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
}

// ── Tarefas / Ações ───────────────────────────────────────────────────────────

export type TaskStatus = 'pending' | 'in_progress' | 'done' | 'cancelled';
export type TaskPriority = 'low' | 'medium' | 'high';

export interface Task {
  id: string;
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  due_date: string | null;  // YYYY-MM-DD
  youth_id: string | null;
  group_id: string | null;
  alert_id: string | null;
  assigned_to: string | null; // FK → profiles.id
  created_by: string | null;
  completed_at: string | null;
  /** Acompanhamento que concluiu esta ação (migration 011) */
  completed_by_follow_up_id: string | null;
  created_at: string;
  updated_at: string;
}

export type TaskInsert = Omit<Task, 'id' | 'created_at' | 'updated_at' | 'completed_at' | 'completed_by_follow_up_id'>;
export type TaskUpdate = Partial<
  Omit<Task, 'id' | 'created_at' | 'updated_at' | 'completed_at' | 'created_by' | 'completed_by_follow_up_id'>
>;

// ── Acompanhamento (migration 011) ────────────────────────────────────────────

export type FollowUpType = 'conversation' | 'call' | 'in_person' | 'guidance' | 'return' | 'other';

export interface FollowUp {
  id: string;
  youth_id: string;
  group_id: string | null;
  alert_id: string | null;
  task_id: string | null;
  occurred_at: string;        // YYYY-MM-DD
  type: FollowUpType;
  reason: string;
  notes: string | null;
  next_action: string | null;
  next_action_due: string | null; // YYYY-MM-DD
  completes_task: boolean;
  /** Responsável ATUAL; só muda pela RPC transfer_follow_up */
  responsible_id: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export type FollowUpInsert = Pick<FollowUp, 'youth_id' | 'reason'> &
  Partial<Pick<FollowUp, 'alert_id' | 'task_id' | 'occurred_at' | 'type' | 'notes' | 'next_action' | 'next_action_due' | 'completes_task' | 'responsible_id'>>;
export type FollowUpUpdate = Partial<
  Pick<FollowUp, 'alert_id' | 'task_id' | 'occurred_at' | 'type' | 'reason' | 'notes' | 'next_action' | 'next_action_due' | 'completes_task'>
>;

/** Histórico imutável de trocas de responsável (gravado só por transfer_follow_up) */
export interface FollowUpTransfer {
  id: string;
  follow_up_id: string;
  from_responsible_id: string | null;
  to_responsible_id: string | null;
  reason: string;
  transferred_by: string | null;
  transferred_at: string;
}

// ── Comunicações por e-mail (migration 015) ───────────────────────────────────

export type CommunicationStatus = 'draft' | 'sending' | 'sent' | 'failed' | 'cancelled';
export type RecipientKind = 'youth' | 'guardian' | 'leader' | 'coordinator' | 'other';
export type FailureReason =
  | 'provider_not_configured'
  | 'provider_rejected'
  | 'invalid_address'
  | 'network'
  | 'timeout'
  | 'unknown';

/**
 * Comunicação por e-mail. O envio é feito pelo servidor (Edge Function `send-communication`) a pedido do usuário; o
 * cliente nunca define `sending`/`sent`. `youth_id`/`alert_id`/`follow_up_id` ficam nulos se o item original for
 * excluído. `provider`/`provider_message_id` são metadados internos do servidor (não exibir na tela).
 */
export interface Communication {
  id: string;
  channel: 'email';
  youth_id: string | null;
  alert_id: string | null;
  follow_up_id: string | null;
  recipient_email: string;
  recipient_name: string | null;
  recipient_kind: RecipientKind;
  subject: string;
  body: string;
  status: CommunicationStatus;
  failure_reason: FailureReason | null;
  created_by: string | null;
  created_at: string;
  sent_at: string | null;
  sent_by: string | null;
  updated_at: string;
  provider: string | null;
  provider_message_id: string | null;
  /** Quantas vezes o servidor tentou enviar */
  attempts: number;
  last_attempt_at: string | null;
}

// ── Situação do jovem (RPC youth_situation / youth_situations) ────────────────

export type YouthSituationLevel = 'normal' | 'attention' | 'critical';

export interface YouthSituation {
  youth_id: string;
  full_name: string;
  /** true = jovem inativo (a situação "normal" não é um diagnóstico) */
  inactive: boolean;
  group_id: string | null;
  group_name: string | null;
  leader_name: string | null;
  /** % de presença nos 8 registros mais recentes; null se não há registros */
  attendance_rate: number | null;
  consecutive_absences: number;
  events_total: number;
  last_event: string | null;
  open_actions: number;
  overdue_actions: number;
  last_follow_up: string | null;
  situation: YouthSituationLevel;
  reasons: string[];
}

// ── Database type map ─────────────────────────────────────────────────────────

export type Database = {
  public: {
    Tables: {
      profiles: {
        Row: Profile;
        Insert: Omit<Profile, 'created_at'>;
        Update: Partial<Omit<Profile, 'id' | 'created_at'>>;
      };
      user_roles: {
        Row: UserRole;
        Insert: UserRole;
        Update: Partial<UserRole>;
      };
      groups: {
        Row: Group;
        Insert: GroupInsert;
        Update: GroupUpdate;
      };
      youth: {
        Row: Youth;
        Insert: YouthInsert;
        Update: YouthUpdate;
      };
      events: {
        Row: Event;
        Insert: EventInsert;
        Update: EventUpdate;
      };
      event_groups: {
        Row: EventGroup;
        Insert: EventGroup;
        Update: never;
      };
      attendance: {
        Row: Attendance;
        Insert: Omit<Attendance, 'id' | 'created_at'>;
        Update: Partial<Pick<Attendance, 'present' | 'notes'>>;
      };
      app_settings: {
        Row: AppSettings;
        Insert: never;
        Update: AppSettingsUpdate;
      };
      alerts: {
        Row: Alert;
        Insert: never;
        Update: Partial<Pick<Alert, 'status' | 'resolution_notes'>>;
      };
      tasks: {
        Row: Task;
        Insert: TaskInsert;
        Update: TaskUpdate;
      };
      follow_ups: {
        Row: FollowUp;
        Insert: FollowUpInsert;
        Update: FollowUpUpdate;
      };
      follow_up_transfers: {
        Row: FollowUpTransfer;
        Insert: never;
        Update: never;
      };
      communications: {
        Row: Communication;
        Insert: Pick<Communication, 'youth_id' | 'recipient_email' | 'subject' | 'body'> &
          Partial<Pick<Communication, 'alert_id' | 'follow_up_id' | 'recipient_name' | 'recipient_kind'>>;
        Update: Partial<Pick<Communication, 'recipient_email' | 'recipient_name' | 'recipient_kind' | 'subject' | 'body'>>;
      };
    };
  };
};
