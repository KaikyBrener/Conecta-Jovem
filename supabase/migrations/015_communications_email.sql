-- Migration: 015_communications_email.sql
-- Descrição: Fase 7 (bloco 10) — comunicações por E-MAIL com envio ASSISTIDO.
--
-- FLUXO (nenhuma etapa envia e-mail a partir do banco ou do navegador):
--   alerta/acompanhamento -> comunicação (RASCUNHO) -> a pessoa revisa/edita -> o frontend abre o cliente de e-mail
--   dela (link `mailto:`, montado no frontend com encodeURIComponent) -> a pessoa confirma "marcar como enviada"
--   (ou "falhou"/"cancelada") -> fica no histórico.
--   O sistema NUNCA sabe se o e-mail saiu de fato: "enviada" é uma declaração da pessoa que usou o cliente de e-mail.
--
-- DEPENDÊNCIA EXTERNA FUTURA (NÃO existe nesta migration): um envio automático exigiria uma Edge Function (ou outro
-- backend) com a chave `service_role`/credenciais do provedor de e-mail guardadas como SEGREDO DO SERVIDOR. Nada
-- disso pode ir ao frontend. Quando existir, ela deverá chamar mark_communication() (ou atualizar a tabela como
-- service_role) — o modelo de estados abaixo já comporta isso sem mudanças. Até lá: nenhum segredo, nenhuma
-- Edge Function, nenhum provedor.
--
-- CANAL ÚNICO: `channel` só aceita 'email' (CHECK). Outros canais exigiriam uma migration que altere o CHECK.
--
-- DADOS DISPONÍVEIS PARA DESTINATÁRIO (schema real): `youth.email` e `youth.phone` existem; NÃO existe coluna de
-- responsável/guardião; `profiles` NÃO tem e-mail (o e-mail de líderes/coordenadores vive em auth.users, que o app
-- não expõe). Logo, suggest_communication_recipients() só sugere o e-mail do próprio jovem; os demais destinatários
-- (responsável, líder, coordenador, outro) são digitados à mão no frontend — `recipient_kind` apenas rotula.
--
-- DECISÕES:
--   * HISTÓRICO SOBREVIVE: youth_id/alert_id/follow_up_id são FK `ON DELETE SET NULL` (diferente de follow_ups, que
--     usa CASCADE). Excluir um jovem não apaga o registro do que foi enviado. Consequências: (1) depois disso só o
--     coordenador enxerga a comunicação (o escopo do líder depende do jovem); (2) o e-mail do destinatário
--     continua guardado — se for preciso remover dado pessoal, o coordenador faz isso fora do app (SQL Editor).
--   * `sent` e `cancelled` são TERMINAIS e totalmente imutáveis para clientes. `failed` só volta a rascunho
--     (para corrigir e tentar de novo) ou vai a `cancelled`; conteúdo só é editável em `draft`.
--   * DELETE: apenas coordenador e apenas `draft`/`cancelled` (rascunho descartado). `sent` e `failed` são
--     registro e ficam. Líder nunca exclui (para descartar, marca como `cancelled`).
--   * Líder: lê comunicações de jovens que estão HOJE em um grupo seu (qualquer autor); cria e edita/marca somente
--     as que ele mesmo criou (created_by = ele). Uma comunicação criada por coordenador é visível, mas não editável.
--   * As transições valem para QUALQUER caminho de escrita de clientes (UPDATE direto ou RPC): quem garante é o
--     trigger `communications_guard`, não a RPC. mark_communication() é conveniência (e valida a entrada).
--   * Registro em `activity_log`: ação `communication_sent` com texto fixo; sem assunto, corpo ou e-mail.
--     (Só o envio marcado vira histórico; rascunhos/falhas/cancelamentos não.)
--   * Ações sem sessão (SQL Editor/service_role: current_user fora de anon/authenticated) não passam pela máquina de
--     estados nem pelas restrições de colunas — é o padrão das migrations anteriores (também permite que a ação de
--     FK ON DELETE SET NULL atualize linhas já enviadas).
--
-- Não há ALTER TYPE ... ADD VALUE. Nenhuma migration anterior foi editada: apenas os CHECKs de `activity_log`
-- (definidos na 014) são recriados aqui com DROP/ADD CONSTRAINT.
--
-- IMPORTANTE: Execute no SQL Editor do Supabase APÓS a migration 014.
-- ============================================================================


