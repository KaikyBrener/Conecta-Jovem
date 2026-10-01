-- Migration: 004_fix_rls_attendance.sql
-- Data: 2026-09-29
-- Descrição: Corrige brechas de segurança no RLS da tabela attendance, garantindo que
-- líderes não possam registrar presença para jovens de outros grupos ou em eventos
-- dos quais seus grupos não participam falsificando as chaves estrangeiras.
-- ============================================================================

DROP POLICY IF EXISTS "leader_insert_attendance" ON public.attendance;
DROP POLICY IF EXISTS "leader_update_attendance" ON public.attendance;

-- Líder: registrar presença (INSERT)
CREATE POLICY "leader_insert_attendance"
  ON public.attendance FOR INSERT
  WITH CHECK (
    -- 1. O grupo referenciado deve ser liderado pelo usuário
    group_id IN (
      SELECT id FROM public.groups WHERE leader_id = auth.uid()
    )
    -- 2. O jovem referenciado deve obrigatoriamente pertencer a este grupo
    AND youth_id IN (
      SELECT id FROM public.youth WHERE group_id = attendance.group_id
    )
    -- 3. O encontro referenciado deve estar vinculado a este grupo
    AND event_id IN (
      SELECT event_id FROM public.event_groups WHERE group_id = attendance.group_id
    )
  );

-- Líder: atualizar presença (UPDATE)
CREATE POLICY "leader_update_attendance"
  ON public.attendance FOR UPDATE
  USING (
    -- Só pode modificar registros vinculados a grupos que ele lidera
    group_id IN (
      SELECT id FROM public.groups WHERE leader_id = auth.uid()
    )
  )
  WITH CHECK (
    -- A nova versão da linha também deve respeitar as mesmas 3 regras de consistência
    group_id IN (
      SELECT id FROM public.groups WHERE leader_id = auth.uid()
    )
    AND youth_id IN (
      SELECT id FROM public.youth WHERE group_id = attendance.group_id
    )
    AND event_id IN (
      SELECT event_id FROM public.event_groups WHERE group_id = attendance.group_id
    )
  );
