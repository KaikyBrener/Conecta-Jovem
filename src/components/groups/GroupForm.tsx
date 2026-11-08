import { useState } from 'react';
import type { Group, GroupInsert, GroupUpdate } from '../../types/database.types';
import type { Profile } from '../../types/database.types';
import { formErrorCls } from '../../lib/formStyles';
import { Button } from '../ui/Button';
import { Field, Select, Textarea } from '../ui/Field';

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
      {err && <p className={formErrorCls} role="alert">{err}</p>}

      <Field
        label="Nome do grupo"
        mandatory
        type="text"
        value={form.name}
        onChange={(e) => set('name', e.target.value)}
        placeholder="Ex.: Grupo Esperança"
      />

      {isCoordinator ? (
        <Select label="Líder responsável" mandatory value={form.leader_id} onChange={(e) => set('leader_id', e.target.value)}>
          <option value="">Selecionar líder</option>
          {leaders.map((l) => (
            <option key={l.id} value={l.id}>
              {l.full_name}
            </option>
          ))}
        </Select>
      ) : (
        <Field
          label="Líder responsável"
          mandatory
          type="text"
          value={leaders.find((l) => l.id === currentUserId)?.full_name ?? 'Você'}
          disabled
          readOnly
        />
      )}

      <Textarea
        label="Descrição"
        value={form.description}
        onChange={(e) => set('description', e.target.value)}
        rows={3}
        placeholder="Informações adicionais sobre o grupo..."
      />

      <div className="flex flex-col-reverse gap-2 border-t border-line-soft pt-4 mt-2 sm:flex-row sm:justify-end sm:gap-3">
        <Button onClick={onCancel}>Cancelar</Button>
        <Button type="submit" variant="primary" disabled={loading}>
          {loading ? 'Salvando...' : initial ? 'Salvar alterações' : 'Criar grupo'}
        </Button>
      </div>
    </form>
  );
}
