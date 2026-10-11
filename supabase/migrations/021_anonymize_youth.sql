-- Migration: 021_anonymize_youth.sql
-- Descrição: LGPD (mínimo técnico) — RPC anonymize_youth(p_youth_id). Nenhuma migration anterior foi editada.
--
-- O QUE FAZ (irreversível, só coordenador, uma transação):
--   * youth: nome vira 'Jovem anonimizado'; data de nascimento, gênero, telefone, e-mail, endereço e observações
--     viram NULL; is_active = false. O grupo (group_id) e o id são MANTIDOS, então presença, relatórios e
--     estatísticas agregadas continuam corretos.
--   * attendance.notes, alerts.resolution_notes: NULL (do jovem).
--   * tasks do jovem: título 'Tarefa anonimizada', descrição NULL.
--   * follow_ups do jovem: motivo 'Registro anonimizado'; notes e next_action NULL.
--     follow_up_transfers desses acompanhamentos: motivo 'Registro anonimizado'.
--   * communications do jovem: destinatário 'anonimizado@anonimizado.invalid' (e nome NULL), assunto e corpo
--     substituídos por textos fixos. Status, datas e provider_message_id permanecem (contagens de envio preservadas).
--     Se houver e-mail em envio (status 'sending'), a função recusa: tente de novo quando o envio terminar.
--   * activity_log NÃO guarda texto livre do jovem (a 014 grava só textos fixos e ids), então não precisa de limpeza.
--
-- O QUE NÃO FAZ (decisões de produto/jurídicas — validar com o responsável da organização):
--   * não define prazos de retenção nem rotina de expurgo; não registra consentimento do responsável;
--   * não apaga o jovem (excluir o jovem remove presença e quebra estatísticas; anonimizar preserva o agregado);
--   * não alcança cópias fora do banco (backups, e-mails já entregues, painel do Resend).
--   * o ato de anonimizar NÃO gera entrada no activity_log (a lista de ações da 014 é fechada; ampliar exigiria
--     alterar o CHECK dela). A transição de is_active para false é registrada pelo trigger existente, como sempre.
--
-- Segurança: SECURITY DEFINER com search_path fixo (public, pg_temp); EXECUTE só para authenticated e checagem interna de papel
-- (coordenador). Os guards de 011/015 só restringem clientes (current_user anon/authenticated); como a função roda
-- como dono, ela consegue escrever os textos substitutos sem afrouxar nenhum RLS.
--
-- IMPORTANTE: Execute no SQL Editor do Supabase APÓS a migration 020.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.anonymize_youth(p_youth_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid     uuid := auth.uid();
  v_tasks   integer := 0;
  v_follow  integer := 0;
  v_comms   integer := 0;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Não autenticado.' USING ERRCODE = '42501';
  END IF;
  IF public.get_my_role() IS DISTINCT FROM 'coordinator' THEN
    RAISE EXCEPTION 'Apenas coordenadores podem anonimizar jovens.' USING ERRCODE = '42501';
  END IF;
  IF p_youth_id IS NULL THEN
    RAISE EXCEPTION 'Informe o jovem.' USING ERRCODE = 'P0001';
  END IF;

  PERFORM 1 FROM public.youth WHERE id = p_youth_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Jovem não encontrado.' USING ERRCODE = 'P0002';
  END IF;

  -- Serializa com begin_communication_send (que também trava a linha com FOR UPDATE): um envio que confirmar antes
  -- faz a checagem abaixo recusar; um envio que chegar depois lê o conteúdo já anonimizado.
  PERFORM 1 FROM public.communications WHERE youth_id = p_youth_id FOR UPDATE;

  IF EXISTS (SELECT 1 FROM public.communications c WHERE c.youth_id = p_youth_id AND c.status = 'sending') THEN
    RAISE EXCEPTION 'Há um e-mail em envio para este jovem. Aguarde o envio terminar e tente novamente.'
      USING ERRCODE = 'P0001';
  END IF;

  UPDATE public.youth
     SET full_name  = 'Jovem anonimizado',
         birth_date = NULL,
         gender     = NULL,
         phone      = NULL,
         email      = NULL,
         address    = NULL,
         notes      = NULL,
         is_active  = false
   WHERE id = p_youth_id;

  UPDATE public.attendance SET notes = NULL WHERE youth_id = p_youth_id AND notes IS NOT NULL;
  UPDATE public.alerts     SET resolution_notes = NULL WHERE youth_id = p_youth_id AND resolution_notes IS NOT NULL;

  UPDATE public.tasks
     SET title = 'Tarefa anonimizada', description = NULL
   WHERE youth_id = p_youth_id;
  GET DIAGNOSTICS v_tasks = ROW_COUNT;

  UPDATE public.follow_up_transfers t
     SET reason = 'Registro anonimizado'
   WHERE t.follow_up_id IN (SELECT f.id FROM public.follow_ups f WHERE f.youth_id = p_youth_id);

  UPDATE public.follow_ups
     SET reason = 'Registro anonimizado', notes = NULL, next_action = NULL
   WHERE youth_id = p_youth_id;
  GET DIAGNOSTICS v_follow = ROW_COUNT;

  UPDATE public.communications
     SET recipient_email = 'anonimizado@anonimizado.invalid',
         recipient_name  = NULL,
         subject         = 'Mensagem anonimizada',
         body            = 'Conteúdo removido por anonimização (LGPD).'
   WHERE youth_id = p_youth_id;
  GET DIAGNOSTICS v_comms = ROW_COUNT;

  RETURN jsonb_build_object('youth_id', p_youth_id, 'tasks', v_tasks, 'follow_ups', v_follow, 'communications', v_comms);
END;
$$;

REVOKE ALL ON FUNCTION public.anonymize_youth(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.anonymize_youth(uuid) TO authenticated;
