import { useState, useEffect, useMemo } from 'react';
import { Plus, Users, ChevronRight, AlertCircle, Pencil, Search, UsersRound } from 'lucide-react';
import { useGroups } from '../hooks/useGroups';
import { Modal } from '../components/Modal';
import { GroupForm } from '../components/groups/GroupForm';
import { GroupMembers } from '../components/groups/GroupMembers';
import { PageHeader } from '../components/ui/PageHeader';
import { SearchInput } from '../components/ui/SearchInput';
import { EmptyState } from '../components/ui/EmptyState';
import { LoadingBlock } from '../components/ui/LoadingBlock';
import { primaryBtnCls } from '../lib/formStyles';
import type { Group, GroupInsert, GroupUpdate } from '../types/database.types';
import type { GroupWithLeader } from '../hooks/useGroups';

type ModalMode = 'none' | 'create' | 'edit' | 'members';

export function Grupos() {
  const {
    groups,
    leaders,
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
  } = useGroups();

  const isCoordinator = role === 'coordinator';

  const [modalMode, setModalMode] = useState<ModalMode>('none');
  const [selected, setSelected] = useState<GroupWithLeader | null>(null);
  const [formLoading, setFormLoading] = useState(false);
  const [search, setSearch] = useState('');

  // Carrega líderes quando o coordenador abre o modal de criação/edição
  useEffect(() => {
    if (isCoordinator && (modalMode === 'create' || modalMode === 'edit')) {
      fetchLeaders();
    }
  }, [isCoordinator, modalMode, fetchLeaders]);

  const filteredGroups = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return groups;
    return groups.filter(
      (g) => g.name.toLowerCase().includes(term) || (g.leader_name ?? '').toLowerCase().includes(term)
    );
  }, [groups, search]);

  const openCreate = () => { setSelected(null); setModalMode('create'); };
  const openEdit = (g: GroupWithLeader) => { setSelected(g); setModalMode('edit'); };
  const openMembers = (g: GroupWithLeader) => { setSelected(g); setModalMode('members'); };
  const closeModal = () => { setModalMode('none'); setSelected(null); };

  const handleCreate = async (data: GroupInsert | GroupUpdate) => {
    setFormLoading(true);
    const result = await createGroup(data as GroupInsert);
    setFormLoading(false);
    if (result) closeModal();
  };

  const handleEdit = async (data: GroupInsert | GroupUpdate) => {
    if (!selected) return;
    setFormLoading(true);
    const result = await updateGroup(selected.id, data as GroupUpdate);
    setFormLoading(false);
    if (result) { await refetch(); closeModal(); }
  };

  // Líder pode editar apenas o seu próprio grupo
  const canEditGroup = (g: Group) =>
    isCoordinator || (role === 'leader' && g.leader_id === user?.id);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Grupos"
        subtitle={`${groups.length} grupo${groups.length !== 1 ? 's' : ''} cadastrado${groups.length !== 1 ? 's' : ''}`}
        action={isCoordinator && (
          <button onClick={openCreate} className={primaryBtnCls}>
            <Plus className="w-4 h-4" />
            <span>Novo grupo</span>
          </button>
        )}
      />

      {/* Filtros */}
      <div className="bg-white border border-gray-200 rounded-xl px-4 py-3">
        <SearchInput value={search} onChange={setSearch} placeholder="Buscar por grupo ou líder..." className="max-w-sm" />
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

      {/* Empty (sem grupos cadastrados) */}
      {!loading && !error && groups.length === 0 && (
        <EmptyState
          icon={Users}
          title="Nenhum grupo cadastrado ainda."
          action={isCoordinator && (
            <button onClick={openCreate} className="mt-3 text-blue-600 text-sm font-medium hover:underline">
              Criar o primeiro grupo
            </button>
          )}
        />
      )}

      {/* Empty (filtro sem resultado) */}
      {!loading && !error && groups.length > 0 && filteredGroups.length === 0 && (
        <EmptyState icon={Search} title={`Nenhum grupo encontrado para "${search}".`} />
      )}

      {/* Tabela - Desktop */}
      {!loading && filteredGroups.length > 0 && (
        <div className="hidden md:block bg-white border border-gray-200 rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-200 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">
                <th className="px-4 py-3">Grupo</th>
                <th className="px-4 py-3">Líder</th>
                <th className="px-4 py-3">Integrantes</th>
                <th className="px-4 py-3 text-right">Ações</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {filteredGroups.map((g) => (
                <tr key={g.id} className="hover:bg-gray-50 transition-colors">
                  <td className="px-4 py-3">
                    <button onClick={() => openMembers(g)} className="flex items-center gap-3 text-left">
                      <div className="flex-shrink-0 w-9 h-9 rounded-full bg-indigo-50 text-indigo-700 font-bold text-sm flex items-center justify-center uppercase">
                        {g.name.charAt(0)}
                      </div>
                      <span className="font-medium text-gray-900">{g.name}</span>
                    </button>
                  </td>
                  <td className="px-4 py-3 text-gray-600">{g.leader_name ?? '—'}</td>
                  <td className="px-4 py-3">
                    <span className="inline-flex items-center justify-center min-w-6 h-6 px-2 rounded-full bg-blue-50 text-blue-700 text-xs font-semibold">
                      {g.member_count}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-1">
                      {canEditGroup(g) && (
                        <button
                          onClick={() => openEdit(g)}
                          className="p-1.5 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded-md transition-colors"
                          title="Editar grupo"
                        >
                          <Pencil className="w-4 h-4" />
                        </button>
                      )}
                      <button
                        onClick={() => openMembers(g)}
                        className="p-1.5 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-md transition-colors"
                        title="Ver integrantes"
                      >
                        <ChevronRight className="w-4 h-4" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Cards - Mobile */}
      {!loading && filteredGroups.length > 0 && (
        <ul className="md:hidden bg-white rounded-xl border border-gray-200 divide-y divide-gray-100 overflow-hidden">
          {filteredGroups.map((g) => (
            <li key={g.id}>
              <div className="flex items-center gap-3 px-4 py-3">
                <div className="flex-shrink-0 w-10 h-10 rounded-full bg-indigo-50 text-indigo-700 font-bold text-sm flex items-center justify-center uppercase">
                  {g.name.charAt(0)}
                </div>

                <button onClick={() => openMembers(g)} className="flex-1 min-w-0 text-left">
                  <p className="text-sm font-medium text-gray-900 truncate">{g.name}</p>
                  <p className="text-xs text-gray-500 truncate flex items-center gap-1.5 mt-0.5">
                    <UsersRound className="w-3 h-3" />
                    {g.leader_name ?? '—'}
                    <span className="inline-flex items-center justify-center min-w-5 h-5 px-1.5 rounded-full bg-blue-50 text-blue-700 text-[11px] font-semibold ml-1">
                      {g.member_count}
                    </span>
                  </p>
                </button>

                <div className="flex items-center gap-1 flex-shrink-0">
                  {canEditGroup(g) && (
                    <button
                      onClick={() => openEdit(g)}
                      className="p-1.5 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded-md transition-colors"
                      title="Editar grupo"
                    >
                      <Pencil className="w-4 h-4" />
                    </button>
                  )}
                  <button
                    onClick={() => openMembers(g)}
                    className="p-1.5 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-md transition-colors"
                    title="Ver integrantes"
                  >
                    <ChevronRight className="w-4 h-4" />
                  </button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

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
