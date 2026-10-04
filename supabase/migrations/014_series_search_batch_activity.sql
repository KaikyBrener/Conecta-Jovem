-- Migration: 014_series_search_batch_activity.sql
-- Descrição: Fase 7 (bloco 8 e correlatos) — encontros recorrentes, busca global, ações em lote e histórico
-- operacional.
--
--   A) HISTÓRICO OPERACIONAL (`activity_log`) — criado primeiro porque as demais partes escrevem nele.
--   B) ENCONTROS RECORRENTES: `event_series`, `event_series_groups`, colunas novas em `events` e as RPCs
--      create_event_series / set_series_groups / extend_event_series / cancel_event_series_future.
--   C) BUSCA GLOBAL: search_norm() + global_search().
--   D) AÇÕES EM LOTE: batch_set_youth_active() (SECURITY INVOKER: o RLS vale) e batch_set_youth_group()
--      (SECURITY DEFINER com escopo explícito — o RLS de youth não deixa o líder desassociar jovens; ver D).
--
-- Não há ALTER TYPE ... ADD VALUE nesta migration. Nenhuma migration anterior foi editada: save_attendance
-- NÃO foi reescrita (o registro "chamada registrada" é feito por triggers de comando, ver A.4).
--
-- IMPORTANTE: Execute no SQL Editor do Supabase APÓS a migration 013.
-- ============================================================================


-- ============================================================================
-- A. HISTÓRICO OPERACIONAL
-- ============================================================================
-- Registro leve de "quem fez o quê" nas operações do dia a dia. NÃO é auditoria forense:
--   * só ações da lista fechada abaixo; o `summary` é SEMPRE um texto fixo em pt-BR montado pelo banco
--     (nunca texto livre digitado por usuários: motivos, observações, títulos e notas ficam de fora);
--   * `meta` carrega só ids/contagens/enums pequenos;
--   * escrita APENAS por triggers e funções SECURITY DEFINER (clientes só têm SELECT; trigger de imutabilidade);
--   * ações sem sessão (auth.uid() NULL: SQL Editor, migrations, service_role) NÃO são registradas — o histórico
--     descreve ações de pessoas autenticadas no app;
--   * resolução AUTOMÁTICA de alerta (condição deixou de valer, jovem inativado) não é registrada: só o
--     encerramento por uma pessoa (resolvido por usuário/tarefa, ou dispensado).
--
-- COMO LISTAR (frontend, paginado no servidor, sem RPC):
--   supabase.from('activity_log')
--     .select('id, occurred_at, actor_id, actor_name, action, entity_type, entity_id, youth_id, group_id, summary, meta',
--             { count: 'exact' })
--     .order('occurred_at', { ascending: false }).order('id', { ascending: false })
--     .range(from, to)
--   Filtros: .eq('youth_id', id) | .eq('group_id', id) | .in('action', [...]) | .gte('occurred_at', ini)
--   | .lt('occurred_at', fimExclusivo). Para o nome do jovem: embed `youth:youth_id(full_name)` (FK em public).
--   Use `actor_name` (cópia do nome no momento da ação) em vez de embed de profiles: o líder só lê o próprio perfil.
-- ============================================================================
CREATE TABLE public.activity_log (
  id          uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  occurred_at timestamp with time zone NOT NULL DEFAULT now(),
  actor_id    uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  actor_name  text,
  action      text NOT NULL CHECK (action IN (
                'attendance_recorded', 'follow_up_created', 'follow_up_transferred', 'task_created',
                'task_completed', 'alert_resolved', 'alert_dismissed', 'youth_group_changed',
                'youth_activated', 'youth_deactivated', 'event_series_created')),
  entity_type text NOT NULL CHECK (entity_type IN ('event', 'follow_up', 'task', 'alert', 'youth', 'event_series')),
  entity_id   uuid,
  youth_id    uuid REFERENCES public.youth(id)  ON DELETE SET NULL,
  group_id    uuid REFERENCES public.groups(id) ON DELETE SET NULL,
  summary     text NOT NULL CHECK (length(summary) BETWEEN 1 AND 200),
  meta        jsonb NOT NULL DEFAULT '{}'::jsonb
                CHECK (jsonb_typeof(meta) = 'object' AND octet_length(meta::text) <= 1000),
  -- Transação que gerou a entrada: só serve para juntar INSERT + UPDATE do mesmo comando de chamada
  -- (A.4) em UMA entrada. Preenchido apenas em 'attendance_recorded'.
  tx_id       bigint
);

CREATE INDEX activity_log_occurred_idx ON public.activity_log (occurred_at DESC, id DESC);
CREATE INDEX activity_log_youth_idx    ON public.activity_log (youth_id, occurred_at DESC) WHERE youth_id IS NOT NULL;
CREATE INDEX activity_log_group_idx    ON public.activity_log (group_id, occurred_at DESC) WHERE group_id IS NOT NULL;
CREATE INDEX activity_log_tx_idx       ON public.activity_log (tx_id) WHERE tx_id IS NOT NULL;

ALTER TABLE public.activity_log ENABLE ROW LEVEL SECURITY;

-- anon nada; authenticated SÓ lê. Sem INSERT/UPDATE/DELETE para clientes (e nenhuma policy de escrita).
REVOKE ALL ON public.activity_log FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.activity_log TO authenticated;

-- Coordenador lê tudo.
CREATE POLICY "coordinator_select_activity_log"
  ON public.activity_log FOR SELECT
  USING (public.get_my_role() = 'coordinator');

-- Líder lê:
--   * entradas ligadas a jovem que ESTÁ HOJE em um grupo seu (o histórico segue o jovem, como em attendance);
--   * entradas SEM jovem (ex.: chamada de um grupo) cujo grupo seja seu;
--   * 'youth_group_changed' do seu grupo (group_id = grupo novo, ou o antigo quando o jovem foi desassociado),
--     para o líder ver a movimentação mesmo depois que o jovem já não é dele.
-- Isto é mais estrito que "youth_id nos meus grupos OU group_id meu": entradas antigas de um jovem que mudou de
-- grupo não ficam visíveis ao líder anterior.
CREATE POLICY "leader_select_activity_log"
  ON public.activity_log FOR SELECT
  USING (
    public.get_my_role() = 'leader'
    AND (
      youth_id IN (
        SELECT y.id FROM public.youth y
         WHERE y.group_id IN (SELECT g.id FROM public.groups g WHERE g.leader_id = auth.uid())
      )
      OR (
        group_id IN (SELECT g.id FROM public.groups g WHERE g.leader_id = auth.uid())
        AND (youth_id IS NULL OR action = 'youth_group_changed')
      )
    )
  );

