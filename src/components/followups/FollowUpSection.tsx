import { useEffect, useState } from 'react';
import { ArrowRightLeft, CalendarClock, CheckCircle2, ChevronDown, ChevronUp, HeartHandshake, ListChecks, Mail, Pencil, Plus, Trash2, AlertTriangle } from 'lucide-react';
import { fetchFollowUpPeople, useFollowUps, type FollowUpWithRelations } from '../../hooks/useFollowUps';
import { useToast } from '../../contexts/ToastContext';
import { Badge } from '../ui/Badge';
import { LoadingBlock } from '../ui/LoadingBlock';
import { Pagination } from '../ui/Pagination';
import { ErrorBanner } from '../ErrorBanner';
import { FollowUpFormModal } from './FollowUpFormModal';
import { TransferFollowUpModal } from './TransferFollowUpModal';
import { CommunicationModal } from '../communications/CommunicationModal';
import { alertDescription, FOLLOW_UP_TYPE_LABEL, TASK_STATUS_LABEL } from '../../lib/labels';
import { appToday, formatDateOnly } from '../../lib/format';
import { canManageFollowUp, isNextActionOverdue, personName, sortTransfers, transferLine } from '../../lib/followups';
import { logError } from '../../lib/logger';

interface FollowUpSectionProps {
  youth: { id: string; full_name: string };
  /** Chamado quando algo mudou (a situação e os alertas do jovem podem ter mudado) */
  onChanged?: () => void;
  /** Nome do grupo do jovem (assinatura dos modelos de e-mail) */
  groupName?: string | null;
  /** Um e-mail ligado a um acompanhamento mudou (a lista de comunicações precisa recarregar) */
  onCommunicationChanged?: () => void;
}

const newBtnCls =
  'inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 transition-colors shadow-sm';

const smallBtnCls =
  'inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50 transition-colors';

