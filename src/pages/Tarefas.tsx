import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Plus, Loader2, ListChecks, CalendarClock, Play, Check, Pencil, Trash2, AlertTriangle, User as UserIcon } from 'lucide-react';
import { useTasks, prefillTaskFromAlert, prefillTaskFromYouth, type TaskWithRelations, type TaskListFilter } from '../hooks/useTasks';
import { useDebouncedValue } from '../hooks/useDebouncedValue';
import { useToast } from '../contexts/ToastContext';
import { Modal } from '../components/Modal';
import { ErrorBanner } from '../components/ErrorBanner';
import { TaskForm, type TaskFormPayload } from '../components/tasks/TaskForm';
import { PageHeader } from '../components/ui/PageHeader';
import { SearchInput } from '../components/ui/SearchInput';
import { EmptyState } from '../components/ui/EmptyState';
import { LoadingBlock } from '../components/ui/LoadingBlock';
import { FilterChips } from '../components/ui/FilterChips';
import { Badge, type BadgeColor } from '../components/ui/Badge';
import { Pagination } from '../components/ui/Pagination';
import { primaryBtnCls } from '../lib/formStyles';
import { TASK_PRIORITY_LABEL, TASK_STATUS_LABEL } from '../lib/labels';
import { formatDateOnly, isOverdue } from '../lib/format';
import { cn } from '../lib/utils';
import type { Task, TaskPriority, TaskStatus } from '../types/database.types';

const STATUS_BADGE_COLOR: Record<TaskStatus, BadgeColor> = {
  pending: 'amber',
  in_progress: 'blue',
  done: 'green',
  cancelled: 'gray',
};

const PRIORITY_COLOR: Record<TaskPriority, string> = {
  low: 'text-gray-400',
  medium: 'text-amber-500',
  high: 'text-red-600',
};

const isOpen = (s: TaskStatus) => s === 'pending' || s === 'in_progress';

