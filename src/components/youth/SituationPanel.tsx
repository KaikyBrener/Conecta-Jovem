import { LoadingBlock } from '../ui/LoadingBlock';
import { SituationBadge } from './SituationBadge';
import { situationCriteriaText, situationDisplay, type SituationTone } from '../../lib/situation';
import { formatDate, formatDateOnly, formatPercent } from '../../lib/format';
import type { YouthSituation } from '../../types/database.types';

interface SituationPanelProps {
  situation: YouthSituation | null;
  loading: boolean;
  error: string | null;
  /** Limites configurados no sistema, só para escrever o critério com números */
  limits?: { attention?: number | null; critical?: number | null };
}

const PANEL_TONE: Record<SituationTone, string> = {
  green: 'border-green-200 bg-green-50',
  amber: 'border-amber-200 bg-amber-50',
  red: 'border-red-200 bg-red-50',
  gray: 'border-gray-200 bg-gray-50',
};

function Metric({ label, value, testId }: { label: string; value: string; testId?: string }) {
  return (
    <div className="rounded-control bg-white px-2.5 py-2 border border-gray-100">
      <dt className="text-[10px] font-medium uppercase tracking-wide text-gray-500">{label}</dt>
      <dd className="mt-0.5 text-sm font-medium text-gray-900 break-words" data-testid={testId}>{value}</dd>
    </div>
  );
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Painel de situação do jovem: selo, motivos objetivos e métricas (tudo calculado no banco). */
export function SituationPanel({ situation, loading, error, limits }: SituationPanelProps) {
  if (loading && !situation) return <LoadingBlock size="sm" />;

  if (!situation) {
    return (
      <p role="status" className="rounded-control bg-gray-50 p-3 text-center text-xs text-gray-500">
        {error ?? 'Situação indisponível para este jovem.'}
      </p>
    );
  }

  const d = situationDisplay(situation);
  const actions = situation.open_actions === 0
    ? 'Nenhuma aberta'
    : `${plural(situation.open_actions, 'aberta', 'abertas')} · ${plural(situation.overdue_actions, 'atrasada', 'atrasadas')}`;

  return (
    <section
      aria-labelledby="situacao-title"
      data-testid="painel-situacao"
      className={`rounded-card border px-3 py-3 ${PANEL_TONE[d.tone]}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 id="situacao-title" className="text-sm font-semibold text-gray-900">Situação do jovem</h4>
        <SituationBadge situation={situation} />
      </div>

      {situation.inactive ? (
        <p className="mt-2 text-sm text-gray-600">Jovem inativo: a situação não é avaliada.</p>
      ) : situation.reasons.length > 0 ? (
        <ul data-testid="situacao-motivos" className="mt-2 list-disc space-y-0.5 pl-5 text-sm text-gray-800">
          {situation.reasons.map((r) => <li key={r}>{r}</li>)}
        </ul>
      ) : (
        <p className="mt-2 text-sm text-gray-600">Nenhum sinal de atenção no momento.</p>
      )}

      <dl className="mt-3 grid grid-cols-2 gap-2 md:grid-cols-4">
        <Metric label="Grupo" value={situation.group_name ?? 'Sem grupo'} />
        <Metric label="Líder" value={situation.leader_name ?? '—'} />
        <Metric label="Frequência (últimos 8)" value={formatPercent(situation.attendance_rate)} testId="metrica-frequencia" />
        <Metric label="Faltas consecutivas" value={String(situation.consecutive_absences)} testId="metrica-faltas" />
        <Metric label="Encontros com chamada" value={String(situation.events_total)} />
        <Metric label="Ações" value={actions} testId="metrica-acoes" />
        <Metric label="Último encontro" value={situation.last_event ? formatDate(situation.last_event) : '—'} />
        <Metric label="Último acompanhamento" value={situation.last_follow_up ? formatDateOnly(situation.last_follow_up) : 'Nenhum'} testId="metrica-ultimo-acompanhamento" />
      </dl>

      <p className="mt-3 text-[11px] leading-snug text-gray-500" data-testid="situacao-criterio">
        {situationCriteriaText(limits)}
      </p>
    </section>
  );
}
