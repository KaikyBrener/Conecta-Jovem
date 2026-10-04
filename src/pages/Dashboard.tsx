import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, CalendarClock, ChevronRight, ListChecks, Percent, UserX } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { useDashboard } from '../hooks/useDashboard';
import { useAttendanceReport } from '../hooks/useReports';
import { ErrorBanner } from '../components/ErrorBanner';
import { PageHeader } from '../components/ui/PageHeader';
import { LoadingBlock } from '../components/ui/LoadingBlock';
import { SituationBadge } from '../components/youth/SituationBadge';
import { AttendanceChart } from '../components/reports/AttendanceChart';
import { appToday, formatDateOnly, formatDateTime, formatPercent } from '../lib/format';
import { resolvePeriod } from '../lib/periods';
import { cn } from '../lib/utils';

function StatCard({ label, value, hint, icon: Icon, to, tone, testId }: {
  label: string; value: string; hint?: string; icon: React.ElementType; to: string; tone?: 'danger'; testId: string;
}) {
  return (
    <Link
      to={to}
      data-testid={testId}
      className="bg-white rounded-xl border border-gray-200 p-4 hover:border-blue-300 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
    >
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-medium text-gray-500">{label}</p>
        <Icon className="w-4 h-4 text-gray-400 flex-shrink-0" aria-hidden="true" />
      </div>
      <p className={cn('text-2xl font-bold mt-1 tabular-nums', tone === 'danger' ? 'text-red-600' : 'text-gray-900')}>{value}</p>
      {hint && <p className="text-[11px] text-gray-500 mt-0.5">{hint}</p>}
    </Link>
  );
}

function Panel({ title, to, linkLabel, children, className, testId }: {
  title: React.ReactNode; to?: string; linkLabel?: string; children: React.ReactNode; className?: string; testId?: string;
}) {
  return (
    <section className={cn('bg-white rounded-xl border border-gray-200 overflow-hidden', className)} data-testid={testId}>
      <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-gray-100">
        <h3 className="text-sm font-semibold text-gray-900">{title}</h3>
        {to && linkLabel && <Link to={to} className="text-xs text-blue-600 hover:underline flex-shrink-0">{linkLabel}</Link>}
      </div>
      {children}
    </section>
  );
}

