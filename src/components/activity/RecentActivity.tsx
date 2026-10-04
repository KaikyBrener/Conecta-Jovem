import { Link } from 'react-router-dom';
import { useRecentActivity } from '../../hooks/useActivityLog';
import { LoadingBlock } from '../ui/LoadingBlock';
import { ActivityBadge } from './ActivityBadge';
import { formatTimestampSP } from '../../lib/format';

interface RecentActivityProps {
  youthId: string;
  /** Muda quando algo que gera histórico aconteceu na ficha (ex.: acompanhamento registrado) */
  version?: number;
}

/** "Histórico recente" da ficha do jovem: as 10 últimas entradas do histórico operacional + link "Ver tudo". */
export function RecentActivity({ youthId, version = 0 }: RecentActivityProps) {
  const { data, loading, error } = useRecentActivity(youthId, version);

  return (
    <section className="border-t border-gray-100 pt-4" aria-labelledby="historico-recente-titulo" data-testid="historico-recente">
      <div className="flex items-center justify-between gap-2 mb-3">
        <h4 id="historico-recente-titulo" className="text-sm font-semibold text-gray-900">Histórico recente</h4>
        <Link to={`/historico?jovem=${encodeURIComponent(youthId)}`} className="text-xs font-medium text-blue-600 hover:underline">
          Ver tudo
        </Link>
      </div>

      {loading ? (
        <LoadingBlock size="sm" />
      ) : error ? (
        <p role="alert" className="text-xs text-red-600 bg-red-50 p-3 rounded-lg">{error}</p>
      ) : data.length === 0 ? (
        <p className="text-xs text-gray-500 italic bg-gray-50 p-3 rounded-lg text-center">
          Nenhuma atividade registrada para este jovem ainda.
        </p>
      ) : (
        <ul className="bg-white border border-gray-200 rounded-lg divide-y divide-gray-100">
          {data.map((a) => (
            <li key={a.id} className="px-3 py-2">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <ActivityBadge action={a.action} />
                <span className="text-xs text-gray-500">{formatTimestampSP(a.occurred_at)}</span>
              </div>
              <p className="mt-1 text-sm text-gray-800">{a.summary}</p>
              {a.actor_name && <p className="text-xs text-gray-500">por {a.actor_name}</p>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
