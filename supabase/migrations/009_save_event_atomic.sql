-- Migration: 009_save_event_atomic.sql
-- Descrição: salvar um encontro e seus grupos vinculados passa a ser UMA operação atômica.
--
-- Problema: o frontend criava/atualizava o encontro e depois sincronizava event_groups em
-- chamadas separadas (UPDATE events → DELETE event_groups → INSERT event_groups). Se o INSERT
-- falhasse (grupo removido no meio do caminho, rede, constraint), o encontro ficava salvo
-- SEM nenhum grupo — e o erro era engolido, então o usuário não percebia.
--
-- Solução: RPC `save_event`, uma única transação (uma chamada de função = um commit):
-- qualquer falha desfaz tudo, inclusive o INSERT/UPDATE do próprio encontro.
--
-- Segurança: SECURITY INVOKER (padrão). A função roda com os privilégios de quem chama, então
-- as policies existentes de events/event_groups continuam sendo a barreira real: só o
-- coordenador consegue escrever; para líder o INSERT/UPDATE é bloqueado pelo RLS.
-- Nenhuma policy foi alterada. Os GRANTs são restritos a `authenticated`.
--
-- IMPORTANTE: Execute no SQL Editor do Supabase APÓS a migration 008.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.save_event(
  p_event_id    uuid,
  p_title       text,
  p_description text,
  p_event_date  timestamp with time zone,
  p_status      event_status,
  p_group_ids   uuid[]
)
RETURNS public.events
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_event  public.events;
  v_groups uuid[];
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Não autenticado.' USING ERRCODE = '42501';
  END IF;

  -- Lista sem nulos nem repetidos (NULL/[] = encontro sem grupos)
  SELECT COALESCE(array_agg(DISTINCT g), '{}')
    INTO v_groups
    FROM unnest(COALESCE(p_group_ids, '{}')) AS g
   WHERE g IS NOT NULL;

  IF p_event_id IS NULL THEN
    -- Criar: título e data são obrigatórios (NOT NULL); status usa o padrão do banco se omitido
    INSERT INTO public.events (title, description, event_date, status, created_by)
    VALUES (p_title, p_description, p_event_date, COALESCE(p_status, 'scheduled'), auth.uid())
    RETURNING * INTO v_event;
  ELSE
    -- Editar: título/data/status nulos significam "manter"; a descrição é substituída
    -- (NULL limpa), igual ao formulário, que sempre envia o valor atual.
    UPDATE public.events
       SET title       = COALESCE(p_title, title),
           description = p_description,
           event_date  = COALESCE(p_event_date, event_date),
           status      = COALESCE(p_status, status)
     WHERE id = p_event_id
    RETURNING * INTO v_event;

    -- 0 linhas = não existe OU o RLS escondeu/bloqueou (ex.: líder). Não distinguimos de propósito.
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Encontro não encontrado ou sem permissão.' USING ERRCODE = 'P0002';
    END IF;
  END IF;

  -- Sincroniza por diferença (remove o que saiu, adiciona o que entrou).
  -- Se algum grupo for inválido, o INSERT falha (FK) e a transação inteira é desfeita.
  DELETE FROM public.event_groups
   WHERE event_id = v_event.id
     AND group_id <> ALL (v_groups);

  INSERT INTO public.event_groups (event_id, group_id)
  SELECT v_event.id, g FROM unnest(v_groups) AS g
  ON CONFLICT (event_id, group_id) DO NOTHING;

  RETURN v_event;
END;
$$;

-- Funções novas em public recebem EXECUTE para anon por padrão no Supabase: restringimos.
REVOKE ALL ON FUNCTION public.save_event(uuid, text, text, timestamp with time zone, event_status, uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_event(uuid, text, text, timestamp with time zone, event_status, uuid[]) TO authenticated;

NOTIFY pgrst, 'reload schema';
