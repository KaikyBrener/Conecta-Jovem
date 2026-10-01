import { useState, useEffect, useCallback } from 'react';
import { UserPlus, UserMinus, Loader2, AlertCircle } from 'lucide-react';
import type { Youth } from '../../types/database.types';

interface GroupMembersProps {
  groupId: string;
  isCoordinator: boolean;
  fetchMembers: (id: string) => Promise<Youth[]>;
  fetchUnassigned: () => Promise<Youth[]>;
  onAssign: (youthId: string, groupId: string) => Promise<boolean>;
  onRemove: (youthId: string) => Promise<boolean>;
}

export function GroupMembers({
  groupId,
  isCoordinator,
  fetchMembers,
  fetchUnassigned,
  onAssign,
  onRemove,
}: GroupMembersProps) {
  const [members, setMembers] = useState<Youth[]>([]);
  const [unassigned, setUnassigned] = useState<Youth[]>([]);
  const [loadingMembers, setLoadingMembers] = useState(true);
  const [actionId, setActionId] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);

  const load = useCallback(async () => {
    setLoadingMembers(true);
    const [m, u] = await Promise.all([fetchMembers(groupId), fetchUnassigned()]);
    setMembers(m);
    setUnassigned(u);
    setLoadingMembers(false);
  }, [groupId, fetchMembers, fetchUnassigned]);

  useEffect(() => {
    let cancelled = false;
    // loadingMembers já inicia como true — não precisamos chamar setState aqui
    Promise.all([fetchMembers(groupId), fetchUnassigned()]).then(([m, u]) => {
      if (cancelled) return;
      setMembers(m);
      setUnassigned(u);
      setLoadingMembers(false);
    });
    return () => { cancelled = true; };
  }, [groupId, fetchMembers, fetchUnassigned]);

  const handleAssign = async (youthId: string) => {
    setErr(null);
    setActionId(youthId);
    const ok = await onAssign(youthId, groupId);
    if (!ok) setErr('Não foi possível adicionar o jovem.');
    await load();
    setActionId(null);
  };

  const handleRemove = async (youthId: string) => {
    setErr(null);
    setActionId(youthId);
    const ok = await onRemove(youthId);
    if (!ok) setErr('Não foi possível remover o jovem.');
    await load();
    setActionId(null);
  };

  if (loadingMembers) {
    return (
      <div className="flex justify-center py-8">
        <Loader2 className="w-5 h-5 text-blue-600 animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {err && (
        <div className="flex items-center gap-2 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
          <AlertCircle className="w-4 h-4 flex-shrink-0" />
          {err}
        </div>
      )}

      {/* Lista de integrantes */}
      <div>
        <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
          Integrantes
          <span className="ml-1.5 inline-flex items-center justify-center min-w-5 h-5 px-1.5 rounded-full bg-gray-100 text-gray-600 text-[11px] font-semibold normal-case">
            {members.length}
          </span>
        </h4>
        {members.length === 0 ? (
          <p className="text-sm text-gray-400 py-3 text-center border border-dashed border-gray-200 rounded-lg">Nenhum integrante ainda.</p>
        ) : (
          <ul className="divide-y divide-gray-100 rounded-lg border border-gray-200 bg-white overflow-hidden">
            {members.map((y) => (
              <li key={y.id} className="flex items-center justify-between px-4 py-2.5 hover:bg-gray-50 transition-colors">
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 rounded-full bg-blue-50 text-blue-700 font-semibold text-xs flex items-center justify-center uppercase">
                    {y.full_name.charAt(0)}
                  </div>
                  <div>
                    <p className="text-sm font-medium text-gray-900">{y.full_name}</p>
                    {!y.is_active && (
                      <span className="inline-block mt-0.5 px-1.5 py-0.5 rounded bg-gray-100 text-gray-500 text-[10px] font-medium">Inativo</span>
                    )}
                  </div>
                </div>
                <button
                  onClick={() => handleRemove(y.id)}
                  disabled={actionId === y.id}
                  className="text-red-500 hover:text-red-700 hover:bg-red-50 disabled:opacity-40 p-1.5 rounded-md transition-colors"
                  title="Remover do grupo"
                >
                  {actionId === y.id
                    ? <Loader2 className="w-4 h-4 animate-spin" />
                    : <UserMinus className="w-4 h-4" />}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Adicionar jovem sem grupo (somente coordenador: a RLS de youth não permite
          que o líder atribua a si um jovem cujo group_id atual não é um dos seus
          grupos — leader_update_youth exige que o grupo ATUAL já pertença a ele) */}
      {isCoordinator && (
        <div className="pt-2 border-t border-gray-100">
          <button
            onClick={() => setShowAdd((s) => !s)}
            className="flex items-center gap-2 text-sm font-medium text-blue-600 hover:text-blue-700"
          >
            <UserPlus className="w-4 h-4" />
            {showAdd ? 'Ocultar jovens disponíveis' : 'Adicionar jovem ao grupo'}
          </button>

          {showAdd && (
            <div className="mt-2">
              {unassigned.length === 0 ? (
                <p className="text-sm text-gray-400 py-2 text-center border border-dashed border-gray-200 rounded-lg">
                  Todos os jovens ativos já estão em grupos.
                </p>
              ) : (
                <ul className="divide-y divide-gray-100 rounded-lg border border-gray-200 bg-white overflow-hidden">
                  {unassigned.map((y) => (
                    <li key={y.id} className="flex items-center justify-between px-4 py-2.5 hover:bg-gray-50 transition-colors">
                      <p className="text-sm text-gray-900">{y.full_name}</p>
                      <button
                        onClick={() => handleAssign(y.id)}
                        disabled={actionId === y.id}
                        className="text-green-600 hover:text-green-800 hover:bg-green-50 disabled:opacity-40 p-1.5 rounded-md transition-colors"
                        title="Adicionar ao grupo"
                      >
                        {actionId === y.id
                          ? <Loader2 className="w-4 h-4 animate-spin" />
                          : <UserPlus className="w-4 h-4" />}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
