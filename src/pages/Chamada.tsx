import { useState, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useAttendance, type AttendanceState } from '../hooks/useAttendance';
import { useAuth } from '../contexts/AuthContext';
import { formatDateTime } from '../lib/format';
import { ArrowLeft, Users, CheckCircle2, Circle, AlertCircle, Loader2 } from 'lucide-react';
import { SearchInput } from '../components/ui/SearchInput';
import { LoadingBlock } from '../components/ui/LoadingBlock';

export function Chamada() {
  const { id: eventId } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const { role } = useAuth();
  const isCoordinator = role === 'coordinator';
  const { loading, error, event, attendanceMap, groups, savedCount, saveAttendance, markEventCompleted } = useAttendance(eventId!);

  // Alterações locais (youth_id -> presente) sobrepostas ao que veio do banco
  const [edits, setEdits] = useState<Record<string, boolean>>({});
  const [saving, setSaving] = useState(false);
  const [markCompleted, setMarkCompleted] = useState(true);
  const isCancelled = event?.status === 'cancelled';

  const localMap = useMemo(() => {
    const merged: Record<string, AttendanceState> = {};
    for (const [id, st] of Object.entries(attendanceMap)) {
      merged[id] = id in edits ? { ...st, present: edits[id] } : st;
    }
    return merged;
  }, [attendanceMap, edits]);
  
  // Filters
  const [search, setSearch] = useState('');
  const [groupFilter, setGroupFilter] = useState<string>('all');

  const handleToggle = (youthId: string) => {
    if (isCancelled) return;
    setEdits(prev => ({ ...prev, [youthId]: !localMap[youthId].present }));
  };

  const youthList = useMemo(() => Object.values(localMap), [localMap]);
  
  const filteredList = useMemo(() => {
    return youthList.filter(y => {
      const matchSearch = y.full_name.toLowerCase().includes(search.toLowerCase());
      const matchGroup = groupFilter === 'all' || y.group_id === groupFilter;
      return matchSearch && matchGroup;
    }).sort((a, b) => a.full_name.localeCompare(b.full_name));
  }, [youthList, search, groupFilter]);

  const markAllVisible = () => {
    setEdits(prev => {
      const next = { ...prev };
      for (const y of filteredList) next[y.youth_id] = true;
      return next;
    });
  };

  const handleSave = async () => {
    setSaving(true);
    // CRÍTICA: salvar considera TODAS as marcações (youthList), não apenas filteredList
    let ok = await saveAttendance(youthList);
    if (ok && isCoordinator && markCompleted && event?.status === 'scheduled') {
      ok = await markEventCompleted();
    }
    setSaving(false);
    if (ok) {
      navigate('/encontros');
    }
  };

  const presentCount = youthList.filter(y => y.present).length;
  const totalCount = youthList.length;

  if (loading) {
    return <LoadingBlock />;
  }

  if (!event) {
    return (
      <div className="text-center py-16">
        <p className="text-gray-500">Encontro não encontrado ou sem permissão.</p>
        <button onClick={() => navigate('/encontros')} className="mt-4 text-blue-600 hover:underline">
          Voltar
        </button>
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center gap-4">
        <button
          onClick={() => navigate('/encontros')}
          className="p-2 -ml-2 text-gray-400 hover:text-gray-600 rounded-full hover:bg-gray-100"
        >
          <ArrowLeft className="w-5 h-5" />
        </button>
        <div>
          <h2 className="text-xl font-semibold text-gray-900 leading-tight">Chamada</h2>
          <p className="text-sm text-gray-500">{event.title} · {formatDateTime(event.event_date)}</p>
          {savedCount > 0 && (
            <p className="text-xs text-green-700 mt-0.5">Chamada já registrada — você está editando.</p>
          )}
        </div>
      </div>

      {error && (
        <div className="flex items-center gap-2 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-4 py-3">
          <AlertCircle className="w-4 h-4 flex-shrink-0" />
          {error}
        </div>
      )}

      {isCancelled && (
        <div className="flex items-center gap-2 text-sm text-gray-700 bg-gray-100 border border-gray-200 rounded-lg px-4 py-3">
          <AlertCircle className="w-4 h-4 flex-shrink-0" />
          Este encontro foi cancelado. A chamada não pode ser alterada e não conta na frequência.
        </div>
      )}

      {!isCancelled && groups.length === 0 && (
        <div className="text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-4 py-3">
          Nenhum grupo vinculado a este encontro. Edite o encontro e selecione os grupos participantes.
        </div>
      )}

      {/* Counters & Mark All */}
      <div className="flex flex-wrap items-center justify-between gap-4 bg-white p-4 rounded-xl border border-gray-200">
        <div className="flex items-center gap-3">
          <div className="w-12 h-12 rounded-full bg-blue-50 flex items-center justify-center">
            <Users className="w-6 h-6 text-blue-600" />
          </div>
          <div>
            <p className="text-sm text-gray-500">Total Presentes</p>
            <p className="text-2xl font-bold text-gray-900 leading-none">
              {presentCount} <span className="text-sm font-medium text-gray-400">/ {totalCount}</span>
            </p>
          </div>
        </div>
        <button
          onClick={markAllVisible}
          disabled={filteredList.length === 0 || isCancelled}
          className="px-4 py-2 text-sm font-medium text-blue-700 bg-blue-50 hover:bg-blue-100 rounded-lg disabled:opacity-50 transition-colors"
        >
          Marcar todos (visíveis)
        </button>
      </div>

      {/* Filters */}
      <div className="bg-white border border-gray-200 rounded-xl px-4 py-3 flex flex-col sm:flex-row gap-3">
        <SearchInput value={search} onChange={setSearch} placeholder="Buscar jovem..." className="flex-1" />
        <select
          value={groupFilter}
          onChange={(e) => setGroupFilter(e.target.value)}
          className="sm:w-48 px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500"
        >
          <option value="all">Todos os grupos</option>
          {groups.map(g => (
            <option key={g.id} value={g.id}>{g.name}</option>
          ))}
        </select>
      </div>

      {/* List */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        {filteredList.length === 0 ? (
          <div className="p-8 text-center text-gray-500 text-sm">
            Nenhum jovem encontrado com os filtros atuais.
          </div>
        ) : (
          <ul className="divide-y divide-gray-100">
            {filteredList.map(y => (
              <li
                key={y.youth_id}
                onClick={() => handleToggle(y.youth_id)}
                className="flex items-center justify-between px-4 py-3 hover:bg-gray-50 cursor-pointer transition-colors select-none"
              >
                <div>
                  <p className="text-sm font-medium text-gray-900">{y.full_name}</p>
                  <p className="text-xs text-gray-500">{groups.find(g => g.id === y.group_id)?.name}</p>
                </div>
                <div className="flex-shrink-0 ml-4">
                  {y.present ? (
                    <CheckCircle2 className="w-6 h-6 text-green-500" />
                  ) : (
                    <Circle className="w-6 h-6 text-gray-300" />
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Save action */}
      <div className="sticky bottom-20 md:bottom-auto pt-4 flex flex-col md:flex-row md:items-center md:justify-end gap-3">
        {isCoordinator && event.status === 'scheduled' && !isCancelled && (
          <label className="flex items-center gap-2 text-sm text-gray-700 bg-white/90 rounded-lg px-2 py-1">
            <input
              type="checkbox"
              checked={markCompleted}
              onChange={(e) => setMarkCompleted(e.target.checked)}
              className="h-4 w-4 text-blue-600 rounded border-gray-300"
            />
            Marcar encontro como realizado
          </label>
        )}
        <button
          onClick={handleSave}
          disabled={saving || youthList.length === 0 || isCancelled}
          className="w-full md:w-auto px-6 py-3 text-sm font-medium text-white bg-blue-600 rounded-xl hover:bg-blue-700 disabled:opacity-50 shadow-lg shadow-blue-200 transition-colors flex items-center justify-center gap-2"
        >
          {saving ? (
            <><Loader2 className="w-4 h-4 animate-spin" /> Salvando...</>
          ) : (
            'Salvar Chamada'
          )}
        </button>
      </div>
    </div>
  );
}
