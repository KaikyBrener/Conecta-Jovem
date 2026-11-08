import { useState } from 'react';
import type { EventInsert, EventUpdate, EventStatus, Group } from '../../types/database.types';
import type { EventWithGroups } from '../../hooks/useEvents';
import { formErrorCls, labelCls } from '../../lib/formStyles';
import { Button } from '../ui/Button';
import { Field, Select, Textarea } from '../ui/Field';

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
      {err && <p className={formErrorCls} role="alert">{err}</p>}

      <Field
        label="Título"
        mandatory
        type="text"
        value={form.title}
        onChange={(e) => set('title', e.target.value)}
        placeholder="Ex.: Encontro Mensal de Líderes"
      />

      <div className="grid grid-cols-2 gap-3">
        <Field
          label="Data e hora"
          mandatory
          type="datetime-local"
          value={form.event_date}
          onChange={(e) => set('event_date', e.target.value)}
        />
        <Select label="Status" value={form.status} onChange={(e) => set('status', e.target.value as EventStatus)}>
          {(Object.keys(STATUS_LABEL) as EventStatus[]).map((s) => (
            <option key={s} value={s}>{STATUS_LABEL[s]}</option>
          ))}
        </Select>
      </div>

      <Textarea
        label="Descrição"
        value={form.description}
        onChange={(e) => set('description', e.target.value)}
        rows={3}
        placeholder="Informações adicionais sobre o encontro..."
      />

      {/* Grupos participantes: conjunto de caixas de marcação = fieldset com legenda */}
      <fieldset className="min-w-0">
        <legend className={labelCls}>Grupos participantes</legend>
        {allGroups.length === 0 ? (
          <p className="mt-1 text-sm text-ink-faint">Nenhum grupo cadastrado.</p>
        ) : (
          <div className="mt-2 space-y-2 max-h-48 overflow-y-auto border border-line rounded-control p-3">
            {allGroups.map((g) => (
              <label key={g.id} className="flex min-h-8 items-center gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={selectedGroups.includes(g.id)}
                  onChange={() => toggleGroup(g.id)}
                  className="h-4 w-4 rounded border-line-strong accent-action"
                />
                <span className="text-sm text-ink">{g.name}</span>
              </label>
            ))}
          </div>
        )}
      </fieldset>

      <div className="flex flex-col-reverse gap-2 border-t border-line-soft pt-4 mt-2 sm:flex-row sm:justify-end sm:gap-3">
        <Button onClick={onCancel}>Cancelar</Button>
        <Button type="submit" variant="primary" disabled={loading}>
          {loading ? 'Salvando...' : initial ? 'Salvar alterações' : 'Criar encontro'}
        </Button>
      </div>
    </form>
  );
}
