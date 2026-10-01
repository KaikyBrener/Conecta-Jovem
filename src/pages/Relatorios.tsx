import { useMemo, useState } from 'react';
import { Download, AlertTriangle, BarChart3 } from 'lucide-react';
import { useReports } from '../hooks/useReports';
import { useAppSettings } from '../hooks/useSettings';
import { ErrorBanner } from '../components/ErrorBanner';
import { PageHeader } from '../components/ui/PageHeader';
import { EmptyState } from '../components/ui/EmptyState';
import { LoadingBlock } from '../components/ui/LoadingBlock';
import { addDays, formatDate, formatPercent, toDateInput } from '../lib/format';
import { toCsv, downloadCsv, type CsvValue } from '../lib/csv';
import {
  belowThreshold, overallRate, summarizeByEvent, summarizeByGroup, summarizeByYouth, validRecords,
} from '../lib/reports';

type Tab = 'groups' | 'events' | 'youth';

/** Barra fina de percentual (um só tom) com o valor em texto */
function RateBar({ value }: { value: number | null }) {
  return (
    <div className="flex items-center gap-2 min-w-28">
      <div className="flex-1 h-1.5 rounded-full bg-gray-100 overflow-hidden" aria-hidden="true">
        {value !== null && <div className="h-full rounded-full bg-blue-600" style={{ width: `${Math.max(value, 2)}%` }} />}
      </div>
      <span className="w-10 text-right text-xs font-medium text-gray-700 tabular-nums">{formatPercent(value)}</span>
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 p-4">
      <p className="text-xs text-gray-500">{label}</p>
      <p className="text-2xl font-bold text-gray-900 mt-1 tabular-nums">{value}</p>
      {hint && <p className="text-[11px] text-gray-400 mt-0.5">{hint}</p>}
    </div>
  );
}

function exportCsv(name: string, headers: string[], rows: CsvValue[][]) {
  downloadCsv(`${name}.csv`, toCsv(headers, rows));
}

const pct = (v: number | null) => (v === null ? '' : Math.round(v));

/** Período [início, fim] (YYYY-MM-DD) terminando hoje */
function presetRange(days: number | 'year'): [string, string] {
  const now = new Date();
  return [days === 'year' ? `${now.getFullYear()}-01-01` : toDateInput(addDays(now, -days)), toDateInput(now)];
}

