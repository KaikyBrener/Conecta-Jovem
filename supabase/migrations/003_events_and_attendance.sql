-- Migration: 003_events_and_attendance.sql
-- Data: 2026-09-29
-- Descrição: Cria as tabelas events, event_groups e attendance (stub para Chamada/Presença).
--
-- IMPORTANTE: Execute no SQL Editor do seu projeto Supabase APÓS as migrations 001 e 002.
-- ============================================================================

-- ============================================================================
-- 1. Enum de status do encontro
-- ============================================================================
CREATE TYPE event_status AS ENUM ('scheduled', 'completed', 'cancelled');

-- ============================================================================
-- 2. Criação das Tabelas
-- ============================================================================
CREATE TABLE public.events (
  id          uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  title       text NOT NULL,
  description text,
  event_date  timestamp with time zone NOT NULL,
  status      event_status DEFAULT 'scheduled'::event_status NOT NULL,
  created_by  uuid REFERENCES auth.users ON DELETE SET NULL NOT NULL,
  created_at  timestamp with time zone DEFAULT timezone('utc', now()) NOT NULL,
  updated_at  timestamp with time zone DEFAULT timezone('utc', now()) NOT NULL
);

CREATE TABLE public.event_groups (
  event_id  uuid REFERENCES public.events(id)  ON DELETE CASCADE NOT NULL,
  group_id  uuid REFERENCES public.groups(id)  ON DELETE CASCADE NOT NULL,
  PRIMARY KEY (event_id, group_id)
);

CREATE TABLE public.attendance (
  id           uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  event_id     uuid REFERENCES public.events(id)  ON DELETE CASCADE NOT NULL,
  youth_id     uuid REFERENCES public.youth(id)   ON DELETE CASCADE NOT NULL,
  group_id     uuid REFERENCES public.groups(id)  ON DELETE CASCADE NOT NULL,
  present      boolean DEFAULT false NOT NULL,
  notes        text,
  recorded_by  uuid REFERENCES auth.users ON DELETE SET NULL,
  created_at   timestamp with time zone DEFAULT timezone('utc', now()) NOT NULL,
  UNIQUE (event_id, youth_id)
);

-- ============================================================================
-- 3. Triggers
-- ============================================================================
CREATE TRIGGER events_updated_at
  BEFORE UPDATE ON public.events
  FOR EACH ROW EXECUTE PROCEDURE public.set_updated_at();

-- ============================================================================
-- 4. Habilitar RLS
-- ============================================================================
ALTER TABLE public.events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.event_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.attendance ENABLE ROW LEVEL SECURITY;

-- ============================================================================
-- 5. Políticas RLS
-- ============================================================================

-- RLS: events
CREATE POLICY "coordinator_all_events"
  ON public.events FOR ALL
  USING (public.get_my_role() = 'coordinator');

CREATE POLICY "leader_select_events"
  ON public.events FOR SELECT
  USING (
    id IN (
      SELECT event_id FROM public.event_groups
      WHERE group_id IN (
        SELECT id FROM public.groups WHERE leader_id = auth.uid()
      )
    )
  );

-- RLS: event_groups
CREATE POLICY "coordinator_all_event_groups"
  ON public.event_groups FOR ALL
  USING (public.get_my_role() = 'coordinator');

CREATE POLICY "leader_select_event_groups"
  ON public.event_groups FOR SELECT
  USING (
    group_id IN (
      SELECT id FROM public.groups WHERE leader_id = auth.uid()
    )
  );

-- RLS: attendance
CREATE POLICY "coordinator_all_attendance"
  ON public.attendance FOR ALL
  USING (public.get_my_role() = 'coordinator');

CREATE POLICY "leader_select_attendance"
  ON public.attendance FOR SELECT
  USING (
    group_id IN (
      SELECT id FROM public.groups WHERE leader_id = auth.uid()
    )
  );

CREATE POLICY "leader_insert_attendance"
  ON public.attendance FOR INSERT
  WITH CHECK (
    group_id IN (
      SELECT id FROM public.groups WHERE leader_id = auth.uid()
    )
  );

CREATE POLICY "leader_update_attendance"
  ON public.attendance FOR UPDATE
  USING (
    group_id IN (
      SELECT id FROM public.groups WHERE leader_id = auth.uid()
    )
  );
