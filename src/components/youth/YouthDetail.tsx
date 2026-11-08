import { useMemo, useState } from 'react';
import type { Youth } from '../../types/database.types';
import { RecentActivity } from '../activity/RecentActivity';
import { useYouthHistory } from '../../hooks/useYouthHistory';
import { useYouthSituation } from '../../hooks/useYouthSituation';
import { useAppSettings } from '../../hooks/useSettings';
import { Link } from 'react-router-dom';
import { CheckCircle2, Circle, AlertCircle, AlertTriangle, ListPlus } from 'lucide-react';
import { Badge } from '../ui/Badge';
import { LoadingBlock } from '../ui/LoadingBlock';
import { SituationPanel } from './SituationPanel';
import { FollowUpSection } from '../followups/FollowUpSection';
import { CommunicationSection } from '../communications/CommunicationSection';
import type { AlertChoice } from '../communications/CommunicationModal';
import { secondaryBtnCls } from '../../lib/formStyles';
import { ALERT_SEVERITY_LABEL, alertDescription } from '../../lib/labels';

interface YouthDetailProps {
  youth: Youth;
  groupName?: string | null;
  canEdit: boolean;
  onCreateTask?: () => void;
  onEdit: () => void;
  onToggleStatus: () => void;
  onClose: () => void;
  actionLoading: boolean;
  /** Avisa a tela pai que a situação do jovem pode ter mudado (acompanhamento registrado, etc.) */
  onDataChanged?: () => void;
  /** Só passado para coordenador e jovem ainda não anonimizado: sem ele, o botão não aparece. */
  onAnonymize?: () => void;
}

const GENDER_LABEL: Record<string, string> = {
  male: 'Masculino',
  female: 'Feminino',
  other: 'Outro',
};

function age(birthDate: string | null): string {
  if (!birthDate) return '—';
  const diff = Date.now() - new Date(birthDate).getTime();
  const years = Math.floor(diff / (1000 * 60 * 60 * 24 * 365.25));
  return `${years} anos`;
}

function Row({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div className="py-2 border-b border-line-soft last:border-0">
      <span className="text-xs text-ink-muted block">{label}</span>
      <span className="text-sm text-ink">{value || '—'}</span>
    </div>
  );
}