-- ============================================================================
-- 1. Funções puras de validação (usadas em CHECKs e nos guards)
-- ============================================================================
-- E-mail "razoável" (não é RFC 5322 completo, de propósito): local-part de 1..64 caracteres seguros
-- [A-Za-z0-9._%+-] (sem aspas, espaços, `<>,;:?&=/` etc., que atrapalham cabeçalhos e `mailto:`), um '@', domínio com
-- rótulos de 1..63 caracteres e TLD alfabético de 2..24. Sem '..', sem ponto no começo/fim do local-part, máx. 254.
-- ReDoS: o motor de regex do PostgreSQL não faz backtracking exponencial e a expressão não tem quantificadores aninhados
-- sobre o mesmo conjunto; tudo é limitado por tamanho. O `$` do PostgreSQL casa só no fim do texto (não antes de um
-- '\n' final), então "a@b.com\n" é rejeitado.
CREATE OR REPLACE FUNCTION public.is_valid_email(p_email text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = public
AS $$
  SELECT COALESCE(
    length(p_email) <= 254
    AND p_email ~ '^[A-Za-z0-9._%+-]{1,64}@([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,24}$'
    AND p_email !~ '\.\.'
    AND p_email !~ '^\.|\.@',
    false)
$$;

-- Texto de UMA linha: sem caracteres de controle (CR, LF, TAB, NUL...), DEL, C1 (inclui NEL) nem U+2028/U+2029.
-- Evita injeção de cabeçalho em assunto/destinatário/nome.
CREATE OR REPLACE FUNCTION public.is_single_line_text(p_text text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = public
AS $$
  SELECT p_text IS NOT NULL AND p_text !~ '[\x01-\x1f\x7f\u0080-\u009f  ]'
$$;

REVOKE ALL ON FUNCTION public.is_valid_email(text)       FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.is_single_line_text(text)  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_valid_email(text)      TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_single_line_text(text) TO authenticated;


-- ============================================================================
-- 2. Tabela
-- ============================================================================
CREATE TYPE communication_status AS ENUM ('draft', 'sent', 'failed', 'cancelled');

CREATE TABLE public.communications (
  id              uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  channel         text NOT NULL DEFAULT 'email' CHECK (channel = 'email'),
  -- Contexto (todos opcionais/anuláveis para o histórico sobreviver; ver DECISÕES).
  youth_id        uuid REFERENCES public.youth(id)       ON DELETE SET NULL,
  alert_id        uuid REFERENCES public.alerts(id)      ON DELETE SET NULL,
  follow_up_id    uuid REFERENCES public.follow_ups(id)  ON DELETE SET NULL,
  -- Destinatário. `recipient_kind` é só um rótulo (ver cabeçalho).
  recipient_email text NOT NULL
                    CHECK (public.is_valid_email(recipient_email)),
  recipient_name  text
                    CHECK (recipient_name IS NULL
                           OR (length(recipient_name) BETWEEN 1 AND 120 AND public.is_single_line_text(recipient_name))),
  recipient_kind  text NOT NULL DEFAULT 'other'
                    CHECK (recipient_kind IN ('youth', 'guardian', 'leader', 'coordinator', 'other')),
  -- Conteúdo. Assunto em UMA linha; corpo pode ter quebras de linha, mas não outros caracteres de controle.
  subject         text NOT NULL
                    CHECK (length(subject) BETWEEN 1 AND 200 AND public.is_single_line_text(subject)),
  body            text NOT NULL
                    CHECK (length(body) BETWEEN 1 AND 5000
                           AND length(btrim(body, E' \t\r\n')) > 0
                           AND body !~ '[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]'),
  status          communication_status NOT NULL DEFAULT 'draft',
  -- Lista fechada de códigos (a UI traduz); nunca texto livre nem mensagem de servidor.
  failure_reason  text
                    CHECK (failure_reason IN ('client_not_opened', 'invalid_address', 'bounced', 'other')),
  created_by      uuid REFERENCES public.profiles(id) ON DELETE SET NULL DEFAULT auth.uid(),
  created_at      timestamp with time zone NOT NULL DEFAULT timezone('utc', now()),
  sent_at         timestamp with time zone,
  sent_by         uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  updated_at      timestamp with time zone NOT NULL DEFAULT timezone('utc', now()),
  -- failure_reason existe se e somente se status = 'failed'; sent_at existe se e somente se status = 'sent'.
  CONSTRAINT communications_failure_reason_consistent
    CHECK ((status = 'failed') = (failure_reason IS NOT NULL)),
  CONSTRAINT communications_sent_at_consistent
    CHECK ((status = 'sent') = (sent_at IS NOT NULL))
);

CREATE INDEX communications_youth_idx     ON public.communications (youth_id, created_at DESC, id DESC);
CREATE INDEX communications_alert_idx     ON public.communications (alert_id)     WHERE alert_id     IS NOT NULL;
CREATE INDEX communications_follow_up_idx ON public.communications (follow_up_id) WHERE follow_up_id IS NOT NULL;
CREATE INDEX communications_status_idx    ON public.communications (status, created_at DESC);

ALTER TABLE public.communications ENABLE ROW LEVEL SECURITY;

-- anon nada; authenticated: CRUD sob RLS (sem TRUNCATE/REFERENCES/TRIGGER).
REVOKE ALL ON public.communications FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.communications TO authenticated;

CREATE TRIGGER communications_updated_at
  BEFORE UPDATE ON public.communications
  FOR EACH ROW EXECUTE PROCEDURE public.set_updated_at();


-- ============================================================================
-- 3. Guard: normalização, escopo de vínculos e máquina de estados
-- ============================================================================
-- SECURITY INVOKER: as leituras de youth/alerts/follow_ups respeitam o RLS de quem grava.
--
-- Transições válidas (clientes):  draft -> sent | failed | cancelled ;  failed -> draft | cancelled ;
--                                 sent e cancelled: terminais (nenhuma alteração, nem de conteúdo).
-- Conteúdo (destinatário, assunto, corpo) só muda em `draft`, e nunca na mesma operação de uma mudança de status
-- (o que foi revisado é o que é marcado como enviado).
-- Clientes não alteram: id, channel, youth_id, alert_id, follow_up_id (erro); created_by/created_at (restaurados);
-- sent_at/sent_by (carimbados aqui, pelo servidor: now() e auth.uid()); failure_reason só entra ao ir para `failed`.
CREATE OR REPLACE FUNCTION public.communications_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_client  boolean := current_user IN ('anon', 'authenticated');
  v_uid     uuid := auth.uid();
  v_reason  text;
  v_ref     uuid;
  v_changed boolean;
BEGIN
  -- Normalização (não altera o que já está normalizado, então comparações com OLD continuam válidas)
  NEW.recipient_email := lower(btrim(NEW.recipient_email));
  NEW.recipient_name  := NULLIF(btrim(NEW.recipient_name), '');
  NEW.subject         := btrim(NEW.subject);

  IF TG_OP = 'INSERT' THEN
    IF v_client THEN
      IF v_uid IS NULL THEN
        RAISE EXCEPTION 'Sessão inválida.' USING ERRCODE = '42501';
      END IF;
      NEW.created_by     := v_uid;
      NEW.created_at     := timezone('utc', now());
      NEW.sent_at        := NULL;
      NEW.sent_by        := NULL;
      NEW.failure_reason := NULL;
      IF NEW.status IS DISTINCT FROM 'draft' THEN
        RAISE EXCEPTION 'A comunicação deve ser criada como rascunho.' USING ERRCODE = 'P0001';
      END IF;
      IF NEW.youth_id IS NULL THEN
        RAISE EXCEPTION 'Informe o jovem da comunicação.' USING ERRCODE = 'P0001';
      END IF;
    END IF;
  ELSE
    IF v_client THEN
      IF NEW.id IS DISTINCT FROM OLD.id OR NEW.channel IS DISTINCT FROM OLD.channel
         OR NEW.youth_id IS DISTINCT FROM OLD.youth_id
         OR NEW.alert_id IS DISTINCT FROM OLD.alert_id
         OR NEW.follow_up_id IS DISTINCT FROM OLD.follow_up_id THEN
        RAISE EXCEPTION 'O jovem e os vínculos de uma comunicação não podem ser alterados.' USING ERRCODE = '42501';
      END IF;
      NEW.created_by := OLD.created_by;
      NEW.created_at := OLD.created_at;
      v_reason       := NEW.failure_reason;   -- só vale se a operação for uma ida para `failed`
      NEW.failure_reason := OLD.failure_reason;
      NEW.sent_at        := OLD.sent_at;
      NEW.sent_by        := OLD.sent_by;

      -- Estados terminais: nenhuma alteração (um UPDATE que não muda nada passa).
      IF OLD.status IN ('sent', 'cancelled')
         AND (to_jsonb(NEW) - 'updated_at') IS DISTINCT FROM (to_jsonb(OLD) - 'updated_at') THEN
        RAISE EXCEPTION '%', CASE WHEN OLD.status = 'sent'
          THEN 'Comunicações enviadas não podem ser alteradas.'
          ELSE 'Comunicações canceladas não podem ser alteradas.' END
          USING ERRCODE = 'P0001';
      END IF;

      v_changed := (NEW.recipient_email, NEW.recipient_name, NEW.recipient_kind, NEW.subject, NEW.body)
                   IS DISTINCT FROM
                   (OLD.recipient_email, OLD.recipient_name, OLD.recipient_kind, OLD.subject, OLD.body);

      IF NEW.status = OLD.status THEN
        IF OLD.status = 'failed' AND v_changed THEN
          RAISE EXCEPTION 'Para editar uma comunicação que falhou, volte-a para rascunho.' USING ERRCODE = 'P0001';
        END IF;
      ELSE
        IF v_changed THEN
          RAISE EXCEPTION 'Altere o conteúdo e o status em operações separadas.' USING ERRCODE = 'P0001';
        END IF;
        IF NOT ((OLD.status = 'draft'  AND NEW.status IN ('sent', 'failed', 'cancelled'))
             OR (OLD.status = 'failed' AND NEW.status IN ('draft', 'cancelled'))) THEN
          RAISE EXCEPTION 'Mudança de status não permitida.' USING ERRCODE = 'P0001';
        END IF;
        IF NEW.status = 'sent' THEN
          NEW.sent_at := timezone('utc', now());
          NEW.sent_by := v_uid;
        ELSIF NEW.status = 'failed' THEN
          IF v_reason IS NOT NULL AND v_reason NOT IN ('client_not_opened', 'invalid_address', 'bounced', 'other') THEN
            RAISE EXCEPTION 'Motivo de falha inválido.' USING ERRCODE = 'P0001';
          END IF;
          NEW.failure_reason := COALESCE(v_reason, 'other');
        END IF;
      END IF;
    END IF;
  END IF;

  -- Consistência (vale também para quem não é cliente)
  IF NEW.status = 'failed' THEN
    NEW.failure_reason := COALESCE(NEW.failure_reason, 'other');
  ELSE
    NEW.failure_reason := NULL;
  END IF;
  IF NEW.status = 'sent' THEN
    IF NEW.sent_at IS NULL THEN
      NEW.sent_at := timezone('utc', now());
      NEW.sent_by := COALESCE(NEW.sent_by, v_uid);
    END IF;
  ELSE
    NEW.sent_at := NULL;
    NEW.sent_by := NULL;
  END IF;

  -- Mensagens amigáveis (os CHECKs são a rede de segurança)
  IF NOT public.is_valid_email(NEW.recipient_email) THEN
    RAISE EXCEPTION 'Informe um e-mail de destinatário válido.' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.recipient_name IS NOT NULL AND NOT public.is_single_line_text(NEW.recipient_name) THEN
    RAISE EXCEPTION 'O nome do destinatário não pode ter quebras de linha.' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.subject IS NULL OR length(NEW.subject) = 0 THEN
    RAISE EXCEPTION 'Informe o assunto.' USING ERRCODE = 'P0001';
  END IF;
  IF NOT public.is_single_line_text(NEW.subject) THEN
    RAISE EXCEPTION 'O assunto não pode ter quebras de linha.' USING ERRCODE = 'P0001';
  END IF;

  -- Jovem, alerta e acompanhamento: precisam existir (e ser visíveis a quem grava) e ser do MESMO jovem.
  IF NEW.youth_id IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.youth_id IS DISTINCT FROM OLD.youth_id) THEN
    PERFORM 1 FROM public.youth y WHERE y.id = NEW.youth_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Jovem não encontrado ou sem permissão.' USING ERRCODE = 'P0002';
    END IF;
  END IF;
  IF NEW.youth_id IS NOT NULL AND NEW.alert_id IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW.alert_id IS DISTINCT FROM OLD.alert_id) THEN
    SELECT a.youth_id INTO v_ref FROM public.alerts a WHERE a.id = NEW.alert_id;
    IF NOT FOUND OR v_ref IS DISTINCT FROM NEW.youth_id THEN
      RAISE EXCEPTION 'O alerta informado não pertence a este jovem.' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  IF NEW.youth_id IS NOT NULL AND NEW.follow_up_id IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW.follow_up_id IS DISTINCT FROM OLD.follow_up_id) THEN
    SELECT f.youth_id INTO v_ref FROM public.follow_ups f WHERE f.id = NEW.follow_up_id;
    IF NOT FOUND OR v_ref IS DISTINCT FROM NEW.youth_id THEN
      RAISE EXCEPTION 'O acompanhamento informado não pertence a este jovem.' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER communications_guard
  BEFORE INSERT OR UPDATE ON public.communications
  FOR EACH ROW EXECUTE PROCEDURE public.communications_guard();

