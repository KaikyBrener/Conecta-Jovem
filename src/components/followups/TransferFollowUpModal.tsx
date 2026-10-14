import { useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { useToast } from '../../contexts/ToastContext';
import { useAssignableResponsibles, useFollowUpMutations, type FollowUpWithRelations } from '../../hooks/useFollowUps';
import { Modal } from '../Modal';
import { ErrorBanner } from '../ErrorBanner';
import { personName } from '../../lib/followups';
import { formErrorCls, inputCls, labelCls, primaryBtnCls, secondaryBtnCls } from '../../lib/formStyles';

interface TransferFollowUpModalProps {
  followUp: FollowUpWithRelations;
  youthName: string;
  /** id -> nome já conhecidos (para mostrar o responsável atual) */
  names: ReadonlyMap<string, string>;
  userId: string | null;
  onClose: () => void;
  onSaved: () => void;
}

/** Troca o responsável de um acompanhamento (motivo obrigatório); grava o histórico pela RPC. */
export function TransferFollowUpModal({ followUp, youthName, names, userId, onClose, onSaved }: TransferFollowUpModalProps) {
  const toast = useToast();
  const mutations = useFollowUpMutations();
  const responsibles = useAssignableResponsibles(followUp.youth_id);
  const [target, setTarget] = useState('');
  const [reason, setReason] = useState('');
  const [err, setErr] = useState('');
  const [saving, setSaving] = useState(false);

  // Só quem ainda não é o responsável atual
  const options = useMemo(
    () => responsibles.data.filter((r) => r.id !== followUp.responsible_id),
    [responsibles.data, followUp.responsible_id],
  );

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setErr('');
    mutations.clearError();
    if (!target) { setErr('Selecione o novo responsável.'); return; }
    if (!reason.trim()) { setErr('Informe o motivo da transferência.'); return; }
    setSaving(true);
    const ok = await mutations.transferFollowUp(followUp.id, target, reason);
    setSaving(false);
    if (!ok) return;
    toast.success('Responsável transferido.');
    onSaved();
    onClose();
  };

  return (
    <Modal title="Transferir responsável" onClose={onClose}>
      <form onSubmit={handleSubmit} className="space-y-4" aria-label="Transferir responsável">
        <p className="text-sm text-gray-600">
          Acompanhamento de <strong className="text-gray-900">{youthName}</strong>
          <span className="block text-xs text-gray-500">
            Responsável atual: {personName(followUp.responsible_id, names, userId)}
          </span>
        </p>
        {err && <p role="alert" className={formErrorCls}>{err}</p>}
        <ErrorBanner message={mutations.error ?? responsibles.error} />

        <div>
          <label className={labelCls} htmlFor="tr-target">Novo responsável *</label>
          <select id="tr-target" value={target} onChange={(e) => setTarget(e.target.value)} className={inputCls}>
            <option value="">{responsibles.loading ? 'Carregando...' : 'Selecione...'}</option>
            {options.map((r) => (
              <option key={r.id} value={r.id}>
                {(r.full_name ?? 'Sem nome') + (r.role === 'coordinator' ? ' · Coordenador' : ' · Líder do grupo')}
              </option>
            ))}
          </select>
          {!responsibles.loading && options.length === 0 && (
            <p className="mt-1 text-xs text-gray-500">Não há outra pessoa disponível: só coordenadores e o líder do grupo do jovem podem assumir.</p>
          )}
        </div>

        <div>
          <label className={labelCls} htmlFor="tr-reason">Motivo da transferência *</label>
          <textarea
            id="tr-reason" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} className={inputCls}
            placeholder="Ex.: O jovem mudou de grupo."
          />
          <p className="mt-1 text-xs text-gray-400">O histórico da transferência fica registrado e não pode ser alterado.</p>
        </div>

        <div className="flex flex-col-reverse gap-2 border-t border-line-soft pt-4 sm:flex-row sm:justify-end sm:gap-3">
          <button type="button" onClick={onClose} className={secondaryBtnCls}>Cancelar</button>
          <button type="submit" disabled={saving} className={primaryBtnCls}>
            {saving ? 'Transferindo...' : 'Transferir'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
