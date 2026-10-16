import { useEffect, useState } from 'react';
import {
  AlertTriangle, ChevronDown, ChevronUp, HeartHandshake, Loader2, Mail, Pencil, RefreshCw, RotateCcw, Send, Trash2,
  TriangleAlert, XCircle,
} from 'lucide-react';
import { useCommunications, type CommunicationWithRelations } from '../../hooks/useCommunications';
import { useToast } from '../../contexts/ToastContext';
import { useConfirm } from '../../contexts/ConfirmContext';
import { ErrorBanner } from '../ErrorBanner';
import { LoadingBlock } from '../ui/LoadingBlock';
import { Pagination } from '../ui/Pagination';
import { CommunicationModal, type AlertChoice } from './CommunicationModal';
import { CommunicationStatusBadge } from './CommunicationStatusBadge';
import {
  alertDescription, failureReasonLabel, FOLLOW_UP_TYPE_LABEL, RECIPIENT_KIND_LABEL, SEND_UNCONFIRMED_MESSAGE,
} from '../../lib/labels';
import { isStuckSending, resolveSendView } from '../../lib/communications';
import { formatDateOnly, formatDateTime } from '../../lib/format';
import type { Communication } from '../../types/database.types';
import { smallBtnCls, smallDangerBtnCls, smallPrimaryBtnCls } from '../../lib/formStyles';

interface CommunicationSectionProps {
  youth: { id: string; full_name: string };
  groupName?: string | null;
  /** Alertas abertos do jovem, para vincular um novo e-mail */
  alertChoices: AlertChoice[];
  /** Muda quando outra parte da tela criou/alterou uma comunicação: recarrega a lista */
  refreshKey?: number;
  /**
   * Um e-mail foi salvo ou marcado pelo assistente (a atividade recente do jovem pode ter mudado).
   * O pai deve avisar de volta pelo `refreshKey` para a lista recarregar.
   */
  onChanged?: () => void;
}

/** Intervalo de atualização enquanto há envio em andamento */
const SENDING_REFRESH_MS = 15_000;

