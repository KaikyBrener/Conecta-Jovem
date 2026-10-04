import { Badge, type BadgeColor } from '../ui/Badge';
import { activityActionLabel } from '../../lib/labels';

const COLOR: Record<string, BadgeColor> = {
  attendance_recorded: 'blue',
  follow_up_created: 'indigo',
  follow_up_transferred: 'indigo',
  task_created: 'gray',
  task_completed: 'green',
  alert_resolved: 'green',
  alert_dismissed: 'amber',
  youth_group_changed: 'blue',
  youth_activated: 'green',
  youth_deactivated: 'gray',
  event_series_created: 'blue',
  communication_sent: 'indigo',
};

/** Selo com o tipo da ação do histórico (rótulos pt-BR de lib/labels) */
export function ActivityBadge({ action }: { action: string }) {
  return <Badge color={COLOR[action] ?? 'gray'}>{activityActionLabel(action)}</Badge>;
}