export function Relatorios() {
  const [start, setStart] = useState(() => presetRange(90)[0]);
  const [end, setEnd] = useState(() => presetRange(90)[1]);
  const [groupId, setGroupId] = useState('all');
  const [tab, setTab] = useState<Tab>('groups');

  const { data, loading, error } = useReports({ start, end, groupId });
  const { effective: settings } = useAppSettings();
  const minRate = settings.low_attendance_threshold;

  const computed = useMemo(() => {
    if (!data) return null;
    const records = validRecords(data.records, data.events);
    const byYouth = summarizeByYouth(records, data.youth, data.groups);
    return {
      records,
      byEvent: summarizeByEvent(records, data.events),
      byGroup: summarizeByGroup(records, data.groups),
      byYouth,
      below: belowThreshold(byYouth, minRate),
      overall: overallRate(records),
      heldEvents: data.events.filter((e) => e.status === 'completed').length,
      openAlerts: data.alerts.filter((a) => a.status === 'open').length,
      doneTasks: data.tasks.filter((t) => t.status === 'done').length,
    };
  }, [data, minRate]);

  const setPreset = (days: number | 'year') => {
    const [s0, e0] = presetRange(days);
    setStart(s0);
    setEnd(e0);
  };

  const periodLabel = `${start}_a_${end}`;
  const invalidPeriod = start > end;

  const tabs: { key: Tab; label: string }[] = [
    { key: 'groups', label: 'Por grupo' },
    { key: 'events', label: 'Por encontro' },
    { key: 'youth', label: 'Por jovem' },
  ];

  return (
    <div className="space-y-5">
      <PageHeader title="Relatórios" subtitle="Frequência e acompanhamento no período. Encontros cancelados não contam." />

      {/* Filtros */}
      <div className="bg-white rounded-xl border border-gray-200 p-4 space-y-3">
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          <div>
            <label className="block text-xs font-medium text-gray-600" htmlFor="r-start">De</label>
            <input id="r-start" type="date" value={start} max={end} onChange={(e) => setStart(e.target.value)}
              className="mt-1 w-full px-3 py-2 text-sm border border-gray-300 rounded-lg" />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600" htmlFor="r-end">Até</label>
            <input id="r-end" type="date" value={end} min={start} onChange={(e) => setEnd(e.target.value)}
              className="mt-1 w-full px-3 py-2 text-sm border border-gray-300 rounded-lg" />
          </div>
          <div className="col-span-2 sm:col-span-1">
            <label className="block text-xs font-medium text-gray-600" htmlFor="r-group">Grupo</label>
            <select id="r-group" value={groupId} onChange={(e) => setGroupId(e.target.value)}
              className="mt-1 w-full px-3 py-2 text-sm border border-gray-300 rounded-lg bg-white">
              <option value="all">Todos os grupos</option>
              {data?.groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
            </select>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {([[30, 'Últimos 30 dias'], [90, 'Últimos 90 dias'], ['year', 'Este ano']] as const).map(([v, l]) => (
            <button key={String(v)} onClick={() => setPreset(v)}
              className="px-3 py-1 text-xs font-medium rounded-full border border-gray-300 bg-white text-gray-600 hover:bg-gray-50">
              {l}
            </button>
          ))}
        </div>
      </div>

      {invalidPeriod && <ErrorBanner message="A data inicial deve ser anterior à final." />}
      <ErrorBanner message={error} />

      {loading && !computed && <LoadingBlock />}

      {computed && (
        <div className={loading ? 'opacity-60 transition-opacity' : ''}>
          {/* Resumo */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <Stat label="Frequência média" value={formatPercent(computed.overall)} hint={`${computed.records.length} registros de chamada`} />
            <Stat label="Encontros realizados" value={String(computed.heldEvents)} hint={`${computed.byEvent.length} com chamada`} />
            <Stat label={`Jovens abaixo de ${minRate}%`} value={String(computed.below.length)} hint={`de ${computed.byYouth.length} com chamada`} />
            <Stat label="Alertas / tarefas concluídas" value={`${data!.alerts.length} / ${computed.doneTasks}`} hint={`${computed.openAlerts} alerta(s) ainda aberto(s)`} />
          </div>

          {/* Abas */}
          <div className="flex gap-2 mt-5 border-b border-gray-200">
            {tabs.map((t) => (
              <button key={t.key} onClick={() => setTab(t.key)}
                className={`px-3 py-2 text-sm font-medium -mb-px border-b-2 ${tab === t.key ? 'border-blue-600 text-blue-700' : 'border-transparent text-gray-500 hover:text-gray-700'}`}>
                {t.label}
              </button>
            ))}
          </div>

          <div className="mt-4 bg-white rounded-xl border border-gray-200 overflow-hidden">
            {computed.records.length === 0 ? (
              <EmptyState icon={BarChart3} title="Nenhuma chamada registrada no período selecionado." bare />
            ) : (
              <>
                <div className="flex justify-end px-4 py-2 border-b border-gray-100">
                  <button
                    onClick={() => {
                      if (tab === 'groups') {
                        exportCsv(`frequencia_grupos_${periodLabel}`, ['Grupo', 'Encontros', 'Presenças', 'Registros', 'Frequência (%)'],
                          computed.byGroup.map((g) => [g.name, g.events, g.present, g.total, pct(g.rate)]));
                      } else if (tab === 'events') {
                        exportCsv(`frequencia_encontros_${periodLabel}`, ['Encontro', 'Data', 'Presentes', 'Registros', 'Frequência (%)'],
                          computed.byEvent.map((e) => [e.title, formatDate(e.event_date), e.present, e.total, pct(e.rate)]));
                      } else {
                        exportCsv(`frequencia_jovens_${periodLabel}`, ['Jovem', 'Grupo', 'Ativo', 'Presenças', 'Faltas', 'Registros', 'Frequência (%)', `Abaixo de ${minRate}%`],
                          computed.byYouth.map((y) => [y.name, y.group_name, y.is_active ? 'Sim' : 'Não', y.present, y.absent, y.total, pct(y.rate),
                            y.rate !== null && y.rate < minRate ? 'Sim' : 'Não']));
                      }
                    }}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
                  >
                    <Download className="w-3.5 h-3.5" /> Exportar CSV
                  </button>
                </div>

                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    {tab === 'groups' && (
                      <>
                        <thead className="bg-gray-50 text-xs text-gray-500">
                          <tr><th className="text-left px-4 py-2 font-medium">Grupo</th><th className="px-2 py-2 font-medium">Encontros</th><th className="px-2 py-2 font-medium">Presenças</th><th className="px-4 py-2 font-medium text-left">Frequência</th></tr>
                        </thead>
                        <tbody className="divide-y divide-gray-100">
                          {computed.byGroup.map((g) => (
                            <tr key={g.group_id}>
                              <td className="px-4 py-2.5 text-gray-900">{g.name}</td>
                              <td className="px-2 py-2.5 text-center text-gray-600 tabular-nums">{g.events}</td>
                              <td className="px-2 py-2.5 text-center text-gray-600 tabular-nums">{g.present}/{g.total}</td>
                              <td className="px-4 py-2.5"><RateBar value={g.rate} /></td>
                            </tr>
                          ))}
                        </tbody>
                      </>
                    )}
                    {tab === 'events' && (
                      <>
                        <thead className="bg-gray-50 text-xs text-gray-500">
                          <tr><th className="text-left px-4 py-2 font-medium">Encontro</th><th className="px-2 py-2 font-medium">Presentes</th><th className="px-4 py-2 font-medium text-left">Frequência</th></tr>
                        </thead>
                        <tbody className="divide-y divide-gray-100">
                          {computed.byEvent.map((e) => (
                            <tr key={e.event_id}>
                              <td className="px-4 py-2.5">
                                <p className="text-gray-900">{e.title}</p>
                                <p className="text-xs text-gray-500">{formatDate(e.event_date)}</p>
                              </td>
                              <td className="px-2 py-2.5 text-center text-gray-600 tabular-nums">{e.present}/{e.total}</td>
                              <td className="px-4 py-2.5"><RateBar value={e.rate} /></td>
                            </tr>
                          ))}
                        </tbody>
                      </>
                    )}
                    {tab === 'youth' && (
                      <>
                        <thead className="bg-gray-50 text-xs text-gray-500">
                          <tr><th className="text-left px-4 py-2 font-medium">Jovem</th><th className="px-2 py-2 font-medium">Faltas</th><th className="px-4 py-2 font-medium text-left">Frequência</th></tr>
                        </thead>
                        <tbody className="divide-y divide-gray-100">
                          {computed.byYouth.map((y) => {
                            const low = y.rate !== null && y.rate < minRate;
                            return (
                              <tr key={y.youth_id}>
                                <td className="px-4 py-2.5">
                                  <p className="text-gray-900">{y.name}{!y.is_active && <span className="text-xs text-gray-400"> (inativo)</span>}</p>
                                  <p className="text-xs text-gray-500">
                                    {y.group_name}
                                    {low && (
                                      <span className="inline-flex items-center gap-1 ml-2 text-amber-700">
                                        <AlertTriangle className="w-3 h-3" /> abaixo de {minRate}%
                                      </span>
                                    )}
                                  </p>
                                </td>
                                <td className="px-2 py-2.5 text-center text-gray-600 tabular-nums">{y.absent}/{y.total}</td>
                                <td className="px-4 py-2.5"><RateBar value={y.rate} /></td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </>
                    )}
                  </table>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
