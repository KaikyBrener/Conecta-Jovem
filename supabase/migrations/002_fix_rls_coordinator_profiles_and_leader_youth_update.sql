-- Migration: 002_fix_rls_coordinator_profiles_and_leader_youth_update.sql
-- Data: 2026-09-29
-- Descrição: Corrige dois problemas de RLS identificados nos testes do módulo Grupos:
--   1. Coordinator agora pode ler todos os profiles/user_roles para listar líderes.
--   2. Líder pode desassociar um jovem do seu grupo (group_id = NULL) sem poder
--      movê-lo para grupo de outro líder.
--
-- IMPORTANTE: Execute este script no SQL Editor do seu projeto Supabase.
-- ============================================================================


-- ============================================================================
-- PARTE 1: Função helper SECURITY DEFINER para evitar recursão no RLS
-- ============================================================================
-- A tabela user_roles usa RLS. Se uma policy de user_roles referenciar user_roles
-- para checar a role do usuário, ocorre recursão infinita.
-- A solução é uma função SECURITY DEFINER que bypassa o RLS ao fazer a leitura.

CREATE OR REPLACE FUNCTION public.get_my_role()
RETURNS text AS $$
  SELECT role::text
  FROM public.user_roles
  WHERE user_id = auth.uid()
  LIMIT 1;
$$ LANGUAGE sql SECURITY DEFINER STABLE;

-- Revoga acesso público para evitar invocação indevida
REVOKE ALL ON FUNCTION public.get_my_role() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_my_role() TO authenticated;


-- ============================================================================
-- PARTE 2: Coordenador pode ler todos os profiles (para listar/selecionar líderes)
-- ============================================================================
-- Adiciona política paralela à já existente "Users can view own profile".
-- Líder comum NÃO ganha acesso a profiles de terceiros — somente coordinator.

CREATE POLICY "coordinator_select_all_profiles"
  ON public.profiles
  FOR SELECT
  USING (public.get_my_role() = 'coordinator');


-- ============================================================================
-- PARTE 3: Coordenador pode ler todos os user_roles (para filtrar quem é líder)
-- ============================================================================
-- Usa get_my_role() para evitar recursão.
-- Líder comum NÃO pode ler roles de outros usuários.

CREATE POLICY "coordinator_select_all_user_roles"
  ON public.user_roles
  FOR SELECT
  USING (public.get_my_role() = 'coordinator');


-- ============================================================================
-- PARTE 4: Corrigir policy de UPDATE para youth — permitir group_id = NULL
-- ============================================================================
-- Problema: A policy anterior usava apenas USING, que o PostgreSQL replica
-- implicitamente para o WITH CHECK. Como NULL IN (subquery) ≠ TRUE, definir
-- group_id = NULL era bloqueado para o líder, impedindo desassociar um jovem.
--
-- Solução: DROP + CREATE com WITH CHECK explícito que permite NULL (remoção de
-- grupo) OU grupo que pertença ao próprio líder. Impede mover para grupo alheio.

DROP POLICY IF EXISTS "leader_update_youth" ON public.youth;

CREATE POLICY "leader_update_youth"
  ON public.youth
  FOR UPDATE
  USING (
    -- Só pode alterar jovens que estão atualmente no seu grupo
    group_id IN (
      SELECT id FROM public.groups WHERE leader_id = auth.uid()
    )
  )
  WITH CHECK (
    -- Estado resultante deve ser: group_id NULL (desassociar)
    -- OU group_id de um grupo que o líder lidera
    group_id IS NULL
    OR group_id IN (
      SELECT id FROM public.groups WHERE leader_id = auth.uid()
    )
  );
