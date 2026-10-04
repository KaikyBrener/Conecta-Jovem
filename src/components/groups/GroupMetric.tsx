import { AlertTriangle, ArrowDown, ArrowRight, ArrowUp, CalendarClock } from 'lucide-react';
import { trendDisplay } from '../../lib/overview';
import type { GroupIndicator } from '../../lib/reportTypes';
import { cn } from '../../lib/utils';

export type GroupMetricKind = 'rate' | 'trend' | 'attention' | 'overdue';

interface GroupMetricProps {
  kind: GroupMetricKind;
  /** undefined = o servidor não devolveu indicadores para este grupo */
  indicator: GroupIndicator | undefined;
  loading: boolean;
}

const MUTED = 'text-gray-400';

/**
 * Um indicador do grupo (vem da RPC group_indicators). Sempre há texto: o sinal nunca depende só de cor ou seta.
 * Sem dado mostra "—" (indisponível) ou o motivo (sem chamadas / dados insuficientes).
 */
export function GroupMetric({ kind, indicator, loading }: GroupMetricProps) {
  if (loading && !indicator) {
    return <span className={MUTED} aria-busy="true" data-testid={`grupo-${kind}`}>…</span>;
  }
  if (!indicator) return <span className={MUTED} data-testid={`grupo-${kind}`}>—</span>;

  if (kind === 'rate') {
    return indicator.attendance_rate === null ? (
      <span className={MUTED} data-testid="grupo-rate" title="Nenhum encontro com chamada registrada ainda.">sem chamadas</span>
    ) : (
      <span className="font-medium text-gray-900 tabular-nums" data-testid="grupo-rate" title="Frequência nos últimos 8 encontros com chamada.">
        {indicator.attendance_rate}%
      </span>
    );
  }

  if (kind === 'trend') {
    const t = trendDisplay(indicator.trend, indicator.trend_delta);
    const Icon = t.kind === 'up' ? ArrowUp : t.kind === 'down' ? ArrowDown : ArrowRight;
    return (
      <span
        data-testid="grupo-trend"
        data-tendencia={t.kind}
        className={cn(
          'inline-flex items-center gap-1 text-xs',
          t.kind === 'up' && 'text-green-700',
          t.kind === 'down' && 'text-amber-700 font-medium',
          t.kind === 'stable' && 'text-gray-600',
          t.kind === 'insufficient' && MUTED,
        )}
        title="Compara os 4 encontros com chamada mais recentes com os 4 anteriores (mínimo de 8 encontros)."
      >
        {t.kind !== 'insufficient' && <Icon className="h-3.5 w-3.5 flex-shrink-0" aria-hidden="true" />}
        {t.label}
        {t.delta && <span className="tabular-nums">({t.delta})</span>}
      </span>
    );
  }

  if (kind === 'attention') {
    const n = indicator.youth_in_attention;
    return (
      <span
        data-testid="grupo-attention"
        className={cn('inline-flex items-center gap-1 tabular-nums', n > 0 ? 'text-amber-700 font-medium' : 'text-gray-600')}
        title="Jovens ativos do grupo com situação Atenção ou Crítico."
      >
        {n > 0 && <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0" aria-hidden="true" />}
        {n}
      </span>
    );
  }

  const n = indicator.overdue_actions;
  return (
    <span
      data-testid="grupo-overdue"
      className={cn('inline-flex items-center gap-1 tabular-nums', n > 0 ? 'text-red-600 font-medium' : 'text-gray-600')}
      title="Ações atrasadas do grupo ou dos jovens ativos dele."
    >
      {n > 0 && <CalendarClock className="h-3.5 w-3.5 flex-shrink-0" aria-hidden="true" />}
      {n}
    </span>
  );
}
