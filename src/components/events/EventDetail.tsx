import type { EventStatus } from '../../types/database.types';
import type { EventWithGroups } from '../../hooks/useEvents';
import { Calendar, Users, Tag, FileText, Trash2 } from 'lucide-react';
import { Badge, type BadgeColor } from '../ui/Badge';
import { secondaryBtnCls } from '../../lib/formStyles';

interface EventDetailProps {
  event: EventWithGroups;
  isCoordinator: boolean;
  onEdit: () => void;
  onDelete: () => void;
  onClose: () => void;
  actionLoading: boolean;
  onOpenAttendance: () => void;
}

const STATUS_LABEL: Record<EventStatus, string> = {
  scheduled: 'Agendado',
  completed: 'Realizado',
  cancelled: 'Cancelado',
};

const STATUS_BADGE_COLOR: Record<EventStatus, BadgeColor> = {
  scheduled: 'blue',
  completed: 'green',
  cancelled: 'gray',
};

function formatDatetime(iso: string): string {
  return new Date(iso).toLocaleString('pt-BR', {
    weekday: 'long',
    day: '2-digit',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function Row({ icon: Icon, label, value }: { icon: React.ElementType; label: string; value: string | null | undefined }) {
  return (
    <div className="flex gap-3 py-2.5 border-b border-gray-100 last:border-0">
      <Icon className="w-4 h-4 text-gray-400 mt-0.5 flex-shrink-0" />
      <div>
        <p className="text-xs text-gray-500">{label}</p>
        <p className="text-sm text-gray-900 mt-0.5">{value || '—'}</p>
      </div>
    </div>
  );
}

export function EventDetail({ event, isCoordinator, onEdit, onDelete, onClose, actionLoading, onOpenAttendance }: EventDetailProps) {
  return (
    <div className="space-y-4">
      {/* Title + status */}
      <div className="flex items-start justify-between gap-3">
        <h3 className="text-lg font-semibold text-gray-900 leading-snug">{event.title}</h3>
        <div className="flex-shrink-0">
          <Badge color={STATUS_BADGE_COLOR[event.status]}>{STATUS_LABEL[event.status]}</Badge>
        </div>
      </div>

      {/* Info rows */}
      <div className="bg-gray-50 rounded-lg px-4 py-1">
        <Row icon={Calendar} label="Data e hora" value={formatDatetime(event.event_date)} />
        <Row icon={Users} label="Grupos participantes" value={event.group_names.length ? event.group_names.join(', ') : 'Nenhum grupo'} />
        <Row icon={Tag} label="Status" value={STATUS_LABEL[event.status]} />
        <Row icon={FileText} label="Descrição" value={event.description} />
      </div>

      {/* Actions */}
      <div className="flex flex-col gap-3 pt-2">
        {event.status === 'cancelled' ? (
          <p className="text-sm text-gray-500 bg-gray-50 rounded-lg px-4 py-3 text-center">
            Encontro cancelado — não há chamada.
          </p>
        ) : (
        <button
          onClick={onOpenAttendance}
          className="w-full flex items-center justify-center gap-2 px-4 py-3 text-sm font-semibold text-white bg-green-600 rounded-xl hover:bg-green-700 transition-colors shadow-md shadow-green-100"
        >
          <Users className="w-5 h-5" />
          Realizar / Ver Chamada
        </button>
        )}

        <div className="flex flex-wrap justify-end gap-2 border-t border-gray-100 pt-3">
          <button onClick={onClose} className={secondaryBtnCls}>
            Fechar
          </button>
        {isCoordinator && (
          <>
            <button
              onClick={onDelete}
              disabled={actionLoading}
              className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-red-700 bg-red-50 border border-red-200 rounded-lg hover:bg-red-100 disabled:opacity-50 transition-colors"
            >
              <Trash2 className="w-3.5 h-3.5" />
              {actionLoading ? '...' : 'Excluir'}
            </button>
            <button
              onClick={onEdit}
              className="px-3 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 transition-colors"
            >
              Editar
            </button>
          </>
        )}
        </div>
      </div>
    </div>
  );
}
