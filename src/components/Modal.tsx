import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { X } from 'lucide-react';

interface ModalProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  /** `lg` = janela larga (ficha do jovem, 760px). Padrão: 512px. No celular é sempre folha inferior. */
  size?: 'md' | 'lg';
  /** data-testid do elemento role="dialog" */
  testId?: string;
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

/**
 * Janela de diálogo (no celular, folha inferior). Teclado e foco:
 * - Esc fecha a janela do topo (menos quando o foco está num <select>, onde o Esc fecha a lista de opções);
 * - o foco entra na janela ao abrir, fica preso nela com Tab/Shift+Tab e volta a quem abriu ao fechar;
 * - o fundo não rola; clicar fora só fecha se o clique começou e terminou fora (arrastar um texto não fecha).
 */
export function Modal({ title, onClose, children, size = 'md', testId }: ModalProps) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  const pressedOnBackdrop = useRef(false);
  // lidos na primeira renderização, antes de qualquer efeito (filhos, como a confirmação, mexem no foco depois)
  const [order] = useState(() => ++openingSeq);
  const [opener] = useState(() => (document.activeElement instanceof HTMLElement ? document.activeElement : null));

  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);

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
        onCloseRef.current();
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
  }, [order]);

  return (
    <div
      className="fixed inset-0 z-[60] flex items-end sm:items-center justify-center p-0 sm:p-4 bg-navy-950/60"
      onMouseDown={(e) => { pressedOnBackdrop.current = e.target === e.currentTarget; }}
      onClick={(e) => {
        const closes = pressedOnBackdrop.current && e.target === e.currentTarget;
        pressedOnBackdrop.current = false;
        if (closes) onClose();
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
            onClick={onClose}
            aria-label="Fechar janela"
            className="inline-flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-control text-ink-muted transition-colors hover:bg-surface-muted hover:text-ink-soft"
          >
            <X className="w-5 h-5" aria-hidden="true" />
          </button>
        </div>
        <div ref={contentRef} className="p-5">{children}</div>
      </div>
    </div>
  );
}
