import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Calendar, ChevronRight, AlertCircle } from 'lucide-react';
import { useEvents } from '../hooks/useEvents';
import { Modal } from '../components/Modal';
import { EventForm } from '../components/events/EventForm';
import { EventDetail } from '../components/events/EventDetail';
import { PageHeader } from '../components/ui/PageHeader';
import { SearchInput } from '../components/ui/SearchInput';
import { EmptyState } from '../components/ui/EmptyState';
import { LoadingBlock } from '../components/ui/LoadingBlock';
import { FilterChips } from '../components/ui/FilterChips';
import { Badge, type BadgeColor } from '../components/ui/Badge';
import { primaryBtnCls } from '../lib/formStyles';
import type { EventInsert, EventUpdate, EventStatus } from '../types/database.types';
import type { EventWithGroups } from '../hooks/useEvents';

type FilterStatus = 'all' | EventStatus;

const STATUS_BADGE_COLOR: Record<EventStatus, BadgeColor> = {
  scheduled: 'blue',
  completed: 'green',
  cancelled: 'gray',
};

const STATUS_LABEL: Record<EventStatus, string> = {
  scheduled: 'Agendado',
  completed: 'Realizado',
  cancelled: 'Cancelado',
};

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('pt-BR', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

type ModalMode = 'none' | 'view' | 'create' | 'edit';

export function Encontros() {
  const navigate = useNavigate();
  const {
    events,
    allGroups,
    loading,
    error,
    role,
    fetchAllGroups,
    createEvent,
    updateEvent,
    deleteEvent,
  } = useEvents();

  const isCoordinator = role === 'coordinator';

  const [search, setSearch] = useState('');
  const [filterStatus, setFilterStatus] = useState<FilterStatus>('all');
  const [modalMode, setModalMode] = useState<ModalMode>('none');
  const [selected, setSelected] = useState<EventWithGroups | null>(null);
  const [formLoading, setFormLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);

  // Carrega grupos quando abre modal de criação/edição
  useEffect(() => {
    if (modalMode === 'create' || modalMode === 'edit') {
      fetchAllGroups();
    }
  }, [modalMode, fetchAllGroups]);

  const filtered = events.filter((ev) => {
    const matchSearch = ev.title.toLowerCase().includes(search.toLowerCase());
    const matchStatus = filterStatus === 'all' || ev.status === filterStatus;
    return matchSearch && matchStatus;
  });

  const openCreate = () => { setSelected(null); setModalMode('create'); };
  const openView = (ev: EventWithGroups) => { setSelected(ev); setModalMode('view'); };
  const openEdit = () => setModalMode('edit');
  const closeModal = () => { setModalMode('none'); setSelected(null); };

  const handleCreate = async (payload: Omit<EventInsert, 'created_by'> | EventUpdate, groupIds: string[]) => {
    setFormLoading(true);
    const result = await createEvent(payload as Omit<EventInsert, 'created_by'>, groupIds);
    setFormLoading(false);
    if (result) closeModal();
  };

  const handleEdit = async (payload: Omit<EventInsert, 'created_by'> | EventUpdate, groupIds: string[]) => {
    if (!selected) return;
    setFormLoading(true);
    const result = await updateEvent(selected.id, payload as EventUpdate, groupIds);
    setFormLoading(false);
    if (result) closeModal();
  };

  const handleDelete = async () => {
    if (!selected || !isCoordinator) return;
    const confirmed = window.confirm(`Excluir "${selected.title}"? Esta ação não pode ser desfeita.`);
    if (!confirmed) return;
    setActionLoading(true);
    const ok = await deleteEvent(selected.id);
    setActionLoading(false);
    if (ok) closeModal();
  };

  const filters: { label: string; value: FilterStatus }[] = [
    { label: 'Todos', value: 'all' },
    { label: 'Agendados', value: 'scheduled' },
    { label: 'Realizados', value: 'completed' },
    { label: 'Cancelados', value: 'cancelled' },
  ];

  return (
    <div className="space-y-5">
      <PageHeader
        title="Encontros"
        subtitle={`${events.length} encontro${events.length !== 1 ? 's' : ''}`}
        action={isCoordinator && (
          <button onClick={openCreate} className={primaryBtnCls}>
            <Plus className="w-4 h-4" />
            <span className="hidden sm:inline">Novo encontro</span>
          </button>
        )}
      />

      {/* Filtros */}
      <div className="bg-white border border-gray-200 rounded-xl px-4 py-3 space-y-3">
        <SearchInput value={search} onChange={setSearch} placeholder="Buscar por título..." className="max-w-sm" />
        <FilterChips options={filters} value={filterStatus} onChange={setFilterStatus} />
      </div>

      {/* Error */}
      {error && (
        <div className="flex items-center gap-2 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-4 py-3">
          <AlertCircle className="w-4 h-4 flex-shrink-0" />
          {error}
        </div>
      )}

      {/* Loading */}
      {loading && <LoadingBlock />}

      {/* Empty */}
      {!loading && !error && filtered.length === 0 && (
        <EmptyState
          icon={Calendar}
          title={search ? `Nenhum encontro encontrado para "${search}".` : 'Nenhum encontro cadastrado ainda.'}
          action={isCoordinator && !search && (
            <button onClick={openCreate} className="mt-3 text-blue-600 text-sm font-medium hover:underline">
              Criar o primeiro encontro
            </button>
          )}
        />
      )}

      {/* Tabela - Desktop */}
      {!loading && filtered.length > 0 && (
        <div className="hidden md:block bg-white border border-gray-200 rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-200 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">
                <th className="px-4 py-3">Encontro</th>
                <th className="px-4 py-3">Data</th>
                <th className="px-4 py-3">Grupos</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3 text-right">Ações</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {filtered.map((ev) => (
                <tr key={ev.id} className="hover:bg-gray-50 transition-colors">
                  <td className="px-4 py-3">
                    <button onClick={() => openView(ev)} className="flex items-center gap-3 text-left">
                      <div className="flex-shrink-0 w-10 text-center">
                        <p className="text-base font-bold text-blue-700 leading-none">{new Date(ev.event_date).getDate()}</p>
                        <p className="text-[10px] text-gray-400 uppercase">{new Date(ev.event_date).toLocaleString('pt-BR', { month: 'short' })}</p>
                      </div>
                      <span className="font-medium text-gray-900">{ev.title}</span>
                    </button>
                  </td>
                  <td className="px-4 py-3 text-gray-600">{formatDate(ev.event_date)}</td>
                  <td className="px-4 py-3 text-gray-600 truncate max-w-xs">
                    {ev.group_names.length > 0 ? `${ev.group_names.slice(0, 2).join(', ')}${ev.group_names.length > 2 ? '…' : ''}` : '—'}
                  </td>
                  <td className="px-4 py-3">
                    <Badge color={STATUS_BADGE_COLOR[ev.status]}>{STATUS_LABEL[ev.status]}</Badge>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button onClick={() => openView(ev)} className="p-1.5 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-md transition-colors">
                      <ChevronRight className="w-4 h-4" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Cards - Mobile */}
      {!loading && filtered.length > 0 && (
        <ul className="md:hidden bg-white rounded-xl border border-gray-200 divide-y divide-gray-100 overflow-hidden">
          {filtered.map((ev) => (
            <li key={ev.id}>
              <button
                onClick={() => openView(ev)}
                className="w-full flex items-center gap-3 px-4 py-3 hover:bg-gray-50 transition-colors text-left"
              >
                {/* Date badge */}
                <div className="flex-shrink-0 w-12 text-center">
                  <p className="text-lg font-bold text-blue-700 leading-none">
                    {new Date(ev.event_date).getDate()}
                  </p>
                  <p className="text-[10px] text-gray-400 uppercase">
                    {new Date(ev.event_date).toLocaleString('pt-BR', { month: 'short' })}
                  </p>
                </div>

                {/* Info */}
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-gray-900 truncate">{ev.title}</p>
                  <p className="text-xs text-gray-500 truncate">
                    {formatDate(ev.event_date)}
                    {ev.group_names.length > 0 && ` · ${ev.group_names.slice(0, 2).join(', ')}${ev.group_names.length > 2 ? '…' : ''}`}
                  </p>
                </div>

                {/* Status + chevron */}
                <div className="flex items-center gap-2 flex-shrink-0">
                  <Badge color={STATUS_BADGE_COLOR[ev.status]}>{STATUS_LABEL[ev.status]}</Badge>
                  <ChevronRight className="w-4 h-4 text-gray-300" />
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}

      {/* Modal: Visualização */}
      {modalMode === 'view' && selected && (
        <Modal title="Detalhes do Encontro" onClose={closeModal}>
          <EventDetail
            event={selected}
            isCoordinator={isCoordinator}
            onEdit={openEdit}
            onDelete={handleDelete}
            onClose={closeModal}
            actionLoading={actionLoading}
            onOpenAttendance={() => navigate(`/chamada/${selected.id}`)}
          />
        </Modal>
      )}

      {/* Modal: Criar */}
      {modalMode === 'create' && (
        <Modal title="Novo Encontro" onClose={closeModal}>
          <EventForm
            allGroups={allGroups}
            onSubmit={handleCreate}
            onCancel={closeModal}
            loading={formLoading}
          />
        </Modal>
      )}

      {/* Modal: Editar */}
      {modalMode === 'edit' && selected && (
        <Modal title="Editar Encontro" onClose={closeModal}>
          <EventForm
            initial={selected}
            allGroups={allGroups}
            onSubmit={handleEdit}
            onCancel={() => setModalMode('view')}
            loading={formLoading}
          />
        </Modal>
      )}
    </div>
  );
}
