import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { CalendarClock, ChevronRight } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { useDashboard } from '../hooks/useDashboard';
import { useAttendanceReport } from '../hooks/useReports';
import { ErrorBanner } from '../components/ErrorBanner';
import { PageHeader } from '../components/ui/PageHeader';
import { LoadingBlock } from '../components/ui/LoadingBlock';
import { Panel, PanelEmpty, PanelLink, Stat, StatGrid } from '../components/ui/Card';
import { SituationBadge } from '../components/youth/SituationBadge';
import { AttendanceChart } from '../components/reports/AttendanceChart';
import { appToday, formatDateOnly, formatDateTime, formatPercent } from '../lib/format';
import { resolvePeriod } from '../lib/periods';
import { cn } from '../lib/utils';

export const Dashboard = () => {
  const { role, profile } = useAuth();
  const { data, loading, error } = useDashboard();
  const isCoordinator = role === 'coordinator';

  // Gráfico: frequência por encontro nos últimos 30 dias (mesma janela da frequência média). Se falhar, some
  // sem atrapalhar o painel (o erro já é registrado).
  const today = useMemo(() => appToday(), []);
  const range = useMemo(() => resolvePeriod('last30', today), [today]);
  const chart = useAttendanceReport(data ? range : null, null, 3);
  const series = chart.data?.series ?? [];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Visão geral"
        subtitle={`${profile?.full_name ? `Olá, ${profile.full_name.split(' ')[0]}! ` : ''}Veja quem precisa de cuidado agora ${isCoordinator ? 'no ministério.' : 'nos seus grupos.'}`}
      />

      <ErrorBanner message={error} />

      {loading && !data && <LoadingBlock />}

      {data && (
        <>
          <StatGrid cols={isCoordinator ? 4 : 3}>
            <Stat
              testId="dash-alertas"
              label="Alertas abertos"
              value={String(data.open_alerts.total)}
              hint={data.open_alerts.total > 0
                ? <><span className="font-medium text-danger-ink">{data.open_alerts.critical} crítico(s)</span> · <span className="font-medium text-warning-ink">{data.open_alerts.attention} em atenção</span></>
                : 'nenhum alerta aberto'}
              tone={data.open_alerts.total > 0 ? undefined : 'muted'}
              to="/alertas"
            />
            <Stat
              testId="dash-acoes-atrasadas"
              label="Ações atrasadas"
              value={String(data.overdue_actions)}
              hint={data.overdue_actions > 0 ? 'passaram do prazo' : 'nenhuma atrasada'}
              tone={data.overdue_actions > 0 ? 'danger' : 'muted'}
              to="/tarefas?filtro=atrasadas"
            />
            <Stat
              testId="dash-frequencia"
              label="Frequência média (30 dias)"
              value={formatPercent(data.avg_attendance)}
              hint={data.avg_attendance_records > 0 ? `${data.avg_attendance_records} registros` : 'sem registros de chamada no período'}
              tone={data.avg_attendance_records > 0 ? undefined : 'muted'}
              to="/relatorios"
            />
            {isCoordinator && (
              <Stat
                testId="dash-sem-grupo"
                label="Jovens sem grupo"
                value={String(data.youth_without_group)}
                hint={data.youth_without_group > 0 ? 'ativos, sem grupo' : 'todos têm grupo'}
                tone={data.youth_without_group > 0 ? undefined : 'muted'}
                  to="/jovens"
              />
            )}
          </StatGrid>

          <Panel
            testId="dash-atencao"
            title={<>Precisam de atenção <span className="ml-1 text-label font-normal text-ink-muted" data-testid="dash-atencao-total">({data.attention_total})</span></>}
            action={<PanelLink to="/jovens">Ver jovens</PanelLink>}
          >
            {data.attention.length === 0 ? (
              <PanelEmpty testId="dash-atencao-vazio">Nenhum jovem precisa de atenção agora.</PanelEmpty>
            ) : (
              <>
                <ul className="divide-y divide-line-soft">
                  {data.attention.map((y) => (
                    <li key={y.youth_id}>
                      <Link
                        to={`/jovens?ficha=${y.youth_id}`}
                        data-testid="dash-atencao-item"
                        data-situacao={y.situation}
                        className="flex items-start justify-between gap-3 px-4 py-3 transition-colors hover:bg-surface-hover focus-visible:-outline-offset-2 sm:px-5"
                      >
                        <div className="min-w-0">
                          <p className="truncate text-sm font-semibold text-ink">{y.full_name}</p>
                          <p className="truncate text-caption text-ink-muted">{y.group_name ?? 'Sem grupo'}</p>
                          {y.reasons.length > 0 && <p className="mt-1 text-caption text-ink-soft">{y.reasons.join(' · ')}</p>}
                        </div>
                        <div className="flex items-center gap-1 flex-shrink-0">
                          <SituationBadge situation={{ situation: y.situation, inactive: false }} />
                          <ChevronRight className="h-4 w-4 text-ink-faint" aria-hidden="true" />
                        </div>
                      </Link>
                    </li>
                  ))}
                </ul>
                {data.attention_total > data.attention.length && (
                  <Link
                    to="/jovens"
                    data-testid="dash-atencao-mais"
                    className="block border-t border-line-soft px-4 py-2.5 text-label font-medium text-action hover:underline sm:px-5"
                  >
                    e mais {data.attention_total - data.attention.length} {data.attention_total - data.attention.length === 1 ? 'jovem' : 'jovens'} em atenção
                  </Link>
                )}
              </>
            )}
          </Panel>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 lg:gap-6">
            <Panel testId="dash-acompanhamentos" title="Próximos acompanhamentos" action={<PanelLink to="/jovens">Ver jovens</PanelLink>}>
              {data.upcoming_follow_ups.length === 0 ? (
                <PanelEmpty hint="Os acompanhamentos com prazo definido aparecem aqui.">Nenhum acompanhamento vencido ou com prazo nos próximos 14 dias.</PanelEmpty>
              ) : (
                <ul className="divide-y divide-line-soft">
                  {data.upcoming_follow_ups.map((f) => {
                    const overdue = f.next_action_due < today;
                    return (
                      <li key={f.follow_up_id}>
                        <Link
                          to={`/jovens?ficha=${f.youth_id}`}
                          data-testid="dash-acompanhamento-item"
                          data-vencido={overdue ? 'true' : 'false'}
                          className="flex items-start justify-between gap-3 px-4 py-3 transition-colors hover:bg-surface-hover focus-visible:-outline-offset-2 sm:px-5"
                        >
                          <div className="min-w-0">
                            <p className="truncate text-sm font-semibold text-ink">{f.youth_name}</p>
                            <p className="text-caption text-ink-soft">{f.next_action ?? 'Próxima ação não descrita'}</p>
                            <p className="text-caption text-ink-muted">Responsável: {f.responsible_name ?? 'não definido'}</p>
                          </div>
                          <span className={cn('inline-flex items-center gap-1 text-caption flex-shrink-0 whitespace-nowrap', overdue ? 'text-red-600 font-medium' : 'text-ink-soft')}>
                            <CalendarClock className="w-3 h-3" aria-hidden="true" />
                            {formatDateOnly(f.next_action_due)}{overdue && ' · vencido'}
                          </span>
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              )}
            </Panel>

            <Panel testId="dash-encontros" title="Próximos encontros" action={<PanelLink to="/encontros">Ver todos</PanelLink>}>
              {data.upcoming_events.length === 0 ? (
                <PanelEmpty hint="Os encontros agendados aparecem aqui.">Nenhum encontro agendado.</PanelEmpty>
              ) : (
                <ul className="divide-y divide-line-soft">
                  {data.upcoming_events.map((e) => (
                    <li key={e.id}>
                      <Link to={`/chamada/${e.id}`} data-testid="dash-encontro-item" className="flex items-center justify-between gap-3 px-4 py-3 transition-colors hover:bg-surface-hover focus-visible:-outline-offset-2 sm:px-5">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-semibold text-ink">{e.title}</p>
                          <p className="text-caption text-ink-muted">{formatDateTime(e.event_date)}</p>
                          {e.groups.length > 0 && <p className="truncate text-caption text-ink-muted">{e.groups.map((g) => g.name).join(', ')}</p>}
                        </div>
                        <span className="flex-shrink-0 text-label font-medium text-action">Chamada</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
          </div>

          {series.length > 0 && (
            <Panel testId="dash-grafico" title="Frequência por encontro (últimos 30 dias)" action={<PanelLink to="/relatorios">Relatórios</PanelLink>}>
              <div className="px-4 pb-3 pt-5 sm:px-6">
                <AttendanceChart points={series} title="Frequência por encontro nos últimos 30 dias" />
              </div>
            </Panel>
          )}
        </>
      )}
    </div>
  );
};