REVOKE ALL ON FUNCTION public.communications_guard() FROM PUBLIC, anon, authenticated;


-- ============================================================================
-- 4. RLS
-- ============================================================================
-- Coordenador: lê, cria e edita tudo; exclui só rascunho/cancelada (a máquina de estados vale para ele também).
CREATE POLICY "coordinator_select_communications"
  ON public.communications FOR SELECT
  USING (public.get_my_role() = 'coordinator');

CREATE POLICY "coordinator_insert_communications"
  ON public.communications FOR INSERT
  WITH CHECK (public.get_my_role() = 'coordinator' AND created_by = auth.uid());

CREATE POLICY "coordinator_update_communications"
  ON public.communications FOR UPDATE
  USING (public.get_my_role() = 'coordinator')
  WITH CHECK (public.get_my_role() = 'coordinator');

CREATE POLICY "coordinator_delete_communications"
  ON public.communications FOR DELETE
  USING (public.get_my_role() = 'coordinator' AND status IN ('draft', 'cancelled'));

-- Líder: lê comunicações de jovens que estão atualmente nos seus grupos (o escopo segue o jovem).
CREATE POLICY "leader_select_communications"
  ON public.communications FOR SELECT
  USING (
    youth_id IN (
      SELECT y.id FROM public.youth y
      WHERE y.group_id IN (SELECT g.id FROM public.groups g WHERE g.leader_id = auth.uid())
    )
  );

