import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { UnsavedChangesContext } from '../hooks/useUnsavedChanges';
import { dangerBtnCls, secondaryBtnCls } from '../lib/formStyles';

interface ModalProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  /** `lg` = janela larga (ficha do jovem, 760px). Padrão: 512px. No celular é sempre folha inferior. */
  size?: 'md' | 'lg';
  /** data-testid do elemento role="dialog" */
  testId?: string;
  /**
   * Há dados não salvos que não estão em campos na tela (ex.: passo de revisão de um assistente). Soma-se à
   * detecção automática dos campos alterados e a `useUnsavedChanges`. Ver "Proteção contra perda de dados" abaixo.
   */
  unsaved?: boolean;
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), ' +
  'textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

const focusablesIn = (root: HTMLElement | null) =>
  Array.from(root?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []).filter((el) => el.getClientRects().length > 0);

/* Ordem de abertura: só a janela do topo responde a Esc e Tab (janelas aninhadas e a confirmação sobre uma janela). */
let openingSeq = 0;
const openModals = new Set<number>();
const isTopmost = (order: number) => Math.max(...openModals) === order;

/* Trava a rolagem do documento enquanto houver janela aberta (o documento é quem rola; ver Layout). */
let scrollLocks = 0;
let overflowBeforeLock = '';
const lockScroll = () => {
  if (scrollLocks++ === 0) {
    overflowBeforeLock = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
  }
};
const unlockScroll = () => {
  if (--scrollLocks === 0) document.body.style.overflow = overflowBeforeLock;
};

/* ---------- Proteção contra perda de dados ---------- */

type FormField = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;

const IGNORED_INPUT_TYPES = new Set(['hidden', 'submit', 'button', 'reset', 'image', 'file']);

/** Campo de um `<form>` de entrada de dados. Buscas e filtros soltos (fora de `<form>`) não contam. */
function isGuardedField(target: EventTarget | null): target is FormField {
  if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement)) return false;
  if (target instanceof HTMLInputElement && IGNORED_INPUT_TYPES.has(target.type)) return false;
  return target.form !== null && target.form.dataset.unsavedGuard !== 'off';
}

/** Valor do campo em texto, para comparar "como estava" com "como está". */
function fieldValue(el: FormField): string {
  if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) return el.checked ? '1' : '0';
  if (el instanceof HTMLSelectElement && el.multiple) return Array.from(el.selectedOptions, (o) => o.value).join('\u0000');
  return el.value;
}

/** Pergunta "Descartar alterações?": o foco começa na ação segura, como nas demais confirmações. */
function DiscardBody({ onAnswer }: { onAnswer: (discard: boolean) => void }) {
  const keepRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { keepRef.current?.focus(); }, []);
  return (
    <div className="space-y-4">
      <p className="text-sm text-ink-soft">
        Você alterou este formulário e ainda não salvou. Se fechar agora, o que foi preenchido será perdido.
      </p>
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <button ref={keepRef} type="button" onClick={() => onAnswer(false)} className={secondaryBtnCls} data-testid="confirmacao-cancelar">
          Continuar editando
        </button>
        <button type="button" onClick={() => onAnswer(true)} className={dangerBtnCls} data-testid="confirmacao-confirmar">
          Descartar alterações
        </button>
      </div>
    </div>
  );
}

/**
 * Janela de diálogo (no celular, folha inferior). Teclado e foco:
 * - Esc fecha a janela do topo (menos quando o foco está num <select>, onde o Esc fecha a lista de opções);
 * - o foco entra na janela ao abrir, fica preso nela com Tab/Shift+Tab e volta a quem abriu ao fechar;
 * - o fundo não rola; clicar fora só fecha se o clique começou e terminou fora (arrastar um texto não fecha).
 *
 * Proteção contra perda de dados: fechar por Esc, clique fora ou pelo botão "Fechar janela" com um formulário
 * alterado pergunta antes ("Descartar alterações?"). Conta como alterado:
 * - um campo de um `<form>` da janela que a pessoa editou e que está diferente de como estava (desfazer a edição
 *   deixa de contar; campos fora de `<form>`, como buscas, e de `<form data-unsaved-guard="off">` não contam);
 * - a propriedade `unsaved` e o hook `useUnsavedChanges`, para dados que já saíram da tela (formulário em etapas).
 * O botão "Cancelar" do próprio formulário é uma decisão explícita e fecha direto, como salvar com sucesso.
 */
