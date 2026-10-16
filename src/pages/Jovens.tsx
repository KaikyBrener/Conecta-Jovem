import { useState, useMemo, useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Plus, UserCheck, UserX, ChevronRight, AlertCircle } from 'lucide-react';
import { useYouth, fetchYouthById, type YouthStatusFilter } from '../hooks/useYouth';
import { parseYouthSheetParam } from '../lib/deepLinks';
import { appToday, errorMessage } from '../lib/format';
import { BATCH_MAX, addToSelection, batchHadEffect, batchSummary, buildYouthCsv, type BatchResult } from '../lib/batch';
import { downloadCsv } from '../lib/csv';
import { notifyAlertsChanged } from '../lib/alertsBus';
import { BatchBar } from '../components/youth/BatchBar';
import { BatchGroupForm } from '../components/youth/BatchGroupForm';
import { useDebouncedValue } from '../hooks/useDebouncedValue';
import { useYouthSituations } from '../hooks/useYouthSituation';
import { useToast } from '../contexts/ToastContext';
import { Modal } from '../components/Modal';
import { YouthForm } from '../components/youth/YouthForm';
import { YouthDetail } from '../components/youth/YouthDetail';
import { AnonymizeYouthForm } from '../components/youth/AnonymizeYouthForm';
import { isAnonymizedYouth } from '../lib/anonymize';
import { SituationBadge } from '../components/youth/SituationBadge';
import { PageHeader } from '../components/ui/PageHeader';
import { SearchInput } from '../components/ui/SearchInput';
import { EmptyState } from '../components/ui/EmptyState';
import { LoadingBlock } from '../components/ui/LoadingBlock';
import { Badge } from '../components/ui/Badge';
import { Pagination } from '../components/ui/Pagination';
import { RefreshingNote } from '../components/ui/RefreshingNote';
import { primaryBtnCls } from '../lib/formStyles';
import { cn } from '../lib/utils';
import type { Youth, YouthInsert, YouthUpdate } from '../types/database.types';

const NO_SELECTION: ReadonlyMap<string, Youth> = new Map();