/** Histórico "Fulano → Beltrano · motivo · data" (nomes sob demanda via follow_up_people). */
function TransferHistory({ followUp }: { followUp: FollowUpWithRelations }) {
  const [names, setNames] = useState<ReadonlyMap<string, string> | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchFollowUpPeople(followUp.id)
      .then((people) => { if (!cancelled) setNames(new Map(people.map((p) => [p.id, p.full_name ?? 'Sem nome']))); })
      .catch((err: unknown) => {
        logError('Erro ao carregar nomes do histórico de transferências', err);
        if (!cancelled) setFailed(true);
      });
    return () => { cancelled = true; };
  }, [followUp.id]);

  return (
    <div data-testid="historico-transferencias" className="mt-2 rounded-lg bg-gray-50 px-3 py-2">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">Histórico de transferências</p>
      {failed && <p className="mt-1 text-xs text-gray-500">Não foi possível carregar os nomes.</p>}
      <ul className="mt-1 space-y-1">
        {sortTransfers(followUp.transfers).map((t) => (
          <li key={t.id} className="text-xs text-gray-600">
            {transferLine(t, names ?? new Map())}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Seção "Acompanhamento" da ficha do jovem: linha do tempo + registrar, editar, transferir e excluir. */
export function FollowUpSection({ youth, onChanged, groupName, onCommunicationChanged }: FollowUpSectionProps) {
  const toast = useToast();
  const {
    followUps, total, page, setPage, pageSize, totalPages, loading, error, names, isCoordinator, userId,
    refetch, deleteFollowUp, clearError,
  } = useFollowUps(youth.id);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<FollowUpWithRelations | null>(null);
  const [transferring, setTransferring] = useState<FollowUpWithRelations | null>(null);
  const [emailing, setEmailing] = useState<FollowUpWithRelations | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [busyId, setBusyId] = useState<string | null>(null);
  const today = appToday();

  const saved = () => { refetch(); onChanged?.(); };

  const toggleHistory = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });

  const handleDelete = async (f: FollowUpWithRelations) => {
    if (!window.confirm(`Excluir o acompanhamento de ${formatDateOnly(f.occurred_at)} ("${f.reason}")? Esta ação não pode ser desfeita.`)) return;
    setBusyId(f.id);
    const ok = await deleteFollowUp(f.id);
    setBusyId(null);
    if (ok) { toast.success('Acompanhamento excluído.'); onChanged?.(); }
  };

  return (
    <section className="border-t border-gray-100 pt-4" aria-labelledby="followups-title" data-testid="secao-acompanhamento">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h4 id="followups-title" className="flex items-center gap-1.5 text-sm font-semibold text-gray-900">
          <HeartHandshake className="h-4 w-4 text-gray-500" aria-hidden="true" /> Acompanhamento
          {total > 0 && <span className="text-xs font-normal text-gray-500">({total})</span>}
        </h4>
        <button type="button" onClick={() => { clearError(); setCreating(true); }} className={newBtnCls}>
          <Plus className="h-3.5 w-3.5" aria-hidden="true" /> Novo acompanhamento
        </button>
      </div>

      <ErrorBanner message={error} />

      {loading && followUps.length === 0 ? (
        <LoadingBlock size="sm" />
      ) : !error && followUps.length === 0 ? (
        <p className="rounded-lg bg-gray-50 p-3 text-center text-xs italic text-gray-500">
          Nenhum acompanhamento registrado para este jovem ainda.
        </p>
      ) : (
        <ol className="space-y-3" aria-busy={loading}>
          {followUps.map((f, index) => {
            const manage = canManageFollowUp(f, userId, isCoordinator);
            // A lista vem da mais recente para a mais antiga: o primeiro item da página 1 é o acompanhamento mais recente
            const late = isNextActionOverdue(f, today, page === 1 && index === 0);
            const hasHistory = f.transfers.length > 0;
            return (
              <li key={f.id} data-testid="acompanhamento-item" className="rounded-lg border border-gray-200 bg-white px-3 py-3">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="text-sm font-medium text-gray-900">{formatDateOnly(f.occurred_at)}</span>
                  <Badge color="blue">{FOLLOW_UP_TYPE_LABEL[f.type]}</Badge>
                  {f.completes_task && f.task && <Badge color="green"><CheckCircle2 className="h-3 w-3" aria-hidden="true" /> Concluiu a ação</Badge>}
                </div>

                <p className="mt-1 text-sm font-medium text-gray-900 break-words">{f.reason}</p>
                {f.notes && <p className="mt-0.5 text-sm text-gray-600 whitespace-pre-line break-words">{f.notes}</p>}

                {(f.next_action || f.next_action_due) && (
                  <p className="mt-1.5 flex flex-wrap items-center gap-x-1.5 text-xs text-gray-600">
                    <CalendarClock className="h-3.5 w-3.5 flex-shrink-0" aria-hidden="true" />
                    <span>Próxima ação: {f.next_action ?? '—'}</span>
                    {f.next_action_due && (
                      <span className={late ? 'font-medium text-red-600' : ''}>
                        · prazo {formatDateOnly(f.next_action_due)}{late && ' (vencido)'}
                      </span>
                    )}
                  </p>
                )}

                {(f.alert || f.task) && (
                  <p className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-gray-500">
                    {f.alert && (
                      <span className="inline-flex items-center gap-1">
                        <AlertTriangle className="h-3 w-3" aria-hidden="true" /> Alerta: {alertDescription(f.alert)}
                      </span>
                    )}
                    {f.task && (
                      <span className="inline-flex items-center gap-1">
                        <ListChecks className="h-3 w-3" aria-hidden="true" /> Ação: {f.task.title} ({TASK_STATUS_LABEL[f.task.status]})
                      </span>
                    )}
                  </p>
                )}

                <p className="mt-2 flex flex-wrap items-center gap-2 text-xs text-gray-600">
                  <Badge color="green">Responsável atual</Badge>
                  <span data-testid="responsavel-atual" className="font-medium text-gray-900">
                    {personName(f.responsible_id, names, userId)}
                  </span>
                </p>

                <div className="mt-2 flex flex-wrap gap-2">
                  {manage && (
                    <>
                      <button type="button" onClick={() => { clearError(); setEditing(f); }} disabled={busyId !== null} className={smallBtnCls}>
                        <Pencil className="h-3 w-3" aria-hidden="true" /> Editar
                      </button>
                      <button type="button" onClick={() => { clearError(); setTransferring(f); }} disabled={busyId !== null} className={smallBtnCls}>
                        <ArrowRightLeft className="h-3 w-3" aria-hidden="true" /> Transferir responsável
                      </button>
                    </>
                  )}
                  <button
                    type="button" onClick={() => setEmailing(f)} disabled={busyId !== null} className={smallBtnCls}
                    data-testid="acompanhamento-escrever-email"
                    aria-label={`Escrever e-mail sobre o acompanhamento de ${formatDateOnly(f.occurred_at)}`}
                  >
                    <Mail className="h-3 w-3" aria-hidden="true" /> E-mail
                  </button>
                  {hasHistory && (
                    <button
                      type="button" onClick={() => toggleHistory(f.id)} className={smallBtnCls}
                      aria-expanded={expanded.has(f.id)}
                    >
                      {expanded.has(f.id) ? <ChevronUp className="h-3 w-3" aria-hidden="true" /> : <ChevronDown className="h-3 w-3" aria-hidden="true" />}
                      Transferências ({f.transfers.length})
                    </button>
                  )}
                  {isCoordinator && !hasHistory && (
                    <button
                      type="button" onClick={() => handleDelete(f)} disabled={busyId !== null}
                      className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-red-700 bg-red-50 border border-red-200 rounded-lg hover:bg-red-100 disabled:opacity-50 transition-colors"
                    >
                      <Trash2 className="h-3 w-3" aria-hidden="true" /> Excluir
                    </button>
                  )}
                </div>

                {hasHistory && expanded.has(f.id) && <TransferHistory followUp={f} />}
              </li>
            );
          })}
        </ol>
      )}

      <Pagination
        page={page} totalPages={totalPages} total={total} pageSize={pageSize}
        onPageChange={setPage} noun={total === 1 ? 'acompanhamento' : 'acompanhamentos'} disabled={loading}
      />

      {creating && (
        <FollowUpFormModal
          youthId={youth.id} youthName={youth.full_name}
          onClose={() => setCreating(false)} onSaved={saved}
        />
      )}
      {editing && (
        <FollowUpFormModal
          youthId={youth.id} youthName={youth.full_name} initial={editing}
          onClose={() => setEditing(null)} onSaved={saved}
        />
      )}
      {emailing && (
        <CommunicationModal
          youthId={youth.id} youthName={youth.full_name} groupName={groupName}
          fixedLinks={{
            alert: emailing.alert ? { id: emailing.alert.id, type: emailing.alert.type, label: alertDescription(emailing.alert) } : null,
            followUp: { id: emailing.id, label: `${formatDateOnly(emailing.occurred_at)} · ${FOLLOW_UP_TYPE_LABEL[emailing.type]}` },
          }}
          onClose={() => setEmailing(null)} onChanged={() => onCommunicationChanged?.()}
        />
      )}
      {transferring && (
        <TransferFollowUpModal
          followUp={transferring} youthName={youth.full_name} names={names} userId={userId}
          onClose={() => setTransferring(null)} onSaved={saved}
        />
      )}
    </section>
  );
}
