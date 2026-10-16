import { useId, type ReactNode } from 'react';
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

export function Modal({ title, onClose, children, size = 'md', testId }: ModalProps) {
  const titleId = useId();
  return (
    <div
      className="fixed inset-0 z-[60] flex items-end sm:items-center justify-center p-0 sm:p-4 bg-navy-950/60"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-testid={testId}
        className={`bg-surface w-full ${size === 'lg' ? 'sm:max-w-[47.5rem]' : 'sm:max-w-lg'} rounded-t-sheet sm:rounded-sheet shadow-xl border border-line max-h-[90vh] overflow-y-auto`}
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
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}
