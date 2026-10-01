-- Migration: 008_set_user_role_race_fix.sql
-- Data: 2026-09-30
-- Descrição: Corrige uma condição de corrida (TOCTOU) em public.set_user_role().
--
-- VULNERABILIDADE:
--   A função lia `count(*) FROM user_roles WHERE role = 'coordinator'` e só
--   depois decidia se o rebaixamento era seguro. Sob READ COMMITTED (padrão do
--   Postgres), duas chamadas concorrentes de set_user_role() rebaixando dois
--   coordenadores diferentes podiam, em tese, ler a mesma contagem (>= 2) ANTES
--   de qualquer uma commitar, e as duas prosseguirem — resultando em 0
--   coordenadores no sistema (estado irrecuperável pela própria aplicação).
--
-- CORREÇÃO:
--   Serializa todas as chamadas a set_user_role() com um advisory lock de
--   transação (pg_advisory_xact_lock). A primeira chamada concorrente obtém o
--   lock e só o libera ao fim da transação (commit/rollback); a segunda
--   chamada bloqueia até a primeira terminar, e então enxerga a contagem já
--   atualizada. Não muda nenhuma regra de negócio nem a assinatura da função.
--
-- IMPORTANTE: Execute no SQL Editor do Supabase APÓS a migration 007.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.set_user_role(p_user_id uuid, p_role user_role)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
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