export function Tarefas() {
  const toast = useToast();
  const [searchParams, setSearchParams] = useSearchParams();

  // Filtros, ordenação e paginação são aplicados no servidor (useTasks)
  const [filter, setFilter] = useState<TaskListFilter>('open');
  const [onlyMine, setOnlyMine] = useState(false);
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebouncedValue(search);
  const {
    tasks, total, page, setPage, pageSize, totalPages, openCount, overdueCount,
    options, loading, error, isCoordinator, user, createTask, updateTask, deleteTask,
  } = useTasks({ status: filter, onlyMine, search: debouncedSearch });
  const [editing, setEditing] = useState<TaskWithRelations | null>(null);
  const [creating, setCreating] = useState<Partial<Task> | null>(null);
  const [formLoading, setFormLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  // Integração: /tarefas?novo=1&jovem=<id> ou &alerta=<id> abre o formulário pré-preenchido
  useEffect(() => {
    if (searchParams.get('novo') !== '1') return;
    const youthId = searchParams.get('jovem');
    const alertId = searchParams.get('alerta');
    let cancelled = false;

    const open = async () => {
      const prefill = alertId
        ? await prefillTaskFromAlert(alertId)
        : youthId
          ? await prefillTaskFromYouth(youthId)
          : null;
      if (!cancelled) {
        setCreating(prefill ?? {});
        setSearchParams({}, { replace: true });
      }
    };
    void open();
    return () => { cancelled = true; };
  }, [searchParams, setSearchParams]);

  const handleCreate = async (payload: TaskFormPayload) => {
    setFormLoading(true);
    const ok = await createTask(payload);
    setFormLoading(false);
    if (ok) { setCreating(null); toast.success('Tarefa criada.'); }
  };

  const handleEdit = async (payload: TaskFormPayload) => {
    if (!editing) return;
    setFormLoading(true);
    const ok = await updateTask(editing.id, payload);
    setFormLoading(false);
    if (ok) { setEditing(null); toast.success('Tarefa atualizada.'); }
  };

  const quickStatus = async (t: TaskWithRelations, status: TaskStatus) => {
    setBusyId(t.id);
    const ok = await updateTask(t.id, { status });
    setBusyId(null);
    if (ok) toast.success(status === 'done' ? 'Tarefa concluída.' : status === 'in_progress' ? 'Tarefa iniciada.' : 'Tarefa atualizada.');
  };

  const handleDelete = async (t: TaskWithRelations) => {
    if (!window.confirm(`Excluir a tarefa "${t.title}"?`)) return;
    setBusyId(t.id);
    const ok = await deleteTask(t.id);
    setBusyId(null);
    if (ok) toast.success('Tarefa excluída.');
  };

  const canDelete = (t: TaskWithRelations) => isCoordinator || t.created_by === user?.id;

  const filters: { label: string; value: TaskListFilter }[] = [
    { label: `Abertas (${openCount})`, value: 'open' },
    { label: 'Encerradas', value: 'done' },
    { label: 'Todas', value: 'all' },
  ];

  return (
    <div className="space-y-5">
      <PageHeader
        title="Tarefas"
        subtitle={
          <>
            {openCount} aberta{openCount !== 1 ? 's' : ''}
            {overdueCount > 0 && <span className="text-red-600"> · {overdueCount} atrasada{overdueCount !== 1 ? 's' : ''}</span>}
          </>
        }
        action={
          <button onClick={() => setCreating({})} className={primaryBtnCls}>
            <Plus className="w-4 h-4" />
            <span className="hidden sm:inline">Nova tarefa</span>
          </button>
        }
      />

      <div className="bg-white border border-gray-200 rounded-xl px-4 py-3 space-y-3">
        <div className="flex flex-col sm:flex-row gap-3">
          <SearchInput value={search} onChange={setSearch} placeholder="Buscar por título ou jovem..." className="flex-1" />
          <label className="flex items-center gap-2 text-sm text-gray-700">
            <input type="checkbox" checked={onlyMine} onChange={(e) => setOnlyMine(e.target.checked)} className="h-4 w-4 rounded border-gray-300 text-blue-600" />
            Só as minhas
          </label>
        </div>
        <FilterChips options={filters} value={filter} onChange={setFilter} />
      </div>

      <ErrorBanner message={error} />

      {loading && tasks.length === 0 && <LoadingBlock />}

      {!loading && tasks.length === 0 && (
        <EmptyState icon={ListChecks} title={search ? `Nenhuma tarefa encontrada para "${search}".` : 'Nenhuma tarefa encontrada para este filtro.'} />
      )}

      {tasks.length > 0 && (
        <ul className={cn('bg-white rounded-xl border border-gray-200 divide-y divide-gray-100 overflow-hidden transition-opacity', loading && 'opacity-60')} aria-busy={loading}>
          {tasks.map((t) => {
            const overdue = isOverdue(t.due_date, t.status);
            return (
              <li key={t.id} className="px-4 py-3 space-y-2">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className={`text-sm font-medium truncate ${t.status === 'done' || t.status === 'cancelled' ? 'text-gray-400 line-through' : 'text-gray-900'}`}>
                      {t.title}
                    </p>
                    <p className="text-xs text-gray-500 flex flex-wrap gap-x-2">
                      <span className={PRIORITY_COLOR[t.priority]}>● {TASK_PRIORITY_LABEL[t.priority]}</span>
                      {t.youth && <span>{t.youth.full_name}</span>}
                      {t.groups && <span>{t.groups.name}</span>}
                      {t.due_date && (
                        <span className={`inline-flex items-center gap-1 ${overdue ? 'text-red-600 font-medium' : ''}`}>
                          <CalendarClock className="w-3 h-3" /> {formatDateOnly(t.due_date)}{overdue && ' (atrasada)'}
                        </span>
                      )}
                      <span className="inline-flex items-center gap-1">
                        <UserIcon className="w-3 h-3" />
                        {t.assigned_to === user?.id ? 'Eu' : t.assignee?.full_name ?? (t.assigned_to ? 'Outro usuário' : 'Sem responsável')}
                      </span>
                      {t.alert && (
                        <span className="inline-flex items-center gap-1 text-amber-600">
                          <AlertTriangle className="w-3 h-3" /> Alerta {t.alert.status === 'open' ? 'aberto' : 'encerrado'}
                        </span>
                      )}
                    </p>
                    {t.description && <p className="text-xs text-gray-500 mt-1 line-clamp-2">{t.description}</p>}
                  </div>
                  <div className="flex-shrink-0">
                    <Badge color={STATUS_BADGE_COLOR[t.status]}>{TASK_STATUS_LABEL[t.status]}</Badge>
                  </div>
                </div>
                <div className="flex flex-wrap justify-end gap-2">
                  {busyId === t.id && <Loader2 className="w-4 h-4 text-blue-600 animate-spin self-center" />}
                  {t.status === 'pending' && (
                    <button onClick={() => quickStatus(t, 'in_progress')} disabled={busyId !== null}
                      className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-blue-700 bg-blue-50 border border-blue-200 rounded-lg hover:bg-blue-100 disabled:opacity-50 transition-colors">
                      <Play className="w-3 h-3" /> Iniciar
                    </button>
                  )}
                  {isOpen(t.status) && (
                    <button onClick={() => quickStatus(t, 'done')} disabled={busyId !== null}
                      className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-green-700 bg-green-50 border border-green-200 rounded-lg hover:bg-green-100 disabled:opacity-50 transition-colors">
                      <Check className="w-3 h-3" /> Concluir
                    </button>
                  )}
                  <button onClick={() => setEditing(t)} disabled={busyId !== null}
                    className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50 transition-colors">
                    <Pencil className="w-3 h-3" /> Editar
                  </button>
                  {canDelete(t) && (
                    <button onClick={() => handleDelete(t)} disabled={busyId !== null}
                      className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-red-700 bg-red-50 border border-red-200 rounded-lg hover:bg-red-100 disabled:opacity-50 transition-colors">
                      <Trash2 className="w-3 h-3" /> Excluir
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <Pagination page={page} totalPages={totalPages} total={total} pageSize={pageSize} onPageChange={setPage} noun={total === 1 ? 'tarefa' : 'tarefas'} disabled={loading} />

      {creating && (
        <Modal title="Nova tarefa" onClose={() => setCreating(null)}>
          {error && <div className="mb-4"><ErrorBanner message={error} /></div>}
          <TaskForm
            initial={creating}
            isEdit={false}
            options={options}
            currentUserId={user?.id ?? ''}
            isCoordinator={isCoordinator}
            onSubmit={handleCreate}
            onCancel={() => setCreating(null)}
            loading={formLoading}
          />
        </Modal>
      )}

      {editing && (
        <Modal title="Editar tarefa" onClose={() => setEditing(null)}>
          {error && <div className="mb-4"><ErrorBanner message={error} /></div>}
          <TaskForm
            initial={editing}
            isEdit
            options={options}
            currentUserId={user?.id ?? ''}
            isCoordinator={isCoordinator}
            onSubmit={handleEdit}
            onCancel={() => setEditing(null)}
            loading={formLoading}
          />
        </Modal>
      )}
    </div>
  );
}