/** Seção "Comunicações" da ficha do jovem: histórico de e-mails + novo e-mail. Enviado e cancelada são só leitura. */
export function CommunicationSection({ youth, groupName, alertChoices, refreshKey, onChanged }: CommunicationSectionProps) {
  const toast = useToast();
  const confirm = useConfirm();
  const {
    communications, total, page, setPage, pageSize, totalPages, loading, error, isCoordinator, userId,
    clearError, markCommunication, sendCommunication, deleteCommunication, refetch,
  } = useCommunications(youth.id, refreshKey);
  const [composing, setComposing] = useState(false);
  const [continuing, setContinuing] = useState<CommunicationWithRelations | Communication | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [busyId, setBusyId] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  // Enquanto algum envio está em andamento, recarrega a lista de tempos em tempos (o servidor conclui sozinho)
  const hasSending = communications.some((c) => c.status === 'sending');
  useEffect(() => {
    if (!hasSending) return;
    const timer = setInterval(() => { setNow(Date.now()); refetch(); }, SENDING_REFRESH_MS);
    return () => clearInterval(timer);
  }, [hasSending, refetch]);

  const changed = () => { onChanged?.(); };

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });

  const reopen = async (c: CommunicationWithRelations) => {
    setBusyId(c.id);
    const row = await markCommunication(c.id, 'draft');
    setBusyId(null);
    if (!row) return;
    toast.success('Comunicação reaberta como rascunho.');
    setContinuing({ ...c, ...row });
  };

  const discard = async (c: CommunicationWithRelations) => {
    const what = c.status === 'draft' ? 'este rascunho' : 'esta comunicação';
    const ok = await confirm({
      title: `Descartar ${what}?`,
      message: 'Ela ficará no histórico como cancelada e não poderá ser editada.',
      confirmLabel: 'Descartar',
    });
    if (!ok) return;
    setBusyId(c.id);
    const row = await markCommunication(c.id, 'cancelled');
    setBusyId(null);
    if (row) { toast.success('Comunicação descartada.'); changed(); }
  };

  /** Reenvia a MESMA comunicação (falha ou envio sem resposta). O servidor decide; o resultado vem do banco. */
  const resend = async (c: CommunicationWithRelations) => {
    const ok = await confirm({
      title: 'Enviar este e-mail agora?',
      message: 'O envio é real e não pode ser desfeito.',
      confirmLabel: 'Enviar e-mail',
      tone: 'primary',
    });
    if (!ok) return;
    clearError();
    setBusyId(c.id);
    const { outcome, row } = await sendCommunication(c.id);
    setBusyId(null);
    setNow(Date.now());
    changed();
    const result = resolveSendView(outcome, row);
    if (result.kind === 'sent') toast.success('E-mail enviado.');
    else if (result.kind === 'failed') toast.error(failureReasonLabel(result.reason));
    else if (result.kind === 'rejected') toast.error(result.message);
    else if (result.kind === 'unconfirmed') toast.error(SEND_UNCONFIRMED_MESSAGE);
  };

  const refreshStatus = () => { setNow(Date.now()); refetch(); };

  const remove = async (c: CommunicationWithRelations) => {
    const confirmed = await confirm({
      title: 'Excluir comunicação?',
      message: 'Excluir esta comunicação definitivamente? Esta ação não pode ser desfeita.',
      confirmLabel: 'Excluir',
    });
    if (!confirmed) return;
    setBusyId(c.id);
    const ok = await deleteCommunication(c.id);
    setBusyId(null);
    if (ok) toast.success('Comunicação excluída.');
  };

  const modalLinks = (c: CommunicationWithRelations | Communication) => {
    const rel = c as Partial<CommunicationWithRelations>;
    return {
      alert: rel.alert ? { id: rel.alert.id, type: rel.alert.type, label: alertDescription(rel.alert) } : null,
      followUp: rel.follow_up
        ? { id: rel.follow_up.id, label: `${formatDateOnly(rel.follow_up.occurred_at)} · ${FOLLOW_UP_TYPE_LABEL[rel.follow_up.type]}` }
        : null,
    };
  };

  return (
    <section className="border-t border-gray-100 pt-4" aria-labelledby="comunicacoes-title" data-testid="secao-comunicacoes">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h4 id="comunicacoes-title" className="flex items-center gap-1.5 text-sm font-semibold text-gray-900">
          <Mail className="h-4 w-4 text-gray-500" aria-hidden="true" /> Comunicações
          {total > 0 && <span className="text-xs font-normal text-gray-500">({total})</span>}
        </h4>
        <button
          type="button" data-testid="jovem-enviar-email"
          onClick={() => { clearError(); setComposing(true); }} className={smallPrimaryBtnCls}
        >
          <Mail className="h-3.5 w-3.5" aria-hidden="true" /> Enviar e-mail
        </button>
      </div>

      <ErrorBanner message={error} />

      {loading && communications.length === 0 ? (
        <LoadingBlock size="sm" />
      ) : !error && communications.length === 0 ? (
        <p className="rounded-control bg-gray-50 p-3 text-center text-xs italic text-gray-500">
          Nenhum e-mail registrado para este jovem ainda.
        </p>
      ) : (
        <ol className="space-y-3" aria-busy={loading}>
          {communications.map((c) => {
            const mine = c.created_by !== null && c.created_by === userId;
            const canEdit = isCoordinator || mine;
            const author = mine ? 'Você' : c.author?.full_name ?? 'Outro usuário';
            const open = expanded.has(c.id);
            const busy = busyId !== null;
            const resending = busyId === c.id;
            const stuck = isStuckSending(c, now);
            return (
              <li
                key={c.id} data-testid="comunicacao-item" data-status={c.status}
                className="rounded-control border border-gray-200 bg-white px-3 py-3"
              >
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <CommunicationStatusBadge status={c.status} />
                  <span className="text-xs text-gray-500">
                    {c.status === 'sent' && c.sent_at ? `Enviado em ${formatDateTime(c.sent_at)}` : `Criado em ${formatDateTime(c.created_at)}`}
                  </span>
                </div>

                <p className="mt-1 break-words text-sm font-medium text-gray-900">{c.subject}</p>
                <p className="mt-0.5 break-words text-xs text-gray-600">
                  Para: {c.recipient_name ? `${c.recipient_name} · ` : ''}{c.recipient_email} ({RECIPIENT_KIND_LABEL[c.recipient_kind]})
                </p>
                <p className="mt-0.5 text-xs text-gray-500">Responsável: {author}</p>

                {c.status === 'failed' && c.failure_reason && (
                  <p data-testid="comunicacao-motivo-falha" className="mt-1 text-xs font-medium text-red-700">
                    Motivo: {failureReasonLabel(c.failure_reason)}
                  </p>
                )}

                {c.status === 'sending' && (
                  <p
                    role={stuck ? 'alert' : 'status'}
                    data-testid={stuck ? 'comunicacao-envio-sem-resposta' : 'comunicacao-enviando-item'}
                    className={`mt-1 flex items-start gap-1.5 text-xs font-medium ${stuck ? 'text-amber-800' : 'text-gray-600'}`}
                  >
                    {stuck
                      ? <TriangleAlert className="mt-0.5 h-3 w-3 flex-shrink-0" aria-hidden="true" />
                      : <Loader2 className="mt-0.5 h-3 w-3 flex-shrink-0 animate-spin motion-reduce:animate-none" aria-hidden="true" />}
                    {stuck ? 'Envio sem resposta — tente novamente.' : 'Envio em andamento. Atualize o status para ver o resultado.'}
                  </p>
                )}

                {(c.alert || c.follow_up) && (
                  <p className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-gray-500">
                    {c.alert && (
                      <span className="inline-flex items-center gap-1">
                        <AlertTriangle className="h-3 w-3" aria-hidden="true" /> Alerta: {alertDescription(c.alert)}
                      </span>
                    )}
                    {c.follow_up && (
                      <span className="inline-flex items-center gap-1">
                        <HeartHandshake className="h-3 w-3" aria-hidden="true" /> Acompanhamento: {formatDateOnly(c.follow_up.occurred_at)} · {FOLLOW_UP_TYPE_LABEL[c.follow_up.type]}
                      </span>
                    )}
                  </p>
                )}

                {open && (
                  <div
                    data-testid="comunicacao-corpo-item"
                    className="mt-2 max-h-60 overflow-y-auto whitespace-pre-wrap break-words rounded-control border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-800"
                  >
                    {c.body}
                  </div>
                )}

                <div className="mt-2 flex flex-wrap gap-2">
                  <button type="button" onClick={() => toggle(c.id)} aria-expanded={open} className={smallBtnCls}>
                    {open ? <ChevronUp className="h-3 w-3" aria-hidden="true" /> : <ChevronDown className="h-3 w-3" aria-hidden="true" />}
                    {open ? 'Ocultar mensagem' : 'Ver mensagem'}
                  </button>
                  {c.status === 'draft' && canEdit && (
                    <>
                      <button
                        type="button" data-testid="comunicacao-continuar" disabled={busy} className={smallBtnCls}
                        onClick={() => { clearError(); setContinuing(c); }}
                      >
                        <Pencil className="h-3 w-3" aria-hidden="true" /> Continuar rascunho
                      </button>
                      <button type="button" data-testid="comunicacao-descartar" onClick={() => discard(c)} disabled={busy} className={smallBtnCls}>
                        <XCircle className="h-3 w-3" aria-hidden="true" /> Descartar
                      </button>
                    </>
                  )}
                  {c.status === 'failed' && canEdit && (
                    <>
                      <button type="button" data-testid="comunicacao-reenviar" onClick={() => resend(c)} disabled={busy} className={smallBtnCls}>
                        {resending ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" /> : <Send className="h-3 w-3" aria-hidden="true" />}
                        {resending ? 'Enviando…' : 'Tentar novamente'}
                      </button>
                      <button type="button" data-testid="comunicacao-reabrir" onClick={() => reopen(c)} disabled={busy} className={smallBtnCls}>
                        <RotateCcw className="h-3 w-3" aria-hidden="true" /> Editar mensagem
                      </button>
                      <button type="button" data-testid="comunicacao-descartar" onClick={() => discard(c)} disabled={busy} className={smallBtnCls}>
                        <XCircle className="h-3 w-3" aria-hidden="true" /> Descartar
                      </button>
                    </>
                  )}
                  {c.status === 'sending' && (
                    <>
                      <button type="button" data-testid="comunicacao-atualizar" onClick={refreshStatus} disabled={loading || busy} className={smallBtnCls}>
                        <RefreshCw className="h-3 w-3" aria-hidden="true" /> Atualizar status
                      </button>
                      {stuck && canEdit && (
                        <button type="button" data-testid="comunicacao-reenviar" onClick={() => resend(c)} disabled={busy} className={smallBtnCls}>
                          {resending ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" /> : <Send className="h-3 w-3" aria-hidden="true" />}
                          {resending ? 'Enviando…' : 'Tentar novamente'}
                        </button>
                      )}
                    </>
                  )}
                  {isCoordinator && (c.status === 'draft' || c.status === 'cancelled') && (
                    <button type="button" data-testid="comunicacao-excluir" onClick={() => remove(c)} disabled={busy} className={smallDangerBtnCls}>
                      <Trash2 className="h-3 w-3" aria-hidden="true" /> Excluir
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      )}

      <Pagination
        page={page} totalPages={totalPages} total={total} pageSize={pageSize}
        onPageChange={setPage} noun={total === 1 ? 'comunicação' : 'comunicações'} disabled={loading}
      />

      {composing && (
        <CommunicationModal
          youthId={youth.id} youthName={youth.full_name} groupName={groupName} alertChoices={alertChoices}
          onClose={() => setComposing(false)} onChanged={changed}
        />
      )}
      {continuing && (
        <CommunicationModal
          youthId={youth.id} youthName={youth.full_name} groupName={groupName}
          initial={continuing} fixedLinks={modalLinks(continuing)}
          onClose={() => setContinuing(null)} onChanged={changed}
        />
      )}
    </section>
  );
}
