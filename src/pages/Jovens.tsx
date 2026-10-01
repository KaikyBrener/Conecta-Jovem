import { useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, UserCheck, UserX, ChevronRight, AlertCircle } from 'lucide-react';
import { useYouth } from '../hooks/useYouth';
import { Modal } from '../components/Modal';
import { YouthForm } from '../components/youth/YouthForm';
import { YouthDetail } from '../components/youth/YouthDetail';
import { PageHeader } from '../components/ui/PageHeader';
import { SearchInput } from '../components/ui/SearchInput';
import { EmptyState } from '../components/ui/EmptyState';
import { LoadingBlock } from '../components/ui/LoadingBlock';
import { Badge } from '../components/ui/Badge';
import { primaryBtnCls } from '../lib/formStyles';
import type { Youth, YouthInsert, YouthUpdate } from '../types/database.types';

type FilterStatus = 'all' | 'active' | 'inactive';

export function Jovens() {
  const { youth, groups, loading, error, role, createYouth, updateYouth, deactivateYouth, activateYouth } = useYouth();
  const navigate = useNavigate();
  const groupName = useMemo(() => new Map(groups.map((g) => [g.id, g.name])), [groups]);

  // UI state
  const [search, setSearch] = useState('');
  const [filterStatus, setFilterStatus] = useState<FilterStatus>('active');
  const [groupFilter, setGroupFilter] = useState<string>('all');
  const [selectedYouth, setSelectedYouth] = useState<Youth | null>(null);
  const [mode, setMode] = useState<'view' | 'create' | 'edit'>('view');
  const [formLoading, setFormLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);

  const canCreate = role === 'coordinator';
  const canEdit = role === 'coordinator' || role === 'leader';

  // Filter + search
  const filtered = useMemo(() => {
    return youth.filter((y) => {
      const matchesSearch = y.full_name.toLowerCase().includes(search.toLowerCase());
      const matchesStatus =
        filterStatus === 'all' ||
        (filterStatus === 'active' && y.is_active) ||
        (filterStatus === 'inactive' && !y.is_active);
      const matchesGroup =
        groupFilter === 'all' ||
        (groupFilter === 'none' ? !y.group_id : y.group_id === groupFilter);
      return matchesSearch && matchesStatus && matchesGroup;
    });
  }, [youth, search, filterStatus, groupFilter]);

  // Handlers
  const openCreate = () => { setSelectedYouth(null); setMode('create'); };
  const openView = (y: Youth) => { setSelectedYouth(y); setMode('view'); };
  const openEdit = () => setMode('edit');
  const closeModal = () => { setSelectedYouth(null); setMode('view'); };

  const handleCreate = async (data: Omit<YouthInsert, 'created_by'> | YouthUpdate) => {
    setFormLoading(true);
    const result = await createYouth(data as Omit<YouthInsert, 'created_by'>);
    setFormLoading(false);
    if (result) closeModal();
  };

  const handleEdit = async (data: Omit<YouthInsert, 'created_by'> | YouthUpdate) => {
    if (!selectedYouth) return;
    setFormLoading(true);
    const result = await updateYouth(selectedYouth.id, data as YouthUpdate);
    setFormLoading(false);
    if (result) { setSelectedYouth(result); setMode('view'); }
  };

  const handleToggleStatus = async () => {
    if (!selectedYouth) return;
    setActionLoading(true);
    if (selectedYouth.is_active) {
      await deactivateYouth(selectedYouth.id);
    } else {
      await activateYouth(selectedYouth.id);
    }
    setActionLoading(false);
    closeModal();
  };

  // Badge counts
  const activeCount = youth.filter((y) => y.is_active).length;
  const inactiveCount = youth.filter((y) => !y.is_active).length;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Jovens"
        subtitle={`${activeCount} ativo${activeCount !== 1 ? 's' : ''} · ${inactiveCount} inativo${inactiveCount !== 1 ? 's' : ''}`}
        action={canCreate && (
          <button onClick={openCreate} className={primaryBtnCls}>
            <Plus className="w-4 h-4" />
            <span className="hidden sm:inline">Novo jovem</span>
          </button>
        )}
      />

      {/* Search + filters */}
      <div className="bg-white border border-gray-200 rounded-xl px-4 py-3 flex flex-col sm:flex-row gap-3">
        <SearchInput value={search} onChange={setSearch} placeholder="Buscar por nome..." className="flex-1" />
        <select
          value={groupFilter}
          onChange={(e) => setGroupFilter(e.target.value)}
          className="sm:w-44 px-3 py-2 text-sm border border-gray-300 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500"
          aria-label="Filtrar por grupo"
        >
          <option value="all">Todos os grupos</option>
          {groups.map((g) => (
            <option key={g.id} value={g.id}>{g.name}</option>
          ))}
          {role === 'coordinator' && <option value="none">Sem grupo</option>}
        </select>
        <div className="flex rounded-lg border border-gray-300 overflow-hidden text-sm">
          {(['all', 'active', 'inactive'] as FilterStatus[]).map((f) => (
            <button
              key={f}
              onClick={() => setFilterStatus(f)}
              className={`px-3 py-2 font-medium transition-colors ${
                filterStatus === f ? 'bg-blue-600 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'
              }`}
            >
              {f === 'all' ? 'Todos' : f === 'active' ? 'Ativos' : 'Inativos'}
            </button>
          ))}
        </div>
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
          icon={UserCheck}
          title={search ? `Nenhum jovem encontrado para "${search}".` : 'Nenhum jovem cadastrado ainda.'}
          action={canCreate && !search && (
            <button onClick={openCreate} className="mt-3 text-blue-600 text-sm font-medium hover:underline">
              Cadastrar o primeiro jovem
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
                <th className="px-4 py-3">Jovem</th>
                <th className="px-4 py-3">Grupo</th>
                <th className="px-4 py-3">Contato</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3 text-right">Ações</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {filtered.map((y) => (
                <tr key={y.id} className="hover:bg-gray-50 transition-colors">
                  <td className="px-4 py-3">
                    <button onClick={() => openView(y)} className="flex items-center gap-3 text-left">
                      <div className="flex-shrink-0 w-9 h-9 rounded-full bg-blue-50 text-blue-700 font-semibold text-sm flex items-center justify-center uppercase">
                        {y.full_name.charAt(0)}
                      </div>
                      <span className="font-medium text-gray-900">{y.full_name}</span>
                    </button>
                  </td>
                  <td className="px-4 py-3 text-gray-600">{(y.group_id && groupName.get(y.group_id)) || 'Sem grupo'}</td>
                  <td className="px-4 py-3 text-gray-600">{y.phone ?? y.email ?? '—'}</td>
                  <td className="px-4 py-3">
                    <Badge color={y.is_active ? 'green' : 'gray'}>{y.is_active ? 'Ativo' : 'Inativo'}</Badge>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button onClick={() => openView(y)} className="p-1.5 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-md transition-colors">
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
          {filtered.map((y) => (
            <li key={y.id}>
              <button
                onClick={() => openView(y)}
                className="w-full flex items-center gap-3 px-4 py-3 hover:bg-gray-50 transition-colors text-left"
              >
                {/* Avatar inicial */}
                <div className="flex-shrink-0 w-9 h-9 rounded-full bg-blue-50 text-blue-700 font-semibold text-sm flex items-center justify-center uppercase">
                  {y.full_name.charAt(0)}
                </div>
                {/* Info */}
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-gray-900 truncate">{y.full_name}</p>
                  <p className="text-xs text-gray-500 truncate">
                    {(y.group_id && groupName.get(y.group_id)) || 'Sem grupo'} · {y.phone ?? y.email ?? 'Sem contato'}
                  </p>
                </div>
                {/* Status badge */}
                <div className="flex items-center gap-2 flex-shrink-0">
                  {y.is_active ? (
                    <UserCheck className="w-4 h-4 text-green-500" />
                  ) : (
                    <UserX className="w-4 h-4 text-gray-400" />
                  )}
                  <ChevronRight className="w-4 h-4 text-gray-300" />
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}

      {/* Modal: Visualização */}
      {selectedYouth && mode === 'view' && (
        <Modal title="Detalhes do Jovem" onClose={closeModal}>
          <YouthDetail
            youth={selectedYouth}
            groupName={(selectedYouth.group_id && groupName.get(selectedYouth.group_id)) || null}
            canEdit={canEdit}
            onCreateTask={() => navigate(`/tarefas?novo=1&jovem=${selectedYouth.id}`)}
            onEdit={openEdit}
            onToggleStatus={handleToggleStatus}
            onClose={closeModal}
            actionLoading={actionLoading}
          />
        </Modal>
      )}

      {/* Modal: Edição */}
      {selectedYouth && mode === 'edit' && (
        <Modal title="Editar Jovem" onClose={closeModal}>
          <YouthForm
            initial={selectedYouth}
            groups={groups}
            canChangeGroup={role === 'coordinator'}
            onSubmit={handleEdit}
            onCancel={() => setMode('view')}
            loading={formLoading}
          />
        </Modal>
      )}

      {/* Modal: Cadastro */}
      {mode === 'create' && !selectedYouth && (
        <Modal title="Novo Jovem" onClose={closeModal}>
          <YouthForm
            groups={groups}
            canChangeGroup={role === 'coordinator'}
            onSubmit={handleCreate}
            onCancel={closeModal}
            loading={formLoading}
          />
        </Modal>
      )}
    </div>
  );
}
