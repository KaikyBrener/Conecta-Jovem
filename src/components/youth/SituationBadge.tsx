import { Badge, type BadgeColor } from '../ui/Badge';
import { situationDisplay, type SituationTone } from '../../lib/situation';
import type { YouthSituation } from '../../types/database.types';

const TONE_COLOR: Record<SituationTone, BadgeColor> = {
  green: 'green',
  amber: 'amber',
  red: 'red',
  gray: 'gray',
};

/** Selo de situação: ponto de cor + texto (nunca só cor). */
export function SituationBadge({ situation }: { situation: Pick<YouthSituation, 'situation' | 'inactive'> }) {
  const d = situationDisplay(situation);
  return (
    <span data-testid="situacao-selo" data-situacao={situation.inactive ? 'inactive' : d.level} title={d.description}>
      <Badge color={TONE_COLOR[d.tone]}>
        {d.label}
      </Badge>
    </span>
  );
}