-- A.1 Imutabilidade (defesa em profundidade: clientes também não têm privilégio). As funções DEFINER e as ações
-- de FK (ON DELETE SET NULL) rodam como dono e passam.
CREATE OR REPLACE FUNCTION public.activity_log_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF current_user IN ('anon', 'authenticated') THEN
    RAISE EXCEPTION 'O histórico de atividades não pode ser alterado.' USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.activity_log_immutable() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER activity_log_immutable
  BEFORE UPDATE OR DELETE ON public.activity_log
  FOR EACH ROW EXECUTE PROCEDURE public.activity_log_immutable();

-- A.2 Escritor interno (sem EXECUTE para clientes). Sem sessão, não registra.
CREATE OR REPLACE FUNCTION public.activity_write(
  p_action      text,
  p_entity_type text,
  p_entity_id   uuid,
  p_youth_id    uuid,
  p_group_id    uuid,
  p_summary     text,
  p_meta        jsonb DEFAULT '{}'::jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid   uuid := auth.uid();
  v_actor uuid;
  v_name  text;
BEGIN
  IF v_uid IS NULL THEN
    RETURN;
  END IF;
  SELECT p.id, p.full_name INTO v_actor, v_name FROM public.profiles p WHERE p.id = v_uid;

  INSERT INTO public.activity_log (actor_id, actor_name, action, entity_type, entity_id, youth_id, group_id, summary, meta)
  VALUES (v_actor, v_name, p_action, p_entity_type, p_entity_id, p_youth_id, p_group_id, p_summary,
          COALESCE(p_meta, '{}'::jsonb));
END;
$$;

REVOKE ALL ON FUNCTION public.activity_write(text, text, uuid, uuid, uuid, text, jsonb) FROM PUBLIC, anon, authenticated;

-- A.3 Triggers de entidades

-- follow_up_created
CREATE OR REPLACE FUNCTION public.follow_ups_log_activity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.activity_write('follow_up_created', 'follow_up', NEW.id, NEW.youth_id, NEW.group_id,
                                'Acompanhamento registrado.',
                                jsonb_build_object('type', NEW.type::text));
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.follow_ups_log_activity() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER follow_ups_log_activity
  AFTER INSERT ON public.follow_ups
  FOR EACH ROW EXECUTE PROCEDURE public.follow_ups_log_activity();

-- follow_up_transferred (a transferência é gravada só por transfer_follow_up, que roda com o auth.uid() do chamador)
CREATE OR REPLACE FUNCTION public.follow_up_transfers_log_activity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_youth uuid;
  v_group uuid;
BEGIN
  SELECT f.youth_id, f.group_id INTO v_youth, v_group FROM public.follow_ups f WHERE f.id = NEW.follow_up_id;
  PERFORM public.activity_write('follow_up_transferred', 'follow_up', NEW.follow_up_id, v_youth, v_group,
                                'Acompanhamento transferido para outro responsável.',
                                jsonb_build_object('from_responsible_id', NEW.from_responsible_id,
                                                   'to_responsible_id', NEW.to_responsible_id));
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.follow_up_transfers_log_activity() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER follow_up_transfers_log_activity
  AFTER INSERT ON public.follow_up_transfers
  FOR EACH ROW EXECUTE PROCEDURE public.follow_up_transfers_log_activity();

-- task_created / task_completed
CREATE OR REPLACE FUNCTION public.tasks_log_activity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_group uuid;
BEGIN
  v_group := COALESCE(NEW.group_id, (SELECT y.group_id FROM public.youth y WHERE y.id = NEW.youth_id));

  IF TG_OP = 'INSERT' THEN
    PERFORM public.activity_write('task_created', 'task', NEW.id, NEW.youth_id, v_group,
                                  'Ação criada.',
                                  jsonb_build_object('priority', NEW.priority::text));
  END IF;

  IF NEW.status = 'done' AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'done') THEN
    PERFORM public.activity_write('task_completed', 'task', NEW.id, NEW.youth_id, v_group,
                                  'Ação concluída.',
                                  jsonb_build_object('priority', NEW.priority::text));
  END IF;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.tasks_log_activity() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER tasks_log_activity
  AFTER INSERT OR UPDATE OF status ON public.tasks
  FOR EACH ROW EXECUTE PROCEDURE public.tasks_log_activity();

-- alert_resolved / alert_dismissed — somente encerramento por PESSOA.
-- resolved_by é preenchido por alerts_guard (cliente) e por tasks_resolve_alert (tarefa concluída); as
-- resoluções automáticas (refresh_youth_alert, sync_rate_alert, alertas por tempo) deixam resolved_by NULL e
-- por isso não geram entrada, o que também evita duplicidade nos recálculos em cascata.
CREATE OR REPLACE FUNCTION public.alerts_log_activity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF OLD.status = 'open' AND NEW.status IN ('resolved', 'dismissed')
     AND (NEW.status = 'dismissed' OR NEW.resolved_by IS NOT NULL) THEN
    PERFORM public.activity_write(
      CASE WHEN NEW.status = 'dismissed' THEN 'alert_dismissed' ELSE 'alert_resolved' END,
      'alert', NEW.id, NEW.youth_id, NEW.group_id,
      CASE WHEN NEW.status = 'dismissed' THEN 'Alerta dispensado.' ELSE 'Alerta resolvido.' END,
      jsonb_build_object('type', NEW.type::text, 'severity', NEW.severity::text));
  END IF;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.alerts_log_activity() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER alerts_log_activity
  AFTER UPDATE OF status ON public.alerts
  FOR EACH ROW
  WHEN (OLD.status = 'open' AND NEW.status IN ('resolved', 'dismissed'))
  EXECUTE PROCEDURE public.alerts_log_activity();

-- youth_group_changed / youth_activated / youth_deactivated
CREATE OR REPLACE FUNCTION public.youth_log_activity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.group_id IS DISTINCT FROM OLD.group_id THEN
    PERFORM public.activity_write('youth_group_changed', 'youth', NEW.id, NEW.id,
                                  COALESCE(NEW.group_id, OLD.group_id),
                                  CASE WHEN NEW.group_id IS NULL THEN 'Jovem desassociado do grupo.'
                                       ELSE 'Grupo do jovem alterado.' END,
                                  jsonb_build_object('from_group_id', OLD.group_id, 'to_group_id', NEW.group_id));
  END IF;
  IF NEW.is_active IS DISTINCT FROM OLD.is_active THEN
    PERFORM public.activity_write(
      CASE WHEN NEW.is_active THEN 'youth_activated' ELSE 'youth_deactivated' END,
      'youth', NEW.id, NEW.id, NEW.group_id,
      CASE WHEN NEW.is_active THEN 'Jovem reativado.' ELSE 'Jovem inativado.' END,
      '{}'::jsonb);
  END IF;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.youth_log_activity() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER youth_log_activity
  AFTER UPDATE OF group_id, is_active ON public.youth
  FOR EACH ROW
  WHEN (OLD.group_id IS DISTINCT FROM NEW.group_id OR OLD.is_active IS DISTINCT FROM NEW.is_active)
  EXECUTE PROCEDURE public.youth_log_activity();

