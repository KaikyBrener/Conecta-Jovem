import { useState } from 'react';
import { Search, X } from 'lucide-react';
import { useYouthReport, useYouthSearch, type YouthOption } from '../../hooks/useReports';
import { useDebouncedValue } from '../../hooks/useDebouncedValue';
import { buildYouthDoc } from '../../lib/reportExport';
import { formatDay, formatPercent } from '../../lib/format';
import { ErrorBanner } from '../ErrorBanner';
import { LoadingBlock } from '../ui/LoadingBlock';
import { SearchInput } from '../ui/SearchInput';
import { SituationBadge } from '../youth/SituationBadge';
import { ExportTableView, Stat, StatGrid } from './ReportParts';
import { ReportShell, type ReportTabProps } from './ReportShell';

function YouthResult({ id, range }: { id: string; range: ReportTabProps['range'] }) {
  const state = useYouthReport(id, range);
  return (
    <ReportShell state={state} build={buildYouthDoc}>
      {(r) => {
        const s = r.situation;
        const doc = buildYouthDoc(r);
        return (
          <div className="space-y-4" data-testid="relatorio-individual">
            <section className="bg-white rounded-xl border border-gray-200 p-4">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <h3 className="text-base font-semibold text-gray-900 break-words" data-testid="rel-jovem-nome">{r.youth.full_name}</h3>
                  <p className="text-sm text-gray-500">
                    {r.youth.group_name ?? 'Sem grupo'}
                    {r.youth.leader_name && ` · Líder: ${r.youth.leader_name}`}
                    {!r.youth.is_active && ' · inativo'}
                  </p>
                </div>
                <SituationBadge situation={{ situation: s.situation, inactive: s.inactive }} />
              </div>
              {s.reasons.length > 0 && <p className="mt-2 text-sm text-gray-700">{s.reasons.join(' · ')}</p>}
            </section>

            <StatGrid>
              <Stat
                testId="rel-frequencia"
                label="Frequência no período"
                value={formatPercent(r.attendance.rate)}
                hint={r.attendance.registered > 0 ? `${r.attendance.present} presenças · ${r.attendance.absent} faltas` : 'sem chamadas no período'}
              />
              <Stat label="Faltas seguidas agora" value={String(s.consecutive_absences)} />
              <Stat label="Ações abertas" value={String(s.open_actions)} hint={`${s.overdue_actions} atrasada(s)`} />
              <Stat label="Último acompanhamento" value={formatDay(s.last_follow_up)} />
            </StatGrid>

            {doc.tables.slice(1).map((t) => <ExportTableView key={t.title} table={t} />)}

            <p className="text-xs text-gray-500">
              Contém dados pessoais de jovem, possivelmente menor de idade. Use apenas para o cuidado pastoral e não compartilhe.
            </p>
          </div>
        );
      }}
    </ReportShell>
  );
}

export function YouthTab({ range }: ReportTabProps) {
  const [term, setTerm] = useState('');
  const debounced = useDebouncedValue(term);
  const { results, loading, error, searching } = useYouthSearch(debounced);
  const [picked, setPicked] = useState<YouthOption | null>(null);

  const choose = (y: YouthOption) => {
    setPicked(y);
    setTerm('');
  };

  return (
    <div className="space-y-4">
      {picked ? (
        <div className="flex flex-wrap items-center justify-between gap-2 bg-white rounded-xl border border-gray-200 px-4 py-3" data-testid="rel-jovem-escolhido">
          <p className="text-sm text-gray-700">Jovem: <span className="font-medium text-gray-900">{picked.full_name}</span></p>
          <button
            type="button"
            onClick={() => setPicked(null)}
            className="inline-flex items-center gap-1 text-xs font-medium text-blue-600 hover:underline"
          >
            <X className="w-3.5 h-3.5" aria-hidden="true" /> Trocar jovem
          </button>
        </div>
      ) : (
        <div className="bg-white rounded-xl border border-gray-200 p-4 space-y-3">
          <p className="text-sm font-medium text-gray-700">Buscar jovem por nome</p>
          <SearchInput
            value={term}
            onChange={setTerm}
            placeholder="Digite pelo menos 2 letras..."
            aria-label="Buscar jovem por nome"
            className="max-w-md"
          />
          <ErrorBanner message={error} />
          {loading && <LoadingBlock size="sm" />}
          {!loading && searching && !error && results.length === 0 && (
            <p className="flex items-center gap-2 text-sm text-gray-500" data-testid="rel-jovem-sem-resultado">
              <Search className="w-4 h-4" aria-hidden="true" /> Nenhum jovem encontrado.
            </p>
          )}
          {results.length > 0 && (
            <ul className="divide-y divide-gray-100 border border-gray-200 rounded-lg" aria-label="Resultados da busca">
              {results.map((y) => (
                <li key={y.id}>
                  <button
                    type="button"
                    onClick={() => choose(y)}
                    data-testid="rel-jovem-resultado"
                    className="w-full text-left px-3 py-2.5 hover:bg-gray-50 focus-visible:outline-none focus-visible:bg-gray-50"
                  >
                    <span className="block text-sm text-gray-900">{y.full_name}{!y.is_active && <span className="text-xs text-gray-500"> (inativo)</span>}</span>
                    <span className="block text-xs text-gray-500">{y.group?.name ?? 'Sem grupo'}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {!searching && <p className="text-xs text-gray-500">Escolha um jovem para ver a ficha de frequência, acompanhamento, ações e alertas no período.</p>}
        </div>
      )}

      {picked && <YouthResult id={picked.id} range={range} />}
    </div>
  );
}