export function Modal({ title, onClose, children, size = 'md', testId, unsaved = false }: ModalProps) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  const unsavedRef = useRef(unsaved);
  const pressedOnBackdrop = useRef(false);
  // campos que a pessoa editou → valor que tinham antes da primeira edição (`null` = não deu para saber)
  const [edited] = useState(() => new Map<FormField, string | null>());
  const [seen] = useState(() => new WeakMap<FormField, string>());
  const [declared] = useState(() => new Set<string>());
  const [askingDiscard, setAskingDiscard] = useState(false);
  // lidos na primeira renderização, antes de qualquer efeito (filhos, como a confirmação, mexem no foco depois)
  const [order] = useState(() => ++openingSeq);
  const [opener] = useState(() => (document.activeElement instanceof HTMLElement ? document.activeElement : null));

  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);
  useEffect(() => { unsavedRef.current = unsaved; }, [unsaved]);

  // Acompanha os campos editados. Só eventos da própria pessoa disparam `input`/`change`: valores preenchidos pelo
  // código (carregar dados, limpar depois de salvar) não marcam nada. Este efeito vem antes do foco inicial para
  // já registrar o valor do primeiro campo.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const own = (target: EventTarget | null): target is FormField =>
      isGuardedField(target) && target.closest('[role="dialog"]') === dialog;   // campos de janela aninhada são dela
    const onFocusIn = (e: FocusEvent) => {
      if (own(e.target) && !edited.has(e.target)) seen.set(e.target, fieldValue(e.target));
    };
    const onEdit = (e: Event) => {
      if (own(e.target) && !edited.has(e.target)) edited.set(e.target, seen.get(e.target) ?? null);
    };
    dialog.addEventListener('focusin', onFocusIn);
    dialog.addEventListener('input', onEdit);
    dialog.addEventListener('change', onEdit);
    return () => {
      dialog.removeEventListener('focusin', onFocusIn);
      dialog.removeEventListener('input', onEdit);
      dialog.removeEventListener('change', onEdit);
    };
  }, [edited, seen]);

  const hasUnsavedChanges = useCallback(() => {
    if (unsavedRef.current || declared.size > 0) return true;
    for (const [field, before] of edited) {
      if (!field.isConnected) { edited.delete(field); continue; }   // o campo saiu da tela (salvou, trocou de aba)
      if (before === null || fieldValue(field) !== before) return true;
    }
    return false;
  }, [declared, edited]);

  /** Fechar por Esc, clique fora ou "Fechar janela": pergunta antes se houver alteração não salva. */
  const requestClose = useCallback(() => {
    if (hasUnsavedChanges()) setAskingDiscard(true);
    else onCloseRef.current();
  }, [hasUnsavedChanges]);

  const answerDiscard = (discard: boolean) => {
    setAskingDiscard(false);
    if (discard) onCloseRef.current();
  };

  useEffect(() => {
    openModals.add(order);
    lockScroll();
    return () => {
      openModals.delete(order);
      unlockScroll();
    };
  }, [order]);

  // Foco inicial: se um filho já focou algo (ex.: "Cancelar" da confirmação), respeita; senão, o primeiro campo
  // no desktop e a própria janela no celular (para não abrir o teclado virtual sozinho).
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (!dialog.contains(document.activeElement)) {
      const touch = typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches;
      const first = touch ? undefined : focusablesIn(contentRef.current)[0];
      (first ?? dialog).focus({ preventScroll: true });
    }
    return () => {
      if (opener && document.contains(opener)) opener.focus();
    };
  }, [opener]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const dialog = dialogRef.current;
      if (!dialog || e.defaultPrevented || !isTopmost(order)) return;

      if (e.key === 'Escape') {
        if (e.target instanceof HTMLSelectElement) return;
        e.preventDefault();
        requestClose();
        return;
      }

      if (e.key !== 'Tab') return;
      const focusable = focusablesIn(dialog);
      if (focusable.length === 0) {
        e.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (!dialog.contains(active)) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      } else if (e.shiftKey && (active === first || active === dialog)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [order, requestClose]);

  return (
    <>
    <div
      className="fixed inset-0 z-[60] flex items-end sm:items-center justify-center p-0 sm:p-4 bg-navy-950/60"
      onMouseDown={(e) => { pressedOnBackdrop.current = e.target === e.currentTarget; }}
      onClick={(e) => {
        const closes = pressedOnBackdrop.current && e.target === e.currentTarget;
        pressedOnBackdrop.current = false;
        if (closes) requestClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        data-testid={testId}
        className={`bg-surface w-full ${size === 'lg' ? 'sm:max-w-[47.5rem]' : 'sm:max-w-lg'} rounded-t-sheet sm:rounded-sheet shadow-xl border border-line max-h-[90dvh] overflow-y-auto overscroll-contain focus:outline-none`}
      >
        <div className="flex items-center justify-between gap-2 border-b border-line-soft py-1.5 pl-5 pr-2">
          <h2 id={titleId} className="min-w-0 break-words text-dialog text-ink">{title}</h2>
          <button
            type="button"
            onClick={requestClose}
            aria-label="Fechar janela"
            className="inline-flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-control text-ink-muted transition-colors hover:bg-surface-muted hover:text-ink-soft"
          >
            <X className="w-5 h-5" aria-hidden="true" />
          </button>
        </div>
        <div ref={contentRef} className="p-5">
          <UnsavedChangesContext.Provider value={declared}>{children}</UnsavedChangesContext.Provider>
        </div>
      </div>
    </div>
    {askingDiscard && (
      <Modal title="Descartar alterações?" onClose={() => answerDiscard(false)} testId="confirmacao">
        <DiscardBody onAnswer={answerDiscard} />
      </Modal>
    )}
    </>
  );
}
