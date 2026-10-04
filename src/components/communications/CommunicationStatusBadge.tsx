import { Ban, FilePenLine, Loader2, MailCheck, MailWarning } from 'lucide-react';
import type { ComponentType } from 'react';
import { Badge, type BadgeColor } from '../ui/Badge';
import { COMMUNICATION_STATUS_LABEL } from '../../lib/labels';
import type { CommunicationStatus } from '../../types/database.types';

const COLOR: Record<CommunicationStatus, BadgeColor> = {
  draft: 'gray',
  sending: 'blue',
  sent: 'green',
  failed: 'red',
  cancelled: 'amber',
};

const ICON: Record<CommunicationStatus, ComponentType<{ className?: string; 'aria-hidden'?: boolean | 'true' | 'false' }>> = {
  draft: FilePenLine,
  sending: Loader2,
  sent: MailCheck,
  failed: MailWarning,
  cancelled: Ban,
};

/** Selo do status da comunicação: ícone + texto (a cor nunca é a única pista). "Enviando" gira. */
export function CommunicationStatusBadge({ status }: { status: CommunicationStatus }) {
  const Icon = ICON[status];
  return (
    <span data-testid="comunicacao-status" data-status={status}>
      <Badge color={COLOR[status]}>
        <Icon className={status === 'sending' ? 'h-3 w-3 animate-spin motion-reduce:animate-none' : 'h-3 w-3'} aria-hidden="true" />
        {COMMUNICATION_STATUS_LABEL[status]}
      </Badge>
    </span>
  );
}
