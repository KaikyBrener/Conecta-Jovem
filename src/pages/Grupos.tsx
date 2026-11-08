import { useState, useEffect } from 'react';
import { Plus, Users, ChevronRight, AlertCircle, Pencil, Search, UsersRound } from 'lucide-react';
import { useGroups } from '../hooks/useGroups';
import { useToast } from '../contexts/ToastContext';
import { useDebouncedValue } from '../hooks/useDebouncedValue';
import { useSearchParamPrefill } from '../hooks/useSearchParamPrefill';
import { Modal } from '../components/Modal';
import { GroupForm } from '../components/groups/GroupForm';
import { GroupMembers } from '../components/groups/GroupMembers';
import { GroupMetric } from '../components/groups/GroupMetric';
import { PageHeader } from '../components/ui/PageHeader';
import { SearchInput } from '../components/ui/SearchInput';
import { EmptyState } from '../components/ui/EmptyState';
import { LoadingBlock } from '../components/ui/LoadingBlock';
import { Pagination } from '../components/ui/Pagination';
import { RefreshingNote } from '../components/ui/RefreshingNote';
import { IconButton } from '../components/ui/IconButton';
import { Avatar } from '../components/ui/Avatar';
import { primaryBtnCls, tableCls, tableWrapCls, thCls, trCls } from '../lib/formStyles';
import { cn } from '../lib/utils';
import type { Group, GroupInsert, GroupUpdate } from '../types/database.types';
import type { GroupWithLeader } from '../hooks/useGroups';

type ModalMode = 'none' | 'create' | 'edit' | 'members';

