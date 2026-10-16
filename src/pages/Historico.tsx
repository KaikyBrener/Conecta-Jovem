import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { AlertCircle, History, X } from 'lucide-react';
import { useActivityLog } from '../hooks/useActivityLog';
import { useDebouncedValue } from '../hooks/useDebouncedValue';
import { useAsyncValue } from '../hooks/useAsyncValue';
import { fetchYouthById } from '../hooks/useYouth';
import { parseHistoryYouthParam } from '../lib/deepLinks';
import { activityBounds, HISTORY_PERIODS, type HistoryPeriod } from '../lib/activity';
import { ACTIVITY_ACTIONS, ACTIVITY_ACTION_LABEL } from '../lib/labels';
import { appToday, formatTimestampSP } from '../lib/format';
import { inputCls, labelCls } from '../lib/formStyles';
import { cn } from '../lib/utils';
import { ActivityBadge } from '../components/activity/ActivityBadge';
import { PageHeader } from '../components/ui/PageHeader';
import { SearchInput } from '../components/ui/SearchInput';
import { EmptyState } from '../components/ui/EmptyState';
import { LoadingBlock } from '../components/ui/LoadingBlock';
import { FilterChips } from '../components/ui/FilterChips';
import { Pagination } from '../components/ui/Pagination';
import type { ActivityAction, ActivityEntry } from '../types/database.types';

function YouthLink({ entry }: { entry: ActivityEntry }) {
  if (!entry.youth_id) return <span className="text-gray-400">—</span>;
  return (
    <Link
      to={`/jovens?ficha=${encodeURIComponent(entry.youth_id)}`}
      className="text-blue-600 hover:underline"
      data-testid="historico-jovem"
    >
      {entry.youth?.full_name ?? 'Ver ficha'}
    </Link>
  );
}