export function Jovens() {
  const toast = useToast();
  // UI state — filtros, ordenação e paginação são aplicados no servidor (useYouth)
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebouncedValue(search);
  const [filterStatus, setFilterStatus] = useState<YouthStatusFilter>('active');
  const [groupFilter, setGroupFilter] = useState<string>('all');
  const {
    youth, groups, total, page, setPage, pageSize, totalPages, activeCount, inactiveCount,
    loading, error, role, createYouth, updateYouth, deactivateYouth, activateYouth,
    batchSetGroup, batchSetActive, anonymizeYouth, clearError,
  } = useYouth({ search: debouncedSearch, status: filterStatus, groupId: groupFilter });
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const groupName = useMemo(() => new Map(groups.map((g) => [g.id, g.name])), [groups]);
  const [selectedYouth, setSelectedYouth] = useState<Youth | null>(null);
  const [mode, setMode] = useState<'view' | 'create' | 'edit' | 'anonymize'>('view');
  const [formLoading, setFormLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);

  // Situação (selo) dos jovens da página atual: 1 chamada por página; falha não quebra a lista.
  // O "sal" refaz a consulta quando algo que muda a situação aconteceu (status do jovem, acompanhamento).
  const [situationVersion, setSituationVersion] = useState(0);
  const pageIds = useMemo(() => youth.map((y) => y.id), [youth]);
  const { situations, error: situationsError } = useYouthSituations(
    pageIds,
    `${situationVersion}:${youth.map((y) => (y.is_active ? 1 : 0)).join('')}`,
  );
  const situationCell = (y: Youth) => {
    const s = situations.get(y.id);
    return s ? <SituationBadge situation={s} /> : <span className="text-xs text-gray-400" aria-label="Situação indisponível">—</span>;
  };

  const canCreate = role === 'coordinator';
  const canEdit = role === 'coordinator' || role === 'leader';

  // ── Seleção em lote ──
  // Vale para o filtro atual (muda busca/status/grupo => seleção zerada, sem effect) e atravessa as páginas;
  // máximo BATCH_MAX por lote.
  const filterKey = `${debouncedSearch}|${filterStatus}|${groupFilter}`;
  const [selState, setSelState] = useState<{ key: string; items: ReadonlyMap<string, Youth> }>({ key: filterKey, items: NO_SELECTION });
  const selection = selState.key === filterKey ? selState.items : NO_SELECTION;
  const setSelection = (items: ReadonlyMap<string, Youth>) => setSelState({ key: filterKey, items });
  const [batchBusy, setBatchBusy] = useState(false);
  const [batchFailed, setBatchFailed] = useState(false);
  const [groupModalOpen, setGroupModalOpen] = useState(false);

  const pageSelected = youth.filter((y) => selection.has(y.id)).length;
  const allPageSelected = youth.length > 0 && pageSelected === youth.length;
  const somePageSelected = pageSelected > 0 && !allPageSelected;

  const toggleOne = (y: Youth) => {
    if (selection.has(y.id)) {
      const next = new Map(selection);
      next.delete(y.id);
      setSelection(next);
      return;
    }
    const { selection: next, rejected } = addToSelection(selection, [y]);
    if (rejected > 0) toast.error(`Você pode selecionar no máximo ${BATCH_MAX} jovens por lote.`);
    else setSelection(next);
  };

  const toggleAllPage = () => {
    if (allPageSelected) {
      const next = new Map(selection);
      youth.forEach((y) => next.delete(y.id));
      setSelection(next);
      return;
    }
    const { selection: next, rejected } = addToSelection(selection, youth);
    setSelection(next);
    if (rejected > 0) {
      toast.error(`Limite de ${BATCH_MAX} jovens por lote: ${rejected} ${rejected === 1 ? 'não foi selecionado' : 'não foram selecionados'}.`);
    }
  };

  const selectAllRef = (el: HTMLInputElement | null) => { if (el) el.indeterminate = somePageSelected; };

  const applyBatch = async (run: () => Promise<BatchResult | null>): Promise<boolean> => {
    setBatchBusy(true);
    setBatchFailed(false);
    const result = await run();
    setBatchBusy(false);
    if (!result) { setBatchFailed(true); return false; }
    const text = batchSummary(result);
    if (batchHadEffect(result)) toast.success(text); else toast.error(text);
    notifyAlertsChanged();
    setSituationVersion((v) => v + 1);
    setSelection(NO_SELECTION);
    return true;
  };

  const ids = () => [...selection.keys()];
  const n = selection.size;
  const countText = n === 1 ? '1 jovem' : `${n} jovens`;

  const openGroupModal = () => { clearError(); setBatchFailed(false); setGroupModalOpen(true); };
  const handleBatchGroup = async (groupId: string | null) => {
    if (await applyBatch(() => batchSetGroup(ids(), groupId))) setGroupModalOpen(false);
  };
  const handleBatchActive = async (active: boolean) => {
    const ok = window.confirm(
      active
        ? `Ativar ${countText}?`
        : `Desativar ${countText}? Os alertas abertos desses jovens serão resolvidos automaticamente.`,
    );
    if (ok) await applyBatch(() => batchSetActive(ids(), active));
  };
  const handleExport = () => {
    const items = [...selection.values()].sort((a, b) => a.full_name.localeCompare(b.full_name, 'pt-BR'));
    downloadCsv(
      `jovens-selecionados-${appToday()}.csv`,
      buildYouthCsv(items, (gid) => (gid && groupName.get(gid)) || 'Sem grupo'),
    );
    toast.success(n === 1 ? '1 jovem exportado.' : `${n} jovens exportados.`);
  };

  // Handlers
  // Deep link /jovens?ficha=<id> (atalho do Dashboard): abre a ficha mesmo que o jovem não esteja na página atual
  const sheetId = parseYouthSheetParam(searchParams.get('ficha'));
  const hasSheetParam = searchParams.has('ficha');
  useEffect(() => {
    if (!hasSheetParam) return;
    let cancelled = false;
    const clearParam = () => setSearchParams((p) => { const n = new URLSearchParams(p); n.delete('ficha'); return n; }, { replace: true });
    const open = async () => {
      let found: Youth | null = null;
      if (sheetId) {
        try {
          found = await fetchYouthById(sheetId);
        } catch (err) {
          if (cancelled) return;
          toast.error(errorMessage(err, 'Não foi possível abrir a ficha do jovem.'));
          clearParam();
          return;
        }
      }
      if (cancelled) return;
      if (found) {
        setSelectedYouth(found);
        setMode('view');
      } else {
        toast.error('Jovem não encontrado ou sem permissão para ver a ficha.');
        clearParam();
      }
    };
    void open();
    return () => { cancelled = true; };
  }, [sheetId, hasSheetParam, setSearchParams, toast]);

  const clearSheetParam = () => {
    if (!searchParams.has('ficha')) return;
    setSearchParams((p) => { const n = new URLSearchParams(p); n.delete('ficha'); return n; }, { replace: true });
  };

  const openCreate = () => { setSelectedYouth(null); setMode('create'); };
  const openView = (y: Youth) => { setSelectedYouth(y); setMode('view'); };
  const openEdit = () => setMode('edit');
  const closeModal = () => { setSelectedYouth(null); setMode('view'); clearSheetParam(); };

  const handleCreate = async (data: Omit<YouthInsert, 'created_by'> | YouthUpdate) => {
    setFormLoading(true);
    const result = await createYouth(data as Omit<YouthInsert, 'created_by'>);
    setFormLoading(false);
    if (result) { closeModal(); toast.success('Jovem cadastrado.'); }
  };

  const handleEdit = async (data: Omit<YouthInsert, 'created_by'> | YouthUpdate) => {
    if (!selectedYouth) return;
    setFormLoading(true);
    const result = await updateYouth(selectedYouth.id, data as YouthUpdate);
    setFormLoading(false);
    if (result) {
      notifyAlertsChanged(); // trocar grupo/ativar/inativar recalcula alertas no banco
      setSelectedYouth(result); setMode('view'); toast.success('Dados do jovem atualizados.');
    }
  };

  const handleToggleStatus = async () => {
    if (!selectedYouth) return;
    setActionLoading(true);
    const wasActive = selectedYouth.is_active;
    const ok = wasActive ? await deactivateYouth(selectedYouth.id) : await activateYouth(selectedYouth.id);
    if (ok) {
      notifyAlertsChanged(); // inativar/reativar abre ou resolve alertas no banco
      toast.success(wasActive ? 'Jovem desativado.' : 'Jovem reativado.');
    }
    setActionLoading(false);
    closeModal();
  };

  const openAnonymize = () => { clearError(); setMode('anonymize'); };
  const handleAnonymize = async () => {
    if (!selectedYouth) return;
    setActionLoading(true);
    const result = await anonymizeYouth(selectedYouth.id);
    setActionLoading(false);
    if (result) {
      setSituationVersion((v) => v + 1);
      closeModal();
      toast.success('Dados do jovem anonimizados.');
    }
  };

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
      <div className="bg-white border border-gray-200 rounded-card px-4 py-3 flex flex-col sm:flex-row sm:flex-wrap gap-3">
        <SearchInput value={search} onChange={setSearch} placeholder="Buscar por nome..." className="flex-1 sm:min-w-60" />
        <select
          value={groupFilter}
          onChange={(e) => setGroupFilter(e.target.value)}
          className="sm:w-44 px-3 py-2 text-sm border border-gray-300 rounded-control bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500"
          aria-label="Filtrar por grupo"
        >
          <option value="all">Todos os grupos</option>
          {groups.map((g) => (
            <option key={g.id} value={g.id}>{g.name}</option>
          ))}
          {role === 'coordinator' && <option value="none">Sem grupo</option>}
        </select>
        <div className="flex rounded-control border border-gray-300 overflow-hidden text-sm">
          {(['all', 'active', 'inactive'] as YouthStatusFilter[]).map((f) => (
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
        <div className="flex items-center gap-2 text-sm text-red-700 bg-red-50 border border-red-200 rounded-control px-4 py-3">
          <AlertCircle className="w-4 h-4 flex-shrink-0" />
          {error}
        </div>
      )}

      {/* Loading */}
      {loading && youth.length === 0 && <LoadingBlock />}

      {/* Empty */}
      {!loading && !error && youth.length === 0 && (
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
      {youth.length > 0 && (
        <div className={cn('hidden lg:block bg-white border border-gray-200 rounded-card overflow-x-auto transition-opacity', loading && 'opacity-60')} aria-busy={loading}>
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-200 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">
                {canEdit && (
                  <th className="pl-4 pr-0 py-2 w-10">
                    <input
                      ref={selectAllRef}
                      type="checkbox"
                      checked={allPageSelected}
                      onChange={toggleAllPage}
                      aria-label="Selecionar todos da página"
                      data-testid="lote-selecionar-pagina"
                      className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                    />
                  </th>
                )}
                <th className="px-4 py-2">Jovem</th>
                <th className="px-4 py-2">Grupo</th>
                <th className="px-4 py-2">Contato</th>
                <th className="px-4 py-2">Status</th>
                <th className="px-4 py-2">Situação</th>
                <th className="px-4 py-2 text-right">Ações</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {youth.map((y) => (
                <tr key={y.id} className={cn('hover:bg-gray-50 transition-colors', selection.has(y.id) && 'bg-blue-50')}>
                  {canEdit && (
                    <td className="pl-4 pr-0 py-3 w-10">
                      <input
                        type="checkbox"
                        checked={selection.has(y.id)}
                        onChange={() => toggleOne(y)}
                        aria-label={`Selecionar ${y.full_name}`}
                        data-testid="lote-selecionar"
                        className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                      />
                    </td>
                  )}
                  <td className="px-4 py-3">
                    <button onClick={() => openView(y)} className="flex items-center gap-3 text-left">
                      <div className="flex-shrink-0 w-9 h-9 rounded-full bg-blue-50 text-blue-700 font-semibold text-sm flex items-center justify-center uppercase">
                        {y.full_name.charAt(0)}
                      </div>
                      <span className="font-medium text-gray-900">{y.full_name}</span>
                    </button>
                  </td>
                  <td className="px-4 py-3 text-gray-600">{(y.group_id && groupName.get(y.group_id)) || 'Sem grupo'}</td>
                  <td className="px-4 py-3 text-gray-600 whitespace-nowrap">{y.phone ?? y.email ?? '—'}</td>
                  <td className="px-4 py-3">
                    <Badge color={y.is_active ? 'green' : 'gray'}>{y.is_active ? 'Ativo' : 'Inativo'}</Badge>
                  </td>
                  <td className="px-4 py-3">{situationCell(y)}</td>
                  <td className="px-4 py-3 text-right">
                    <button onClick={() => openView(y)} className="p-1.5 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-control transition-colors">
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
      {youth.length > 0 && canEdit && (
        <label className="lg:hidden flex items-center gap-3 px-1 text-sm text-gray-700">
          <input
            ref={selectAllRef}
            type="checkbox"
            checked={allPageSelected}
            onChange={toggleAllPage}
            data-testid="lote-selecionar-pagina-mobile"
            className="h-5 w-5 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
          />
          Selecionar todos da página
        </label>
      )}
      {youth.length > 0 && (
        <ul className={cn('lg:hidden bg-white rounded-card border border-gray-200 divide-y divide-gray-100 overflow-hidden transition-opacity', loading && 'opacity-60')} aria-busy={loading}>
          {youth.map((y) => (
            <li key={y.id} className={cn('flex items-stretch', selection.has(y.id) && 'bg-blue-50')}>
              {canEdit && (
                <label className="flex items-center pl-4 pr-1 cursor-pointer" aria-label={`Selecionar ${y.full_name}`}>
                  <input
                    type="checkbox"
                    checked={selection.has(y.id)}
                    onChange={() => toggleOne(y)}
                    data-testid="lote-selecionar"
                    className="h-5 w-5 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                  />
                </label>
              )}
              <button
                onClick={() => openView(y)}
                className="flex-1 min-w-0 flex items-center gap-3 px-3 py-3 hover:bg-gray-50 transition-colors text-left"
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
                {/* Situação + status */}
                <div className="flex items-center gap-2 flex-shrink-0">
                  {situationCell(y)}
                  {y.is_active ? (
                    <UserCheck className="w-4 h-4 text-green-500" aria-label="Ativo" />
                  ) : (
                    <UserX className="w-4 h-4 text-gray-400" aria-label="Inativo" />
                  )}
                  <ChevronRight className="w-4 h-4 text-gray-300" aria-hidden="true" />
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}

      <RefreshingNote show={loading && youth.length > 0} />

      {situationsError && youth.length > 0 && (
        <p role="status" className="text-xs text-gray-500">A situação dos jovens não pôde ser carregada agora. A lista continua disponível.</p>
      )}

      <Pagination page={page} totalPages={totalPages} total={total} pageSize={pageSize} onPageChange={setPage} noun={total === 1 ? 'jovem' : 'jovens'} disabled={loading} />

      {n > 0 && canEdit && (
        <BatchBar
          count={n}
          busy={batchBusy}
          atLimit={n >= BATCH_MAX}
          error={batchFailed && !groupModalOpen ? error : null}
          onChangeGroup={openGroupModal}
          onActivate={() => handleBatchActive(true)}
          onDeactivate={() => handleBatchActive(false)}
          onExport={handleExport}
          onClear={() => setSelection(NO_SELECTION)}
        />
      )}

      {/* Modal: Alterar grupo em lote */}
      {groupModalOpen && (
        <Modal title="Alterar grupo" onClose={() => setGroupModalOpen(false)}>
          <BatchGroupForm
            count={n}
            groups={groups}
            loading={batchBusy}
            error={batchFailed ? error : null}
            onSubmit={handleBatchGroup}
            onCancel={() => setGroupModalOpen(false)}
          />
        </Modal>
      )}

      {/* Modal: Visualização */}
      {selectedYouth && mode === 'view' && (
        <Modal title="Detalhes do Jovem" onClose={closeModal} size="lg">
          <YouthDetail
            youth={selectedYouth}
            groupName={(selectedYouth.group_id && groupName.get(selectedYouth.group_id)) || null}
            canEdit={canEdit}
            onCreateTask={() => navigate(`/tarefas?novo=1&jovem=${selectedYouth.id}`)}
            onEdit={openEdit}
            onToggleStatus={handleToggleStatus}
            onClose={closeModal}
            actionLoading={actionLoading}
            onDataChanged={() => setSituationVersion((v) => v + 1)}
            onAnonymize={role === 'coordinator' && !isAnonymizedYouth(selectedYouth.full_name) ? openAnonymize : undefined}
          />
        </Modal>
      )}

      {/* Modal: Anonimizar (só coordenador; irreversível) */}
      {selectedYouth && mode === 'anonymize' && role === 'coordinator' && (
        <Modal title="Anonimizar dados" onClose={() => { clearError(); setMode('view'); }}>
          <AnonymizeYouthForm
            youthName={selectedYouth.full_name}
            loading={actionLoading}
            error={error}
            onConfirm={handleAnonymize}
            onCancel={() => { clearError(); setMode('view'); }}
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
