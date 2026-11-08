import { useState, useMemo } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useAttendance, type SaveAttendanceResult } from '../hooks/useAttendance';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../contexts/ToastContext';
import { formatDateTime } from '../lib/format';
import {
  attendanceMarkLabel,
  countAttendance,
  editedRowsToSave,
  filterBySearchAndGroup,
  filterByState,
  formatAttendanceRate,
  nextMark,
  unregisteredIds,
  type AttendanceFilter,
  type AttendanceMark,
  type AttendanceRow,
} from '../lib/attendance';
import { ALERT_SEVERITY_LABEL, alertTypeLabel } from '../lib/labels';
import { ArrowLeft, AlertCircle, AlertTriangle, CheckCircle2, XCircle, Loader2, CheckCheck } from 'lucide-react';
import { SearchInput } from '../components/ui/SearchInput';
import { LoadingBlock } from '../components/ui/LoadingBlock';
import { FilterChips } from '../components/ui/FilterChips';
import { ProgressBar } from '../components/ui/ProgressBar';
import { ErrorBanner } from '../components/ErrorBanner';
import { cn } from '../lib/utils';
import { primaryBtnCls, secondaryBtnCls } from '../lib/formStyles';

type SaveSummary = SaveAttendanceResult & { completionFailed: boolean };

function plural(n: number, one: string, many: string) {
  return `${n} ${n === 1 ? one : many}`;
}

