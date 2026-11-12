-- Migration: 025_anonymize_audit_and_cancel_unsent.sql
-- Descrição: fecha duas pendências da anonimização (docs/PRIVACIDADE.md, seção 6, itens 2 e 3). Nenhuma migration
--            anterior foi editada: a função da 021 é substituída aqui por CREATE OR REPLACE.
--
-- 1) AUDITORIA DA ANONIMIZAÇÃO (quem e quando)
--    * youth.anonymized_at / youth.anonymized_by: marca objetiva de que o cadastro foi anonimizado, quando e por quem.
--      Só a função anonymize_youth escreve nelas: o trigger youth_anonymized_guard devolve o valor anterior quando um
--      cliente (anon/authenticated) tenta gravar, então nem o coordenador consegue forjar ou apagar a marca pela API.
--      Reanonimizar um jovem já marcado mantém a data e o responsável ORIGINAIS.
--    * activity_log ganha a ação 'youth_anonymized' (texto fixo; meta só com contagens). Cada execução gera UMA
--      linha com o autor (actor_id + cópia do nome) e o horário, que aparece no Histórico do app. O histórico é
--      imutável para clientes (014).
--    * Jovens anonimizados ANTES desta migration ficam sem marca: o banco não registrou quem nem quando, e inventar
--      esses dados seria falsificar a auditoria. Eles continuam reconhecíveis pelo nome 'Jovem anonimizado'.
--
-- 2) E-MAILS NÃO ENVIADOS DO JOVEM ANONIMIZADO
--    * Rascunhos ('draft') e envios que falharam ('failed') do jovem passam a 'cancelled' na própria anonimização.
--      Cancelada é o estado final que já existia: clientes não alteram nem reabrem (guard da 018) e
--      begin_communication_send recusa o envio ('conflict' / 'not_sendable'). Assim o rascunho anonimizado deixa de
--      ser enviável sem mexer no caminho de envio (nenhum deploy da Edge Function é necessário).
--    * 'sent' continua 'sent' (contagem de envios preservada). 'sending' continua bloqueando a anonimização (021).
--    * Jovens anonimizados ANTES desta migration (pela função da 021): os rascunhos e falhas deles já estavam com o
--      destinatário de marcação e continuavam enviáveis. A seção 4 cancela esses também, uma única vez por linha.
--    * Efeito sobre números: os envios que falharam e ainda podiam ser repetidos deixam de aparecer como 'failed'
--      (viram 'cancelled'; attempts e last_attempt_at permanecem; failure_reason é limpo pelo guard, como em todo
--      cancelamento).
--
-- O QUE NÃO FAZ (decisões da organização/jurídico, fora desta migration): prazos de retenção e expurgo (a 022
-- continua reservada para isso), registro de consentimento, bloquear a edição posterior de um cadastro anonimizado
-- e criar novos e-mails para um jovem anonimizado.
--
-- Segurança: nenhuma policy é alterada. As duas funções têm search_path fixo; anonymize_youth segue SECURITY DEFINER
-- com checagem interna de coordenador e EXECUTE só para authenticated; a função-trigger não é chamável por clientes.
--
-- IMPORTANTE: Execute no SQL Editor do Supabase APÓS a migration 021 (a 023 e a 024 são independentes desta).
-- Reexecutável.
-- ============================================================================


-- ============================================================================
-- 1. Marca de anonimização no cadastro
-- ============================================================================
ALTER TABLE public.youth
  ADD COLUMN IF NOT EXISTS anonymized_at timestamp with time zone,
  ADD COLUMN IF NOT EXISTS anonymized_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.youth.anonymized_at IS 'Quando os dados pessoais foram anonimizados (RPC anonymize_youth). NULL = não anonimizado ou anonimizado antes da migration 025.';
COMMENT ON COLUMN public.youth.anonymized_by IS 'Quem anonimizou (profiles.id). Escrita só pela RPC anonymize_youth.';

-- Clientes não escrevem na marca: o valor enviado é ignorado (INSERT) ou trocado pelo anterior (UPDATE), sem erro,
-- como os demais "fatos do servidor" (ver communications_guard, 018). Funções do banco (dono) passam.
CREATE OR REPLACE FUNCTION public.youth_anonymized_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF current_user IN ('anon', 'authenticated') THEN
    IF TG_OP = 'INSERT' THEN
      NEW.anonymized_at := NULL;
      NEW.anonymized_by := NULL;
    ELSE
      NEW.anonymized_at := OLD.anonymized_at;
      NEW.anonymized_by := OLD.anonymized_by;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.youth_anonymized_guard() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS youth_anonymized_guard ON public.youth;
CREATE TRIGGER youth_anonymized_guard
  BEFORE INSERT OR UPDATE ON public.youth
  FOR EACH ROW EXECUTE PROCEDURE public.youth_anonymized_guard();


