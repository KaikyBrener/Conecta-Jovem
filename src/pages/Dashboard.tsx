import { Link } from 'react-router-dom';
import { Users, Calendar, AlertTriangle, ListChecks, Percent, ChevronRight, ClipboardCheck, CalendarClock } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { useDashboard } from '../hooks/useDashboard';
import { ErrorBanner } from '../components/ErrorBanner';
import { PageHeader } from '../components/ui/PageHeader';
import { LoadingBlock } from '../components/ui/LoadingBlock';
import { formatDateOnly, formatDateTime, formatPercent, isOverdue } from '../lib/format';

function StatCard({ label, value, hint, icon: Icon, to }: {
  label: string; value: string; hint?: string; icon: React.ElementType; to: string;
}) {
  return (
    <Link to={to} className="bg-white rounded-xl border border-gray-200 p-4 hover:border-blue-300 transition-colors">
      <div className="flex items-center justify-between">
        <p className="text-xs font-medium text-gray-500">{label}</p>
        <Icon className="w-4 h-4 text-gray-400" aria-hidden="true" />
      </div>
      <p className="text-2xl font-bold text-gray-900 mt-1 tabular-nums">{value}</p>
      {hint && <p className="text-[11px] text-gray-400 mt-0.5">{hint}</p>}
    </Link>
  );
}

function Panel({ title, to, linkLabel, children }: { title: string; to: string; linkLabel: string; children: React.ReactNode }) {
  return (
    <section className="bg-white rounded-xl border border-gray-200 overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100">
        <h3 className="text-sm font-semibold text-gray-900">{title}</h3>
        <Link to={to} className="text-xs text-blue-600 hover:underline">{linkLabel}</Link>
      </div>
      {children}
    </section>
  );
}

function Empty({ text }: { text: string }) {
  return <p className="px-4 py-6 text-sm text-gray-400 text-center">{text}</p>;
}

export const Dashboard = () => {
  const { role, profile } = useAuth();
  const { data, loading, error } = useDashboard();

  return (
    <div className="space-y-6">
      <PageHeader
        title={`Olá, ${profile?.full_name?.split(' ')[0] || 'bem-vindo'}!`}
        subtitle={`Visão geral ${role === 'coordinator' ? 'do ministério' : 'dos seus grupos'}.`}
      />

      <ErrorBanner message={error} />

      {loading && <LoadingBlock />}

      {data && (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
            <StatCard label="Jovens ativos" value={String(data.activeYouth)} icon={Users} to="/jovens" />
            <StatCard label="Encontros no mês" value={String(data.eventsThisMonth)} icon={Calendar} to="/encontros" />
            <StatCard label="Frequência (30 dias)" value={formatPercent(data.rate30)} hint={`${data.rate30Records} registros`} icon={Percent} to="/relatorios" />
            <StatCard label="Alertas abertos" value={String(data.openAlerts)} hint="faltas consecutivas" icon={AlertTriangle} to="/alertas" />
            <StatCard
              label="Minhas tarefas"
              value={String(data.myOpenTasks)}
              hint={data.myOverdueTasks ? `${data.myOverdueTasks} atrasada(s)` : 'em aberto'}
              icon={ListChecks}
              to="/tarefas"
            />
          </div>

          {data.pendingCalls.length > 0 && (
            <section className="bg-amber-50 border border-amber-200 rounded-xl p-4">
              <h3 className="flex items-center gap-2 text-sm font-semibold text-amber-900">
                <ClipboardCheck className="w-4 h-4" /> Encontros passados ainda marcados como agendados
              </h3>
              <p className="text-xs text-amber-800 mt-0.5">Faça a chamada para manter o histórico e os alertas atualizados.</p>
              <ul className="mt-2 space-y-1">
                {data.pendingCalls.map((e) => (
                  <li key={e.id}>
                    <Link to={`/chamada/${e.id}`} className="flex items-center justify-between text-sm text-amber-900 hover:underline">
                      <span>{e.title} · {formatDateTime(e.event_date)}</span>
                      <ChevronRight className="w-4 h-4" />
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <Panel title="Próximos encontros" to="/encontros" linkLabel="Ver todos">
              {data.upcoming.length === 0 ? <Empty text="Nenhum encontro agendado." /> : (
                <ul className="divide-y divide-gray-100">
                  {data.upcoming.map((e) => (
                    <li key={e.id}>
                      <Link to={`/chamada/${e.id}`} className="flex items-center justify-between px-4 py-2.5 hover:bg-gray-50">
                        <div className="min-w-0">
                          <p className="text-sm text-gray-900 truncate">{e.title}</p>
                          <p className="text-xs text-gray-500">{formatDateTime(e.event_date)}</p>
                        </div>
                        <span className="text-xs text-blue-600 flex-shrink-0">Chamada</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>

            <Panel title="Alertas abertos" to="/alertas" linkLabel="Ver alertas">
              {data.recentAlerts.length === 0 ? <Empty text="Nenhum alerta aberto." /> : (
                <ul className="divide-y divide-gray-100">
                  {data.recentAlerts.map((a) => (
                    <li key={a.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
                      <div className="min-w-0">
                        <p className="text-sm text-gray-900 truncate">{a.youth?.full_name ?? 'Jovem'}</p>
                        <p className="text-xs text-gray-500">{a.groups?.name ?? 'Sem grupo'}</p>
                      </div>
                      <span className="inline-flex items-center gap-1 text-xs text-amber-700 flex-shrink-0">
                        <AlertTriangle className="w-3 h-3" /> {a.consecutive_absences} faltas
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>

            <Panel title="Minhas tarefas" to="/tarefas" linkLabel="Ver tarefas">
              {data.myTasks.length === 0 ? <Empty text="Nenhuma tarefa em aberto atribuída a você." /> : (
                <ul className="divide-y divide-gray-100">
                  {data.myTasks.map((t) => {
                    const overdue = isOverdue(t.due_date, t.status);
                    return (
                      <li key={t.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
                        <div className="min-w-0">
                          <p className="text-sm text-gray-900 truncate">{t.title}</p>
                          {t.youth && <p className="text-xs text-gray-500">{t.youth.full_name}</p>}
                        </div>
                        {t.due_date && (
                          <span className={`inline-flex items-center gap-1 text-xs flex-shrink-0 ${overdue ? 'text-red-600 font-medium' : 'text-gray-500'}`}>
                            <CalendarClock className="w-3 h-3" /> {formatDateOnly(t.due_date)}{overdue && ' · atrasada'}
                          </span>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </Panel>

            <Panel title={`Frequência abaixo de ${data.lowThreshold}% (90 dias)`} to="/relatorios" linkLabel="Relatórios">
              {data.lowAttendance.length === 0 ? <Empty text="Nenhum jovem abaixo da frequência mínima." /> : (
                <ul className="divide-y divide-gray-100">
                  {data.lowAttendance.map((y) => (
                    <li key={y.youth_id} className="flex items-center justify-between gap-3 px-4 py-2.5">
                      <div className="min-w-0">
                        <p className="text-sm text-gray-900 truncate">{y.name}</p>
                        <p className="text-xs text-gray-500">{y.group_name} · {y.present}/{y.total} presenças</p>
                      </div>
                      <span className="text-sm font-semibold text-gray-700 tabular-nums">{formatPercent(y.rate)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
          </div>
        </>
      )}
    </div>
  );
};
