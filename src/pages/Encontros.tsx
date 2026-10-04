import { useState, useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Plus, Calendar, ChevronRight, AlertCircle, CalendarClock } from 'lucide-react';
import { useEvents, fetchEventById, type EventStatusFilter } from '../hooks/useEvents';
import { useEventSeries, type SeriesRow } from '../hooks/useEventSeries';
import { useDebouncedValue } from '../hooks/useDebouncedValue';
import { useSearchParamPrefill } from '../hooks/useSearchParamPrefill';
import { parseEventParam } from '../lib/deepLinks';
import { errorMessage } from '../lib/format';
import { cancelMessage, createdMessage, groupsMessage, hasPendingGroups, type SeriesInput } from '../lib/series';
import { SeriesForm } from '../components/events/SeriesForm';
import { SeriesManager } from '../components/events/SeriesManager';
import { useToast } from '../contexts/ToastContext';
import { Modal } from '../components/Modal';
import { EventForm } from '../components/events/EventForm';
import { EventDetail } from '../components/events/EventDetail';
import { PageHeader } from '../components/ui/PageHeader';
import { SearchInput } from '../components/ui/SearchInput';
import { EmptyState } from '../components/ui/EmptyState';
import { LoadingBlock } from '../components/ui/LoadingBlock';
import { FilterChips } from '../components/ui/FilterChips';
import { Badge, type BadgeColor } from '../components/ui/Badge';
import { Pagination } from '../components/ui/Pagination';
import { primaryBtnCls, secondaryBtnCls } from '../lib/formStyles';
import { cn } from '../lib/utils';
import type { EventInsert, EventUpdate, EventStatus } from '../types/database.types';
import type { EventWithGroups } from '../hooks/useEvents';

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

type ModalMode = 'none' | 'view' | 'create' | 'edit' | 'series-new' | 'series-manage';

/** Selos do encontro: série de origem e aviso de grupos pendentes */
function EventBadges({ ev }: { ev: EventWithGroups }) {
  const pending = hasPendingGroups(ev);
  if (!ev.series_id && !pending) return null;
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      {ev.series_id && <Badge color="indigo">Série: {ev.series_name ?? 'sem nome'}</Badge>}
      {pending && <Badge color="amber">Grupos pendentes</Badge>}
    </span>
  );
}