-- Líder cria (sempre como autor) para jovens dos seus grupos.
CREATE POLICY "leader_insert_communications"
  ON public.communications FOR INSERT
  WITH CHECK (
    public.get_my_role() = 'leader'
    AND created_by = auth.uid()
    AND youth_id IN (
      SELECT y.id FROM public.youth y
      WHERE y.group_id IN (SELECT g.id FROM public.groups g WHERE g.leader_id = auth.uid())
    )
  );

-- Líder edita/marca só as que ele criou, enquanto o jovem estiver nos seus grupos. Sem DELETE para líder.
CREATE POLICY "leader_update_communications"
  ON public.communications FOR UPDATE
  USING (
    public.get_my_role() = 'leader'
    AND created_by = auth.uid()
    AND youth_id IN (
      SELECT y.id FROM public.youth y
      WHERE y.group_id IN (SELECT g.id FROM public.groups g WHERE g.leader_id = auth.uid())
    )
  )
  WITH CHECK (
    created_by = auth.uid()
    AND youth_id IN (
      SELECT y.id FROM public.youth y
      WHERE y.group_id IN (SELECT g.id FROM public.groups g WHERE g.leader_id = auth.uid())
    )
  );


-- ============================================================================
-- 5. RPC mark_communication
-- ============================================================================
-- Transições de status. SECURITY INVOKER: o RLS decide quem pode (coordenador; líder só nas suas), e o trigger
-- communications_guard valida a transição e carimba sent_at/sent_by (servidor). Não usa DEFINER de propósito: não há
-- nada que o chamador não possa fazer por UPDATE direto, então não há motivo para ampliar privilégios.
--   p_status         'sent' | 'failed' | 'cancelled' | 'draft' (draft só a partir de failed)
--   p_failure_reason 'client_not_opened' | 'invalid_address' | 'bounced' | 'other' (só para 'failed'; padrão 'other')
-- Retorna a linha atualizada. Erros (mensagens em pt-BR): P0002 não encontrada/sem permissão; P0001 status inválido,
-- motivo inválido, status já aplicado ou transição não permitida.
CREATE OR REPLACE FUNCTION public.mark_communication(
  p_id             uuid,
  p_status         text,
  p_failure_reason text DEFAULT NULL
)
RETURNS public.communications
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_old public.communications;
  v_new public.communications;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Sessão inválida.' USING ERRCODE = '42501';
  END IF;
  IF p_status IS NULL OR p_status NOT IN ('draft', 'sent', 'failed', 'cancelled') THEN
    RAISE EXCEPTION 'Status inválido.' USING ERRCODE = 'P0001';
  END IF;
  IF p_failure_reason IS NOT NULL
     AND p_failure_reason NOT IN ('client_not_opened', 'invalid_address', 'bounced', 'other') THEN
    RAISE EXCEPTION 'Motivo de falha inválido.' USING ERRCODE = 'P0001';
  END IF;

  -- FOR UPDATE aplica as policies de SELECT e UPDATE: fora do escopo => "não encontrada" (não vaza existência).
  SELECT * INTO v_old FROM public.communications WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Comunicação não encontrada ou sem permissão.' USING ERRCODE = 'P0002';
  END IF;
  IF v_old.status = p_status::communication_status THEN
    RAISE EXCEPTION 'A comunicação já está com esse status.' USING ERRCODE = 'P0001';
  END IF;

  UPDATE public.communications
     SET status = p_status::communication_status,
         failure_reason = CASE WHEN p_status = 'failed' THEN COALESCE(p_failure_reason, 'other') END
   WHERE id = p_id
   RETURNING * INTO v_new;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Comunicação não encontrada ou sem permissão.' USING ERRCODE = 'P0002';
  END IF;
  RETURN v_new;