-- A.4 attendance_recorded — UMA entrada por chamada (por encontro + grupo), NÃO por linha.
-- DECISÃO: save_attendance NÃO foi reescrita (é SECURITY INVOKER e não pode escrever em activity_log, e dar
-- EXECUTE de um escritor aos clientes permitiria forjar entradas). Em vez disso, triggers de COMANDO
-- (FOR EACH STATEMENT) com tabelas de transição agregam o comando inteiro:
--   * o upsert de save_attendance dispara o trigger de INSERT (linhas novas) e o de UPDATE (linhas que mudaram
--     `present`); as duas contribuições da mesma transação/encontro/grupo/autor são somadas na MESMA entrada
--     (tx_id), então uma chamada = uma entrada;
--   * linhas inalteradas (mesmo `present`) e a reescrita de attendance.group_id (trigger 012) não geram entrada;
--   * um comando que atinge vários grupos do mesmo encontro gera uma entrada por grupo (o líder só enxerga o seu);
--   * gravações diretas na tabela (coordenador) também são registradas, pelo mesmo caminho.
-- (Postgres não permite coluna em UPDATE OF junto com tabelas de transição; o filtro é feito na função.)
CREATE OR REPLACE FUNCTION public.attendance_log_activity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid   uuid := auth.uid();
  v_actor uuid;
  v_name  text;
  v_tx    bigint;
  r       record;
  v_id    uuid;
  v_p     integer;
  v_a     integer;
  v_rows  jsonb;
BEGIN
  IF v_uid IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT p.id, p.full_name INTO v_actor, v_name FROM public.profiles p WHERE p.id = v_uid;
  v_tx := txid_current();

  -- INSERT: todas as linhas novas; UPDATE: só as que mudaram `present`. (old_rows só existe no trigger de
  -- UPDATE, por isso as duas consultas ficam em ramos separados.)
  IF TG_OP = 'INSERT' THEN
    SELECT COALESCE(jsonb_agg(jsonb_build_object('event_id', s.event_id, 'group_id', s.group_id,
                                                 'p', s.p, 'a', s.a)), '[]'::jsonb)
      INTO v_rows
      FROM (
        SELECT nr.event_id, nr.group_id,
               count(*) FILTER (WHERE nr.present)     AS p,
               count(*) FILTER (WHERE NOT nr.present) AS a
          FROM new_rows nr
         GROUP BY nr.event_id, nr.group_id
      ) s;
  ELSE
    SELECT COALESCE(jsonb_agg(jsonb_build_object('event_id', s.event_id, 'group_id', s.group_id,
                                                 'p', s.p, 'a', s.a)), '[]'::jsonb)
      INTO v_rows
      FROM (
        SELECT nr.event_id, nr.group_id,
               count(*) FILTER (WHERE nr.present)     AS p,
               count(*) FILTER (WHERE NOT nr.present) AS a
          FROM new_rows nr
          JOIN old_rows orow ON orow.id = nr.id
         WHERE orow.present IS DISTINCT FROM nr.present
         GROUP BY nr.event_id, nr.group_id
      ) s;
  END IF;

  FOR r IN
    SELECT (e ->> 'event_id')::uuid AS event_id, (e ->> 'group_id')::uuid AS group_id,
           (e ->> 'p')::integer AS p, (e ->> 'a')::integer AS a
      FROM jsonb_array_elements(v_rows) AS e
  LOOP
    SELECT a.id, (a.meta ->> 'present')::integer, (a.meta ->> 'absent')::integer
      INTO v_id, v_p, v_a
      FROM public.activity_log a
     WHERE a.tx_id = v_tx AND a.action = 'attendance_recorded'
       AND a.entity_id = r.event_id
       AND a.group_id IS NOT DISTINCT FROM r.group_id
       AND a.actor_id IS NOT DISTINCT FROM v_actor
     LIMIT 1;

    IF v_id IS NOT NULL THEN
      v_p := v_p + r.p;
      v_a := v_a + r.a;
      UPDATE public.activity_log
         SET meta = jsonb_build_object('present', v_p, 'absent', v_a),
             summary = format('Chamada registrada: %s %s e %s %s.',
                              v_p, CASE WHEN v_p = 1 THEN 'presente' ELSE 'presentes' END,
                              v_a, CASE WHEN v_a = 1 THEN 'ausente' ELSE 'ausentes' END)
       WHERE id = v_id;
    ELSE
      INSERT INTO public.activity_log (actor_id, actor_name, action, entity_type, entity_id, youth_id, group_id,
                                       summary, meta, tx_id)
      VALUES (v_actor, v_name, 'attendance_recorded', 'event', r.event_id, NULL, r.group_id,
              format('Chamada registrada: %s %s e %s %s.',
                     r.p, CASE WHEN r.p = 1 THEN 'presente' ELSE 'presentes' END,
                     r.a, CASE WHEN r.a = 1 THEN 'ausente' ELSE 'ausentes' END),
              jsonb_build_object('present', r.p, 'absent', r.a), v_tx);
    END IF;
  END LOOP;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.attendance_log_activity() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER attendance_log_activity_ins
  AFTER INSERT ON public.attendance
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE PROCEDURE public.attendance_log_activity();

CREATE TRIGGER attendance_log_activity_upd
  AFTER UPDATE ON public.attendance
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE PROCEDURE public.attendance_log_activity();


-- ============================================================================
-- B. ENCONTROS RECORRENTES
-- ============================================================================
-- Modelo: uma SÉRIE (dia da semana + horário + recorrência + período) gera ENCONTROS INDIVIDUAIS (linhas normais
-- de `events`, status 'scheduled'). Depois de gerados, cada encontro vive sozinho: dá para editar, cancelar ou
-- excluir um sem afetar os demais.
--
-- Recorrências: 'weekly' (toda semana), 'biweekly' (a cada 14 dias) e 'monthly_nth_weekday' (mensal no N-ésimo
-- dia da semana do mês). No mensal, N é derivado da PRIMEIRA ocorrência (ex.: início em um sábado do dia 10
-- => 2º sábado de cada mês); se N = 5, vale o ÚLTIMO dia da semana do mês (o 5º não existe em todo mês).
--
-- Fuso: o horário é local America/Sao_Paulo; events.event_date (timestamptz) guarda o instante correspondente.
-- A "data da ocorrência" (events.series_date) é a data LOCAL, e é ela que entra na chave de unicidade
-- (series_id, series_date): gerar de novo nunca duplica, mesmo que o instante em UTC caia no dia seguinte
-- (ex.: 22h local = 01h UTC do dia seguinte). series_date é a "vaga" da ocorrência e NÃO muda quando o
-- encontro é remarcado, então uma extensão/regeração não recria o encontro que foi movido.
--
-- Limites: período máximo de 731 dias (2 anos) a partir de start_date e no máximo 120 ocorrências por série
-- (o limite de 120 é defensivo: com 731 dias a recorrência semanal gera no máximo 105).
--
-- Critério de "encontro editado individualmente" (events.series_customized = true), feito por trigger quando um
-- CLIENTE (anon/authenticated) altera título, descrição ou data de um encontro de série, ou adiciona/remove
-- grupos dele (ex.: save_event). As RPCs da série rodam como dono do banco e NÃO marcam. set_series_groups
-- ignora encontros marcados, os que não estão 'scheduled' e os de data anterior ao corte.
-- ============================================================================
CREATE TABLE public.event_series (
  id                  uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  name                text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  weekday             smallint NOT NULL CHECK (weekday BETWEEN 0 AND 6),     -- 0 = domingo
  start_time          time NOT NULL,                                          -- horário local (America/Sao_Paulo)
  recurrence          text NOT NULL CHECK (recurrence IN ('weekly', 'biweekly', 'monthly_nth_weekday')),
  start_date          date NOT NULL,
  end_date            date NOT NULL,
  default_description text,
  created_by          uuid REFERENCES public.profiles(id) ON DELETE SET NULL DEFAULT auth.uid(),
  created_at          timestamp with time zone NOT NULL DEFAULT now(),
  active              boolean NOT NULL DEFAULT true,
  CHECK (end_date >= start_date),
  CHECK (end_date - start_date <= 731)
);

