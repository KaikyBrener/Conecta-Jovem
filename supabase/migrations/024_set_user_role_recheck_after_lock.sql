-- Migration: 024_set_user_role_recheck_after_lock.sql
-- Descrição: corrige a ordem de checagem de set_user_role() (achado do teste de concorrência em Postgres real).
-- Nenhuma migration anterior foi editada.
--
-- PROBLEMA: a checagem "o chamador é coordenador?" rodava ANTES do pg_advisory_xact_lock (008) e não era refeita.
--   Com 3 coordenadores (A, B, C): A rebaixa B enquanto B rebaixa C. B passa na checagem (ainda é coordenador no seu
--   snapshot), espera o lock, e depois que A confirma, rebaixa C mesmo já sendo líder. A invariante "sempre há
--   pelo menos 1 coordenador" já era garantida pelo lock; o que faltava era a equivalência com a execução serial
--   (em sequência, a chamada de B falharia com 42501).
-- CORREÇÃO: depois de obter o lock, refaz get_my_role() = 'coordinator' com o mesmo erro 42501. A primeira checagem
--   continua (recusa barata, sem fazer fila no lock quem nunca foi coordenador).
--
-- Corpo da função igual ao da 008 + a segunda checagem. `search_path = public, pg_temp` (a 016 já havia acrescentado
-- pg_temp a todas as SECURITY DEFINER; um CREATE OR REPLACE com `= public` o removeria). Grants reafirmados.
-- TESTE: tests/concurrency/set-user-role.pgtest.ts (Postgres real, duas conexões). O PGlite não reproduz a corrida.
-- IMPORTANTE: Execute no SQL Editor do Supabase APÓS a migration 021 (ordem de aplicação: 020, 021, 024).
-- ============================================================================

CREATE OR REPLACE FUNCTION public.set_user_role(p_user_id uuid, p_role user_role)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_current user_role;
BEGIN
  IF public.get_my_role() IS DISTINCT FROM 'coordinator' THEN
    RAISE EXCEPTION 'Apenas coordenadores podem alterar papéis.' USING ERRCODE = '42501';
  END IF;

  -- Serializa concorrência: nenhuma outra chamada a set_user_role() prossegue
  -- além deste ponto até esta transação commitar/abortar.
  PERFORM pg_advisory_xact_lock(hashtext('public.set_user_role:coordinator_count'));

  -- Refaz a checagem: enquanto esperava o lock, uma chamada anterior pode ter rebaixado o chamador.
  IF public.get_my_role() IS DISTINCT FROM 'coordinator' THEN
    RAISE EXCEPTION 'Apenas coordenadores podem alterar papéis.' USING ERRCODE = '42501';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = p_user_id) THEN
    RAISE EXCEPTION 'Usuário não encontrado.' USING ERRCODE = 'P0002';
  END IF;

  SELECT role INTO v_current FROM public.user_roles WHERE user_id = p_user_id;

  IF v_current = 'coordinator' AND p_role <> 'coordinator'
     AND (SELECT count(*) FROM public.user_roles WHERE role = 'coordinator') <= 1 THEN
    RAISE EXCEPTION 'Não é possível remover o último coordenador.' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO public.user_roles (user_id, role)
  VALUES (p_user_id, p_role)
  ON CONFLICT (user_id) DO UPDATE SET role = EXCLUDED.role;
END;
$$;

-- GRANTs já existentes continuam válidos (CREATE OR REPLACE preserva privilégios),
-- mas reafirmamos explicitamente por clareza e para não depender disso.
REVOKE ALL ON FUNCTION public.set_user_role(uuid, user_role) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_user_role(uuid, user_role) TO authenticated;
