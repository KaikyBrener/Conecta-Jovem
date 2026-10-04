import { useState } from 'react';
import { FunctionsHttpError } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';
import { errorMessage } from '../lib/format';
import { fetchAll } from '../lib/fetchAll';
import { logError } from '../lib/logger';
import {
  parseSendError, parseSendResponse, toDraftPayload, type CommunicationFormValues, type SendOutcome,
} from '../lib/communications';
import { useAsyncValue } from './useAsyncValue';
import { usePagedList } from './usePagedList';
import type { Alert, Communication, FollowUp, RecipientKind } from '../types/database.types';

// Comunicações por e-mail (migration 015 + envio pelo servidor). O navegador NÃO envia e-mail nem guarda segredo:
// pede o envio à Edge Function `send-communication` (o JWT do usuário vai junto) e o resultado REAL vem do servidor.
// O cliente nunca define `sending`/`sent`. Os dados da mensagem (destinatário, assunto, corpo) nunca vão para console,
// toasts ou mensagens de erro — `errorMessage` registra só código/mensagem sanitizada e devolve texto escrito por nós.

export interface CommunicationWithRelations extends Communication {
  alert: Pick<Alert, 'id' | 'type' | 'severity' | 'status' | 'consecutive_absences' | 'attendance_rate' | 'previous_rate' | 'sample_size'> | null;
  follow_up: Pick<FollowUp, 'id' | 'occurred_at' | 'type' | 'reason'> | null;
  /** Nulo para o líder quando o autor é outra pessoa (RLS de profiles) */
  author: { full_name: string | null } | null;
}

/** Conteúdo editável de um rascunho */
export interface DraftContent extends CommunicationFormValues {
  recipientKind: RecipientKind;
}

/** Vínculos do rascunho (definidos na criação; o banco não deixa mudar depois) */
export interface DraftLinks {
  youthId: string;
  alertId?: string | null;
  followUpId?: string | null;
}

export interface RecipientSuggestion {
  kind: RecipientKind;
  name: string | null;
  email: string;
}

/** 10 por página: cada item mostra assunto, destinatário e vínculos */
const COMMUNICATIONS_PAGE_SIZE = 10;

const SELECT = `
  *,
  alert:alert_id ( id, type, severity, status, consecutive_absences, attendance_rate, previous_rate, sample_size ),
  follow_up:follow_up_id ( id, occurred_at, type, reason ),
  author:created_by ( full_name )
`;

export interface SendResult {
  outcome: SendOutcome;
  /** Linha relida do banco depois do envio (estado real); null se não foi possível reler */
  row: Communication | null;
}

/** Relê a comunicação (estado real). Falha aqui é registrada e não impede o resto do fluxo. */
async function fetchRow(id: string): Promise<Communication | null> {
  const { data, error } = await (supabase as any).from('communications').select('*').eq('id', id).maybeSingle();
  if (error) { logError('Erro ao reler a comunicação.', error); return null; }
  return (data ?? null) as Communication | null;
}

/**
 * Erro devolvido por `functions.invoke`. Só `FunctionsHttpError` (a função respondeu com 4xx/5xx) traz um corpo
 * `{ error }` no `context` (um Response); rede e relay não dizem se o e-mail saiu.
 */
async function outcomeFromInvokeError(err: unknown): Promise<SendOutcome> {
  if (!(err instanceof FunctionsHttpError)) {
    logError('Erro ao chamar o envio de e-mail.', err);
    return { kind: 'unconfirmed' };
  }
  const res: unknown = err.context;
  const status = res instanceof Response ? res.status : null;
  let body: unknown = null;
  try {
    if (res instanceof Response) body = await res.clone().json();
  } catch {
    body = null; // corpo ausente ou não-JSON: o código HTTP decide
  }
  return parseSendError(status, body);
}

const NO_SUGGESTIONS: RecipientSuggestion[] = [];
const NO_COUNTS: ReadonlyMap<string, number> = new Map();