export function YouthDetail({ youth, groupName, canEdit, onCreateTask, onEdit, onToggleStatus, onClose, actionLoading, onDataChanged, onAnonymize }: YouthDetailProps) {
  const isActive = youth.is_active;
  const { loading: histLoading, error: histErr, stats, openAlerts, refetch: refetchHistory } = useYouthHistory(youth.id);
  const { situation, loading: situationLoading, error: situationError, refetch: refetchSituation } = useYouthSituation(youth.id);
  const { settings } = useAppSettings();

  // Acompanhamento registrado/editado/transferido: situação e alertas (resolvidos pelo banco) mudam
  const [activityVersion, setActivityVersion] = useState(0);
  const handleFollowUpChanged = () => {
    setActivityVersion((v) => v + 1);
    refetchSituation();
    refetchHistory();
    onDataChanged?.();
  };
  // E-mail marcado como enviado entra no histórico operacional; situação e alertas não mudam
  const [communicationsVersion, setCommunicationsVersion] = useState(0);
  const handleCommunicationChanged = () => {
    setCommunicationsVersion((v) => v + 1);
    setActivityVersion((v) => v + 1);
  };
  const alertChoices = useMemo<AlertChoice[]>(
    () => openAlerts.map((a) => ({ id: a.id, type: a.type, label: alertDescription(a) })),
    [openAlerts],
  );

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h3 className="text-lg font-semibold text-ink">{youth.full_name}</h3>
          <div className="mt-1">
            <Badge color={isActive ? 'green' : 'gray'}>{isActive ? 'Ativo' : 'Inativo'}</Badge>
          </div>
        </div>
      </div>

      <SituationPanel
        situation={situation}
        loading={situationLoading}
        error={situationError}
        limits={{ attention: settings?.absence_alert_threshold, critical: settings?.critical_absence_threshold }}
      />

      {openAlerts.length > 0 && (
        <div data-testid="alertas-abertos-jovem" className="flex items-start gap-2 text-sm text-warning-ink bg-warning-soft border border-warning-line rounded-control px-3 py-2">
          <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" aria-hidden="true" />
          <div className="flex-1 min-w-0">
            <ul className="space-y-0.5">
              {openAlerts.map((a) => (
                <li key={a.id} className="font-medium">
                  {alertDescription(a)}
                  {a.severity === 'critical' && <span className="ml-1 text-xs font-semibold">· {ALERT_SEVERITY_LABEL.critical}</span>}
                </li>
              ))}
            </ul>
            <Link to="/alertas" className="text-xs underline">Ver alertas</Link>
          </div>
        </div>
      )}

      {/* Info grid */}
      <div className="bg-canvas rounded-control px-4 py-1 divide-y divide-line-soft">
        <Row label="Grupo" value={groupName ?? (youth.group_id ? null : 'Sem grupo')} />
        <Row label="Data de nascimento" value={youth.birth_date ? new Date(youth.birth_date + 'T00:00:00').toLocaleDateString('pt-BR') : null} />
        <Row label="Idade" value={age(youth.birth_date)} />
        <Row label="Gênero" value={youth.gender ? GENDER_LABEL[youth.gender] : null} />
        <Row label="Telefone" value={youth.phone} />
        <Row label="E-mail" value={youth.email} />
        <Row label="Endereço" value={youth.address} />
        <Row label="Observações" value={youth.notes} />
      </div>

      {/* Acompanhamento */}
      <FollowUpSection
        youth={{ id: youth.id, full_name: youth.full_name }} groupName={groupName}
        onChanged={handleFollowUpChanged} onCommunicationChanged={handleCommunicationChanged}
      />

      {/* Comunicações (e-mail) */}
      <CommunicationSection
        youth={{ id: youth.id, full_name: youth.full_name }} groupName={groupName}
        alertChoices={alertChoices} refreshKey={communicationsVersion} onChanged={handleCommunicationChanged}
      />

      {/* Histórico de Presença */}
      <div className="border-t border-line-soft pt-4">
        <h4 className="text-sm font-semibold text-ink mb-3">Histórico de Presença</h4>
        
        {histLoading ? (
          <LoadingBlock size="sm" />
        ) : histErr ? (
          <div className="flex items-center gap-2 text-xs text-red-600 bg-danger-soft p-3 rounded-control">
            <AlertCircle className="w-4 h-4" /> {histErr}
          </div>
        ) : stats && stats.total > 0 ? (
          <div className="space-y-4">
            {/* Stats row */}
            <div className="grid grid-cols-3 gap-2">
              <div className="bg-canvas rounded-control p-3 text-center">
                <span className="block text-xs text-ink-muted uppercase font-medium">Presenças</span>
                <span className="block text-lg font-semibold text-success-ink">{stats.present}</span>
              </div>
              <div className="bg-canvas rounded-control p-3 text-center">
                <span className="block text-xs text-ink-muted uppercase font-medium">Faltas</span>
                <span className="block text-lg font-semibold text-red-600">{stats.absent}</span>
              </div>
              <div className="bg-canvas rounded-control p-3 text-center">
                <span className="block text-xs text-ink-muted uppercase font-medium">Frequência</span>
                <span className="block text-lg font-semibold text-action">{stats.percentage}%</span>
              </div>
            </div>

            {/* List */}
            <div className="bg-surface border border-line rounded-control max-h-48 overflow-y-auto">
              <ul className="divide-y divide-line-soft">
                {stats.history.map(record => (
                  <li key={record.id} className="flex items-center justify-between px-3 py-2 hover:bg-surface-hover">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-ink truncate">{record.events.title}</p>
                      <p className="text-xs text-ink-muted">
                        {new Date(record.events.event_date).toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' })}
                      </p>
                    </div>
                    <div className="flex-shrink-0 ml-3">
                      {record.present ? (
                        <CheckCircle2 className="w-5 h-5 text-success-ink" />
                      ) : (
                        <Circle className="w-5 h-5 text-danger-ink" />
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        ) : (
          <p className="text-xs text-ink-muted italic bg-canvas p-3 rounded-control text-center">
            Nenhuma chamada registrada para este jovem ainda.
          </p>
        )}
      </div>

      {/* Histórico operacional (últimas 10 entradas) */}
      <RecentActivity youthId={youth.id} version={activityVersion} />

      {/* Actions */}
      <div className="flex flex-wrap gap-2 justify-end pt-2 border-t border-line-soft">
        {onAnonymize && (
          <button
            onClick={onAnonymize}
            disabled={actionLoading}
            className="sm:mr-auto px-3 py-2 text-sm font-medium text-danger-ink border border-danger-line rounded-control hover:bg-danger-soft disabled:opacity-50 transition-colors"
          >
            Anonimizar dados
          </button>
        )}
        <button onClick={onClose} className={secondaryBtnCls}>
          Fechar
        </button>
        {onCreateTask && (
          <button
            onClick={onCreateTask}
            className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-action-ink bg-action-soft border border-action-line rounded-control hover:bg-action-soft transition-colors"
          >
            <ListPlus className="w-4 h-4" />
            Nova tarefa
          </button>
        )}
        {canEdit && (
          <>
            <button
              onClick={onToggleStatus}
              disabled={actionLoading}
              className={`px-3 py-2 text-sm font-medium rounded-control disabled:opacity-50 transition-colors ${
                isActive
                  ? 'text-danger-ink bg-danger-soft border border-danger-line hover:bg-danger-soft'
                  : 'text-success-ink bg-success-soft border border-success-line hover:bg-success-soft'
              }`}
            >
              {actionLoading ? '...' : isActive ? 'Desativar' : 'Reativar'}
            </button>
            <button
              onClick={onEdit}
              className="px-3 py-2 text-sm font-medium text-white bg-action rounded-control hover:bg-action-hover transition-colors"
            >
              Editar
            </button>
          </>
        )}
      </div>
    </div>
  );
}