export function Historico() {
  const [searchParams, setSearchParams] = useSearchParams();
  const youthId = parseHistoryYouthParam(searchParams.get('jovem'));

  const [search, setSearch] = useState('');
  const debouncedSearch = useDebouncedValue(search);
  const [action, setAction] = useState<ActivityAction | 'all'>('all');
  // Vindo da ficha ("Ver tudo") mostra o histórico inteiro do jovem; senão, os últimos 30 dias
  const [period, setPeriod] = useState<HistoryPeriod>(() => (youthId ? 'all' : 'last30'));
  const [custom, setCustom] = useState({ from: '', to: '' });

  const today = appToday();
  const bounds = useMemo(() => activityBounds(period, today, custom), [period, today, custom]);

  const { rows, total, page, setPage, pageSize, totalPages, loading, error } = useActivityLog(
    {
      action,
      from: bounds.from,
      toExclusive: bounds.toExclusive,
      youthId,
      search: debouncedSearch,
    },
    // período personalizado inválido: não consulta até corrigir
    bounds.error === null,
  );

  const youthName = useAsyncValue<string | null>(
    youthId,
    async () => (await fetchYouthById(youthId as string))?.full_name ?? null,
    null,
    'Não foi possível carregar o nome do jovem.',
  );

  const clearYouth = () => setSearchParams((p) => { const n = new URLSearchParams(p); n.delete('jovem'); return n; }, { replace: true });

  const hasFilters = action !== 'all' || !!debouncedSearch.trim() || !!youthId || period !== 'last30';

  return (
    <div className="space-y-5">
      <PageHeader
        title="Histórico"
        subtitle="Registro das ações feitas no sistema: chamadas, acompanhamentos, ações, alertas e mudanças de jovens."
      />

      <div className="bg-white border border-gray-200 rounded-card px-4 py-3 space-y-3">
        <div className="flex flex-col sm:flex-row gap-3">
          <SearchInput
            value={search}
            onChange={setSearch}
            placeholder="Buscar por jovem..."
            aria-label="Buscar por jovem"
            className="flex-1"
          />
          <select
            value={action}
            onChange={(e) => setAction(e.target.value as ActivityAction | 'all')}
            aria-label="Filtrar por tipo de ação"
            className="sm:w-64 px-3 py-2 text-sm border border-gray-300 rounded-control bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500"
          >
            <option value="all">Todas as ações</option>
            {ACTIVITY_ACTIONS.map((a) => (
              <option key={a} value={a}>{ACTIVITY_ACTION_LABEL[a]}</option>
            ))}
          </select>
        </div>

        <FilterChips options={HISTORY_PERIODS.map((p) => ({ label: p.label, value: p.value }))} value={period} onChange={setPeriod} />

        {period === 'custom' && (
          <div className="grid grid-cols-2 gap-3 max-w-md">
            <div>
              <label htmlFor="historico-de" className={labelCls}>De</label>
              <input id="historico-de" type="date" value={custom.from} max={custom.to || undefined}
                onChange={(e) => setCustom((c) => ({ ...c, from: e.target.value }))} className={inputCls} />
            </div>
            <div>
              <label htmlFor="historico-ate" className={labelCls}>Até</label>
              <input id="historico-ate" type="date" value={custom.to} min={custom.from || undefined}
                onChange={(e) => setCustom((c) => ({ ...c, to: e.target.value }))} className={inputCls} />
            </div>
          </div>
        )}
        {period === 'custom' && bounds.error && (
          <p role="alert" className="text-sm text-red-700">{bounds.error}</p>
        )}

        {youthId && (
          <div className="flex flex-wrap items-center gap-2 text-sm" data-testid="historico-filtro-jovem">
            <span className="text-gray-500">Jovem:</span>
            <span className="inline-flex items-center gap-1 rounded-full bg-blue-50 text-blue-700 border border-blue-200 pl-3 pr-1 py-0.5 font-medium">
              {youthName.loading ? 'Carregando…' : youthName.data ?? 'Jovem selecionado'}
              <button
                type="button"
                onClick={clearYouth}
                aria-label="Remover filtro de jovem"
                className="rounded-full p-1 hover:bg-blue-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
              >
                <X className="w-3.5 h-3.5" aria-hidden="true" />
              </button>
            </span>
          </div>
        )}
      </div>

      {error && (
        <div role="alert" className="flex items-center gap-2 text-sm text-red-700 bg-red-50 border border-red-200 rounded-control px-4 py-3">
          <AlertCircle className="w-4 h-4 flex-shrink-0" />
          {error}
        </div>
      )}

      {loading && rows.length === 0 && bounds.error === null && <LoadingBlock />}

      {!loading && !error && rows.length === 0 && bounds.error === null && (
        <EmptyState
          icon={History}
          title={hasFilters ? 'Nenhuma atividade encontrada para os filtros escolhidos.' : 'Nenhuma atividade registrada ainda.'}
        />
      )}

      {/* Tabela - Desktop */}
      {rows.length > 0 && (
        <div className={cn('hidden lg:block bg-white border border-gray-200 rounded-card overflow-x-auto transition-opacity', loading && 'opacity-60')} aria-busy={loading}>
          <table className="w-full text-sm" data-testid="historico-tabela">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-200 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">
                <th className="px-4 py-2">Data e hora</th>
                <th className="px-4 py-2">Ação</th>
                <th className="px-4 py-2">Resumo</th>
                <th className="px-4 py-2">Jovem</th>
                <th className="px-4 py-2">Feito por</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {rows.map((a) => (
                <tr key={a.id} data-testid="historico-linha" className="align-top hover:bg-gray-50 transition-colors">
                  <td className="px-4 py-3 text-gray-600 whitespace-nowrap">{formatTimestampSP(a.occurred_at)}</td>
                  <td className="px-4 py-3"><ActivityBadge action={a.action} /></td>
                  <td className="px-4 py-3 text-gray-800">{a.summary}</td>
                  <td className="px-4 py-3"><YouthLink entry={a} /></td>
                  <td className="px-4 py-3 text-gray-600">{a.actor_name ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Cards - Mobile */}
      {rows.length > 0 && (
        <ul className={cn('lg:hidden bg-white rounded-card border border-gray-200 divide-y divide-gray-100 overflow-hidden transition-opacity', loading && 'opacity-60')} aria-busy={loading}>
          {rows.map((a) => (
            <li key={a.id} data-testid="historico-card" className="px-4 py-3 space-y-1">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <ActivityBadge action={a.action} />
                <span className="text-xs text-gray-500">{formatTimestampSP(a.occurred_at)}</span>
              </div>
              <p className="text-sm text-gray-800">{a.summary}</p>
              <p className="text-xs text-gray-500 break-words">
                {a.youth_id && <><YouthLink entry={a} /> · </>}
                por {a.actor_name ?? '—'}
              </p>
            </li>
          ))}
        </ul>
      )}

      <Pagination page={page} totalPages={totalPages} total={total} pageSize={pageSize} onPageChange={setPage} noun={total === 1 ? 'registro' : 'registros'} disabled={loading} />
    </div>
  );
}