function Empty({ text, testId }: { text: string; testId?: string }) {
  return <p className="px-4 py-6 text-sm text-gray-500 text-center" data-testid={testId}>{text}</p>;
}

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
          <div className={cn('grid grid-cols-2 gap-3', isCoordinator ? 'lg:grid-cols-4' : 'lg:grid-cols-3')}>
            <StatCard
              testId="dash-alertas"
              label="Alertas abertos"
              value={String(data.open_alerts.total)}
              hint={data.open_alerts.total > 0 ? `${data.open_alerts.critical} crítico(s) · ${data.open_alerts.attention} em atenção` : 'nenhum alerta aberto'}
              icon={AlertTriangle}
              to="/alertas"
            />
            <StatCard
              testId="dash-acoes-atrasadas"
              label="Ações atrasadas"
              value={String(data.overdue_actions)}
              hint={data.overdue_actions > 0 ? 'passaram do prazo' : 'nenhuma atrasada'}
              tone={data.overdue_actions > 0 ? 'danger' : undefined}
              icon={ListChecks}
              to="/tarefas?filtro=atrasadas"
            />
            <StatCard
              testId="dash-frequencia"
              label="Frequência média (30 dias)"
              value={formatPercent(data.avg_attendance)}
              hint={data.avg_attendance_records > 0 ? `${data.avg_attendance_records} registros` : 'sem registros de chamada no período'}
              icon={Percent}
              to="/relatorios"
            />
            {isCoordinator && (
              <StatCard
                testId="dash-sem-grupo"
                label="Jovens sem grupo"
                value={String(data.youth_without_group)}
                hint={data.youth_without_group > 0 ? 'ativos, sem grupo' : 'todos têm grupo'}
                icon={UserX}
                to="/jovens"
              />
            )}
          </div>

          <Panel
            testId="dash-atencao"
            title={<>Precisam de atenção <span className="ml-1 font-normal text-gray-500" data-testid="dash-atencao-total">({data.attention_total})</span></>}
            to="/jovens"
            linkLabel="Ver jovens"
          >
            {data.attention.length === 0 ? (
              <Empty testId="dash-atencao-vazio" text="Nenhum jovem precisa de atenção agora." />
            ) : (
              <>
                <ul className="divide-y divide-gray-100">
                  {data.attention.map((y) => (
                    <li key={y.youth_id}>
                      <Link
                        to={`/jovens?ficha=${y.youth_id}`}
                        data-testid="dash-atencao-item"
                        data-situacao={y.situation}
                        className="flex items-start justify-between gap-3 px-4 py-3 hover:bg-gray-50 focus-visible:outline-none focus-visible:bg-gray-50"
                      >
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-gray-900 truncate">{y.full_name}</p>
                          <p className="text-xs text-gray-500 truncate">{y.group_name ?? 'Sem grupo'}</p>
                          {y.reasons.length > 0 && <p className="mt-1 text-xs text-gray-600">{y.reasons.join(' · ')}</p>}
                        </div>
                        <div className="flex items-center gap-1 flex-shrink-0">
                          <SituationBadge situation={{ situation: y.situation, inactive: false }} />
                          <ChevronRight className="w-4 h-4 text-gray-400" aria-hidden="true" />
                        </div>
                      </Link>
                    </li>
                  ))}
                </ul>
                {data.attention_total > data.attention.length && (
                  <Link
                    to="/jovens"
                    data-testid="dash-atencao-mais"
                    className="block px-4 py-3 text-xs text-blue-600 hover:underline border-t border-gray-100"
                  >
                    e mais {data.attention_total - data.attention.length} {data.attention_total - data.attention.length === 1 ? 'jovem' : 'jovens'} em atenção
                  </Link>
                )}
              </>
            )}
          </Panel>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <Panel testId="dash-acompanhamentos" title="Próximos acompanhamentos" to="/jovens" linkLabel="Ver jovens">
              {data.upcoming_follow_ups.length === 0 ? (
                <Empty text="Nenhum acompanhamento vencido ou com prazo nos próximos 14 dias." />
              ) : (
                <ul className="divide-y divide-gray-100">
                  {data.upcoming_follow_ups.map((f) => {
                    const overdue = f.next_action_due < today;
                    return (
                      <li key={f.follow_up_id}>
                        <Link
                          to={`/jovens?ficha=${f.youth_id}`}
                          data-testid="dash-acompanhamento-item"
                          data-vencido={overdue ? 'true' : 'false'}
                          className="flex items-start justify-between gap-3 px-4 py-3 hover:bg-gray-50 focus-visible:outline-none focus-visible:bg-gray-50"
                        >
                          <div className="min-w-0">
                            <p className="text-sm font-medium text-gray-900 truncate">{f.youth_name}</p>
                            <p className="text-xs text-gray-600">{f.next_action ?? 'Próxima ação não descrita'}</p>
                            <p className="text-xs text-gray-500">Responsável: {f.responsible_name ?? 'não definido'}</p>
                          </div>
                          <span className={cn('inline-flex items-center gap-1 text-xs flex-shrink-0 whitespace-nowrap', overdue ? 'text-red-600 font-medium' : 'text-gray-600')}>
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

            <Panel testId="dash-encontros" title="Próximos encontros" to="/encontros" linkLabel="Ver todos">
              {data.upcoming_events.length === 0 ? (
                <Empty text="Nenhum encontro agendado." />
              ) : (
                <ul className="divide-y divide-gray-100">
                  {data.upcoming_events.map((e) => (
                    <li key={e.id}>
                      <Link to={`/chamada/${e.id}`} data-testid="dash-encontro-item" className="flex items-center justify-between gap-3 px-4 py-3 hover:bg-gray-50 focus-visible:outline-none focus-visible:bg-gray-50">
                        <div className="min-w-0">
                          <p className="text-sm text-gray-900 truncate">{e.title}</p>
                          <p className="text-xs text-gray-500">{formatDateTime(e.event_date)}</p>
                          {e.groups.length > 0 && <p className="text-xs text-gray-500 truncate">{e.groups.map((g) => g.name).join(', ')}</p>}
                        </div>
                        <span className="text-xs text-blue-600 flex-shrink-0">Chamada</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
          </div>

          {series.length > 0 && (
            <Panel testId="dash-grafico" title="Frequência por encontro (últimos 30 dias)" to="/relatorios" linkLabel="Relatórios">
              <div className="p-4">
                <AttendanceChart points={series} title="Frequência por encontro nos últimos 30 dias" />
              </div>
            </Panel>
          )}
        </>
      )}
    </div>
  );
};