/**
 * Mutações de comunicação. Retornam null/false em erro e preenchem `error` (texto seguro, em pt-BR).
 * `onChanged` roda depois de cada sucesso (recarregar a lista).
 */
export function useCommunicationMutations(onChanged?: () => void) {
  const { user } = useAuth();
  const [error, setError] = useState<string | null>(null);

  const createDraft = async (links: DraftLinks, content: DraftContent): Promise<Communication | null> => {
    if (!user) return null;
    setError(null);
    const { data, error: e } = await (supabase as any)
      .from('communications')
      .insert({
        ...toDraftPayload(content),
        recipient_kind: content.recipientKind,
        youth_id: links.youthId,
        alert_id: links.alertId ?? null,
        follow_up_id: links.followUpId ?? null,
        created_by: user.id,
      })
      .select('*')
      .single();
    if (e) { setError(errorMessage(e, 'Erro ao salvar o rascunho.')); return null; }
    onChanged?.();
    return data as Communication;
  };

  /** Só rascunhos têm conteúdo editável (o banco recusa o resto) */
  const updateDraft = async (id: string, content: DraftContent): Promise<Communication | null> => {
    setError(null);
    const { data, error: e } = await (supabase as any)
      .from('communications')
      .update({ ...toDraftPayload(content), recipient_kind: content.recipientKind })
      .eq('id', id)
      .select('*')
      .maybeSingle();
    if (e) { setError(errorMessage(e, 'Erro ao salvar o rascunho.')); return null; }
    if (!data) { setError('Sem permissão para alterar esta comunicação.'); return null; }
    onChanged?.();
    return data as Communication;
  };

  /**
   * Muda o status pela RPC mark_communication. O cliente só faz duas coisas: descartar ('cancelled', a partir de
   * rascunho ou falha) e reabrir uma falha como rascunho ('draft'). 'sending'/'sent'/'failed' são do servidor.
   */
  const markCommunication = async (id: string, status: 'draft' | 'cancelled'): Promise<Communication | null> => {
    setError(null);
    const { data, error: e } = await (supabase as any).rpc('mark_communication', {
      p_id: id,
      p_status: status,
      p_failure_reason: null,
    });
    if (e) { setError(errorMessage(e, 'Erro ao atualizar a comunicação.')); return null; }
    onChanged?.();
    return data as Communication;
  };

  /**
   * Pede ao servidor para enviar a comunicação (que deve estar salva). NÃO lança: devolve o que o servidor disse
   * (`outcome`) e a linha relida do banco (`row`, o estado real; null se a releitura falhar). Falha de rede ou
   * resposta ilegível = `unconfirmed`: não sabemos se saiu, e a releitura mostra se está sending/sent/failed.
   */
  const sendCommunication = async (id: string): Promise<SendResult> => {
    setError(null);
    let outcome: SendOutcome;
    try {
      const { data, error: e } = await supabase.functions.invoke('send-communication', { body: { communication_id: id } });
      outcome = e ? await outcomeFromInvokeError(e) : parseSendResponse(data);
    } catch (err: unknown) {
      logError('Erro ao enviar a comunicação.', err);
      outcome = { kind: 'unconfirmed' };
    }
    if (outcome.kind === 'failed') logError(`Envio de e-mail falhou (${outcome.reason})`, null);
    if (outcome.kind === 'rejected') logError(`Envio de e-mail recusado (${outcome.code})`, null);

    const row = await fetchRow(id);
    onChanged?.();
    return { outcome, row };
  };

  /** Só o coordenador exclui, e só rascunho ou cancelada (RLS) */
  const deleteCommunication = async (id: string): Promise<boolean> => {
    setError(null);
    const { data, error: e } = await (supabase as any)
      .from('communications')
      .delete()
      .eq('id', id)
      .select('id');
    if (e) { setError(errorMessage(e, 'Erro ao excluir a comunicação.')); return false; }
    if (!data || data.length === 0) { setError('Não foi possível excluir: só o coordenador exclui rascunhos e comunicações canceladas.'); return false; }
    onChanged?.();
    return true;
  };

  return {
    error, clearError: () => setError(null), createDraft, updateDraft, markCommunication, sendCommunication, deleteCommunication,
  };
}

