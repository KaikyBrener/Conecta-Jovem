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
}

export type EventInsert = Omit<Event, 'id' | 'created_at' | 'updated_at'>;
export type EventUpdate = Partial<Omit<Event, 'id' | 'created_at' | 'updated_at' | 'created_by'>>;

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
  updated_by: string | null;
  updated_at: string;
}

export type AppSettingsUpdate = Partial<Pick<AppSettings, 'absence_alert_threshold' | 'low_attendance_threshold'>>;

// ── Alertas ──────────────────────────────────────────────────────────────────

export type AlertType = 'consecutive_absences';
export type AlertStatus = 'open' | 'resolved' | 'dismissed';

export interface Alert {
  id: string;
  youth_id: string;
  group_id: string | null;
  type: AlertType;
  status: AlertStatus;
  consecutive_absences: number;
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
  created_at: string;
  updated_at: string;
}

export type TaskInsert = Omit<Task, 'id' | 'created_at' | 'updated_at' | 'completed_at'>;
export type TaskUpdate = Partial<Omit<Task, 'id' | 'created_at' | 'updated_at' | 'completed_at' | 'created_by'>>;

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
    };
  };
};
