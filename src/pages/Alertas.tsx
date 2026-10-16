import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  AlertTriangle, CheckCircle2, HeartHandshake, ListPlus, Loader2, Mail, MailCheck, OctagonAlert, Phone, RotateCcw, XCircle, ListChecks,
} from 'lucide-react';
import { useAlerts, type AlertWithRelations } from '../hooks/useAlerts';
import { useToast } from '../contexts/ToastContext';
import { Modal } from '../components/Modal';
import { ErrorBanner } from '../components/ErrorBanner';
import { FollowUpFormModal } from '../components/followups/FollowUpFormModal';
import { CommunicationModal } from '../components/communications/CommunicationModal';
import { useSentCommunicationCounts } from '../hooks/useCommunications';
import { PageHeader } from '../components/ui/PageHeader';
import { EmptyState } from '../components/ui/EmptyState';
import { LoadingBlock } from '../components/ui/LoadingBlock';
import { FilterChips } from '../components/ui/FilterChips';
import { Pagination } from '../components/ui/Pagination';
import { Badge, type BadgeColor } from '../components/ui/Badge';
import { controlCls, inputCls, labelCls, primaryBtnCls, secondaryBtnCls, smallBtnCls, smallPrimaryBtnCls } from '../lib/formStyles';
import { formatDate, formatDateOnly, formatDateTime, isOverdue } from '../lib/format';
import {
  ALERT_SEVERITY_LABEL, ALERT_TYPE_NAME, ALERT_TYPES, FOLLOW_UP_TYPE_LABEL, TASK_STATUS_LABEL, alertDescription,
} from '../lib/labels';
import type { AlertSeverity, AlertStatus, AlertType } from '../types/database.types';

type StatusFilter = 'open' | 'resolved' | 'dismissed' | 'all';
type TypeFilter = AlertType | 'all';
type SeverityFilter = AlertSeverity | 'all';

const STATUS_LABEL: Record<AlertStatus, string> = {
  open: 'Aberto',
  resolved: 'Resolvido',
  dismissed: 'Dispensado',
};

const STATUS_BADGE_COLOR: Record<AlertStatus, BadgeColor> = {
  open: 'amber',
  resolved: 'green',
  dismissed: 'gray',
};

const selectCls = `sm:w-52 bg-surface ${controlCls}`;

