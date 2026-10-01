import { useState } from 'react';
import type { Youth, YouthInsert, YouthUpdate, Gender, GroupRef } from '../../types/database.types';
import { inputCls, labelCls, primaryBtnCls, secondaryBtnCls, formErrorCls } from '../../lib/formStyles';

type FormData = {
  full_name: string;
  birth_date: string;
  gender: Gender | '';
  phone: string;
  email: string;
  address: string;
  notes: string;
  is_active: boolean;
  group_id: string;
};

interface YouthFormProps {
  initial?: Youth | null;
  /** Grupos disponíveis; só coordenadores podem escolher/trocar o grupo */
  groups?: GroupRef[];
  canChangeGroup?: boolean;
  onSubmit: (data: Omit<YouthInsert, 'created_by'> | YouthUpdate) => Promise<void>;
  onCancel: () => void;
  loading: boolean;
}

const EMPTY: FormData = {
  full_name: '',
  birth_date: '',
  gender: '',
  phone: '',
  email: '',
  address: '',
  notes: '',
  is_active: true,
  group_id: '',
};

function toFormData(y: Youth): FormData {
  return {
    full_name: y.full_name,
    birth_date: y.birth_date ?? '',
    gender: y.gender ?? '',
    phone: y.phone ?? '',
    email: y.email ?? '',
    address: y.address ?? '',
    notes: y.notes ?? '',
    is_active: y.is_active,
    group_id: y.group_id ?? '',
  };
}

export function YouthForm({ initial, groups = [], canChangeGroup = false, onSubmit, onCancel, loading }: YouthFormProps) {
  const [form, setForm] = useState<FormData>(initial ? toFormData(initial) : EMPTY);
  const [error, setError] = useState('');

  const set = (field: keyof FormData, value: string | boolean) =>
    setForm((prev) => ({ ...prev, [field]: value }));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (!form.full_name.trim()) { setError('Nome é obrigatório.'); return; }
    const payload = {
      full_name: form.full_name.trim(),
      birth_date: form.birth_date || null,
      gender: (form.gender || null) as Gender | null,
      phone: form.phone.trim() || null,
      email: form.email.trim() || null,
      address: form.address.trim() || null,
      notes: form.notes.trim() || null,
      is_active: form.is_active,
    };
    // Só envia group_id quando o usuário pode alterá-lo; caso contrário preserva o grupo atual
    // (antes o formulário sempre enviava null e a edição removia o jovem do grupo).
    if (canChangeGroup) {
      await onSubmit({ ...payload, group_id: form.group_id || null });
    } else if (initial) {
      await onSubmit(payload);
    } else {
      await onSubmit({ ...payload, group_id: null });
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {error && <p className={formErrorCls}>{error}</p>}

      <div>
        <label className={labelCls}>Nome completo *</label>
        <input
          type="text"
          value={form.full_name}
          onChange={(e) => set('full_name', e.target.value)}
          className={inputCls}
          placeholder="Ex.: Maria Silva"
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className={labelCls}>Data de nascimento</label>
          <input
            type="date"
            value={form.birth_date}
            onChange={(e) => set('birth_date', e.target.value)}
            className={inputCls}
          />
        </div>
        <div>
          <label className={labelCls}>Gênero</label>
          <select
            value={form.gender}
            onChange={(e) => set('gender', e.target.value)}
            className={inputCls}
          >
            <option value="">Selecionar</option>
            <option value="male">Masculino</option>
            <option value="female">Feminino</option>
            <option value="other">Outro</option>
          </select>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className={labelCls}>Telefone</label>
          <input
            type="tel"
            value={form.phone}
            onChange={(e) => set('phone', e.target.value)}
            className={inputCls}
            placeholder="(00) 00000-0000"
          />
        </div>
        <div>
          <label className={labelCls}>E-mail</label>
          <input
            type="email"
            value={form.email}
            onChange={(e) => set('email', e.target.value)}
            className={inputCls}
            placeholder="email@exemplo.com"
          />
        </div>
      </div>

      {canChangeGroup && (
        <div>
          <label className={labelCls}>Grupo</label>
          <select
            value={form.group_id}
            onChange={(e) => set('group_id', e.target.value)}
            className={inputCls}
          >
            <option value="">Sem grupo</option>
            {groups.map((g) => (
              <option key={g.id} value={g.id}>{g.name}</option>
            ))}
          </select>
        </div>
      )}

      <div>
        <label className={labelCls}>Endereço</label>
        <input
          type="text"
          value={form.address}
          onChange={(e) => set('address', e.target.value)}
          className={inputCls}
          placeholder="Rua, número, bairro"
        />
      </div>

      <div>
        <label className={labelCls}>Observações</label>
        <textarea
          value={form.notes}
          onChange={(e) => set('notes', e.target.value)}
          rows={3}
          className={inputCls}
          placeholder="Informações adicionais..."
        />
      </div>

      {initial && (
        <div className="flex items-center gap-3">
          <button
            type="button"
            role="switch"
            aria-checked={form.is_active}
            onClick={() => set('is_active', !form.is_active)}
            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
              form.is_active ? 'bg-blue-600' : 'bg-gray-300'
            }`}
          >
            <span
              className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                form.is_active ? 'translate-x-6' : 'translate-x-1'
              }`}
            />
          </button>
          <span className="text-sm text-gray-700">{form.is_active ? 'Ativo' : 'Inativo'}</span>
        </div>
      )}

      <div className="flex justify-end gap-3 pt-2 border-t border-gray-100 mt-2">
        <button type="button" onClick={onCancel} className={secondaryBtnCls}>
          Cancelar
        </button>
        <button type="submit" disabled={loading} className={primaryBtnCls}>
          {loading ? 'Salvando...' : initial ? 'Salvar alterações' : 'Cadastrar'}
        </button>
      </div>
    </form>
  );
}
