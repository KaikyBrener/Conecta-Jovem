-- Migration: 007_fix_groups_leader_profiles_fk.sql
-- Data: 2026-09-30
-- Descrição: Corrige o relacionamento groups.leader_id para o PostgREST.
--
-- CAUSA DO BUG:
--   A migration 001 criou `groups.leader_id uuid REFERENCES auth.users`.
--   O schema `auth` não é exposto ao PostgREST (só `public` é introspectado),
--   então o embed usado pelo frontend (`.select('*, profiles:leader_id(full_name)')`)
--   nunca pôde funcionar: não existe, do ponto de vista do PostgREST, nenhuma FK
--   entre `groups` e `public.profiles`. O erro
--   "Could not find a relationship between 'groups' and 'leader_id' in the schema cache"
--   é exatamente isso — a "relationship" precisa ser uma FK dentro de um schema exposto.
--
--   Se uma FK para `public.profiles(id)` foi adicionada manualmente no SQL Editor,
--   ela pode ter ficado duplicada ao lado da FK antiga (para `auth.users`), ou o
--   cache de schema do PostgREST pode não ter sido recarregado — este script
--   resolve os dois casos de forma idempotente.
--
-- IMPORTANTE: Execute no SQL Editor do Supabase APÓS a migration 006.
-- ============================================================================

-- ============================================================================
-- 1. Remove qualquer FK existente em groups.leader_id (para auth.users, para
--    profiles com nome diferente do padrão, ou duplicadas), sem assumir nomes.
-- ============================================================================
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT con.conname
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
    WHERE nsp.nspname = 'public'
      AND rel.relname = 'groups'
      AND con.contype = 'f'
      AND con.conkey = (
        SELECT array_agg(attnum ORDER BY attnum)
        FROM pg_attribute
        WHERE attrelid = rel.oid AND attname = 'leader_id'
      )
  LOOP
    EXECUTE format('ALTER TABLE public.groups DROP CONSTRAINT %I', r.conname);
  END LOOP;
END $$;

-- ============================================================================
-- 2. Garante que não sobrou nenhum leader_id órfão (defensivo; não deveria
--    ocorrer, pois todo auth.users tem um profiles correspondente via trigger).
-- ============================================================================
UPDATE public.groups g
SET leader_id = NULL
WHERE leader_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = g.leader_id);

-- ============================================================================
-- 3. Recria a FK apontando para public.profiles(id), com nome explícito, para
--    que o PostgREST consiga resolver o embed `profiles:leader_id(...)`.
-- ============================================================================
ALTER TABLE public.groups
  ADD CONSTRAINT groups_leader_id_fkey
  FOREIGN KEY (leader_id) REFERENCES public.profiles(id) ON DELETE SET NULL;

-- ============================================================================
-- 4. Força o PostgREST a recarregar o cache de schema imediatamente. Em geral
--    o Supabase já faz isso automaticamente após DDL via SQL Editor, mas o
--    NOTIFY explícito remove qualquer dependência de timing.
-- ============================================================================
NOTIFY pgrst, 'reload schema';
