-- Migration: 001_base.sql
-- Data: 2026-09-29
-- Descrição: Schema base contendo profiles, user_roles, groups, youth, RLS iniciais e triggers.
--
-- ============================================================================

-- ============================================================================
-- 1. Enums
-- ============================================================================
CREATE TYPE user_role AS ENUM ('coordinator', 'leader');
CREATE TYPE gender_type AS ENUM ('male', 'female', 'other');


-- ============================================================================
-- 2. Profiles e Roles
-- ============================================================================
CREATE TABLE public.profiles (
  id uuid REFERENCES auth.users ON DELETE CASCADE NOT NULL PRIMARY KEY,
  full_name text,
  created_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL
);

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own profile" 
  ON public.profiles FOR SELECT USING (auth.uid() = id);

CREATE POLICY "Users can update own profile" 
  ON public.profiles FOR UPDATE USING (auth.uid() = id);

CREATE TABLE public.user_roles (
  user_id uuid REFERENCES public.profiles(id) ON DELETE CASCADE NOT NULL PRIMARY KEY,
  role user_role DEFAULT 'leader'::user_role NOT NULL,
  created_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL
);

ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own role" 
  ON public.user_roles FOR SELECT USING (auth.uid() = user_id);

-- ============================================================================
-- 3. Automação de Cadastro de Usuário
-- ============================================================================
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger AS $$
BEGIN
  INSERT INTO public.profiles (id, full_name)
  VALUES (new.id, new.raw_user_meta_data->>'full_name');
  INSERT INTO public.user_roles (user_id, role)
  VALUES (new.id, 'leader');
  RETURN new;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE PROCEDURE public.handle_new_user();


-- ============================================================================
-- 4. Função Auxiliar Genérica
-- ============================================================================
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger AS $$
BEGIN 
  NEW.updated_at = timezone('utc', now()); 
  RETURN NEW; 
END;
$$ LANGUAGE plpgsql;


-- ============================================================================
-- 5. Grupos
-- ============================================================================
CREATE TABLE public.groups (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  name text NOT NULL,
  description text,
  leader_id uuid REFERENCES auth.users ON DELETE SET NULL,
  created_at timestamp with time zone DEFAULT timezone('utc', now()) NOT NULL,
  updated_at timestamp with time zone DEFAULT timezone('utc', now()) NOT NULL
);

ALTER TABLE public.groups ENABLE ROW LEVEL SECURITY;

CREATE TRIGGER groups_updated_at
  BEFORE UPDATE ON public.groups
  FOR EACH ROW EXECUTE PROCEDURE public.set_updated_at();

-- RLS Inicial (algumas destas usam queries diretas em user_roles que depois são
-- melhoradas/corrigidas na migration 002)
CREATE POLICY "coordinator_select_groups" ON public.groups FOR SELECT
  USING (EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = auth.uid() AND role = 'coordinator'));

CREATE POLICY "leader_select_own_group" ON public.groups FOR SELECT
  USING (leader_id = auth.uid());

CREATE POLICY "coordinator_all_groups" ON public.groups FOR ALL
  USING (EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = auth.uid() AND role = 'coordinator'));

CREATE POLICY "leader_update_own_group" ON public.groups FOR UPDATE
  USING (leader_id = auth.uid());


-- ============================================================================
-- 6. Jovens
-- ============================================================================
CREATE TABLE public.youth (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  full_name text NOT NULL,
  birth_date date,
  gender gender_type,
  phone text,
  email text,
  address text,
  notes text,
  is_active boolean DEFAULT true NOT NULL,
  group_id uuid REFERENCES public.groups(id) ON DELETE SET NULL,
  created_by uuid REFERENCES auth.users ON DELETE SET NULL NOT NULL,
  created_at timestamp with time zone DEFAULT timezone('utc', now()) NOT NULL,
  updated_at timestamp with time zone DEFAULT timezone('utc', now()) NOT NULL
);

ALTER TABLE public.youth ENABLE ROW LEVEL SECURITY;

CREATE TRIGGER youth_updated_at
  BEFORE UPDATE ON public.youth
  FOR EACH ROW EXECUTE PROCEDURE public.set_updated_at();

-- Coordenador: acesso total
CREATE POLICY "coordinator_all_youth" ON public.youth FOR ALL
  USING (EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = auth.uid() AND role = 'coordinator'));

-- Líder: lê e edita apenas jovens do seu grupo
CREATE POLICY "leader_select_youth" ON public.youth FOR SELECT
  USING (group_id IN (SELECT id FROM public.groups WHERE leader_id = auth.uid()));

CREATE POLICY "leader_update_youth" ON public.youth FOR UPDATE
  USING (group_id IN (SELECT id FROM public.groups WHERE leader_id = auth.uid()));
