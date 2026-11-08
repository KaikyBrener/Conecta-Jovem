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
    <section className="border-t border-line-soft pt-4" aria-labelledby="historico-recente-titulo" data-testid="historico-recente">
      <div className="flex items-center justify-between gap-2 mb-3">
        <h4 id="historico-recente-titulo" className="text-sm font-semibold text-ink">Histórico recente</h4>
        <Link to={`/historico?jovem=${encodeURIComponent(youthId)}`} className="text-xs font-medium text-action hover:underline">
          Ver tudo
        </Link>
      </div>

      {loading ? (
        <LoadingBlock size="sm" />
      ) : error ? (
        <p role="alert" className="text-xs text-red-600 bg-danger-soft p-3 rounded-control">{error}</p>
      ) : data.length === 0 ? (
        <p className="text-xs text-ink-muted italic bg-canvas p-3 rounded-control text-center">
          Nenhuma atividade registrada para este jovem ainda.
        </p>
      ) : (
        <ul className="bg-surface border border-line rounded-control divide-y divide-line-soft">
          {data.map((a) => (
            <li key={a.id} className="px-3 py-2">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <ActivityBadge action={a.action} />
                <span className="text-xs text-ink-muted">{formatTimestampSP(a.occurred_at)}</span>
              </div>
              <p className="mt-1 text-sm text-ink">{a.summary}</p>
              {a.actor_name && <p className="text-xs text-ink-muted">por {a.actor_name}</p>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