function CloseAlertForm({ alert, action, onConfirm, onCancel }: {
  alert: AlertWithRelations;
  action: 'resolved' | 'dismissed';
  onConfirm: (notes: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="space-y-4"
      onSubmit={async (e) => { e.preventDefault(); setBusy(true); await onConfirm(notes.trim()); setBusy(false); }}
    >
      <p className="text-sm text-gray-700">
        {action === 'resolved' ? 'Resolver' : 'Dispensar'} o alerta de <strong>{alert.youth?.full_name ?? 'jovem'}</strong>
        {' '}({alertDescription(alert)})?
      </p>
      <p data-testid="aviso-historico" className="text-xs text-gray-600 bg-gray-50 border border-gray-200 rounded-control px-3 py-2">
        {action === 'resolved' ? 'Resolver' : 'Dispensar'} não apaga as faltas; elas continuam no histórico.

        {' '}O alerta não é recriado enquanto a situação continuar a mesma. Ele só volta se uma presença quebrar a sequência.
      </p>
      <div>
        <label className={labelCls} htmlFor="notes">Observações</label>
        <textarea
          id="notes"
          rows={3}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder={action === 'resolved' ? 'Ex.: Conversamos por telefone, voltará no próximo encontro.' : 'Ex.: Está viajando neste mês.'}
          className={inputCls}
        />
      </div>
      <div className="flex justify-end gap-3">
        <button type="button" onClick={onCancel} className={secondaryBtnCls}>
          Cancelar
        </button>
        <button type="submit" disabled={busy} className={primaryBtnCls}>
          {busy ? 'Salvando...' : 'Confirmar'}
        </button>
      </div>
    </form>
  );
}

export function Alertas() {
  const toast = useToast();
  const navigate = useNavigate();
  const [status, setStatus] = useState<StatusFilter>('open');
  const [type, setType] = useState<TypeFilter>('all');
  const [severity, setSeverity] = useState<SeverityFilter>('all');
  // Filtros, ordenação e paginação são aplicados no servidor (useAlerts)
  const {
    alerts: filtered, total, page, setPage, pageSize, totalPages, openCount, loading, error, updateStatus, refetch,
  } = useAlerts({ status, type, severity });
  const [closing, setClosing] = useState<{ alert: AlertWithRelations; action: 'resolved' | 'dismissed' } | null>(null);
  const [following, setFollowing] = useState<AlertWithRelations | null>(null);
  const [emailing, setEmailing] = useState<AlertWithRelations | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const { counts: sentCounts, refetch: refetchSentCounts } = useSentCommunicationCounts(filtered.map((a) => a.id));

  const reopen = async (a: AlertWithRelations) => {
    setBusyId(a.id);
    const ok = await updateStatus(a.id, 'open');
    setBusyId(null);
    if (ok) toast.success('Alerta reaberto.');
  };

  const statusFilters: { label: string; value: StatusFilter }[] = [
    { label: `Abertos (${openCount})`, value: 'open' },
    { label: 'Resolvidos', value: 'resolved' },
    { label: 'Dispensados', value: 'dismissed' },
    { label: 'Todos', value: 'all' },
  ];

  const hasExtraFilter = type !== 'all' || severity !== 'all';

  return (
    <div className="space-y-5">
      <PageHeader
        title="Alertas"
        subtitle="Gerados automaticamente pelo sistema: faltas seguidas, frequência baixa ou em queda, falta de acompanhamento e ações atrasadas. Os alertas encerrados ficam no histórico."
      />

      <div className="bg-white border border-gray-200 rounded-card px-4 py-3 space-y-3">
        <FilterChips options={statusFilters} value={status} onChange={setStatus} />
        <div className="flex flex-col sm:flex-row gap-3">
          <select
            value={type}
            onChange={(e) => setType(e.target.value as TypeFilter)}
            className={selectCls}
            aria-label="Filtrar por tipo"
          >
            <option value="all">Todos os tipos</option>
            {ALERT_TYPES.map((t) => <option key={t} value={t}>{ALERT_TYPE_NAME[t]}</option>)}
          </select>
          <select
            value={severity}
            onChange={(e) => setSeverity(e.target.value as SeverityFilter)}
            className={selectCls}
            aria-label="Filtrar por severidade"
          >
            <option value="all">Qualquer severidade</option>
            <option value="attention">{ALERT_SEVERITY_LABEL.attention}</option>
            <option value="critical">{ALERT_SEVERITY_LABEL.critical}</option>
          </select>
        </div>
      </div>

      <ErrorBanner message={error} />

      {loading && <LoadingBlock />}

      {!loading && filtered.length === 0 && (
        <EmptyState
          icon={CheckCircle2}
          title={status === 'open' && !hasExtraFilter ? 'Nenhum alerta aberto. Tudo em dia!' : 'Nenhum alerta encontrado.'}
        />
      )}

      {!loading && filtered.length > 0 && (
        <ul className="space-y-3">
          {filtered.map((a) => {
            const openTasks = a.tasks.filter((t) => t.status === 'pending' || t.status === 'in_progress');
            const isOpen = a.status === 'open';
            const critical = a.severity === 'critical';
            const SeverityIcon = critical ? OctagonAlert : AlertTriangle;
            return (
              <li key={a.id} data-testid="alerta-item" data-tipo={a.type} data-severidade={a.severity} className="bg-white rounded-card border border-gray-200 p-4 space-y-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-start gap-3 min-w-0">
                    <SeverityIcon
                      className={`w-5 h-5 mt-0.5 flex-shrink-0 ${isOpen ? (critical ? 'text-red-600' : 'text-amber-500') : 'text-gray-300'}`}
                      aria-hidden="true"
                    />
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-gray-900 truncate">{a.youth?.full_name ?? 'Jovem'}</p>
                      <p className="text-xs text-gray-500">
                        {a.groups?.name ?? 'Sem grupo'} · <span data-testid="alerta-descricao">{alertDescription(a)}</span>
                      </p>
                      {a.type !== 'consecutive_absences' && (
                        <p className="text-xs text-gray-400">{ALERT_TYPE_NAME[a.type]}</p>
                      )}
                      {a.last_event && (
                        <p className="text-xs text-gray-400">
                          {a.type === 'consecutive_absences' ? 'Última falta' : 'Último encontro'}: {a.last_event.title} ({formatDate(a.last_event.event_date)})
                        </p>
                      )}
                      {a.youth?.phone && (
                        <a href={`tel:${a.youth.phone}`} className="inline-flex items-center gap-1 text-xs text-blue-600 mt-1">
                          <Phone className="w-3 h-3" /> {a.youth.phone}
                        </a>
                      )}
                    </div>
                  </div>
                  <div className="flex-shrink-0 flex flex-col items-end gap-1">
                    <Badge color={critical ? 'red' : 'amber'}>
                      <SeverityIcon className="w-3 h-3" aria-hidden="true" />
                      {ALERT_SEVERITY_LABEL[a.severity]}
                    </Badge>
                    <Badge color={STATUS_BADGE_COLOR[a.status]}>{STATUS_LABEL[a.status]}</Badge>
                    {(sentCounts.get(a.id) ?? 0) > 0 && (
                      <span data-testid="alerta-email-enviado">
                        <Badge color="green">
                          <MailCheck className="w-3 h-3" aria-hidden="true" />
                          E-mail enviado{(sentCounts.get(a.id) ?? 0) > 1 ? ` (${sentCounts.get(a.id)})` : ''}
                        </Badge>
                      </span>
                    )}
                  </div>
                </div>

                {(a.tasks.length > 0 || a.follow_ups.length > 0) ? (
                  <div data-testid="alerta-cadeia" className="text-xs bg-gray-50 rounded-control px-3 py-2 space-y-2">
                    {a.tasks.length > 0 && (
                      <div className="space-y-1">
                        <p className="font-medium text-gray-500">Ações</p>
                        {a.tasks.map((t) => (
                          <p key={t.id} className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-gray-600">
                            <ListChecks className="w-3.5 h-3.5" aria-hidden="true" />
                            <span>{t.title} — {TASK_STATUS_LABEL[t.status]}</span>
                            {t.due_date && <span className="text-gray-400">· prazo {formatDateOnly(t.due_date)}</span>}
                            {isOverdue(t.due_date, t.status) && <Badge color="red">Atrasada</Badge>}
                            {t.completed_by_follow_up_id && <Badge color="green">Concluída por acompanhamento</Badge>}
                          </p>
                        ))}
                      </div>
                    )}
                    {a.follow_ups.length > 0 && (
                      <div className="space-y-1">
                        <p className="font-medium text-gray-500">Acompanhamentos</p>
                        {a.follow_ups.map((f) => (
                          <p key={f.id} className="flex items-center gap-1.5 text-gray-600">
                            <HeartHandshake className="w-3.5 h-3.5 flex-shrink-0" aria-hidden="true" />
                            <span className="min-w-0 break-words">{formatDateOnly(f.occurred_at)} · {FOLLOW_UP_TYPE_LABEL[f.type]} — {f.reason}</span>
                          </p>
                        ))}
                      </div>
                    )}
                  </div>
                ) : isOpen && (
                  <p className="text-xs text-gray-400">Ainda sem ação nem acompanhamento ligados a este alerta.</p>
                )}

                {!isOpen && (a.resolution_notes || a.resolved_at) && (
                  <p className="text-xs text-gray-500">
                    {a.resolved_at && `Encerrado em ${formatDateTime(a.resolved_at)}. `}
                    {a.resolution_notes}
                  </p>
                )}

                <div className="flex flex-wrap justify-end gap-2 border-t border-gray-100 pt-3">
                  {isOpen ? (
                    <>
                      <button
                        onClick={() => setClosing({ alert: a, action: 'dismissed' })}
                        className={smallBtnCls}
                      >
                        <XCircle className="w-3.5 h-3.5" /> Dispensar
                      </button>
                      <button
                        onClick={() => setClosing({ alert: a, action: 'resolved' })}
                        className={smallBtnCls}
                      >
                        <CheckCircle2 className="w-3.5 h-3.5" /> Resolver
                      </button>
                      <button
                        onClick={() => setFollowing(a)}
                        className={smallBtnCls}
                      >
                        <HeartHandshake className="w-3.5 h-3.5" /> Registrar acompanhamento
                      </button>
                      <button
                        onClick={() => setEmailing(a)}
                        data-testid="alerta-enviar-email"
                        className={smallBtnCls}
                      >
                        <Mail className="w-3.5 h-3.5" aria-hidden="true" /> Enviar e-mail
                      </button>
                      <button
                        onClick={() => navigate(`/tarefas?novo=1&alerta=${a.id}`)}
                        className={smallPrimaryBtnCls}
                      >
                        <ListPlus className="w-3.5 h-3.5" /> {openTasks.length ? 'Outra tarefa' : 'Criar tarefa'}
                      </button>
                    </>
                  ) : (
                    <button
                      onClick={() => reopen(a)}
                      disabled={busyId === a.id}
                      className={smallBtnCls}
                    >
                      {busyId === a.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RotateCcw className="w-3.5 h-3.5" />}
                      {busyId === a.id ? 'Reabrindo…' : 'Reabrir'}
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <Pagination page={page} totalPages={totalPages} total={total} pageSize={pageSize} onPageChange={setPage} noun={total === 1 ? 'alerta' : 'alertas'} disabled={loading} />

      {closing && (
        <Modal title={closing.action === 'resolved' ? 'Resolver alerta' : 'Dispensar alerta'} onClose={() => setClosing(null)}>
          {error && <div className="mb-4"><ErrorBanner message={error} /></div>}
          <CloseAlertForm
            alert={closing.alert}
            action={closing.action}
            onCancel={() => setClosing(null)}
            onConfirm={async (notes) => {
              const ok = await updateStatus(closing.alert.id, closing.action, notes || null);
              if (ok) {
                setClosing(null);
                toast.success(closing.action === 'resolved' ? 'Alerta resolvido.' : 'Alerta dispensado.');
              }
            }}
          />
        </Modal>
      )}

      {emailing && (
        <CommunicationModal
          youthId={emailing.youth_id}
          youthName={emailing.youth?.full_name ?? 'Jovem'}
          groupName={emailing.groups?.name}
          fixedLinks={{ alert: { id: emailing.id, type: emailing.type, label: alertDescription(emailing) } }}
          onClose={() => setEmailing(null)}
          onChanged={refetchSentCounts}
        />
      )}

      {following && (
        <FollowUpFormModal
          youthId={following.youth_id}
          youthName={following.youth?.full_name ?? 'Jovem'}
          defaultAlertId={following.id}
          onClose={() => setFollowing(null)}
          onSaved={() => { void refetch(); }}
        />
      )}
    </div>
  );
}
