import type { FollowUpTransfer, FollowUpType } from '../types/database.types';

// Lógica pura do módulo de acompanhamento (validação do formulário, nomes e histórico de transferências).
// A autorização e as regras reais ficam no banco (RLS + follow_ups_guard + transfer_follow_up).

export interface FollowUpFormValues {
  occurred_at: string;
  type: FollowUpType;
  reason: string;
  notes: string;
  next_action: string;
  next_action_due: string;
  responsible_id: string;
  /** Ação aberta do jovem vinculada ('' = nenhuma) */
  task_id: string;
  completes_task: boolean;
  /** Alerta vinculado ('' = nenhum) */
  alert_id: string;
}

/**
 * Valida o formulário antes de enviar (o banco valida de novo). Devolve a primeira mensagem de erro
 * em pt-BR, ou null se estiver válido. `today` = YYYY-MM-DD no fuso do produto.
 */
export function validateFollowUpForm(f: FollowUpFormValues, today: string): string | null {
  if (!f.reason.trim()) return 'Informe o motivo do acompanhamento.';
  if (!f.occurred_at) return 'Informe a data do contato.';
  if (f.occurred_at > today) return 'A data do contato não pode estar no futuro.';
  if (f.next_action_due && f.next_action_due < f.occurred_at) {
    return 'O prazo da próxima ação não pode ser anterior à data do contato.';
  }
  if (f.completes_task && !f.task_id) return 'Selecione a ação que será concluída.';
  return null;
}

/** Nome de uma pessoa a partir do mapa id -> nome; sem expor identificadores. */
export function personName(
  id: string | null,
  names: ReadonlyMap<string, string>,
  currentUserId?: string | null,
): string {
  if (!id) return 'Sem responsável';
  if (currentUserId && id === currentUserId) return 'Você';
  return names.get(id) ?? 'Outro usuário';
}

/** "Fulano → Beltrano · motivo · 12/09/2026" */
export function transferLine(
  t: Pick<FollowUpTransfer, 'from_responsible_id' | 'to_responsible_id' | 'reason' | 'transferred_at'>,
  names: ReadonlyMap<string, string>,
  currentUserId?: string | null,
): string {
  const day = t.transferred_at
    ? new Date(t.transferred_at).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' })
    : '';
  return [
    `${personName(t.from_responsible_id, names, currentUserId)} → ${personName(t.to_responsible_id, names, currentUserId)}`,
    t.reason,
    day,
  ].filter(Boolean).join(' · ');
}

/** Transferências da mais antiga para a mais recente (ordem de leitura do histórico). */
export function sortTransfers<T extends Pick<FollowUpTransfer, 'transferred_at'>>(list: readonly T[]): T[] {
  return [...list].sort((a, b) => a.transferred_at.localeCompare(b.transferred_at));
}

/** Sinaliza se a próxima ação combinada já passou do prazo (informativo; não gera alerta). */
export function isNextActionLate(due: string | null, today: string): boolean {
  return !!due && due < today;
}

/**
 * "Próxima ação" vencida, na mesma regra do banco (report_pending_followups, migration 012): só conta se tem prazo
 * vencido, é do acompanhamento MAIS RECENTE do jovem (um contato novo substitui a próxima ação anterior), não conclui
 * a ação vinculada e a ação vinculada não está concluída/cancelada.
 */
export function isNextActionOverdue(
  f: { next_action_due: string | null; completes_task: boolean; task: { status: string } | null },
  today: string,
  isLatest: boolean,
): boolean {
  if (!isLatest || f.completes_task) return false;
  if (f.task && (f.task.status === 'done' || f.task.status === 'cancelled')) return false;
  return isNextActionLate(f.next_action_due, today);
}

/**
 * Quem vê os botões de editar/transferir: coordenador, ou o líder que é o responsável ATUAL (ou o criador,
 * se o responsável foi removido). Só esconde botões: a autorização real é o RLS + transfer_follow_up.
 */
export function canManageFollowUp(
  f: { responsible_id: string | null; created_by: string | null },
  userId: string | null | undefined,
  isCoordinator: boolean,
): boolean {
  if (isCoordinator) return true;
  if (!userId) return false;
  return f.responsible_id === userId || (f.responsible_id === null && f.created_by === userId);
}

/** Converte os campos de texto do formulário no payload do banco ('' vira null). */
export function followUpPayload(f: FollowUpFormValues) {
  const blank = (v: string) => (v.trim() === '' ? null : v.trim());
  return {
    occurred_at: f.occurred_at,
    type: f.type,
    reason: f.reason.trim(),
    notes: blank(f.notes),
    next_action: blank(f.next_action),
    next_action_due: f.next_action_due || null,
    alert_id: f.alert_id || null,
    task_id: f.task_id || null,
    // sem ação vinculada não há o que concluir
    completes_task: !!f.task_id && f.completes_task,
  };
}