export function Chamada() {
  const toast = useToast();
  const { id: eventId } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const { role } = useAuth();
  const isCoordinator = role === 'coordinator';
  const { loading, error, event, attendanceMap, groups, savedCount, saveAttendance, markEventCompleted, refetch } = useAttendance(eventId!);

  // Alterações locais (youth_id -> estado) sobrepostas ao que veio do banco; null = não registrado
  const [edits, setEdits] = useState<Record<string, AttendanceMark>>({});
  const [saving, setSaving] = useState(false);
  const [markCompleted, setMarkCompleted] = useState(true);
  const [summary, setSummary] = useState<SaveSummary | null>(null);
  const isCancelled = event?.status === 'cancelled';

  // Filtros
  const [search, setSearch] = useState('');
  const [groupFilter, setGroupFilter] = useState<string>('all');
  const [stateFilter, setStateFilter] = useState<AttendanceFilter>('all');

  const groupName = useMemo(() => new Map(groups.map((g) => [g.id, g.name])), [groups]);

  // Todas as linhas (já com as edições aplicadas), em ordem alfabética
  const rows = useMemo<AttendanceRow[]>(() => {
    return Object.values(attendanceMap)
      .map((s) => ({ ...s, present: s.youth_id in edits ? edits[s.youth_id] : s.present }))
      .sort((a, b) => a.full_name.localeCompare(b.full_name));
  }, [attendanceMap, edits]);

  const counts = useMemo(() => countAttendance(rows), [rows]);

  // Busca + grupo definem o "escopo"; o filtro de estado refina dentro dele
  const scoped = useMemo(() => filterBySearchAndGroup(rows, search, groupFilter), [rows, search, groupFilter]);
  const scopedCounts = useMemo(() => countAttendance(scoped), [scoped]);
  const visible = useMemo(() => filterByState(scoped, stateFilter), [scoped, stateFilter]);
  const visibleUnregistered = useMemo(() => unregisteredIds(visible), [visible]);

  const filterOptions: { label: string; value: AttendanceFilter }[] = [
    { label: `Todos (${scopedCounts.total})`, value: 'all' },
    { label: `Não registrados (${scopedCounts.unregistered})`, value: 'unregistered' },
    { label: `Presentes (${scopedCounts.present})`, value: 'present' },
    { label: `Ausentes (${scopedCounts.absent})`, value: 'absent' },
  ];

  const handleMark = (row: AttendanceRow, target: boolean) => {
    if (isCancelled) return;
    const next = nextMark(row.present, target, row.saved);
    if (next === row.present) return;
    setEdits((prev) => ({ ...prev, [row.youth_id]: next }));
  };

  // Só afeta quem está sem estado; nunca sobrescreve quem já foi marcado
  const markUnregisteredPresent = () => {
    if (isCancelled || visibleUnregistered.length === 0) return;
    setEdits((prev) => {
      const next = { ...prev };
      for (const id of visibleUnregistered) next[id] = true;
      return next;
    });
  };

  // Só as linhas editadas nesta sessão (e diferentes do carregado) são enviadas, independentemente do
  // filtro da tela: reenviar linhas intactas poderia sobrescrever a alteração de outra pessoa.
  const pending = useMemo(() => editedRowsToSave(attendanceMap, edits), [attendanceMap, edits]);
  const canSave = !saving && !isCancelled && pending.length > 0;

  const handleSave = async () => {
    if (!canSave) return;
    setSaving(true);
    const res = await saveAttendance(pending);
    if (!res) {
      setSaving(false);
      return;
    }
    setEdits({});
    let completionFailed = false;
    if (isCoordinator && markCompleted && event?.status === 'scheduled') {
      completionFailed = !(await markEventCompleted());
    }
    setSaving(false);
    setSummary({ ...res, completionFailed });
    if (!completionFailed) toast.success('Chamada registrada.');
  };

  if (loading) {
    return <LoadingBlock />;
  }

  if (!event) {
    return (
      <div className="text-center py-16">
        <p className="text-ink-muted" role={error ? 'alert' : undefined}>
          {error ?? 'Encontro não encontrado ou sem permissão.'}
        </p>
        <div className="mt-4 flex items-center justify-center gap-4">
          {error && (
            <button
              type="button"
              onClick={() => void refetch()}
              className="min-h-11 px-4 py-2 text-sm font-medium text-white bg-action rounded-card hover:bg-action-hover transition-colors"
            >
              Tentar novamente
            </button>
          )}
          <button onClick={() => navigate('/encontros')} className="min-h-11 px-4 text-action hover:underline">
            Voltar
          </button>
        </div>
      </div>
    );
  }

  const header = (
    <div className="flex items-center gap-4">
      <button
        onClick={() => navigate('/encontros')}
        aria-label="Voltar para os encontros"
        className="p-2 -ml-2 min-h-11 min-w-11 flex items-center justify-center text-ink-faint hover:text-ink-soft rounded-full hover:bg-surface-muted"
      >
        <ArrowLeft className="w-5 h-5" />
      </button>
      <div className="min-w-0">
        <h2 className="text-xl font-semibold text-ink leading-tight">Chamada</h2>
        <p className="text-sm text-ink-muted">{event.title} · {formatDateTime(event.event_date)}</p>
        {savedCount > 0 && (
          <p className="text-xs text-success-ink mt-0.5">Chamada já registrada — você está editando.</p>
        )}
      </div>
    </div>
  );

  // Pós-salvar: painel de resumo (não navega sozinho)
  if (summary) {
    return (
      <div className="max-w-2xl mx-auto space-y-6">
        {header}
        <ErrorBanner message={error} />
        <section
          aria-labelledby="chamada-resumo-titulo"
          data-testid="chamada-resumo"
          className="bg-surface border border-line rounded-card p-4 sm:p-6 space-y-4"
        >
          <div className="flex items-start gap-3">
            <CheckCircle2 className="w-6 h-6 text-success-ink flex-shrink-0" aria-hidden="true" />
            <div>
              <h3 id="chamada-resumo-titulo" className="text-base font-semibold text-ink">
                {summary.completionFailed
                  ? 'Chamada registrada, mas o encontro não foi marcado como realizado.'
                  : 'Chamada registrada.'}
              </h3>
              <p className="text-sm text-ink-soft mt-1" data-testid="chamada-resumo-numeros">
                {plural(summary.total_registered, 'registrado', 'registrados')} ·{' '}
                {plural(summary.present, 'presente', 'presentes')} ·{' '}
                {plural(summary.absent, 'ausente', 'ausentes')} · {summary.rate}%
                {counts.total !== summary.total_registered && (
                  <span className="text-ink-muted" data-testid="chamada-resumo-de-total">
                    {' '}· de {plural(counts.total, 'jovem', 'jovens')}
                  </span>
                )}
              </p>
            </div>
          </div>

          {summary.new_alerts.length === 0 ? (
            <p className="text-sm text-ink-muted">Nenhum novo alerta.</p>
          ) : (
            <div data-testid="chamada-novos-alertas">
              <p className="text-sm font-medium text-warning-ink flex items-center gap-2">
                <AlertTriangle className="w-4 h-4" aria-hidden="true" />
                Novas situações que pedem atenção
              </p>
              <ul className="mt-2 divide-y divide-line-soft border border-line rounded-control">
                {summary.new_alerts.map((a) => (
                  <li key={a.id} className="px-3 py-2 text-sm flex flex-wrap items-center justify-between gap-x-3">
                    <span className="font-medium text-ink">{a.youth_name}</span>
                    <span className="text-ink-soft">
                      {alertTypeLabel(a.type, a.consecutive_absences)}
                      {a.severity === 'critical' && ` · ${ALERT_SEVERITY_LABEL.critical}`}
                    </span>
                  </li>
                ))}
              </ul>
              <Link to="/alertas" className="inline-block mt-2 text-sm text-action hover:underline">
                Ver alertas
              </Link>
            </div>
          )}

          <div className="flex flex-col sm:flex-row sm:justify-end gap-3 pt-2">
            <button
              onClick={() => setSummary(null)}
              className="min-h-11 px-5 py-2 text-sm font-medium text-ink-soft bg-surface border border-line-strong rounded-card hover:bg-surface-hover transition-colors"
            >
              Continuar editando
            </button>
            <button
              onClick={() => navigate('/encontros')}
              className="min-h-11 px-5 py-2 text-sm font-medium text-white bg-action rounded-card hover:bg-action-hover transition-colors"
            >
              Voltar aos encontros
            </button>
          </div>
        </section>
      </div>
    );
  }

  const stat = (label: string, value: string | number, testId: string, tone?: string) => (
    <div className="text-center min-w-0">
      <p className={cn('text-xl font-semibold leading-none text-ink', tone)} data-testid={testId}>{value}</p>
      <p className="mt-1 text-xs leading-tight text-ink-muted">{label}</p>
    </div>
  );

  return (
    <div className="max-w-2xl mx-auto space-y-4 sm:space-y-6">
      {header}

      <ErrorBanner message={error} />

      {isCancelled && (
        <div className="flex items-center gap-2 text-sm text-ink-soft bg-surface-muted border border-line rounded-control px-4 py-3">
          <AlertCircle className="w-4 h-4 flex-shrink-0" />
          Este encontro foi cancelado. A chamada não pode ser alterada e não conta na frequência.
        </div>
      )}

      {!isCancelled && groups.length === 0 && (
        <div className="text-sm text-warning-ink bg-warning-soft border border-warning-line rounded-control px-4 py-3">
          Nenhum grupo vinculado a este encontro. Edite o encontro e selecione os grupos participantes.
        </div>
      )}

      {/* Resumo */}
      <div className="rounded-card border border-line bg-surface p-3 sm:p-4">
        <div data-testid="chamada-contadores" className="grid grid-cols-5 gap-2">
          {stat('Total', counts.total, 'contador-total')}
          {stat('Presentes', counts.present, 'contador-presentes', 'text-success-ink')}
          {stat('Ausentes', counts.absent, 'contador-ausentes', 'text-danger-ink')}
          {stat('Não registrados', counts.unregistered, 'contador-nao-registrados')}
          {stat('Frequência', formatAttendanceRate(counts.rate), 'contador-percentual')}
        </div>
        {counts.total > 0 && (
          <div className="mt-3" data-testid="chamada-progresso">
            <div
              role="progressbar"
              aria-label="Jovens com presença registrada"
              aria-valuemin={0}
              aria-valuemax={counts.total}
              aria-valuenow={counts.total - counts.unregistered}
            >
              <ProgressBar value={((counts.total - counts.unregistered) / counts.total) * 100} min={1} />
            </div>
            <p className="mt-1.5 text-xs text-ink-muted">
              {counts.total - counts.unregistered} de {counts.total} com registro
            </p>
          </div>
        )}
      </div>

      {/* Filtros */}
      <div className="bg-surface border border-line rounded-card px-4 py-3 space-y-3">
        <div className="flex flex-col sm:flex-row gap-3">
          <SearchInput
            value={search}
            onChange={setSearch}
            placeholder="Buscar jovem..."
            aria-label="Buscar jovem"
            className="flex-1"
          />
          {groups.length > 1 && (
            <select
              value={groupFilter}
              onChange={(e) => setGroupFilter(e.target.value)}
              aria-label="Filtrar por grupo"
              className="sm:w-48 min-h-10 px-3 py-2 text-sm border border-line-strong rounded-control focus:outline-none focus:ring-2 focus:ring-action/20 focus:border-action"
            >
              <option value="all">Todos os grupos</option>
              {groups.map((g) => (
                <option key={g.id} value={g.id}>{g.name}</option>
              ))}
            </select>
          )}
        </div>
        <FilterChips options={filterOptions} value={stateFilter} onChange={setStateFilter} />
        <button
          onClick={markUnregisteredPresent}
          disabled={visibleUnregistered.length === 0 || isCancelled}
          className={cn('w-full sm:w-auto', secondaryBtnCls)}
        >
          <CheckCheck className="w-4 h-4" aria-hidden="true" />
          Marcar não registrados (visíveis) como presentes
        </button>
      </div>

      {/* Lista */}
      {visible.length === 0 ? (
        <div className="bg-surface rounded-card border border-line p-8 text-center text-ink-muted text-sm">
          {counts.total === 0
            ? 'Nenhum jovem ativo nos grupos deste encontro.'
            : 'Nenhum jovem encontrado com os filtros atuais.'}
        </div>
      ) : (
        <ul className="space-y-2 md:space-y-0 md:bg-surface md:rounded-card md:border md:border-line md:divide-y md:divide-line-soft md:overflow-hidden">
          {visible.map((y) => {
            const stateText = attendanceMarkLabel(y.present);
            return (
              <li
                key={y.youth_id}
                data-testid="chamada-jovem"
                data-state={y.present === true ? 'present' : y.present === false ? 'absent' : 'unregistered'}
                className="bg-surface border border-line rounded-card p-3 md:border-0 md:rounded-none md:px-4 md:flex md:items-center md:justify-between md:gap-4"
              >
                <div className="min-w-0">
                  <p className="text-sm font-medium text-ink break-words">{y.full_name}</p>
                  <p className="text-xs text-ink-muted">
                    {groupName.get(y.group_id) ?? 'Sem grupo'}
                    {' · '}
                    <span
                      data-testid="estado-texto"
                      className={cn(
                        'font-medium',
                        y.present === true && 'text-success-ink',
                        y.present === false && 'text-danger-ink',
                      )}
                    >
                      {stateText}
                    </span>
                  </p>
                </div>
                <div className="grid grid-cols-2 gap-2 mt-3 md:mt-0 md:w-72 md:flex-shrink-0">
                  <button
                    type="button"
                    onClick={() => handleMark(y, true)}
                    disabled={isCancelled}
                    aria-pressed={y.present === true}
                    aria-label={`Presente: ${y.full_name}`}
                    className={cn(
                      'min-h-11 px-3 text-sm font-medium rounded-control border flex items-center justify-center gap-2 transition-colors disabled:opacity-60',
                      y.present === true
                        ? 'bg-green-600 border-green-600 text-white'
                        : 'bg-surface border-line-strong text-ink-soft hover:bg-surface-hover',
                    )}
                  >
                    <CheckCircle2 className="w-5 h-5" aria-hidden="true" />
                    Presente
                  </button>
                  <button
                    type="button"
                    onClick={() => handleMark(y, false)}
                    disabled={isCancelled}
                    aria-pressed={y.present === false}
                    aria-label={`Ausente: ${y.full_name}`}
                    className={cn(
                      'min-h-11 px-3 text-sm font-medium rounded-control border flex items-center justify-center gap-2 transition-colors disabled:opacity-60',
                      y.present === false
                        ? 'bg-red-600 border-red-600 text-white'
                        : 'bg-surface border-line-strong text-ink-soft hover:bg-surface-hover',
                    )}
                  >
                    <XCircle className="w-5 h-5" aria-hidden="true" />
                    Ausente
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {/* Ao salvar: só o coordenador, e só em encontro agendado */}
      {isCoordinator && event.status === 'scheduled' && !isCancelled && (
        <label className="flex min-h-11 cursor-pointer items-center gap-3 rounded-card border border-line bg-surface px-4 text-sm text-ink-soft">
          <input
            type="checkbox"
            checked={markCompleted}
            onChange={(e) => setMarkCompleted(e.target.checked)}
            className="h-4 w-4 rounded border-line-strong accent-action"
          />
          Marcar encontro como realizado
        </label>
      )}

      {/* Salvar: uma linha só (estado à esquerda, botão à direita) para cobrir pouco da lista no celular */}
      <div className="sticky bottom-20 md:bottom-0 z-[5] flex items-center justify-between gap-3 rounded-card border border-line bg-surface p-3 shadow-lg">
        <div className="flex min-w-0 flex-col gap-0.5">
          {counts.unregistered > 0 && counts.total > 0 && (
            <p className="text-xs text-ink-muted" data-testid="aviso-sem-registro">
              {counts.unregistered === 1
                ? '1 jovem ficará sem registro'
                : `${counts.unregistered} jovens ficarão sem registro`}
            </p>
          )}
          <p className="text-xs text-ink-muted" id="chamada-salvar-status" data-testid="chamada-alteracoes">
            {pending.length === 0
              ? 'Nenhuma alteração para salvar.'
              : pending.length === 1
                ? '1 alteração será salva'
                : `${pending.length} alterações serão salvas`}
          </p>
        </div>
        <button
          onClick={handleSave}
          disabled={!canSave}
          aria-describedby="chamada-salvar-status"
          className={cn('flex-shrink-0 md:px-6', primaryBtnCls)}
        >
          {saving ? (
            <><Loader2 className="w-4 h-4 animate-spin" /> Salvando...</>
          ) : (
            'Salvar Chamada'
          )}
        </button>
      </div>
    </div>
  );
}