export function Encontros() {
  const toast = useToast();
  const navigate = useNavigate();
  // Filtros, ordenação e paginação são aplicados no servidor (useEvents)
  // `/encontros?busca=<texto>` preenche a busca
  const [search, setSearch] = useSearchParamPrefill('busca');
  const debouncedSearch = useDebouncedValue(search);
  const [filterStatus, setFilterStatus] = useState<EventStatusFilter>('all');
  const {
    events,
    total,
    totalAll,
    page,
    setPage,
    pageSize,
    totalPages,
    allGroups,
    loading,
    error,
    role,
    fetchAllGroups,
    createEvent,
    updateEvent,
    deleteEvent,
    refetch,
  } = useEvents({ search: debouncedSearch, status: filterStatus });

  const isCoordinator = role === 'coordinator';
  const [searchParams, setSearchParams] = useSearchParams();

  const [modalMode, setModalMode] = useState<ModalMode>('none');
  const seriesApi = useEventSeries(isCoordinator && modalMode === 'series-manage');
  const [selected, setSelected] = useState<EventWithGroups | null>(null);
  const [formLoading, setFormLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);

  // Carrega grupos quando abre modal de criação/edição
  useEffect(() => {
    if (modalMode === 'create' || modalMode === 'edit' || modalMode === 'series-new' || modalMode === 'series-manage') {
      fetchAllGroups();
    }
  }, [modalMode, fetchAllGroups]);

  const openCreate = () => { setSelected(null); setModalMode('create'); };
  const openView = (ev: EventWithGroups) => { setSelected(ev); setModalMode('view'); };
  const openEdit = () => setModalMode('edit');
  const closeModal = () => {
    setModalMode('none');
    setSelected(null);
    setSearchParams((p) => { if (!p.has('evento')) return p; const n = new URLSearchParams(p); n.delete('evento'); return n; }, { replace: true });
  };

  // Deep link /encontros?evento=<id> (busca global): abre o detalhe mesmo que o encontro não esteja na página atual
  const hasEventParam = searchParams.has('evento');
  const eventId = parseEventParam(searchParams.get('evento'));
  useEffect(() => {
    if (!hasEventParam) return;
    let cancelled = false;
    const clearParam = () => setSearchParams((p) => { const n = new URLSearchParams(p); n.delete('evento'); return n; }, { replace: true });
    const open = async () => {
      let found: EventWithGroups | null = null;
      if (eventId) {
        try {
          found = await fetchEventById(eventId);
        } catch (err) {
          if (cancelled) return;
          toast.error(errorMessage(err, 'Não foi possível abrir o encontro.'));
          clearParam();
          return;
        }
      }
      if (cancelled) return;
      if (found) {
        setSelected(found);
        setModalMode('view');
      } else {
        toast.error('Encontro não encontrado ou sem permissão para vê-lo.');
        clearParam();
      }
    };
    void open();
    return () => { cancelled = true; };
  }, [eventId, hasEventParam, setSearchParams, toast]);

  // ── Séries (coordenador) ──
  const openSeriesNew = () => { seriesApi.clearError(); setSelected(null); setModalMode('series-new'); };
  const openSeriesManage = () => { seriesApi.clearError(); setSelected(null); setModalMode('series-manage'); };

  const handleCreateSeries = async (input: SeriesInput, description: string, groupIds: string[]): Promise<boolean> => {
    setFormLoading(true);
    const result = await seriesApi.createSeries(input, description, groupIds);
    setFormLoading(false);
    if (!result) return false;
    closeModal();
    refetch();
    toast.success(createdMessage(result, 'criada'));
    return true;
  };

  const handleSetSeriesGroups = async (s: SeriesRow, groupIds: string[]): Promise<boolean> => {
    const result = await seriesApi.setSeriesGroups(s.id, groupIds);
    if (!result) return false;
    refetch();
    toast.success(groupsMessage(result));
    return true;
  };

  const handleExtendSeries = async (s: SeriesRow, newEnd: string): Promise<boolean> => {
    const result = await seriesApi.extendSeries(s.id, newEnd);
    if (!result) return false;
    refetch();
    toast.success(createdMessage(result, 'estendida'));
    return true;
  };

  const handleCancelSeries = async (s: SeriesRow): Promise<boolean> => {
    const result = await seriesApi.cancelSeriesFuture(s.id);
    if (!result) return false;
    refetch();
    toast.success(cancelMessage(result));
    return true;
  };


  const handleCreate = async (payload: Omit<EventInsert, 'created_by'> | EventUpdate, groupIds: string[]) => {
    setFormLoading(true);
    const result = await createEvent(payload as Omit<EventInsert, 'created_by'>, groupIds);
    setFormLoading(false);
    if (result) { closeModal(); toast.success('Encontro criado.'); }
  };

  const handleEdit = async (payload: Omit<EventInsert, 'created_by'> | EventUpdate, groupIds: string[]) => {
    if (!selected) return;
    setFormLoading(true);
    const result = await updateEvent(selected.id, payload as EventUpdate, groupIds);
    setFormLoading(false);
    if (result) { closeModal(); toast.success('Encontro atualizado.'); }
  };

  const handleDelete = async () => {
    if (!selected || !isCoordinator) return;
    const confirmed = window.confirm(`Excluir "${selected.title}"? Esta ação não pode ser desfeita.`);
    if (!confirmed) return;
    setActionLoading(true);
    const ok = await deleteEvent(selected.id);
    setActionLoading(false);
    if (ok) { closeModal(); toast.success('Encontro excluído.'); }
  };

  const filters: { label: string; value: EventStatusFilter }[] = [
    { label: 'Todos', value: 'all' },
    { label: 'Agendados', value: 'scheduled' },
    { label: 'Realizados', value: 'completed' },
    { label: 'Cancelados', value: 'cancelled' },
  ];

  return (
    <div className="space-y-5">
      <PageHeader
        title="Encontros"
        subtitle={`${totalAll} encontro${totalAll !== 1 ? 's' : ''}`}
        action={isCoordinator && (
          <div className="flex flex-wrap items-center gap-2">
            <button onClick={openSeriesManage} className={secondaryBtnCls} data-testid="series-gerenciar" aria-label="Gerenciar séries">
              <CalendarClock className="w-4 h-4" aria-hidden="true" />
              <span className="hidden sm:inline">Gerenciar séries</span>
            </button>
            <button onClick={openSeriesNew} className={secondaryBtnCls} data-testid="serie-nova" aria-label="Nova série">
              <CalendarClock className="w-4 h-4" aria-hidden="true" />
              <span className="hidden sm:inline">Nova série</span>
            </button>
            <button onClick={openCreate} className={primaryBtnCls}>
              <Plus className="w-4 h-4" />
              <span className="hidden sm:inline">Novo encontro</span>
            </button>
          </div>
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
      {loading && events.length === 0 && <LoadingBlock />}

      {/* Empty */}
      {!loading && !error && events.length === 0 && (
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
      {events.length > 0 && (
        <div className={cn('hidden md:block bg-white border border-gray-200 rounded-xl overflow-hidden transition-opacity', loading && 'opacity-60')} aria-busy={loading}>
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
              {events.map((ev) => (
                <tr key={ev.id} className="hover:bg-gray-50 transition-colors">
                  <td className="px-4 py-3">
                    <button onClick={() => openView(ev)} className="flex items-center gap-3 text-left">
                      <div className="flex-shrink-0 w-10 text-center">
                        <p className="text-base font-bold text-blue-700 leading-none">{new Date(ev.event_date).getDate()}</p>
                        <p className="text-[10px] text-gray-400 uppercase">{new Date(ev.event_date).toLocaleString('pt-BR', { month: 'short' })}</p>
                      </div>
                      <span className="font-medium text-gray-900">{ev.title}</span>
                    </button>
                    <div className="mt-1 pl-[3.25rem] empty:hidden"><EventBadges ev={ev} /></div>
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
      {events.length > 0 && (
        <ul className={cn('md:hidden bg-white rounded-xl border border-gray-200 divide-y divide-gray-100 overflow-hidden transition-opacity', loading && 'opacity-60')} aria-busy={loading}>
          {events.map((ev) => (
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
                  {(ev.series_id || hasPendingGroups(ev)) && <div className="mt-0.5"><EventBadges ev={ev} /></div>}
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

      <Pagination page={page} totalPages={totalPages} total={total} pageSize={pageSize} onPageChange={setPage} noun={total === 1 ? 'encontro' : 'encontros'} disabled={loading} />

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

      {/* Modal: Nova série */}
      {modalMode === 'series-new' && isCoordinator && (
        <Modal title="Nova série de encontros" onClose={closeModal}>
          <SeriesForm allGroups={allGroups} onSubmit={handleCreateSeries} onCancel={closeModal} loading={formLoading} error={seriesApi.error} />
        </Modal>
      )}

      {/* Modal: Gerenciar séries */}
      {modalMode === 'series-manage' && isCoordinator && (
        <Modal title="Séries de encontros" onClose={closeModal}>
          <SeriesManager
            series={seriesApi.series}
            loading={seriesApi.loading}
            error={seriesApi.error}
            allGroups={allGroups}
            onSetGroups={handleSetSeriesGroups}
            onExtend={handleExtendSeries}
            onCancelFuture={handleCancelSeries}
            onNew={openSeriesNew}
            onClose={closeModal}
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