export function Grupos() {
  const toast = useToast();
  // Busca, ordenação e paginação são aplicadas no servidor (useGroups)
  // `/grupos?busca=<texto>` (busca global) preenche o campo
  const [search, setSearch] = useSearchParamPrefill('busca');
  const debouncedSearch = useDebouncedValue(search);
  const {
    groups,
    total,
    totalAll,
    page,
    setPage,
    pageSize,
    totalPages,
    leaders,
    indicators,
    indicatorsLoading,
    indicatorsFailed,
    loading,
    error,
    role,
    user,
    refetch,
    fetchLeaders,
    fetchMembers,
    fetchUnassigned,
    createGroup,
    updateGroup,
    assignYouth,
    removeYouthFromGroup,
  } = useGroups({ search: debouncedSearch });

  const isCoordinator = role === 'coordinator';

  const [modalMode, setModalMode] = useState<ModalMode>('none');
  const [selected, setSelected] = useState<GroupWithLeader | null>(null);
  const [formLoading, setFormLoading] = useState(false);

  // Carrega líderes quando o coordenador abre o modal de criação/edição
  useEffect(() => {
    if (isCoordinator && (modalMode === 'create' || modalMode === 'edit')) {
      fetchLeaders();
    }
  }, [isCoordinator, modalMode, fetchLeaders]);

  const openCreate = () => { setSelected(null); setModalMode('create'); };
  const openEdit = (g: GroupWithLeader) => { setSelected(g); setModalMode('edit'); };
  const openMembers = (g: GroupWithLeader) => { setSelected(g); setModalMode('members'); };
  const closeModal = () => { setModalMode('none'); setSelected(null); };

  const handleCreate = async (data: GroupInsert | GroupUpdate) => {
    setFormLoading(true);
    const result = await createGroup(data as GroupInsert);
    setFormLoading(false);
    if (result) { closeModal(); toast.success('Grupo criado.'); }
  };

  const handleEdit = async (data: GroupInsert | GroupUpdate) => {
    if (!selected) return;
    setFormLoading(true);
    const result = await updateGroup(selected.id, data as GroupUpdate);
    setFormLoading(false);
    if (result) { await refetch(); closeModal(); toast.success('Grupo atualizado.'); }
  };

  // Líder pode editar apenas o seu próprio grupo
  const canEditGroup = (g: Group) =>
    isCoordinator || (role === 'leader' && g.leader_id === user?.id);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Grupos"
        subtitle={`${totalAll} grupo${totalAll !== 1 ? 's' : ''} cadastrado${totalAll !== 1 ? 's' : ''}`}
        action={isCoordinator && (
          <button onClick={openCreate} className={primaryBtnCls}>
            <Plus className="w-4 h-4" aria-hidden="true" />
            <span>Novo grupo</span>
          </button>
        )}
      />

      {/* Filtros */}
      <div className="bg-surface border border-line rounded-card px-4 py-3">
        <SearchInput value={search} onChange={setSearch} placeholder="Buscar por grupo ou líder..." className="max-w-sm" />
      </div>

      {/* Error */}
      {error && (
        <div className="flex items-center gap-2 text-sm text-danger-ink bg-danger-soft border border-danger-line rounded-control px-4 py-3">
          <AlertCircle className="w-4 h-4 flex-shrink-0" />
          {error}
        </div>
      )}

      {indicatorsFailed && groups.length > 0 && (
        <p className="text-xs text-ink-muted" role="status" data-testid="grupos-indicadores-indisponiveis">
          Não foi possível carregar os indicadores dos grupos agora. A lista continua disponível.
        </p>
      )}

      {/* Loading */}
      {loading && groups.length === 0 && <LoadingBlock />}

      {/* Empty (sem grupos cadastrados) */}
      {!loading && !error && total === 0 && !search.trim() && (
        <EmptyState
          icon={Users}
          title="Nenhum grupo cadastrado ainda."
          action={isCoordinator && (
            <button onClick={openCreate} className="mt-3 text-action text-sm font-medium hover:underline">
              Criar o primeiro grupo
            </button>
          )}
        />
      )}

      {/* Empty (filtro sem resultado) */}
      {!loading && !error && total === 0 && search.trim() && (
        <EmptyState icon={Search} title={`Nenhum grupo encontrado para "${search}".`} />
      )}

      {/* Tabela - Desktop */}
      {groups.length > 0 && (
        <div className={cn('hidden lg:block', tableWrapCls, 'transition-opacity', loading && 'opacity-60')} aria-busy={loading}>
          <table className={tableCls}>
            <thead>
              <tr className="text-left">
                <th className={thCls}>Grupo</th>
                <th className={thCls}>Líder</th>
                <th className={thCls}>Integrantes</th>
                <th className={thCls}>Frequência</th>
                <th className={thCls}>Tendência</th>
                <th className={thCls}>Em atenção</th>
                <th className={thCls}>Ações atrasadas</th>
                <th className={cn(thCls, 'text-right')}>Ações</th>
              </tr>
            </thead>
            <tbody>
              {groups.map((g) => (
                <tr key={g.id} data-testid="grupo-linha" className={trCls}>
                  <td className="px-4 py-3">
                    <button onClick={() => openMembers(g)} className="flex items-center gap-3 text-left">
                      <Avatar name={g.name} size="sm" shape="square" />
                      <span className="whitespace-nowrap font-medium text-ink">{g.name}</span>
                    </button>
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-ink-soft">{g.leader_name ?? '—'}</td>
                  <td className="px-4 py-3">
                    <span className="inline-flex items-center justify-center min-w-6 h-6 px-2 rounded-full bg-action-soft text-action-ink text-xs font-semibold">
                      {g.member_count}
                    </span>
                  </td>
                  <td className="px-4 py-3"><GroupMetric kind="rate" indicator={indicators.get(g.id)} loading={indicatorsLoading} /></td>
                  <td className="px-4 py-3"><GroupMetric kind="trend" indicator={indicators.get(g.id)} loading={indicatorsLoading} /></td>
                  <td className="px-4 py-3"><GroupMetric kind="attention" indicator={indicators.get(g.id)} loading={indicatorsLoading} /></td>
                  <td className="px-4 py-3"><GroupMetric kind="overdue" indicator={indicators.get(g.id)} loading={indicatorsLoading} /></td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-1">
                      {canEditGroup(g) && (
                        <IconButton label="Editar grupo" icon={Pencil} tone="action" onClick={() => openEdit(g)} />
                      )}
                      <IconButton label="Ver integrantes" icon={ChevronRight} onClick={() => openMembers(g)} />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Cards - Mobile */}
      {groups.length > 0 && (
        <ul className={cn('lg:hidden bg-surface rounded-card border border-line divide-y divide-line-soft overflow-hidden transition-opacity', loading && 'opacity-60')} aria-busy={loading}>
          {groups.map((g) => (
            <li key={g.id} data-testid="grupo-card">
              <div className="flex items-center gap-3 px-4 py-3">
                <Avatar name={g.name} size="lg" shape="square" />

                <button onClick={() => openMembers(g)} className="flex-1 min-w-0 text-left">
                  <p className="text-sm font-medium text-ink truncate">{g.name}</p>
                  <p className="text-xs text-ink-muted truncate flex items-center gap-1.5 mt-0.5">
                    <UsersRound className="w-3 h-3" />
                    {g.leader_name ?? '—'}
                    <span className="inline-flex items-center justify-center min-w-5 h-5 px-1.5 rounded-full bg-action-soft text-action-ink text-xs font-semibold ml-1">
                      {g.member_count}
                    </span>
                  </p>
                </button>

                <div className="flex items-center gap-1 flex-shrink-0">
                  {canEditGroup(g) && (
                    <IconButton label="Editar grupo" icon={Pencil} tone="action" onClick={() => openEdit(g)} />
                  )}
                  <IconButton label="Ver integrantes" icon={ChevronRight} onClick={() => openMembers(g)} />
                </div>
              </div>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 px-4 pb-3 pl-[4.25rem] text-xs">
                <div className="flex items-baseline justify-between gap-2">
                  <dt className="text-ink-muted">Frequência</dt>
                  <dd><GroupMetric kind="rate" indicator={indicators.get(g.id)} loading={indicatorsLoading} /></dd>
                </div>
                <div className="flex items-baseline justify-between gap-2">
                  <dt className="text-ink-muted">Em atenção</dt>
                  <dd><GroupMetric kind="attention" indicator={indicators.get(g.id)} loading={indicatorsLoading} /></dd>
                </div>
                <div className="flex items-baseline justify-between gap-2">
                  <dt className="text-ink-muted">Atrasadas</dt>
                  <dd><GroupMetric kind="overdue" indicator={indicators.get(g.id)} loading={indicatorsLoading} /></dd>
                </div>
                <div className="col-span-2 flex flex-wrap items-baseline justify-between gap-x-2">
                  <dt className="text-ink-muted">Tendência</dt>
                  <dd><GroupMetric kind="trend" indicator={indicators.get(g.id)} loading={indicatorsLoading} /></dd>
                </div>
              </dl>
            </li>
          ))}
        </ul>
      )}

      <RefreshingNote show={loading && groups.length > 0} />

      <Pagination page={page} totalPages={totalPages} total={total} pageSize={pageSize} onPageChange={setPage} noun={total === 1 ? 'grupo' : 'grupos'} disabled={loading} />

      {/* Modal: Criar */}
      {modalMode === 'create' && (
        <Modal title="Novo Grupo" onClose={closeModal}>
          <GroupForm
            leaders={leaders}
            currentUserId={user?.id ?? ''}
            isCoordinator={isCoordinator}
            onSubmit={handleCreate}
            onCancel={closeModal}
            loading={formLoading}
          />
        </Modal>
      )}

      {/* Modal: Editar */}
      {modalMode === 'edit' && selected && (
        <Modal title="Editar Grupo" onClose={closeModal}>
          <GroupForm
            initial={selected}
            leaders={leaders}
            currentUserId={user?.id ?? ''}
            isCoordinator={isCoordinator}
            onSubmit={handleEdit}
            onCancel={closeModal}
            loading={formLoading}
          />
        </Modal>
      )}

      {/* Modal: Integrantes */}
      {modalMode === 'members' && selected && (
        <Modal title={`Integrantes — ${selected.name}`} onClose={closeModal}>
          <GroupMembers
            groupId={selected.id}
            isCoordinator={isCoordinator}
            fetchMembers={fetchMembers}
            fetchUnassigned={fetchUnassigned}
            onAssign={assignYouth}
            onRemove={removeYouthFromGroup}
          />
        </Modal>
      )}
    </div>
  );
}
