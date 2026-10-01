import { useState } from 'react';
import type { EventInsert, EventUpdate, EventStatus, Group } from '../../types/database.types';
import type { EventWithGroups } from '../../hooks/useEvents';
import { inputCls, labelCls, primaryBtnCls, secondaryBtnCls, formErrorCls } from '../../lib/formStyles';

interface EventFormProps {
  initial?: EventWithGroups | null;
  allGroups: Group[];
  onSubmit: (payload: Omit<EventInsert, 'created_by'> | EventUpdate, groupIds: string[]) => Promise<void>;
  onCancel: () => void;
  loading: boolean;
}

type FormData = {
  title: string;
  description: string;
  event_date: string; // datetime-local value
  status: EventStatus;
};

const STATUS_LABEL: Record<EventStatus, string> = {
  scheduled: 'Agendado',
  completed: 'Realizado',
  cancelled: 'Cancelado',
};

function toLocalDatetime(iso: string): string {
  // Remove timezone offset for datetime-local input
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function toFormData(ev: EventWithGroups): FormData {
  return {
    title: ev.title,
    description: ev.description ?? '',
    event_date: toLocalDatetime(ev.event_date),
    status: ev.status,
  };
}

const EMPTY: FormData = {
  title: '',
  description: '',
  event_date: '',
  status: 'scheduled',
};

export function EventForm({ initial, allGroups, onSubmit, onCancel, loading }: EventFormProps) {
  const [form, setForm] = useState<FormData>(initial ? toFormData(initial) : EMPTY);
  const [selectedGroups, setSelectedGroups] = useState<string[]>(initial?.group_ids ?? []);
  const [err, setErr] = useState('');

  const set = <K extends keyof FormData>(field: K, value: FormData[K]) =>
    setForm((prev) => ({ ...prev, [field]: value }));

  const toggleGroup = (id: string) =>
    setSelectedGroups((prev) =>
      prev.includes(id) ? prev.filter((g) => g !== id) : [...prev, id]
    );

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr('');
    if (!form.title.trim()) { setErr('Título é obrigatório.'); return; }
    if (!form.event_date) { setErr('Data e hora são obrigatórias.'); return; }

    const payload = {
      title: form.title.trim(),
      description: form.description.trim() || null,
      event_date: new Date(form.event_date).toISOString(),
      status: form.status,
    };
    await onSubmit(payload, selectedGroups);
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {err && <p className={formErrorCls}>{err}</p>}

      <div>
        <label className={labelCls}>Título *</label>
        <input
          type="text"
          value={form.title}
          onChange={(e) => set('title', e.target.value)}
          className={inputCls}
          placeholder="Ex.: Encontro Mensal de Líderes"
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className={labelCls}>Data e hora *</label>
          <input
            type="datetime-local"
            value={form.event_date}
            onChange={(e) => set('event_date', e.target.value)}
            className={inputCls}
          />
        </div>
        <div>
          <label className={labelCls}>Status</label>
          <select
            value={form.status}
            onChange={(e) => set('status', e.target.value as EventStatus)}
            className={inputCls}
          >
            {(Object.keys(STATUS_LABEL) as EventStatus[]).map((s) => (
              <option key={s} value={s}>{STATUS_LABEL[s]}</option>
            ))}
          </select>
        </div>
      </div>

      <div>
        <label className={labelCls}>Descrição</label>
        <textarea
          value={form.description}
          onChange={(e) => set('description', e.target.value)}
          rows={3}
          className={inputCls}
          placeholder="Informações adicionais sobre o encontro..."
        />
      </div>

      {/* Seleção de grupos participantes */}
      <div>
        <label className={labelCls}>Grupos participantes</label>
        {allGroups.length === 0 ? (
          <p className="mt-1 text-sm text-gray-400">Nenhum grupo cadastrado.</p>
        ) : (
          <div className="mt-2 space-y-2 max-h-48 overflow-y-auto border border-gray-200 rounded-lg p-3">
            {allGroups.map((g) => (
              <label key={g.id} className="flex items-center gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={selectedGroups.includes(g.id)}
                  onChange={() => toggleGroup(g.id)}
                  className="h-4 w-4 text-blue-600 rounded border-gray-300 focus:ring-blue-500"
                />
                <span className="text-sm text-gray-800">{g.name}</span>
              </label>
            ))}
          </div>
        )}
      </div>

      <div className="flex justify-end gap-3 pt-2 border-t border-gray-100 mt-2">
        <button type="button" onClick={onCancel} className={secondaryBtnCls}>
          Cancelar
        </button>
        <button type="submit" disabled={loading} className={primaryBtnCls}>
          {loading ? 'Salvando...' : initial ? 'Salvar alterações' : 'Criar encontro'}
        </button>
      </div>
    </form>
  );
}
