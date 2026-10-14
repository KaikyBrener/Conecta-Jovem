import { Children, isValidElement, type ReactNode } from 'react';
import { cn } from '../../lib/utils';

/** `muted` = apagado (Cancelado, Não registrado: não contam na frequência). `indigo` é legado e cai no azul. */
export type BadgeColor = 'gray' | 'muted' | 'blue' | 'green' | 'amber' | 'red' | 'indigo';

const COLOR_CLS: Record<BadgeColor, { box: string; dot: string }> = {
  gray: { box: 'border-line bg-surface-muted text-ink-soft', dot: 'bg-ink-faint' },
  muted: { box: 'border-line bg-surface text-ink-muted', dot: 'bg-line-strong' },
  blue: { box: 'border-action-line bg-action-soft text-action-ink', dot: 'bg-action' },
  green: { box: 'border-success-line bg-success-soft text-success-ink', dot: 'bg-success' },
  amber: { box: 'border-warning-line bg-warning-soft text-warning-ink', dot: 'bg-warning' },
  red: { box: 'border-danger-line bg-danger-soft text-danger-ink', dot: 'bg-danger' },
  indigo: { box: 'border-action-line bg-action-soft text-action-ink', dot: 'bg-action' },
};

interface BadgeProps {
  color?: BadgeColor;
  /** Ponto de cor antes do texto. Padrão: ligado, exceto quando o conteúdo já traz um ícone. */
  dot?: boolean;
  className?: string;
  children: ReactNode;
}

/**
 * Tag do design system: 20px de altura, raio 4, ponto de cor + texto. A cor nunca é o único sinal: o texto
 * sempre diz o estado.
 */
export function Badge({ color = 'gray', dot, className, children }: BadgeProps) {
  const c = COLOR_CLS[color];
  const showDot = dot ?? !Children.toArray(children).some(isValidElement);
  return (
    <span
      className={cn(
        'inline-flex h-5 items-center gap-1.5 whitespace-nowrap rounded-tag border px-2 text-xs font-medium leading-none',
        c.box,
        className,
      )}
    >
      {showDot && <span className={cn('h-1.5 w-1.5 flex-shrink-0 rounded-full', c.dot)} aria-hidden="true" />}
      {children}
    </span>
  );
}

/** Mesmo componente com o nome usado no design system. */
export { Badge as Tag };
