import { useState } from 'react';
import type { Group, GroupInsert, GroupUpdate } from '../../types/database.types';
import type { Profile } from '../../types/database.types';
import { inputCls, labelCls, primaryBtnCls, secondaryBtnCls, formErrorCls } from '../../lib/formStyles';

interface GroupFormProps {
  initial?: Group | null;
  leaders: Profile[];
  currentUserId: string;
  isCoordinator: boolean;
  onSubmit: (data: GroupInsert | GroupUpdate) => Promise<void>;
  onCancel: () => void;
  loading: boolean;
}

type FormData = {
  name: string;
  leader_id: string;
  description: string;
};

function toFormData(g: Group): FormData {
  return {
    name: g.name,
    leader_id: g.leader_id,
    description: g.description ?? '',
  };
}

const EMPTY: FormData = { name: '', leader_id: '', description: '' };

export function GroupForm({
  initial,
  leaders,
  currentUserId,
  isCoordinator,
  onSubmit,
  onCancel,
  loading,
}: GroupFormProps) {
  const [form, setForm] = useState<FormData>(
    initial ? toFormData(initial) : { ...EMPTY, leader_id: isCoordinator ? '' : currentUserId }
  );
  const [err, setErr] = useState('');

  // Líder não pode trocar o líder — será fixado no submit ou na inicialização


  const set = (field: keyof FormData, value: string) =>
    setForm((prev) => ({ ...prev, [field]: value }));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr('');
    if (!form.name.trim()) { setErr('Nome é obrigatório.'); return; }
    if (!form.leader_id) { setErr('Líder responsável é obrigatório.'); return; }

    const payload = {
      name: form.name.trim(),
      leader_id: form.leader_id,
      description: form.description.trim() || null,
    };
    await onSubmit(payload);
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {err && <p className={formErrorCls}>{err}</p>}

      <div>
        <label className={labelCls}>Nome do grupo *</label>
        <input
          type="text"
          value={form.name}
          onChange={(e) => set('name', e.target.value)}
          className={inputCls}
          placeholder="Ex.: Grupo Esperança"
        />
      </div>

      <div>
        <label className={labelCls}>Líder responsável *</label>
        {isCoordinator ? (
          <select
            value={form.leader_id}
            onChange={(e) => set('leader_id', e.target.value)}
            className={inputCls}
          >
            <option value="">Selecionar líder</option>
            {leaders.map((l) => (
              <option key={l.id} value={l.id}>
                {l.full_name}
              </option>
            ))}
          </select>
        ) : (
          <input
            type="text"
            value={leaders.find((l) => l.id === currentUserId)?.full_name ?? 'Você'}
            disabled
            className={`${inputCls} bg-gray-50 text-gray-500 cursor-not-allowed`}
          />
        )}
      </div>

      <div>
        <label className={labelCls}>Descrição</label>
        <textarea
          value={form.description}
          onChange={(e) => set('description', e.target.value)}
          rows={3}
          className={inputCls}
          placeholder="Informações adicionais sobre o grupo..."
        />
      </div>

      <div className="flex justify-end gap-3 pt-2 border-t border-gray-100 mt-2">
        <button type="button" onClick={onCancel} className={secondaryBtnCls}>
          Cancelar
        </button>
        <button type="submit" disabled={loading} className={primaryBtnCls}>
          {loading ? 'Salvando...' : initial ? 'Salvar alterações' : 'Criar grupo'}
        </button>
      </div>
    </form>
  );
}
