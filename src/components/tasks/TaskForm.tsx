import { useMemo, useState } from 'react';
import type { Task, TaskInsert, TaskPriority, TaskStatus } from '../../types/database.types';
import type { TaskOptions } from '../../hooks/useTasks';
import { TASK_PRIORITY_LABEL, TASK_STATUS_LABEL } from '../../lib/labels';
import { inputCls, labelCls, primaryBtnCls, secondaryBtnCls, formErrorCls } from '../../lib/formStyles';

export type TaskFormPayload = Omit<TaskInsert, 'created_by'>;

interface TaskFormProps {
  initial?: Partial<Task> | null;
  isEdit: boolean;
  options: TaskOptions;
  currentUserId: string;
  isCoordinator: boolean;
  onSubmit: (payload: TaskFormPayload) => Promise<void>;
  onCancel: () => void;
  loading: boolean;
}

type FormData = {
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  due_date: string;
  youth_id: string;
  group_id: string;
  assigned_to: string;
};

export function TaskForm({ initial, isEdit, options, currentUserId, isCoordinator, onSubmit, onCancel, loading }: TaskFormProps) {
  const [form, setForm] = useState<FormData>({
    title: initial?.title ?? '',
    description: initial?.description ?? '',
    status: initial?.status ?? 'pending',
    priority: initial?.priority ?? 'medium',
    due_date: initial?.due_date ?? '',
    youth_id: initial?.youth_id ?? '',
    group_id: initial?.group_id ?? '',
    // Líder só pode atribuir a si mesmo; por padrão a tarefa fica com quem cria
    assigned_to: isEdit ? (initial?.assigned_to ?? '') : (initial?.assigned_to ?? currentUserId),
  });
  const [err, setErr] = useState('');

  const set = <K extends keyof FormData>(field: K, value: FormData[K]) =>
    setForm((prev) => ({ ...prev, [field]: value }));

  // Ao escolher um jovem, sugere o grupo dele
  const selectYouth = (id: string) => {
    const y = options.youth.find((o) => o.id === id);
    setForm((prev) => ({ ...prev, youth_id: id, group_id: y?.group_id ?? prev.group_id }));
  };

  // Garante que o valor atual apareça nas listas mesmo se não estiver nas opções (ex.: jovem inativo)
  const youthOptions = useMemo(() => {
    const list = [...options.youth];
    if (form.youth_id && !list.some((y) => y.id === form.youth_id)) {
      list.unshift({ id: form.youth_id, full_name: 'Jovem atual', group_id: null });
    }
    return list;
  }, [options.youth, form.youth_id]);

  const assigneeOptions = useMemo(() => {
    const list = [...options.assignees];
    if (form.assigned_to && !list.some((a) => a.id === form.assigned_to)) {
      list.unshift({ id: form.assigned_to, full_name: 'Responsável atual' });
    }
    return list;
  }, [options.assignees, form.assigned_to]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr('');
    if (!form.title.trim()) { setErr('Título é obrigatório.'); return; }
    await onSubmit({
      title: form.title.trim(),
      description: form.description.trim() || null,
      status: form.status,
      priority: form.priority,
      due_date: form.due_date || null,
      youth_id: form.youth_id || null,
      group_id: form.group_id || null,
      alert_id: initial?.alert_id ?? null,
      assigned_to: form.assigned_to || null,
    });
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {err && <p className={formErrorCls}>{err}</p>}

      {initial?.alert_id && (
        <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded px-3 py-2">
          Vinculada a um alerta de faltas. Ao concluir a tarefa, o alerta será resolvido automaticamente.
        </p>
      )}

      <div>
        <label className={labelCls} htmlFor="task-title">Título *</label>
        <input id="task-title" type="text" value={form.title} onChange={(e) => set('title', e.target.value)} className={inputCls} placeholder="Ex.: Ligar para o jovem" />
      </div>

      <div>
        <label className={labelCls} htmlFor="task-desc">Descrição</label>
        <textarea id="task-desc" rows={3} value={form.description} onChange={(e) => set('description', e.target.value)} className={inputCls} />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className={labelCls} htmlFor="task-status">Status</label>
          <select id="task-status" value={form.status} onChange={(e) => set('status', e.target.value as TaskStatus)} className={inputCls}>
            {(Object.keys(TASK_STATUS_LABEL) as TaskStatus[]).map((s) => <option key={s} value={s}>{TASK_STATUS_LABEL[s]}</option>)}
          </select>
        </div>
        <div>
          <label className={labelCls} htmlFor="task-priority">Prioridade</label>
          <select id="task-priority" value={form.priority} onChange={(e) => set('priority', e.target.value as TaskPriority)} className={inputCls}>
            {(Object.keys(TASK_PRIORITY_LABEL) as TaskPriority[]).map((p) => <option key={p} value={p}>{TASK_PRIORITY_LABEL[p]}</option>)}
          </select>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className={labelCls} htmlFor="task-due">Prazo</label>
          <input id="task-due" type="date" value={form.due_date} onChange={(e) => set('due_date', e.target.value)} className={inputCls} />
        </div>
        <div>
          <label className={labelCls} htmlFor="task-assignee">Responsável</label>
          <select
            id="task-assignee"
            value={form.assigned_to}
            onChange={(e) => set('assigned_to', e.target.value)}
            className={inputCls}
          >
            <option value="">Sem responsável</option>
            {assigneeOptions.map((a) => (
              <option key={a.id} value={a.id}>{a.id === currentUserId ? `${a.full_name ?? 'Eu'} (eu)` : (a.full_name ?? 'Sem nome')}</option>
            ))}
          </select>
          {!isCoordinator && <p className="mt-1 text-xs text-gray-400">Líderes atribuem tarefas apenas a si.</p>}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className={labelCls} htmlFor="task-youth">Jovem</label>
          <select id="task-youth" value={form.youth_id} onChange={(e) => selectYouth(e.target.value)} className={inputCls}>
            <option value="">Nenhum</option>
            {youthOptions.map((y) => <option key={y.id} value={y.id}>{y.full_name}</option>)}
          </select>
        </div>
        <div>
          <label className={labelCls} htmlFor="task-group">Grupo</label>
          <select id="task-group" value={form.group_id} onChange={(e) => set('group_id', e.target.value)} className={inputCls}>
            <option value="">Nenhum</option>
            {options.groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
          </select>
        </div>
      </div>

      <div className="flex justify-end gap-3 pt-2 border-t border-gray-100 mt-2">
        <button type="button" onClick={onCancel} className={secondaryBtnCls}>
          Cancelar
        </button>
        <button type="submit" disabled={loading} className={primaryBtnCls}>
          {loading ? 'Salvando...' : isEdit ? 'Salvar alterações' : 'Criar tarefa'}
        </button>
      </div>
    </form>
  );
}
