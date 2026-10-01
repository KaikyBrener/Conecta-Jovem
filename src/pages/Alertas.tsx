import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertTriangle, CheckCircle2, ListPlus, Loader2, Phone, RotateCcw, XCircle, ListChecks } from 'lucide-react';
import { useAlerts, type AlertWithRelations } from '../hooks/useAlerts';
import { Modal } from '../components/Modal';
import { ErrorBanner } from '../components/ErrorBanner';
import { PageHeader } from '../components/ui/PageHeader';
import { EmptyState } from '../components/ui/EmptyState';
import { LoadingBlock } from '../components/ui/LoadingBlock';
import { FilterChips } from '../components/ui/FilterChips';
import { Badge, type BadgeColor } from '../components/ui/Badge';
import { inputCls, labelCls, primaryBtnCls, secondaryBtnCls } from '../lib/formStyles';
import { formatDate, formatDateTime } from '../lib/format';
import { TASK_STATUS_LABEL } from '../lib/labels';
import type { AlertStatus } from '../types/database.types';

type Filter = 'open' | 'closed' | 'all';

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
        {action === 'resolved' ? 'Resolver' : 'Dispensar'} o alerta de <strong>{alert.youth?.full_name ?? 'jovem'}</strong>?
        {action === 'dismissed' && ' O alerta não será recriado até que ocorra uma nova falta.'}
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
  const navigate = useNavigate();
  const { alerts, loading, error, updateStatus } = useAlerts();
  const [filter, setFilter] = useState<Filter>('open');
  const [closing, setClosing] = useState<{ alert: AlertWithRelations; action: 'resolved' | 'dismissed' } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const openCount = alerts.filter((a) => a.status === 'open').length;
  const filtered = useMemo(
    () => alerts.filter((a) => filter === 'all' || (filter === 'open' ? a.status === 'open' : a.status !== 'open')),
    [alerts, filter],
  );

  const reopen = async (a: AlertWithRelations) => {
    setBusyId(a.id);
    await updateStatus(a.id, 'open');
    setBusyId(null);
  };

  const filters: { label: string; value: Filter }[] = [
    { label: `Abertos (${openCount})`, value: 'open' },
    { label: 'Encerrados', value: 'closed' },
    { label: 'Todos', value: 'all' },
  ];

  return (
    <div className="space-y-5">
      <PageHeader
        title="Alertas"
        subtitle="Gerados automaticamente a partir das chamadas quando um jovem acumula faltas consecutivas."
      />

      <div className="bg-white border border-gray-200 rounded-xl px-4 py-3">
        <FilterChips options={filters} value={filter} onChange={setFilter} />
      </div>

      <ErrorBanner message={error} />

      {loading && <LoadingBlock />}

      {!loading && filtered.length === 0 && (
        <EmptyState
          icon={CheckCircle2}
          title={filter === 'open' ? 'Nenhum alerta aberto. Tudo em dia!' : 'Nenhum alerta encontrado.'}
        />
      )}

      {!loading && filtered.length > 0 && (
        <ul className="space-y-3">
          {filtered.map((a) => {
            const openTasks = a.tasks.filter((t) => t.status === 'pending' || t.status === 'in_progress');
            return (
              <li key={a.id} className="bg-white rounded-xl border border-gray-200 p-4 space-y-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-start gap-3 min-w-0">
                    <AlertTriangle className={`w-5 h-5 mt-0.5 flex-shrink-0 ${a.status === 'open' ? 'text-amber-500' : 'text-gray-300'}`} />
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-gray-900 truncate">{a.youth?.full_name ?? 'Jovem'}</p>
                      <p className="text-xs text-gray-500">
                        {a.groups?.name ?? 'Sem grupo'} · {a.consecutive_absences} falta{a.consecutive_absences !== 1 ? 's' : ''} consecutiva{a.consecutive_absences !== 1 ? 's' : ''}
                      </p>
                      {a.last_event && (
                        <p className="text-xs text-gray-400">
                          Última falta: {a.last_event.title} ({formatDate(a.last_event.event_date)})
                        </p>
                      )}
                      {a.youth?.phone && (
                        <a href={`tel:${a.youth.phone}`} className="inline-flex items-center gap-1 text-xs text-blue-600 mt-1">
                          <Phone className="w-3 h-3" /> {a.youth.phone}
                        </a>
                      )}
                    </div>
                  </div>
                  <div className="flex-shrink-0">
                    <Badge color={STATUS_BADGE_COLOR[a.status]}>{STATUS_LABEL[a.status]}</Badge>
                  </div>
                </div>

                {a.tasks.length > 0 && (
                  <div className="text-xs bg-gray-50 rounded-lg px-3 py-2 space-y-1">
                    {a.tasks.map((t) => (
                      <p key={t.id} className="flex items-center gap-1.5 text-gray-600">
                        <ListChecks className="w-3.5 h-3.5" /> {t.title} — {TASK_STATUS_LABEL[t.status]}
                      </p>
                    ))}
                  </div>
                )}

                {a.status !== 'open' && (a.resolution_notes || a.resolved_at) && (
                  <p className="text-xs text-gray-500">
                    {a.resolved_at && `Encerrado em ${formatDateTime(a.resolved_at)}. `}
                    {a.resolution_notes}
                  </p>
                )}

                <div className="flex flex-wrap justify-end gap-2 border-t border-gray-100 pt-3">
                  {a.status === 'open' ? (
                    <>
                      <button
                        onClick={() => setClosing({ alert: a, action: 'dismissed' })}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
                      >
                        <XCircle className="w-3.5 h-3.5" /> Dispensar
                      </button>
                      <button
                        onClick={() => setClosing({ alert: a, action: 'resolved' })}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-green-700 bg-green-50 border border-green-200 rounded-lg hover:bg-green-100 transition-colors"
                      >
                        <CheckCircle2 className="w-3.5 h-3.5" /> Resolver
                      </button>
                      <button
                        onClick={() => navigate(`/tarefas?novo=1&alerta=${a.id}`)}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 transition-colors"
                      >
                        <ListPlus className="w-3.5 h-3.5" /> {openTasks.length ? 'Outra tarefa' : 'Criar tarefa'}
                      </button>
                    </>
                  ) : (
                    <button
                      onClick={() => reopen(a)}
                      disabled={busyId === a.id}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50 transition-colors"
                    >
                      {busyId === a.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RotateCcw className="w-3.5 h-3.5" />}
                      Reabrir
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {closing && (
        <Modal title={closing.action === 'resolved' ? 'Resolver alerta' : 'Dispensar alerta'} onClose={() => setClosing(null)}>
          {error && <div className="mb-4"><ErrorBanner message={error} /></div>}
          <CloseAlertForm
            alert={closing.alert}
            action={closing.action}
            onCancel={() => setClosing(null)}
            onConfirm={async (notes) => {
              const ok = await updateStatus(closing.alert.id, closing.action, notes || null);
              if (ok) setClosing(null);
            }}
          />
        </Modal>
      )}
    </div>
  );
}