-- ============================================================================
-- 2. Histórico operacional: nova ação 'youth_anonymized'
-- ============================================================================
-- Mesma lista da 015 mais a ação nova (o constraint tem nome fixo desde a 015).
ALTER TABLE public.activity_log DROP CONSTRAINT IF EXISTS activity_log_action_check;
ALTER TABLE public.activity_log ADD CONSTRAINT activity_log_action_check CHECK (action IN (
  'attendance_recorded', 'follow_up_created', 'follow_up_transferred', 'task_created',
  'task_completed', 'alert_resolved', 'alert_dismissed', 'youth_group_changed',
  'youth_activated', 'youth_deactivated', 'event_series_created', 'communication_sent',
  'youth_anonymized'));


-- ============================================================================
-- 3. anonymize_youth: mesma função da 021, mais a auditoria e o cancelamento dos e-mails não enviados
-- ============================================================================
-- Retorno: as chaves da 021 (youth_id, tasks, follow_ups, communications) mais
--   communications_cancelled = quantos rascunhos/falhas foram cancelados; anonymized_at = data da marca.
CREATE OR REPLACE FUNCTION public.anonymize_youth(p_youth_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid       uuid := auth.uid();
  v_tasks     integer := 0;
  v_follow    integer := 0;
  v_comms     integer := 0;
  v_cancelled integer := 0;
  v_group     uuid;
  v_at        timestamptz;
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
  -- faz a checagem abaixo recusar; um envio que chegar depois encontra a comunicação já cancelada e não envia.
  PERFORM 1 FROM public.communications WHERE youth_id = p_youth_id FOR UPDATE;

  IF EXISTS (SELECT 1 FROM public.communications c WHERE c.youth_id = p_youth_id AND c.status = 'sending') THEN
    RAISE EXCEPTION 'Há um e-mail em envio para este jovem. Aguarde o envio terminar e tente novamente.'
      USING ERRCODE = 'P0001';
  END IF;

  UPDATE public.youth
     SET full_name     = 'Jovem anonimizado',
         birth_date    = NULL,
         gender        = NULL,
         phone         = NULL,
         email         = NULL,
         address       = NULL,
         notes         = NULL,
         is_active     = false,
         -- a marca é do PRIMEIRO ato; repetir a anonimização não reescreve quem nem quando
         anonymized_by = CASE WHEN anonymized_at IS NULL THEN v_uid ELSE anonymized_by END,
         anonymized_at = COALESCE(anonymized_at, now())
   WHERE id = p_youth_id
   RETURNING group_id, anonymized_at INTO v_group, v_at;

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

  -- Rascunhos e falhas ainda podiam ser enviados (ou reabertos e enviados): contam antes de virar 'cancelled'.
  SELECT count(*)::integer INTO v_cancelled
    FROM public.communications c
   WHERE c.youth_id = p_youth_id AND c.status::text IN ('draft', 'failed');

  UPDATE public.communications
     SET recipient_email = 'anonimizado@anonimizado.invalid',
         recipient_name  = NULL,
         subject         = 'Mensagem anonimizada',
         body            = 'Conteúdo removido por anonimização (LGPD).',
         status          = CASE WHEN status::text IN ('draft', 'failed') THEN 'cancelled'::communication_status ELSE status END
   WHERE youth_id = p_youth_id;
  GET DIAGNOSTICS v_comms = ROW_COUNT;

  -- Auditoria: quem (auth.uid() + cópia do nome) e quando ficam no histórico imutável. Texto fixo, sem dado do jovem.
  IF v_group IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.groups g WHERE g.id = v_group) THEN
    v_group := NULL;
  END IF;
  PERFORM public.activity_write(
    'youth_anonymized', 'youth', p_youth_id, p_youth_id, v_group,
    'Dados do jovem anonimizados.',
    jsonb_build_object('tasks', v_tasks, 'follow_ups', v_follow, 'communications', v_comms,
                       'communications_cancelled', v_cancelled));

  RETURN jsonb_build_object(
    'youth_id', p_youth_id, 'tasks', v_tasks, 'follow_ups', v_follow, 'communications', v_comms,
    'communications_cancelled', v_cancelled, 'anonymized_at', v_at);
END;
$$;

REVOKE ALL ON FUNCTION public.anonymize_youth(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.anonymize_youth(uuid) TO authenticated;


-- ============================================================================
-- 4. E-mails não enviados de quem foi anonimizado ANTES desta migration
-- ============================================================================
-- A função da 021 trocava o destinatário por 'anonimizado@anonimizado.invalid' (endereço reservado, que só ela
-- escreve) mas deixava o rascunho/falha enviável. Aqui eles passam a 'cancelled', como os da função nova.
-- Não toca em 'sent', 'sending' nem em e-mails de quem não foi anonimizado. Rodar de novo não muda mais nada.
UPDATE public.communications
   SET status = 'cancelled'
 WHERE recipient_email = 'anonimizado@anonimizado.invalid'
   AND status::text IN ('draft', 'failed');

NOTIFY pgrst, 'reload schema';
