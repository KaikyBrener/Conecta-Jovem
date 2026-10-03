import { useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { useToast } from '../../contexts/ToastContext';
import {
  useAssignableResponsibles,
  useFollowUpLinkOptions,
  useFollowUpMutations,
  type FollowUpWithRelations,
} from '../../hooks/useFollowUps';
import { Modal } from '../Modal';
import { ErrorBanner } from '../ErrorBanner';
import { alertDescription, FOLLOW_UP_TYPE_LABEL, FOLLOW_UP_TYPES, TASK_STATUS_LABEL } from '../../lib/labels';
import { appToday, formatDateOnly } from '../../lib/format';
import { validateFollowUpForm, type FollowUpFormValues } from '../../lib/followups';
import { formErrorCls, inputCls, labelCls, primaryBtnCls, secondaryBtnCls } from '../../lib/formStyles';
import type { FollowUpType } from '../../types/database.types';

interface FollowUpFormModalProps {
  youthId: string;
  youthName: string;
  /** Presente = edição */
  initial?: FollowUpWithRelations | null;
  /** Novo acompanhamento já vinculado a este alerta (vindo de /alertas) */
  defaultAlertId?: string | null;
  defaultTaskId?: string | null;
  onClose: () => void;
  /** Chamado depois de salvar com sucesso (recarregar listas/situação) */
  onSaved: () => void;
}

/** Formulário (em Modal) para registrar ou editar um acompanhamento de um jovem. */
export function FollowUpFormModal({
  youthId, youthName, initial, defaultAlertId, defaultTaskId, onClose, onSaved,
}: FollowUpFormModalProps) {
  const toast = useToast();
  const { user, profile, role } = useAuth();
  const isCoordinator = role === 'coordinator';
  const isEdit = !!initial;
  const mutations = useFollowUpMutations();
  const responsibles = useAssignableResponsibles(isEdit ? null : youthId);
  const links = useFollowUpLinkOptions(youthId);

  const [form, setForm] = useState<FollowUpFormValues>({
    occurred_at: initial?.occurred_at ?? appToday(),
    type: initial?.type ?? 'conversation',
    reason: initial?.reason ?? '',
    notes: initial?.notes ?? '',
    next_action: initial?.next_action ?? '',
    next_action_due: initial?.next_action_due ?? '',
    responsible_id: initial?.responsible_id ?? user?.id ?? '',
    task_id: initial?.task_id ?? defaultTaskId ?? '',
    completes_task: initial?.completes_task ?? false,
    alert_id: initial?.alert_id ?? defaultAlertId ?? '',
  });
  const [err, setErr] = useState('');
  const [saving, setSaving] = useState(false);
  const initialTask = initial?.task ?? null;
  const initialAlert = initial?.alert ?? null;

  const set = <K extends keyof FollowUpFormValues>(field: K, value: FollowUpFormValues[K]) =>
    setForm((prev) => ({ ...prev, [field]: value }));

  const responsibleOptions = useMemo(() => {
    const list = responsibles.data.map((r) => ({ id: r.id, name: r.full_name ?? 'Sem nome' }));
    if (user && !list.some((r) => r.id === user.id)) list.unshift({ id: user.id, name: profile?.full_name ?? 'Você' });
    return list;
  }, [responsibles.data, user, profile?.full_name]);

  // Mantém no seletor o vínculo atual mesmo que já não esteja "aberto" (alerta encerrado, ação concluída)
  const taskOptions = useMemo(() => {
    const list = links.data.tasks.map((t) => ({
      id: t.id,
      label: `${t.title}${t.due_date ? ` (prazo ${formatDateOnly(t.due_date)})` : ''}`,
    }));
    if (form.task_id && !list.some((t) => t.id === form.task_id)) {
      list.unshift({
        id: form.task_id,
        label: initialTask ? `${initialTask.title} (${TASK_STATUS_LABEL[initialTask.status]})` : 'Ação vinculada',
      });
    }
    return list;
  }, [links.data.tasks, form.task_id, initialTask]);

  const alertOptions = useMemo(() => {
    const list = links.data.alerts.map((a) => ({ id: a.id, label: alertDescription(a) }));
    if (form.alert_id && !list.some((a) => a.id === form.alert_id)) {
      list.unshift({ id: form.alert_id, label: initialAlert ? alertDescription(initialAlert) : 'Alerta vinculado' });
    }
    return list;
  }, [links.data.alerts, form.alert_id, initialAlert]);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setErr('');
    mutations.clearError();
    const problem = validateFollowUpForm(form, appToday());
    if (problem) { setErr(problem); return; }
    setSaving(true);
    const ok = initial
      ? await mutations.updateFollowUp(initial.id, form)
      : await mutations.createFollowUp(youthId, form);
    setSaving(false);
    if (!ok) return;
    toast.success(isEdit ? 'Acompanhamento atualizado.' : 'Acompanhamento registrado.');
    onSaved();
    onClose();
  };

  const alreadyCompletes = !!initial?.completes_task;

  return (
    <Modal title={isEdit ? 'Editar acompanhamento' : 'Novo acompanhamento'} onClose={onClose}>
      <form onSubmit={handleSubmit} className="space-y-4" aria-label="Formulário de acompanhamento">
        <p className="text-sm text-gray-600">Jovem: <strong className="text-gray-900">{youthName}</strong></p>
        {err && <p role="alert" className={formErrorCls}>{err}</p>}
        <ErrorBanner message={mutations.error} />
        <ErrorBanner message={links.error ?? responsibles.error} />

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={labelCls} htmlFor="fu-date">Data do contato *</label>
            <input
              id="fu-date" type="date" value={form.occurred_at} max={appToday()}
              onChange={(e) => set('occurred_at', e.target.value)} className={inputCls}
            />
          </div>
          <div>
            <label className={labelCls} htmlFor="fu-type">Tipo</label>
            <select id="fu-type" value={form.type} onChange={(e) => set('type', e.target.value as FollowUpType)} className={inputCls}>
              {FOLLOW_UP_TYPES.map((t) => <option key={t} value={t}>{FOLLOW_UP_TYPE_LABEL[t]}</option>)}
            </select>
          </div>
        </div>

        <div>
          <label className={labelCls} htmlFor="fu-reason">Motivo *</label>
          <input
            id="fu-reason" type="text" value={form.reason} maxLength={300}
            onChange={(e) => set('reason', e.target.value)} className={inputCls}
            placeholder="Ex.: Faltou nos últimos encontros"
          />
        </div>

        <div>
          <label className={labelCls} htmlFor="fu-notes">Observação</label>
          <textarea id="fu-notes" rows={3} value={form.notes} onChange={(e) => set('notes', e.target.value)} className={inputCls} />
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className={labelCls} htmlFor="fu-next">Próxima ação</label>
            <input
              id="fu-next" type="text" value={form.next_action} maxLength={300}
              onChange={(e) => set('next_action', e.target.value)} className={inputCls}
              placeholder="Ex.: Ligar na sexta"
            />
          </div>
          <div>
            <label className={labelCls} htmlFor="fu-next-due">Prazo da próxima ação</label>
            <input
              id="fu-next-due" type="date" value={form.next_action_due} min={form.occurred_at || undefined}
              onChange={(e) => set('next_action_due', e.target.value)} className={inputCls}
            />
          </div>
        </div>

        <div>
          {isEdit ? (
            <p className="text-xs text-gray-500">O responsável só muda pela opção &ldquo;Transferir responsável&rdquo;.</p>
          ) : isCoordinator ? (
            <>
              <label className={labelCls} htmlFor="fu-responsible">Responsável</label>
              <select
                id="fu-responsible" value={form.responsible_id}
                onChange={(e) => set('responsible_id', e.target.value)} className={inputCls}
              >
                {responsibleOptions.map((r) => (
                  <option key={r.id} value={r.id}>{r.id === user?.id ? `${r.name} (eu)` : r.name}</option>
                ))}
              </select>
            </>
          ) : (
            <p className="text-sm text-gray-600">
              Responsável: <strong className="text-gray-900">você</strong>
              <span className="block text-xs text-gray-400">Líderes registram acompanhamentos sob a própria responsabilidade.</span>
            </p>
          )}
        </div>

        <fieldset className="space-y-3 rounded-lg border border-gray-200 px-3 py-3">
          <legend className="px-1 text-xs font-medium text-gray-500">Vínculos (opcional)</legend>
          <div>
            <label className={labelCls} htmlFor="fu-alert">Alerta</label>
            <select id="fu-alert" value={form.alert_id} onChange={(e) => set('alert_id', e.target.value)} className={inputCls}>
              <option value="">Nenhum</option>
              {alertOptions.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
            </select>
          </div>
          <div>
            <label className={labelCls} htmlFor="fu-task">Ação em aberto</label>
            <select
              id="fu-task" value={form.task_id}
              onChange={(e) => setForm((prev) => ({ ...prev, task_id: e.target.value, completes_task: e.target.value ? prev.completes_task : false }))}
              className={inputCls}
            >
              <option value="">Nenhuma</option>
              {taskOptions.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
            </select>
          </div>
          {form.task_id && (
            <label className="flex items-start gap-2 text-sm text-gray-700">
              <input
                type="checkbox" checked={form.completes_task} disabled={alreadyCompletes}
                onChange={(e) => set('completes_task', e.target.checked)}
                className="mt-0.5 h-4 w-4 rounded border-gray-300 text-blue-600"
              />
              <span>
                Concluir a ação ao registrar
                <span className="block text-xs text-gray-400">A ação vira &ldquo;Concluída&rdquo;. A presença não é alterada.</span>
              </span>
            </label>
          )}
        </fieldset>

        <div className="flex justify-end gap-3 pt-2 border-t border-gray-100">
          <button type="button" onClick={onClose} className={secondaryBtnCls}>Cancelar</button>
          <button type="submit" disabled={saving} className={primaryBtnCls}>
            {saving ? 'Salvando...' : isEdit ? 'Salvar alterações' : 'Registrar acompanhamento'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
