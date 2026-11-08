import { useState, useEffect, useCallback } from 'react';
import { UserPlus, UserMinus, Loader2, AlertCircle } from 'lucide-react';
import type { Youth } from '../../types/database.types';
import { IconButton } from '../ui/IconButton';
import { Avatar } from '../ui/Avatar';

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
        <Loader2 className="w-5 h-5 text-action animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {err && (
        <div className="flex items-center gap-2 text-sm text-danger-ink bg-danger-soft border border-danger-line rounded-control px-3 py-2">
          <AlertCircle className="w-4 h-4 flex-shrink-0" />
          {err}
        </div>
      )}

      {/* Lista de integrantes */}
      <div>
        <h4 className="text-xs font-semibold text-ink-muted uppercase tracking-wide mb-2">
          Integrantes
          <span className="ml-1.5 inline-flex items-center justify-center min-w-5 h-5 px-1.5 rounded-full bg-surface-muted text-ink-soft text-xs font-semibold normal-case">
            {members.length}
          </span>
        </h4>
        {members.length === 0 ? (
          <p className="text-sm text-ink-faint py-3 text-center border border-dashed border-line rounded-control">Nenhum integrante ainda.</p>
        ) : (
          <ul className="divide-y divide-line-soft rounded-control border border-line bg-surface overflow-hidden">
            {members.map((y) => (
              <li key={y.id} className="flex items-center justify-between px-4 py-2.5 hover:bg-surface-hover transition-colors">
                <div className="flex items-center gap-3">
                  <Avatar name={y.full_name} size="sm" />
                  <div>
                    <p className="text-sm font-medium text-ink">{y.full_name}</p>
                    {!y.is_active && (
                      <span className="inline-block mt-0.5 px-1.5 py-0.5 rounded bg-surface-muted text-ink-muted text-xs font-medium">Inativo</span>
                    )}
                  </div>
                </div>
                <IconButton
                  label="Remover do grupo"
                  icon={UserMinus}
                  tone="danger"
                  busy={actionId === y.id}
                  onClick={() => handleRemove(y.id)}
                  disabled={actionId === y.id}
                />
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Adicionar jovem sem grupo (somente coordenador: a RLS de youth não permite
          que o líder atribua a si um jovem cujo group_id atual não é um dos seus
          grupos — leader_update_youth exige que o grupo ATUAL já pertença a ele) */}
      {isCoordinator && (
        <div className="pt-2 border-t border-line-soft">
          <button
            onClick={() => setShowAdd((s) => !s)}
            className="flex items-center gap-2 text-sm font-medium text-action hover:text-action-ink"
          >
            <UserPlus className="w-4 h-4" />
            {showAdd ? 'Ocultar jovens disponíveis' : 'Adicionar jovem ao grupo'}
          </button>

          {showAdd && (
            <div className="mt-2">
              {unassigned.length === 0 ? (
                <p className="text-sm text-ink-faint py-2 text-center border border-dashed border-line rounded-control">
                  Todos os jovens ativos já estão em grupos.
                </p>
              ) : (
                <ul className="divide-y divide-line-soft rounded-control border border-line bg-surface overflow-hidden">
                  {unassigned.map((y) => (
                    <li key={y.id} className="flex items-center justify-between px-4 py-2.5 hover:bg-surface-hover transition-colors">
                      <p className="text-sm text-ink">{y.full_name}</p>
                      <IconButton
                        label="Adicionar ao grupo"
                        icon={UserPlus}
                        tone="success"
                        busy={actionId === y.id}
                        onClick={() => handleAssign(y.id)}
                        disabled={actionId === y.id}
                      />
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