/**
 * Histórico de comunicações de um jovem: paginado no servidor (10 por página), mais recentes primeiro.
 * `refreshKey` recarrega a lista (volta à página 1) quando outra parte da tela criou/alterou uma comunicação.
 */
export function useCommunications(youthId: string, refreshKey = 0) {
  const { user, role } = useAuth();

  const list = usePagedList<CommunicationWithRelations>({
    enabled: !!user && !!youthId,
    filters: [youthId, refreshKey],
    pageSize: COMMUNICATIONS_PAGE_SIZE,
    errorFallback: 'Erro ao carregar as comunicações.',
    fetchPage: async ({ from, to }) => {
      const { data, count, error } = await (supabase as any)
        .from('communications')
        .select(SELECT, { count: 'exact' })
        .eq('youth_id', youthId)
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
        .range(from, to);
      if (error) throw error;
      return { rows: (data ?? []) as CommunicationWithRelations[], total: count ?? 0 };
    },
  });
  const { refetch } = list;
  const mutations = useCommunicationMutations(refetch);

  return {
    communications: list.rows,
    total: list.total,
    page: list.page,
    setPage: list.setPage,
    pageSize: list.pageSize,
    totalPages: list.totalPages,
    loading: list.loading,
    error: mutations.error ?? list.error,
    isCoordinator: role === 'coordinator',
    userId: user?.id ?? null,
    refetch,
    clearError: mutations.clearError,
    markCommunication: mutations.markCommunication,
    sendCommunication: mutations.sendCommunication,
    deleteCommunication: mutations.deleteCommunication,
  };
}

/**
 * Destinatários sugeridos para um jovem (RPC suggest_communication_recipients). Hoje só o e-mail do próprio jovem:
 * o schema não tem e-mail de responsável e os perfis não expõem e-mail. Os demais destinatários são digitados.
 */
export function useRecipientSuggestions(youthId: string | null) {
  return useAsyncValue<RecipientSuggestion[]>(
    youthId,
    async () => {
      const { data, error } = await (supabase as any).rpc('suggest_communication_recipients', { p_youth_id: youthId });
      if (error) throw error;
      return (data ?? []) as RecipientSuggestion[];
    },
    NO_SUGGESTIONS,
    'Não foi possível carregar a sugestão de destinatário.',
  );
}

/**
 * Quantas comunicações ENVIADAS cada alerta (dos `alertIds` informados) tem (para o selo no cartão do alerta). É um dado auxiliar: se a
 * consulta falhar, o erro é registrado (sanitizado) e os cartões simplesmente aparecem sem o selo.
 */
export function useSentCommunicationCounts(alertIds: readonly string[]) {
  const { user } = useAuth();
  // Só os alertas da página exibida (a lista de alertas é paginada); sem alertas, nada a buscar
  const key = user && alertIds.length > 0 ? `${user.id}|${alertIds.join(',')}` : null;
  const { data, refetch } = useAsyncValue<ReadonlyMap<string, number>>(
    key,
    async () => {
      const rows = await fetchAll<{ alert_id: string }>(() =>
        (supabase as any)
          .from('communications')
          .select('id, alert_id')
          .eq('status', 'sent')
          .in('alert_id', alertIds)
          .order('id'));
      const counts = new Map<string, number>();
      for (const r of rows) counts.set(r.alert_id, (counts.get(r.alert_id) ?? 0) + 1);
      return counts as ReadonlyMap<string, number>;
    },
    NO_COUNTS,
    'Não foi possível carregar as comunicações enviadas.',
  );
  return { counts: data, refetch };
}