-- Grupos padrão da série (aplicados aos encontros novos e por set_series_groups). Vazio = grupos pendentes.
CREATE TABLE public.event_series_groups (
  series_id uuid NOT NULL REFERENCES public.event_series(id) ON DELETE CASCADE,
  group_id  uuid NOT NULL REFERENCES public.groups(id)       ON DELETE CASCADE,
  PRIMARY KEY (series_id, group_id)
);
CREATE INDEX event_series_groups_group_idx ON public.event_series_groups (group_id);

ALTER TABLE public.events
  ADD COLUMN series_id         uuid REFERENCES public.event_series(id) ON DELETE SET NULL,
  ADD COLUMN series_date       date,
  ADD COLUMN series_customized boolean NOT NULL DEFAULT false;

CREATE UNIQUE INDEX events_series_slot_uidx ON public.events (series_id, series_date) WHERE series_id IS NOT NULL;
CREATE INDEX events_series_idx ON public.events (series_id, event_date) WHERE series_id IS NOT NULL;

ALTER TABLE public.event_series        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.event_series_groups ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.event_series, public.event_series_groups FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.event_series, public.event_series_groups TO authenticated;

CREATE POLICY "coordinator_all_event_series"
  ON public.event_series FOR ALL
  USING (public.get_my_role() = 'coordinator')
  WITH CHECK (public.get_my_role() = 'coordinator');

-- Líder lê apenas séries que tenham ao menos um encontro visível a ele (os encontros seguem o RLS de events,
-- isto é, vinculados aos seus grupos). Série só com grupos pendentes não aparece para líder.
CREATE POLICY "leader_select_event_series"
  ON public.event_series FOR SELECT
  USING (
    public.get_my_role() = 'leader'
    AND EXISTS (SELECT 1 FROM public.events e WHERE e.series_id = event_series.id)
  );

CREATE POLICY "coordinator_all_event_series_groups"
  ON public.event_series_groups FOR ALL
  USING (public.get_my_role() = 'coordinator')
  WITH CHECK (public.get_my_role() = 'coordinator');

CREATE POLICY "leader_select_event_series_groups"
  ON public.event_series_groups FOR SELECT
  USING (group_id IN (SELECT g.id FROM public.groups g WHERE g.leader_id = auth.uid()));

-- B.1 Guarda de events: deriva series_date e marca "editado individualmente"
CREATE OR REPLACE FUNCTION public.events_series_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_client boolean := current_user IN ('anon', 'authenticated');
BEGIN
  IF NEW.series_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.series_date IS NULL THEN
      NEW.series_date := (NEW.event_date AT TIME ZONE 'America/Sao_Paulo')::date;
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.series_id IS DISTINCT FROM OLD.series_id THEN
    -- vinculado manualmente a uma série: a vaga é a data local atual; conta como editado
    NEW.series_date := (NEW.event_date AT TIME ZONE 'America/Sao_Paulo')::date;
    IF v_client THEN NEW.series_customized := true; END IF;
  ELSIF v_client THEN
    NEW.series_date := OLD.series_date;          -- a vaga da ocorrência não muda por edição de cliente
    IF NEW.title IS DISTINCT FROM OLD.title
       OR NEW.description IS DISTINCT FROM OLD.description
       OR NEW.event_date IS DISTINCT FROM OLD.event_date THEN
      NEW.series_customized := true;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.events_series_guard() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER events_series_guard
  BEFORE INSERT OR UPDATE ON public.events
  FOR EACH ROW EXECUTE PROCEDURE public.events_series_guard();

-- Mudança de grupos de um encontro de série feita por cliente (save_event) também conta como edição individual.
-- SECURITY INVOKER: só quem pode escrever em events consegue marcar (coordenador).
CREATE OR REPLACE FUNCTION public.event_groups_series_customize()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF current_user IN ('anon', 'authenticated') THEN
    UPDATE public.events
       SET series_customized = true
     WHERE id = CASE WHEN TG_OP = 'DELETE' THEN OLD.event_id ELSE NEW.event_id END
       AND series_id IS NOT NULL
       AND NOT series_customized;
  END IF;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.event_groups_series_customize() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER event_groups_series_customize
  AFTER INSERT OR DELETE ON public.event_groups
  FOR EACH ROW EXECUTE PROCEDURE public.event_groups_series_customize();

-- B.2 Datas das ocorrências (interna). p_start é o âncora: a 1ª ocorrência é o primeiro p_weekday >= p_start.
CREATE OR REPLACE FUNCTION public.series_dates(
  p_weekday    integer,
  p_recurrence text,
  p_start      date,
  p_end        date
)
RETURNS SETOF date
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE
  v_first date;
  v_n     integer;
  v_m     date;
  v_cand  date;
BEGIN
  v_first := p_start + ((p_weekday - extract(dow FROM p_start)::integer + 7) % 7);
  IF v_first > p_end THEN
    RETURN;
  END IF;

  IF p_recurrence IN ('weekly', 'biweekly') THEN
    RETURN QUERY
      SELECT d::date
        FROM generate_series(v_first::timestamp, p_end::timestamp,
                             CASE WHEN p_recurrence = 'weekly' THEN interval '7 days' ELSE interval '14 days' END) AS d;
    RETURN;
  END IF;

  -- monthly_nth_weekday
  v_n := (extract(day FROM v_first)::integer - 1) / 7 + 1;      -- 1..5
  v_m := date_trunc('month', v_first)::date;
  WHILE v_m <= p_end LOOP
    v_cand := v_m + ((p_weekday - extract(dow FROM v_m)::integer + 7) % 7) + 7 * (v_n - 1);
    IF v_cand >= (v_m + interval '1 month')::date THEN
      v_cand := v_cand - 7;                                      -- 5º dia da semana inexistente => o último
    END IF;
    IF v_cand >= v_first AND v_cand <= p_end THEN
      RETURN NEXT v_cand;
    END IF;
    v_m := (v_m + interval '1 month')::date;
  END LOOP;
  RETURN;