END;
$$;

REVOKE ALL ON FUNCTION public.mark_communication(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mark_communication(uuid, text, text) TO authenticated;


-- ============================================================================
-- 6. Sugestão de destinatários
-- ============================================================================
-- Devolve o(s) destinatário(s) possível(is) para UM jovem: hoje, apenas o e-mail do próprio jovem (se válido).
-- Não há e-mail de responsável no schema, e profiles não tem e-mail (ver cabeçalho): nenhum dado de perfis alheios
-- é exposto. SECURITY DEFINER com escopo explícito (o RLS de youth também restringiria, mas aqui o escopo fica
-- visível): coordenador, ou líder do grupo ATUAL do jovem; fora disso, jovem inexistente ou sem sessão => vazio.
-- Colunas: kind ('youth'), name (nome do jovem), email (normalizado).
CREATE OR REPLACE FUNCTION public.suggest_communication_recipients(p_youth_id uuid)
RETURNS TABLE (kind text, name text, email text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT 'youth'::text, y.full_name, lower(btrim(y.email))
    FROM public.youth y
    LEFT JOIN public.groups g ON g.id = y.group_id
   WHERE y.id = p_youth_id
     AND auth.uid() IS NOT NULL
     AND (public.get_my_role() = 'coordinator' OR g.leader_id = auth.uid())
     AND public.is_valid_email(lower(btrim(y.email)))
$$;

REVOKE ALL ON FUNCTION public.suggest_communication_recipients(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.suggest_communication_recipients(uuid) TO authenticated;


-- ============================================================================
-- 7. Histórico operacional (activity_log)
-- ============================================================================
-- Recria os CHECKs de `action` e `entity_type` (definidos na 014) incluindo os valores novos. O nome do constraint
-- automático pode variar, então removemos QUALQUER CHECK de uma coluna só sobre essas duas colunas e recriamos com
-- nome fixo. Reexecutável.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT c.conname
      FROM pg_constraint c
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
     WHERE c.conrelid = 'public.activity_log'::regclass
       AND c.contype = 'c'
       AND array_length(c.conkey, 1) = 1
       AND a.attname IN ('action', 'entity_type')
  LOOP
    EXECUTE format('ALTER TABLE public.activity_log DROP CONSTRAINT %I', r.conname);
  END LOOP;
END;
$$;

ALTER TABLE public.activity_log ADD CONSTRAINT activity_log_action_check CHECK (action IN (
  'attendance_recorded', 'follow_up_created', 'follow_up_transferred', 'task_created',
  'task_completed', 'alert_resolved', 'alert_dismissed', 'youth_group_changed',
  'youth_activated', 'youth_deactivated', 'event_series_created', 'communication_sent'));

ALTER TABLE public.activity_log ADD CONSTRAINT activity_log_entity_type_check CHECK (entity_type IN (
  'event', 'follow_up', 'task', 'alert', 'youth', 'event_series', 'communication'));

-- communication_sent: só quando a comunicação passa a `sent`. Texto fixo; meta só com ids/enums
-- (nunca assunto, corpo, nome ou e-mail). O grupo registrado é o ATUAL do jovem (como nas demais ações do jovem).
CREATE OR REPLACE FUNCTION public.communications_log_activity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.activity_write(
    'communication_sent', 'communication', NEW.id, NEW.youth_id,
    (SELECT y.group_id FROM public.youth y WHERE y.id = NEW.youth_id),
    'Comunicação por e-mail marcada como enviada.',
    jsonb_build_object('channel', NEW.channel, 'recipient_kind', NEW.recipient_kind,
                       'alert_id', NEW.alert_id, 'follow_up_id', NEW.follow_up_id));
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.communications_log_activity() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER communications_log_activity
  AFTER UPDATE OF status ON public.communications
  FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM 'sent' AND NEW.status = 'sent')
  EXECUTE PROCEDURE public.communications_log_activity();

NOTIFY pgrst, 'reload schema';
