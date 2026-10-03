import { AlertTriangle, CheckCircle2, MinusCircle, OctagonAlert } from 'lucide-react';
import { Badge, type BadgeColor } from '../ui/Badge';
import { situationDisplay, type SituationTone } from '../../lib/situation';
import type { YouthSituation } from '../../types/database.types';

const TONE_COLOR: Record<SituationTone, BadgeColor> = {
  green: 'green',
  amber: 'amber',
  red: 'red',
  gray: 'gray',
};

/** Selo de situação: sempre ícone + texto (nunca só cor). */
export function SituationBadge({ situation }: { situation: Pick<YouthSituation, 'situation' | 'inactive'> }) {
  const d = situationDisplay(situation);
  const cls = 'h-3 w-3';
  const icon = situation.inactive
    ? <MinusCircle className={cls} aria-hidden="true" />
    : d.level === 'critical'
      ? <OctagonAlert className={cls} aria-hidden="true" />
      : d.level === 'attention'
        ? <AlertTriangle className={cls} aria-hidden="true" />
        : <CheckCircle2 className={cls} aria-hidden="true" />;
  return (
    <span data-testid="situacao-selo" data-situacao={situation.inactive ? 'inactive' : d.level} title={d.description}>
      <Badge color={TONE_COLOR[d.tone]}>
        {icon}
        {d.label}
      </Badge>
    </span>
  );
}