END;
$$;
REVOKE ALL ON FUNCTION public.series_dates(integer, text, date, date) FROM PUBLIC, anon, authenticated;

-- B.3 create_event_series
-- Retorno: {"series_id": uuid, "created": n, "skipped": n}
-- Coordenador apenas. Atômica (uma transação). Grupos podem ser vazios (pendentes). Erros pt-BR (P0001/42501).
CREATE OR REPLACE FUNCTION public.create_event_series(
  p_name        text,
  p_weekday     integer,
  p_start_time  time,
  p_recurrence  text,
  p_start_date  date,
  p_end_date    date,
  p_description text,
  p_group_ids   uuid[] DEFAULT '{}'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid     uuid := auth.uid();
  v_name    text := btrim(COALESCE(p_name, ''));
  v_desc    text := NULLIF(btrim(COALESCE(p_description, '')), '');
  v_groups  uuid[];
  v_dates   date[];
  v_series  uuid;
  v_created integer;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Não autenticado.' USING ERRCODE = '42501';
  END IF;
  IF public.get_my_role() IS DISTINCT FROM 'coordinator' THEN
    RAISE EXCEPTION 'Apenas coordenadores podem criar séries de encontros.' USING ERRCODE = '42501';
  END IF;

  IF v_name = '' THEN
    RAISE EXCEPTION 'Informe o nome da série.' USING ERRCODE = 'P0001';
  END IF;
  IF length(v_name) > 120 THEN
    RAISE EXCEPTION 'O nome da série pode ter no máximo 120 caracteres.' USING ERRCODE = 'P0001';
  END IF;
  IF p_weekday IS NULL OR p_weekday NOT BETWEEN 0 AND 6 THEN
    RAISE EXCEPTION 'Dia da semana inválido (use 0 = domingo até 6 = sábado).' USING ERRCODE = 'P0001';
  END IF;
  IF p_start_time IS NULL THEN
    RAISE EXCEPTION 'Informe o horário do encontro.' USING ERRCODE = 'P0001';
  END IF;
  IF p_recurrence IS NULL OR p_recurrence NOT IN ('weekly', 'biweekly', 'monthly_nth_weekday') THEN
    RAISE EXCEPTION 'Recorrência inválida.' USING ERRCODE = 'P0001';
  END IF;
  IF p_start_date IS NULL OR p_end_date IS NULL THEN
    RAISE EXCEPTION 'Informe a data inicial e a data final da série.' USING ERRCODE = 'P0001';
  END IF;
  IF p_end_date < p_start_date THEN
    RAISE EXCEPTION 'A data final não pode ser anterior à data inicial.' USING ERRCODE = 'P0001';
  END IF;
  IF p_end_date - p_start_date > 731 THEN
    RAISE EXCEPTION 'O período da série não pode passar de 2 anos.' USING ERRCODE = 'P0001';
  END IF;

  SELECT COALESCE(array_agg(DISTINCT g), '{}') INTO v_groups
    FROM unnest(COALESCE(p_group_ids, '{}')) AS g WHERE g IS NOT NULL;
  IF (SELECT count(*) FROM public.groups WHERE id = ANY (v_groups)) <> cardinality(v_groups) THEN
    RAISE EXCEPTION 'Há grupos inexistentes na lista.' USING ERRCODE = 'P0001';
  END IF;

  SELECT array_agg(d ORDER BY d) INTO v_dates
    FROM public.series_dates(p_weekday, p_recurrence, p_start_date, p_end_date) AS d;
  IF v_dates IS NULL THEN
    RAISE EXCEPTION 'O período informado não contém nenhuma data para este dia da semana.' USING ERRCODE = 'P0001';
  END IF;
  IF cardinality(v_dates) > 120 THEN
    RAISE EXCEPTION 'A série geraria mais de 120 encontros. Reduza o período.' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO public.event_series (name, weekday, start_time, recurrence, start_date, end_date,
                                   default_description, created_by)
  VALUES (v_name, p_weekday, p_start_time, p_recurrence, p_start_date, p_end_date, v_desc, v_uid)
  RETURNING id INTO v_series;

  INSERT INTO public.event_series_groups (series_id, group_id)
  SELECT v_series, g FROM unnest(v_groups) AS g;

  WITH ins AS (
    INSERT INTO public.events (title, description, event_date, status, created_by, series_id, series_date)
    SELECT v_name, v_desc, ((d + p_start_time)::timestamp AT TIME ZONE 'America/Sao_Paulo'),
           'scheduled', v_uid, v_series, d
      FROM unnest(v_dates) AS d
    ON CONFLICT (series_id, series_date) WHERE series_id IS NOT NULL DO NOTHING
    RETURNING id
  ), grp AS (
    INSERT INTO public.event_groups (event_id, group_id)
    SELECT ins.id, g FROM ins CROSS JOIN unnest(v_groups) AS g
    RETURNING 1
  )
  SELECT count(*) INTO v_created FROM ins;

  PERFORM public.activity_write('event_series_created', 'event_series', v_series, NULL, NULL,
                                'Série de encontros criada.',
                                jsonb_build_object('recurrence', p_recurrence, 'created', v_created));

  RETURN jsonb_build_object('series_id', v_series, 'created', v_created,
                            'skipped', cardinality(v_dates) - v_created);
END;
$$;

-- B.4 set_series_groups
-- Define os grupos padrão da série e os aplica aos encontros FUTUROS ainda 'scheduled' (series_date >= p_from),
-- exceto os editados individualmente (series_customized). Passados, realizados e cancelados não são tocados.
-- Retorno: {"series_id": uuid, "updated": n, "skipped": n}  (skipped = elegíveis por data/status, mas editados)
CREATE OR REPLACE FUNCTION public.set_series_groups(
  p_series_id uuid,
  p_group_ids uuid[],
  p_from      date DEFAULT public.app_today()
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_groups  uuid[];
  v_from    date := COALESCE(p_from, public.app_today());
  v_ids     uuid[];
  v_skipped integer;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Não autenticado.' USING ERRCODE = '42501';
  END IF;
  IF public.get_my_role() IS DISTINCT FROM 'coordinator' THEN
    RAISE EXCEPTION 'Apenas coordenadores podem alterar séries de encontros.' USING ERRCODE = '42501';
  END IF;

  PERFORM 1 FROM public.event_series WHERE id = p_series_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Série não encontrada.' USING ERRCODE = 'P0002';
  END IF;

  SELECT COALESCE(array_agg(DISTINCT g), '{}') INTO v_groups
    FROM unnest(COALESCE(p_group_ids, '{}')) AS g WHERE g IS NOT NULL;
  IF (SELECT count(*) FROM public.groups WHERE id = ANY (v_groups)) <> cardinality(v_groups) THEN
    RAISE EXCEPTION 'Há grupos inexistentes na lista.' USING ERRCODE = 'P0001';
  END IF;

  -- grupos padrão da série (para encontros gerados depois)
  DELETE FROM public.event_series_groups WHERE series_id = p_series_id AND group_id <> ALL (v_groups);
  INSERT INTO public.event_series_groups (series_id, group_id)
  SELECT p_series_id, g FROM unnest(v_groups) AS g
  ON CONFLICT DO NOTHING;

  SELECT COALESCE(array_agg(e.id), '{}') INTO v_ids
    FROM public.events e
   WHERE e.series_id = p_series_id AND e.status = 'scheduled'
     AND NOT e.series_customized AND e.series_date >= v_from;

  SELECT count(*) INTO v_skipped
    FROM public.events e
   WHERE e.series_id = p_series_id AND e.status = 'scheduled'
     AND e.series_customized AND e.series_date >= v_from;

  DELETE FROM public.event_groups WHERE event_id = ANY (v_ids) AND group_id <> ALL (v_groups);
  INSERT INTO public.event_groups (event_id, group_id)
  SELECT e, g FROM unnest(v_ids) AS e CROSS JOIN unnest(v_groups) AS g
  ON CONFLICT DO NOTHING;

  RETURN jsonb_build_object('series_id', p_series_id, 'updated', cardinality(v_ids), 'skipped', v_skipped);
END;
$$;

-- B.5 extend_event_series — idempotente. Só gera as datas POSTERIORES à data final atual (não recria
-- ocorrências excluídas/remarcadas no período antigo). Nova data final igual à atual = nada a fazer.
-- Retorno: {"series_id": uuid, "created": n, "skipped": n}
CREATE OR REPLACE FUNCTION public.extend_event_series(p_series_id uuid, p_new_end_date date)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid     uuid := auth.uid();
  v_s       public.event_series%ROWTYPE;
  v_groups  uuid[];
  v_dates   date[];
  v_total   integer;
  v_created integer := 0;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Não autenticado.' USING ERRCODE = '42501';
  END IF;
  IF public.get_my_role() IS DISTINCT FROM 'coordinator' THEN
    RAISE EXCEPTION 'Apenas coordenadores podem alterar séries de encontros.' USING ERRCODE = '42501';
  END IF;
  IF p_new_end_date IS NULL THEN
    RAISE EXCEPTION 'Informe a nova data final.' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_s FROM public.event_series WHERE id = p_series_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Série não encontrada.' USING ERRCODE = 'P0002';
  END IF;
  IF NOT v_s.active THEN
    RAISE EXCEPTION 'Esta série foi encerrada e não pode ser estendida.' USING ERRCODE = 'P0001';
  END IF;
  IF p_new_end_date < v_s.end_date THEN
    RAISE EXCEPTION 'A nova data final não pode ser anterior à data final atual.' USING ERRCODE = 'P0001';
  END IF;
  IF p_new_end_date = v_s.end_date THEN
    RETURN jsonb_build_object('series_id', v_s.id, 'created', 0, 'skipped', 0);
  END IF;
  IF p_new_end_date - v_s.start_date > 731 THEN
    RAISE EXCEPTION 'O período da série não pode passar de 2 anos.' USING ERRCODE = 'P0001';
  END IF;

  SELECT count(*) INTO v_total
    FROM public.series_dates(v_s.weekday, v_s.recurrence, v_s.start_date, p_new_end_date);
  IF v_total > 120 THEN
    RAISE EXCEPTION 'A série geraria mais de 120 encontros. Reduza o período.' USING ERRCODE = 'P0001';
  END IF;

  SELECT COALESCE(array_agg(group_id), '{}') INTO v_groups
    FROM public.event_series_groups WHERE series_id = v_s.id;

  SELECT array_agg(d ORDER BY d) INTO v_dates
    FROM public.series_dates(v_s.weekday, v_s.recurrence, v_s.start_date, p_new_end_date) AS d
   WHERE d > v_s.end_date;

  IF v_dates IS NOT NULL THEN
    WITH ins AS (
      INSERT INTO public.events (title, description, event_date, status, created_by, series_id, series_date)
      SELECT v_s.name, v_s.default_description, ((d + v_s.start_time)::timestamp AT TIME ZONE 'America/Sao_Paulo'),
             'scheduled', v_uid, v_s.id, d
        FROM unnest(v_dates) AS d
      ON CONFLICT (series_id, series_date) WHERE series_id IS NOT NULL DO NOTHING
      RETURNING id
    ), grp AS (
      INSERT INTO public.event_groups (event_id, group_id)
      SELECT ins.id, g FROM ins CROSS JOIN unnest(v_groups) AS g
      RETURNING 1
    )
    SELECT count(*) INTO v_created FROM ins;
  END IF;

  UPDATE public.event_series SET end_date = p_new_end_date WHERE id = v_s.id;

  RETURN jsonb_build_object('series_id', v_s.id, 'created', v_created,
                            'skipped', COALESCE(cardinality(v_dates), 0) - v_created);
END;
$$;

-- B.6 cancel_event_series_future — cancela os encontros FUTUROS ('scheduled' e com data/hora depois de agora) que
-- ainda não têm nenhuma chamada registrada, e encerra a série (active = false). Nunca apaga chamada nem toca em
-- encontros passados, realizados ou que já têm presença.
-- Retorno: {"series_id": uuid, "cancelled": n, "skipped": n}  (skipped = futuros que já tinham chamada)
CREATE OR REPLACE FUNCTION public.cancel_event_series_future(p_series_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_cancelled integer;
  v_skipped   integer;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Não autenticado.' USING ERRCODE = '42501';
  END IF;
  IF public.get_my_role() IS DISTINCT FROM 'coordinator' THEN
    RAISE EXCEPTION 'Apenas coordenadores podem alterar séries de encontros.' USING ERRCODE = '42501';
  END IF;

  PERFORM 1 FROM public.event_series WHERE id = p_series_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Série não encontrada.' USING ERRCODE = 'P0002';
  END IF;

  SELECT count(*) INTO v_skipped
    FROM public.events e
   WHERE e.series_id = p_series_id AND e.status = 'scheduled' AND e.event_date > now()
     AND EXISTS (SELECT 1 FROM public.attendance a WHERE a.event_id = e.id);

  WITH c AS (
    UPDATE public.events e
       SET status = 'cancelled'
     WHERE e.series_id = p_series_id AND e.status = 'scheduled' AND e.event_date > now()
       AND NOT EXISTS (SELECT 1 FROM public.attendance a WHERE a.event_id = e.id)
    RETURNING e.id
  )
  SELECT count(*) INTO v_cancelled FROM c;

  UPDATE public.event_series SET active = false WHERE id = p_series_id;

  RETURN jsonb_build_object('series_id', p_series_id, 'cancelled', v_cancelled, 'skipped', v_skipped);
END;
$$;

REVOKE ALL ON FUNCTION public.create_event_series(text, integer, time, text, date, date, text, uuid[]) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.set_series_groups(uuid, uuid[], date)  FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.extend_event_series(uuid, date)        FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.cancel_event_series_future(uuid)       FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_event_series(text, integer, time, text, date, date, text, uuid[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_series_groups(uuid, uuid[], date)  TO authenticated;
GRANT EXECUTE ON FUNCTION public.extend_event_series(uuid, date)        TO authenticated;
GRANT EXECUTE ON FUNCTION public.cancel_event_series_future(uuid)       TO authenticated;


-- ============================================================================
-- C. BUSCA GLOBAL
-- ============================================================================
-- Normalização própria (sem extensão): minúsculas e sem acentos do português. Evita depender de `unaccent`
-- (que no Supabase vive no schema `extensions` e precisa ser habilitada) e funciona igual no Supabase e no PGlite.
-- IMMUTABLE => pode ser usada em índice. As letras acentuadas maiúsculas entram no translate porque, em bancos
-- com locale "C", lower() não converte caracteres não ASCII.
CREATE OR REPLACE FUNCTION public.search_norm(p_text text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog
AS $$
  SELECT lower(translate(p_text,
    'ÁÀÂÃÄÅÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇÑáàâãäåéèêëíìîïóòôõöúùûüçñ',
    'AAAAAAEEEEIIIIOOOOOUUUUCNaaaaaaeeeeiiiiooooouuuucn'))
$$;

REVOKE ALL ON FUNCTION public.search_norm(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.search_norm(text) TO authenticated;

-- Índices btree (busca por prefixo). A busca "contém" varre a tabela (volume pequeno); pg_trgm não é usado
-- para não depender de extensão nos dois ambientes.
CREATE INDEX youth_name_search_idx  ON public.youth  (public.search_norm(full_name) text_pattern_ops);
CREATE INDEX groups_name_search_idx ON public.groups (public.search_norm(name) text_pattern_ops);
CREATE INDEX events_title_search_idx ON public.events (public.search_norm(title) text_pattern_ops);

-- global_search — SECURITY INVOKER: tudo passa pelo RLS de youth/groups/events/profiles do chamador
-- (coordenador: tudo; líder: só jovens/grupos/encontros dos seus grupos; líder só enxerga o próprio perfil).
-- Entrada: remove , ( ) " * % _ \ (vira espaço), colapsa espaços, normaliza (sem acento/minúsculas) e escapa
-- curingas LIKE; menos de 2 caracteres => listas vazias (sem erro). p_limit: padrão 8, entre 1 e 20.
-- Ordem: nome começa com o termo, depois alguma palavra começa com o termo, depois contém; desempate por nome.
-- Retorno: {"youth":[{id,full_name,group_name,is_active}], "groups":[{id,name,leader_name}],
--           "events":[{id,title,event_date,status}]}
CREATE OR REPLACE FUNCTION public.global_search(p_query text, p_limit integer DEFAULT 8)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_q      text;
  v_esc    text;
  v_lim    integer := LEAST(GREATEST(COALESCE(p_limit, 8), 1), 20);
  v_pre    text;
  v_word   text;
  v_any    text;
  v_youth  jsonb;
  v_groups jsonb;
  v_events jsonb;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Não autenticado.' USING ERRCODE = '42501';
  END IF;

  v_q := btrim(regexp_replace(regexp_replace(COALESCE(p_query, ''), '[,()"*%_\\]', ' ', 'g'), '\s+', ' ', 'g'));
  v_q := public.search_norm(v_q);
  IF length(v_q) < 2 THEN
    RETURN jsonb_build_object('youth', '[]'::jsonb, 'groups', '[]'::jsonb, 'events', '[]'::jsonb);
  END IF;

  v_esc  := replace(replace(replace(v_q, '\', '\\'), '%', '\%'), '_', '\_');
  v_pre  := v_esc || '%';
  v_word := '% ' || v_esc || '%';
  v_any  := '%' || v_esc || '%';

  SELECT COALESCE(jsonb_agg(jsonb_build_object('id', x.id, 'full_name', x.full_name,
                                               'group_name', x.group_name, 'is_active', x.is_active)
                            ORDER BY x.rank, x.nm, x.id), '[]'::jsonb)
    INTO v_youth
    FROM (
      SELECT y.id, y.full_name, g.name AS group_name, y.is_active,
             public.search_norm(y.full_name) AS nm,
             CASE WHEN public.search_norm(y.full_name) LIKE v_pre  ESCAPE '\' THEN 0
                  WHEN public.search_norm(y.full_name) LIKE v_word ESCAPE '\' THEN 1
                  ELSE 2 END AS rank
        FROM public.youth y
        LEFT JOIN public.groups g ON g.id = y.group_id
       WHERE public.search_norm(y.full_name) LIKE v_any ESCAPE '\'
       ORDER BY rank, nm, y.id
       LIMIT v_lim
    ) x;

  SELECT COALESCE(jsonb_agg(jsonb_build_object('id', x.id, 'name', x.name, 'leader_name', x.leader_name)
                            ORDER BY x.rank, x.nm, x.id), '[]'::jsonb)
    INTO v_groups
    FROM (
      SELECT g.id, g.name, p.full_name AS leader_name,
             public.search_norm(g.name) AS nm,
             CASE WHEN public.search_norm(g.name) LIKE v_pre  ESCAPE '\' THEN 0
                  WHEN public.search_norm(g.name) LIKE v_word ESCAPE '\' THEN 1
                  ELSE 2 END AS rank
        FROM public.groups g
        LEFT JOIN public.profiles p ON p.id = g.leader_id
       WHERE public.search_norm(g.name) LIKE v_any ESCAPE '\'
       ORDER BY rank, nm, g.id
       LIMIT v_lim
    ) x;

  SELECT COALESCE(jsonb_agg(jsonb_build_object('id', x.id, 'title', x.title, 'event_date', x.event_date,
                                               'status', x.status)
                            ORDER BY x.rank, x.nm, x.event_date DESC, x.id), '[]'::jsonb)
    INTO v_events
    FROM (
      SELECT e.id, e.title, e.event_date, e.status::text AS status,
             public.search_norm(e.title) AS nm,
             CASE WHEN public.search_norm(e.title) LIKE v_pre  ESCAPE '\' THEN 0
                  WHEN public.search_norm(e.title) LIKE v_word ESCAPE '\' THEN 1
                  ELSE 2 END AS rank
        FROM public.events e
       WHERE public.search_norm(e.title) LIKE v_any ESCAPE '\'
       ORDER BY rank, nm, e.event_date DESC, e.id
       LIMIT v_lim
    ) x;

  RETURN jsonb_build_object('youth', v_youth, 'groups', v_groups, 'events', v_events);
END;
$$;

REVOKE ALL ON FUNCTION public.global_search(text, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.global_search(text, integer) TO authenticated;


-- ============================================================================
-- D. AÇÕES EM LOTE (atômicas — uma chamada = uma transação)
-- ============================================================================
-- Máximo de 200 jovens DISTINTOS por chamada. NULLs e repetidos são ignorados. Retorno:
--   {"requested": n distintos, "updated": n alterados, "unchanged": n já no estado pedido,
--    "skipped": [ids inexistentes ou sem permissão]}
-- skipped = ids que o chamador não enxerga/pode alterar pelo RLS (líder: jovens fora dos seus grupos). Os
-- triggers existentes (alertas, sincronização de attendance.group_id, histórico) disparam por linha.
-- Erro inesperado (ex.: grupo de destino inválido) desfaz o lote inteiro.

-- Troca de grupo. p_group_id NULL desassocia. Líder: só pode desassociar ou mover entre grupos seus;
-- coordenador: qualquer grupo.
--
-- EXCEÇÃO À REGRA "INVOKER": esta função é SECURITY DEFINER com escopo explícito (abaixo), porque o RLS atual de
-- youth NÃO permite que o líder desassocie um jovem: ao anular group_id, a linha NOVA deixa de passar pela policy
-- de SELECT do líder, e o Postgres também aplica as policies de SELECT à linha nova quando o UPDATE tem WHERE/
-- RETURNING ("new row violates row-level security policy"), mesmo com a policy leader_update_youth (migration 002)
-- aceitando group_id NULL no WITH CHECK. Um UPDATE direto do líder com group_id = NULL (ex.: useGroups) falha
-- hoje; esta RPC é o caminho que funciona (use-a também para desassociar um único jovem: passe [id], NULL).
-- Escopo replicado aqui (equivale ao RLS): coordenador => qualquer jovem/grupo; líder => jovens cujo grupo
-- ATUAL ele lidera, destino NULL ou grupo que ele lidera; qualquer outro papel/anon => recusado.
-- A batch_set_youth_active abaixo segue INVOKER (a linha nova continua visível, o RLS funciona normalmente).
CREATE OR REPLACE FUNCTION public.batch_set_youth_group(p_youth_ids uuid[], p_group_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid       uuid := auth.uid();
  v_role      text;
  v_ids       uuid[];
  v_visible   uuid[];
  v_skipped   uuid[];
  v_updated   integer;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Não autenticado.' USING ERRCODE = '42501';
  END IF;
  v_role := public.get_my_role();
  IF v_role IS NULL OR v_role NOT IN ('coordinator', 'leader') THEN
    RAISE EXCEPTION 'Sem permissão.' USING ERRCODE = '42501';
  END IF;

  SELECT COALESCE(array_agg(DISTINCT i), '{}') INTO v_ids FROM unnest(COALESCE(p_youth_ids, '{}')) AS i WHERE i IS NOT NULL;
  IF cardinality(v_ids) = 0 THEN
    RAISE EXCEPTION 'Selecione ao menos um jovem.' USING ERRCODE = 'P0001';
  END IF;
  IF cardinality(v_ids) > 200 THEN
    RAISE EXCEPTION 'Selecione no máximo 200 jovens por vez.' USING ERRCODE = 'P0001';
  END IF;

  -- Grupo de destino precisa existir E estar no escopo do chamador (líder: só grupos que ele lidera)
  IF p_group_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM public.groups g
        WHERE g.id = p_group_id AND (v_role = 'coordinator' OR g.leader_id = v_uid)) THEN
    RAISE EXCEPTION 'Grupo não encontrado ou sem permissão.' USING ERRCODE = 'P0002';
  END IF;

  -- Jovens no escopo: coordenador todos; líder os que estão HOJE em grupo seu
  SELECT COALESCE(array_agg(y.id), '{}') INTO v_visible
    FROM public.youth y
   WHERE y.id = ANY (v_ids)
     AND (v_role = 'coordinator'
          OR y.group_id IN (SELECT g.id FROM public.groups g WHERE g.leader_id = v_uid));
  SELECT COALESCE(array_agg(i), '{}') INTO v_skipped FROM unnest(v_ids) AS i WHERE i <> ALL (v_visible);

  UPDATE public.youth
     SET group_id = p_group_id
   WHERE id = ANY (v_visible) AND group_id IS DISTINCT FROM p_group_id;
  GET DIAGNOSTICS v_updated = ROW_COUNT;

  RETURN jsonb_build_object('requested', cardinality(v_ids), 'updated', v_updated,
                            'unchanged', cardinality(v_visible) - v_updated,
                            'skipped', to_jsonb(v_skipped));
END;
$$;

-- Ativar/inativar. Inativar resolve automaticamente os alertas abertos (trigger existente).
CREATE OR REPLACE FUNCTION public.batch_set_youth_active(p_youth_ids uuid[], p_active boolean)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_ids       uuid[];
  v_visible   uuid[];
  v_skipped   uuid[];
  v_updated   integer;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Não autenticado.' USING ERRCODE = '42501';
  END IF;
  IF public.get_my_role() IS NULL THEN
    RAISE EXCEPTION 'Sem permissão.' USING ERRCODE = '42501';
  END IF;
  IF p_active IS NULL THEN
    RAISE EXCEPTION 'Informe se os jovens ficarão ativos ou inativos.' USING ERRCODE = 'P0001';
  END IF;

  SELECT COALESCE(array_agg(DISTINCT i), '{}') INTO v_ids FROM unnest(COALESCE(p_youth_ids, '{}')) AS i WHERE i IS NOT NULL;
  IF cardinality(v_ids) = 0 THEN
    RAISE EXCEPTION 'Selecione ao menos um jovem.' USING ERRCODE = 'P0001';
  END IF;
  IF cardinality(v_ids) > 200 THEN
    RAISE EXCEPTION 'Selecione no máximo 200 jovens por vez.' USING ERRCODE = 'P0001';
  END IF;

  SELECT COALESCE(array_agg(id), '{}') INTO v_visible FROM public.youth WHERE id = ANY (v_ids);
  SELECT COALESCE(array_agg(i), '{}') INTO v_skipped FROM unnest(v_ids) AS i WHERE i <> ALL (v_visible);

  UPDATE public.youth
     SET is_active = p_active
   WHERE id = ANY (v_visible) AND is_active IS DISTINCT FROM p_active;
  GET DIAGNOSTICS v_updated = ROW_COUNT;

  RETURN jsonb_build_object('requested', cardinality(v_ids), 'updated', v_updated,
                            'unchanged', cardinality(v_visible) - v_updated,
                            'skipped', to_jsonb(v_skipped));
END;
$$;

REVOKE ALL ON FUNCTION public.batch_set_youth_group(uuid[], uuid)   FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.batch_set_youth_active(uuid[], boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.batch_set_youth_group(uuid[], uuid)   TO authenticated;
GRANT EXECUTE ON FUNCTION public.batch_set_youth_active(uuid[], boolean) TO authenticated;

NOTIFY pgrst, 'reload schema';
