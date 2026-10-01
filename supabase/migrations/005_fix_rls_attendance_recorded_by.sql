-- Migration: 005_fix_rls_attendance_recorded_by.sql
-- Data: 2026-09-29
-- Descrição: Fecha a última brecha do RLS na tabela attendance: impede que um
-- Líder falsifique a coluna "recorded_by" fingindo que outra pessoa fez a chamada.
-- ============================================================================

DROP POLICY IF EXISTS "leader_insert_attendance" ON public.attendance;
DROP POLICY IF EXISTS "leader_update_attendance" ON public.attendance;

-- Líder: registrar presença (INSERT)
CREATE POLICY "leader_insert_attendance"
  ON public.attendance FOR INSERT
  WITH CHECK (
    group_id IN (SELECT id FROM public.groups WHERE leader_id = auth.uid())
    AND youth_id IN (SELECT id FROM public.youth WHERE group_id = attendance.group_id)
    AND event_id IN (SELECT event_id FROM public.event_groups WHERE group_id = attendance.group_id)
    -- Nova restrição: o autor do registro deve ser obrigatoriamente ele mesmo
    AND recorded_by = auth.uid()
  );

-- Líder: atualizar presença (UPDATE)
CREATE POLICY "leader_update_attendance"
  ON public.attendance FOR UPDATE
  USING (
    group_id IN (SELECT id FROM public.groups WHERE leader_id = auth.uid())
  )
  WITH CHECK (
    group_id IN (SELECT id FROM public.groups WHERE leader_id = auth.uid())
    AND youth_id IN (SELECT id FROM public.youth WHERE group_id = attendance.group_id)
    AND event_id IN (SELECT event_id FROM public.event_groups WHERE group_id = attendance.group_id)
    -- Nova restrição: o autor da modificação/registro deve ser mantido como ele mesmo
    AND recorded_by = auth.uid()
  );
