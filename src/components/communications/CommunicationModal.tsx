import { useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { CheckCircle2, Info, Loader2, Mail, TriangleAlert, XCircle } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { useToast } from '../../contexts/ToastContext';
import { useConfirm } from '../../contexts/ConfirmContext';
import { useCommunicationMutations, useRecipientSuggestions, type DraftContent } from '../../hooks/useCommunications';
import { Modal } from '../Modal';
import { ErrorBanner } from '../ErrorBanner';
import {
  BODY_MAX, RECIPIENT_NAME_MAX, SUBJECT_MAX, TEMPLATE_IDS, TEMPLATE_LABEL, buildTemplate, resolveSendView,
  templateForAlert, textLength, validateCommunicationForm, validateMessage, validateRecipient,
  type SendView, type TemplateId,
} from '../../lib/communications';
import {
  RECIPIENT_KIND_LABEL, RECIPIENT_KINDS, SEND_IN_PROGRESS_MESSAGE, SEND_UNCONFIRMED_MESSAGE, failureReasonLabel,
} from '../../lib/labels';
import { formatDateTime } from '../../lib/format';
import { formErrorCls, inputCls, labelCls, primaryBtnCls, secondaryBtnCls } from '../../lib/formStyles';
import type { AlertType, Communication, RecipientKind } from '../../types/database.types';

export interface AlertChoice {
  id: string;
  type: AlertType;
  /** Texto objetivo do alerta (ex.: "3 faltas seguidas") */
  label: string;
}

export interface FollowUpChoice {
  id: string;
  label: string;
}

interface CommunicationModalProps {
  youthId: string;
  youthName: string;
  groupName?: string | null;
  /**
   * Vínculos fixos: cartão do alerta, acompanhamento ou rascunho existente (o banco não deixa trocar o vínculo
   * depois de criar). Sem isto, a pessoa escolhe entre `alertChoices`.
   */
  fixedLinks?: { alert?: AlertChoice | null; followUp?: FollowUpChoice | null } | null;
  /** Alertas abertos do jovem que podem ser vinculados (ficha do jovem) */
  alertChoices?: AlertChoice[];
  /** Rascunho a continuar */
  initial?: Communication | null;
  onClose: () => void;
  /** Algo foi gravado (rascunho salvo, envio tentado, status mudou): recarregar listas */
  onChanged: () => void;
}

type Step = 'recipient' | 'message' | 'review';

const STEPS: { id: Step; label: string }[] = [
  { id: 'recipient', label: 'Destinatário' },
  { id: 'message', label: 'Mensagem' },
  { id: 'review', label: 'Revisar' },
];

const NO_CHOICES: AlertChoice[] = [];

const LEADER_NO_EMAIL = 'Este jovem não tem e-mail cadastrado. Peça à coordenação para cadastrar ou enviar.';

const footerCls = 'flex flex-col-reverse gap-2 border-t border-gray-100 pt-4 sm:flex-row sm:justify-end sm:gap-3';

/**
 * Assistente de e-mail em 3 passos (Destinatário, Mensagem, Revisar). "Enviar e-mail" (clique do usuário) salva o
 * rascunho e pede o envio ao servidor; o resultado mostrado (Enviado, Falhou, em andamento) é o REAL, relido do
 * banco. O navegador nunca marca nada como enviado.
 */
export function CommunicationModal({
  youthId, youthName, groupName, fixedLinks, alertChoices = NO_CHOICES, initial, onClose, onChanged,
}: CommunicationModalProps) {
  const toast = useToast();
  const confirm = useConfirm();
  const { profile, role } = useAuth();
  // Líder só escreve ao e-mail cadastrado do jovem (o servidor também recusa outro destinatário)
  const isLeader = role === 'leader';
  const mutations = useCommunicationMutations();
  const suggestions = useRecipientSuggestions(youthId);

  // Rascunho existente: os vínculos já estão gravados e não mudam
  const fixed = fixedLinks ?? (initial ? { alert: null, followUp: null } : null);

  const [step, setStep] = useState<Step>(initial ? 'review' : 'recipient');
  const [draft, setDraft] = useState<Communication | null>(initial ?? null);
  const [busy, setBusy] = useState(false);
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false); // trava o duplo clique antes de o estado atualizar
  const [view, setView] = useState<SendView | null>(null);
  const [sendErr, setSendErr] = useState('');
  const [formErr, setFormErr] = useState('');
  const working = busy || sending;

  // Destinatário: `null` = ainda vale a sugestão do banco (e-mail do jovem); string = a pessoa digitou
  const [kind, setKind] = useState<RecipientKind>(initial?.recipient_kind ?? 'youth');
  const [emailEdit, setEmailEdit] = useState<string | null>(initial ? initial.recipient_email : null);
  const [nameEdit, setNameEdit] = useState<string | null>(initial ? initial.recipient_name ?? '' : null);

  // Mensagem: `null` = ainda vale o automático: o primeiro alerta aberto (que pode chegar depois de o modal
  // abrir), o modelo dele e o texto do modelo
  const [chosenAlertId, setChosenAlertId] = useState<string | null>(null);
  const [templateEdit, setTemplateEdit] = useState<TemplateId | null>(null);
  const [subjectEdit, setSubjectEdit] = useState<string | null>(initial?.subject ?? null);
  const [bodyEdit, setBodyEdit] = useState<string | null>(initial?.body ?? null);

  const selectedAlertId = chosenAlertId ?? alertChoices[0]?.id ?? '';
  const alertChoice = fixed ? fixed.alert ?? null : alertChoices.find((a) => a.id === selectedAlertId) ?? null;
  const templateId: TemplateId = templateEdit
    ?? (fixedLinks?.followUp ? 'return_after_follow_up' : templateForAlert(alertChoice?.type));
  const followUp = fixed?.followUp ?? null;

  const suggestion = suggestions.data.find((s) => s.kind === 'youth') ?? null;
  const email = emailEdit ?? (kind === 'youth' ? suggestion?.email ?? '' : '');
  const name = nameEdit ?? (kind === 'youth' ? suggestion?.name ?? youthName : '');

  const senderName = profile?.full_name;
  const built = useMemo(
    () => buildTemplate(templateId, kind, { nome: youthName, grupo: groupName, remetente: senderName }),
    [templateId, kind, youthName, groupName, senderName],
  );
  const subject = subjectEdit ?? built.subject;
  const body = bodyEdit ?? built.body;
  const edited = subjectEdit !== null || bodyEdit !== null;

  const content: DraftContent = { recipientEmail: email, recipientName: name, subject, body, recipientKind: kind };

  const changeKind = (next: RecipientKind) => {
    setKind(next);
    // E-mail e nome sugeridos valem só para o jovem; para os outros tipos a pessoa digita
    setEmailEdit(next === 'youth' ? null : '');
    setNameEdit(next === 'youth' ? null : '');
  };

  const applyTemplate = async (next: TemplateId) => {
    if (next === templateId) return;
    if (edited) {
      const ok = await confirm({
        title: 'Trocar o modelo?',
        message: 'Trocar o modelo substitui o assunto e a mensagem que você editou.',
        confirmLabel: 'Trocar modelo',
        tone: 'primary',
      });
      if (!ok) return;
    }
    setTemplateEdit(next);
    setSubjectEdit(null);
    setBodyEdit(null);
  };

  const changeAlert = (id: string) => {
    setChosenAlertId(id);
    const choice = alertChoices.find((a) => a.id === id);
    if (!edited && choice) setTemplateEdit(null); // o modelo volta a seguir o tipo do alerta
  };

  const goMessage = (e: FormEvent) => {
    e.preventDefault();
    const problem = validateRecipient(email, name);
    if (problem) { setFormErr(problem); return; }
    setFormErr('');
    mutations.clearError();
    setStep('message');
  };

  const goReview = (e: FormEvent) => {
    e.preventDefault();
    const problem = validateMessage(subject, body);
    if (problem) { setFormErr(problem); return; }
    setFormErr('');
    mutations.clearError();
    setStep('review');
  };

  /** Valida e grava o rascunho (cria ou atualiza). Devolve a linha gravada ou null. */
  const persist = async (): Promise<Communication | null> => {
    setFormErr('');
    const problem = validateCommunicationForm({ recipientEmail: email, recipientName: name, subject, body });
    if (problem) { setFormErr(problem); return null; }
    const saved = draft
      ? await mutations.updateDraft(draft.id, content)
      : await mutations.createDraft({ youthId, alertId: alertChoice?.id ?? null, followUpId: followUp?.id ?? null }, content);
    if (saved) setDraft(saved);
    return saved;
  };

  const saveDraft = async () => {
    setBusy(true);
    const saved = await persist();
    setBusy(false);
    if (!saved) return;
    toast.success('Rascunho salvo.');
    onChanged();
    onClose();
  };

  /**
   * Envio real, só por clique. Rascunho: salva o que está na tela e envia. Falha (tentar de novo): reenvia a MESMA
   * comunicação, sem criar outra. O que aparece depois vem do banco (relido), não da suposição do cliente.
   */
  const send = async () => {
    if (sendingRef.current) return;
    sendingRef.current = true;
    setSending(true);
    setSendErr('');
    setFormErr('');
    mutations.clearError();
    try {
      let target = draft;
      if (!target || target.status === 'draft') {
        target = await persist();
        if (!target) return;
      }
      const { outcome, row } = await mutations.sendCommunication(target.id);
      if (row) setDraft(row);
      const result = resolveSendView(outcome, row);
      onChanged();
      if (result.kind === 'rejected') { setSendErr(result.message); return; }
      setView(result);
      if (result.kind === 'sent') toast.success('E-mail enviado.');
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  };

  /** Não confirmado / em andamento: relê o estado real no banco */
  const refreshView = async () => {
    if (!draft) return;
    setBusy(true);
    const row = await mutations.reloadCommunication(draft.id);
    setBusy(false);
    if (!row) { setView({ kind: 'unconfirmed' }); return; }
    setDraft(row);
    setView(resolveSendView({ kind: 'unconfirmed' }, row));
    if (row.status === 'sent') toast.success('E-mail enviado.');
  };

  /** Falhou: volta a ser rascunho para corrigir a mensagem e tentar de novo */
  const editAfterFailure = async () => {
    if (!draft) return;
    setBusy(true);
    const row = await mutations.markCommunication(draft.id, 'draft');
    setBusy(false);
    if (!row) return;
    setDraft(row);
    setView(null);
    setSendErr('');
    setStep('message');
    onChanged();
  };

  // Durante o envio a janela não fecha: o resultado precisa chegar aqui
  const close = () => { if (!sendingRef.current) onClose(); };

  const stepIndex = STEPS.findIndex((s) => s.id === step);
  const noYouthEmail = kind === 'youth' && !suggestions.loading && !suggestions.error && !suggestion;
  const leaderNoEmail = isLeader && !suggestions.loading && !suggestions.error && !suggestion;
  // Rascunho antigo de líder com destinatário alheio: o envio será recusado; dá para voltar ao e-mail do jovem
  const leaderCanReset = isLeader && !!suggestion && (kind !== 'youth' || email !== suggestion.email);
  const resetToYouth = () => { setKind('youth'); setEmailEdit(null); setNameEdit(null); };

  const sendingStatus = (
    <p
      role="status" aria-live="polite" data-testid="comunicacao-enviando"
      className={sending ? 'flex items-center gap-2 text-sm text-gray-700' : 'sr-only'}
    >
      {sending && (
        <>
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          Enviando e-mail… Não feche esta janela.
        </>
      )}
    </p>
  );

  return (
    <Modal title="Enviar e-mail" onClose={close}>
      <div className="space-y-4" data-testid="comunicacao-modal" data-etapa={view ? 'resultado' : step}>
        <p className="text-sm text-gray-600">Jovem: <strong className="text-gray-900">{youthName}</strong></p>

        {!view && (
          <ol aria-label="Etapas" className="flex items-center gap-2 text-xs">
            {STEPS.map((s, i) => (
              <li
                key={s.id}
                aria-current={s.id === step ? 'step' : undefined}
                className={`flex flex-1 items-center gap-1.5 rounded-control border px-2 py-1.5 ${
                  s.id === step ? 'border-blue-500 bg-blue-50 font-semibold text-blue-700' : i < stepIndex ? 'border-gray-200 text-gray-700' : 'border-gray-200 text-gray-400'
                }`}
              >
                <span className="tabular-nums">{i + 1}.</span> {s.label}
              </li>
            ))}
          </ol>
        )}

        {formErr && <p role="alert" data-testid="comunicacao-erro" className={formErrorCls}>{formErr}</p>}
        <ErrorBanner message={mutations.error} />
        {!view && step === 'recipient' && <ErrorBanner message={suggestions.error} />}

        {!view && step === 'recipient' && (
          <form onSubmit={goMessage} noValidate className="space-y-4" aria-label="Destinatário do e-mail">
            {!isLeader && (
              <div>
                <label className={labelCls} htmlFor="com-kind">Tipo de destinatário</label>
                <select
                  id="com-kind" data-testid="comunicacao-tipo" value={kind}
                  onChange={(e) => changeKind(e.target.value as RecipientKind)} className={inputCls}
                >
                  {RECIPIENT_KINDS.map((k) => <option key={k} value={k}>{RECIPIENT_KIND_LABEL[k]}</option>)}
                </select>
              </div>
            )}

            {isLeader && (
              <p className="flex items-start gap-2 text-xs text-gray-500">
                <Info className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" aria-hidden="true" />
                <span>Você envia ao e-mail cadastrado do jovem.</span>
              </p>
            )}
            {leaderCanReset && (
              <button type="button" onClick={resetToYouth} data-testid="comunicacao-usar-email-jovem" className={secondaryBtnCls}>
                Usar o e-mail cadastrado do jovem
              </button>
            )}

            {leaderNoEmail && (
              <p data-testid="comunicacao-sem-email" className="flex items-start gap-2 rounded-control border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
                <TriangleAlert className="mt-0.5 h-4 w-4 flex-shrink-0" aria-hidden="true" />
                <span>{LEADER_NO_EMAIL}</span>
              </p>
            )}
            {!isLeader && noYouthEmail && (
              <p data-testid="comunicacao-sem-email" className="flex items-start gap-2 rounded-control border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
                <TriangleAlert className="mt-0.5 h-4 w-4 flex-shrink-0" aria-hidden="true" />
                <span>Este jovem não tem e-mail cadastrado. Digite um endereço para continuar ou atualize o cadastro do jovem.</span>
              </p>
            )}
            {!isLeader && kind !== 'youth' && (
              <p className="flex items-start gap-2 text-xs text-gray-500">
                <Info className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" aria-hidden="true" />
                <span>O sistema não guarda o e-mail de responsáveis, líderes ou coordenadores: digite o endereço.</span>
              </p>
            )}

            <div>
              <label className={labelCls} htmlFor="com-name">Nome do destinatário (opcional)</label>
              <input
                id="com-name" data-testid="comunicacao-nome" type="text" value={name} maxLength={RECIPIENT_NAME_MAX} readOnly={isLeader}
                onChange={(e) => setNameEdit(e.target.value)} className={inputCls} autoComplete="off"
              />
            </div>
            <div>
              <label className={labelCls} htmlFor="com-email">E-mail do destinatário *</label>
              <input
                id="com-email" data-testid="comunicacao-email" type="email" inputMode="email" value={email} readOnly={isLeader}
                onChange={(e) => setEmailEdit(e.target.value)} className={inputCls} autoComplete="off"
                placeholder="nome@exemplo.com"
              />
              {kind === 'youth' && suggestion && emailEdit === null && (
                <p className="mt-1 text-xs text-gray-500">E-mail cadastrado do jovem.</p>
              )}
            </div>

            <div className={footerCls}>
              <button type="button" onClick={close} className={secondaryBtnCls}>Cancelar</button>
              {!leaderNoEmail && <button type="submit" data-testid="comunicacao-proximo" className={primaryBtnCls}>Continuar</button>}
            </div>
          </form>
        )}

        {!view && step === 'message' && (
          <form onSubmit={goReview} noValidate className="space-y-4" aria-label="Mensagem do e-mail">
            {fixed ? (
              (alertChoice || followUp) && (
                <p data-testid="comunicacao-vinculo" className="rounded-control bg-gray-50 px-3 py-2 text-xs text-gray-600">
                  {alertChoice && <span className="block">Relacionada ao alerta: {alertChoice.label}</span>}
                  {followUp && <span className="block">Relacionada ao acompanhamento: {followUp.label}</span>}
                </p>
              )
            ) : alertChoices.length > 0 && (
              <div>
                <label className={labelCls} htmlFor="com-alert">Relacionada ao alerta (opcional)</label>
                <select
                  id="com-alert" data-testid="comunicacao-alerta" value={selectedAlertId}
                  onChange={(e) => changeAlert(e.target.value)} className={inputCls}
                >
                  <option value="">Nenhum</option>
                  {alertChoices.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
                </select>
              </div>
            )}

            <div>
              <label className={labelCls} htmlFor="com-template">Modelo de mensagem</label>
              <select
                id="com-template" data-testid="comunicacao-modelo" value={templateId}
                onChange={(e) => applyTemplate(e.target.value as TemplateId)} className={inputCls}
              >
                {TEMPLATE_IDS.map((t) => <option key={t} value={t}>{TEMPLATE_LABEL[t]}</option>)}
              </select>
              <p className="mt-1 text-xs text-gray-500">Revise e ajuste o texto antes de enviar. Os modelos não citam números nem diagnósticos.</p>
            </div>

            <div>
              <label className={labelCls} htmlFor="com-subject">Assunto *</label>
              <input
                id="com-subject" data-testid="comunicacao-assunto" type="text" value={subject}
                onChange={(e) => setSubjectEdit(e.target.value)} className={inputCls} aria-describedby="com-subject-count"
              />
              <p id="com-subject-count" className={`mt-1 text-right text-xs tabular-nums ${textLength(subject) > SUBJECT_MAX ? 'text-red-600' : 'text-gray-500'}`}>
                {textLength(subject)}/{SUBJECT_MAX}
              </p>
            </div>
            <div>
              <label className={labelCls} htmlFor="com-body">Mensagem *</label>
              <textarea
                id="com-body" data-testid="comunicacao-corpo" rows={10} value={body}
                onChange={(e) => setBodyEdit(e.target.value)} className={inputCls} aria-describedby="com-body-count"
              />
              <p id="com-body-count" className={`mt-1 text-right text-xs tabular-nums ${textLength(body) > BODY_MAX ? 'text-red-600' : 'text-gray-500'}`}>
                {textLength(body)}/{BODY_MAX}
              </p>
            </div>

            <div className={footerCls}>
              <button type="button" onClick={() => { setFormErr(''); setStep('recipient'); }} className={secondaryBtnCls}>Voltar</button>
              <button type="submit" data-testid="comunicacao-proximo" className={primaryBtnCls}>Revisar</button>
            </div>
          </form>
        )}

        {!view && step === 'review' && (
          <div data-testid="comunicacao-revisao" className="space-y-4">
            <dl className="space-y-3 text-sm">
              <div>
                <dt className="text-xs font-medium text-gray-500">Para</dt>
                <dd data-testid="comunicacao-revisao-destinatario" className="break-words text-gray-900">
                  {name.trim() ? `${name.trim()} · ` : ''}{email.trim().toLowerCase()} ({RECIPIENT_KIND_LABEL[kind]})
                </dd>
              </div>
              <div>
                <dt className="text-xs font-medium text-gray-500">Assunto</dt>
                <dd data-testid="comunicacao-revisao-assunto" className="break-words font-medium text-gray-900">{subject}</dd>
              </div>
              <div>
                <dt className="text-xs font-medium text-gray-500">Mensagem</dt>
                <dd
                  data-testid="comunicacao-revisao-corpo"
                  className="mt-1 max-h-72 overflow-y-auto whitespace-pre-wrap break-words rounded-control border border-gray-200 bg-gray-50 px-3 py-2 text-gray-900"
                >
                  {body}
                </dd>
              </div>
            </dl>

            <p data-testid="comunicacao-aviso-envio" className="flex items-start gap-2 rounded-control border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-700">
              <Info className="mt-0.5 h-4 w-4 flex-shrink-0" aria-hidden="true" />
              <span>
                Ao clicar em &ldquo;Enviar e-mail&rdquo;, a mensagem é enviada de verdade ao destinatário e o envio não pode
                ser desfeito. O resultado aparece aqui e fica registrado no histórico.
              </span>
            </p>

            {leaderNoEmail && (
              <p data-testid="comunicacao-sem-email" className="flex items-start gap-2 rounded-control border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
                <TriangleAlert className="mt-0.5 h-4 w-4 flex-shrink-0" aria-hidden="true" />
                <span>{LEADER_NO_EMAIL}</span>
              </p>
            )}
            {sendErr && <p role="alert" data-testid="comunicacao-erro-envio" className={formErrorCls}>{sendErr}</p>}
            {sendingStatus}

            <div className="flex flex-col gap-2 border-t border-gray-100 pt-4 sm:flex-row sm:flex-wrap sm:justify-end">
              <button
                type="button" onClick={() => { setFormErr(''); setSendErr(''); setStep('message'); }}
                disabled={working} className={secondaryBtnCls}
              >
                Voltar e editar
              </button>
              <button type="button" onClick={saveDraft} disabled={working} data-testid="comunicacao-salvar-rascunho" className={secondaryBtnCls}>
                Salvar rascunho
              </button>
              {!leaderNoEmail && (
                <button type="button" onClick={send} disabled={working} aria-busy={sending} data-testid="comunicacao-enviar" className={primaryBtnCls}>
                  {sending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Mail className="h-4 w-4" aria-hidden="true" />}
                  {sending ? 'Enviando…' : 'Enviar e-mail'}
                </button>
              )}
            </div>
          </div>
        )}

        {view && (
          <section
            role={view.kind === 'sent' ? 'status' : 'alert'} data-testid="comunicacao-resultado" data-resultado={view.kind}
            className="space-y-4"
          >
            {view.kind === 'sent' && (
              <div className="flex items-start gap-2 rounded-control border border-green-200 bg-green-50 px-3 py-3 text-sm text-green-700">
                <CheckCircle2 className="mt-0.5 h-5 w-5 flex-shrink-0" aria-hidden="true" />
                <div>
                  <p className="font-semibold">E-mail enviado</p>
                  {view.sentAt && <p className="mt-0.5">Enviado em {formatDateTime(view.sentAt)}.</p>}
                  <p className="mt-0.5">O registro está no histórico de comunicações do jovem.</p>
                </div>
              </div>
            )}
            {view.kind === 'failed' && (
              <div className="flex items-start gap-2 rounded-control border border-red-200 bg-red-50 px-3 py-3 text-sm text-red-700">
                <XCircle className="mt-0.5 h-5 w-5 flex-shrink-0" aria-hidden="true" />
                <div>
                  <p className="font-semibold">O e-mail não foi enviado</p>
                  <p data-testid="comunicacao-motivo-falha" className="mt-0.5">{failureReasonLabel(view.reason)}</p>
                </div>
              </div>
            )}
            {(view.kind === 'unconfirmed' || view.kind === 'in_progress') && (
              <div className="flex items-start gap-2 rounded-control border border-amber-200 bg-amber-50 px-3 py-3 text-sm text-amber-800">
                <TriangleAlert className="mt-0.5 h-5 w-5 flex-shrink-0" aria-hidden="true" />
                <p>{view.kind === 'unconfirmed' ? SEND_UNCONFIRMED_MESSAGE : SEND_IN_PROGRESS_MESSAGE}</p>
              </div>
            )}

            {sendErr && <p role="alert" data-testid="comunicacao-erro-envio" className={formErrorCls}>{sendErr}</p>}
            {sendingStatus}

            <div className={footerCls}>
              {(view.kind === 'unconfirmed' || view.kind === 'in_progress') && draft && (
                <button type="button" onClick={refreshView} disabled={working} data-testid="comunicacao-atualizar-status" className={secondaryBtnCls}>
                  Atualizar status
                </button>
              )}
              {view.kind === 'failed' && (
                <>
                  <button type="button" onClick={editAfterFailure} disabled={working} data-testid="comunicacao-editar-mensagem" className={secondaryBtnCls}>
                    Editar mensagem
                  </button>
                  <button type="button" onClick={send} disabled={working} aria-busy={sending} data-testid="comunicacao-tentar-novamente" className={primaryBtnCls}>
                    {sending && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
                    {sending ? 'Enviando…' : 'Tentar novamente'}
                  </button>
                </>
              )}
              <button
                type="button" onClick={close} disabled={working} data-testid="comunicacao-fechar"
                className={view.kind === 'failed' ? secondaryBtnCls : primaryBtnCls}
              >
                Fechar
              </button>
            </div>
          </section>
        )}
      </div>
    </Modal>
  );
}
