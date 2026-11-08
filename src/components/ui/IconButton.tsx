import type { ButtonHTMLAttributes, ElementType } from 'react';
import { Loader2 } from 'lucide-react';
import { cn } from '../../lib/utils';
import { iconBtnCls } from '../../lib/formStyles';

type Tone = 'neutral' | 'action' | 'danger' | 'success';

const toneCls: Record<Tone, string> = {
  neutral: 'text-ink-muted hover:bg-surface-muted hover:text-ink',
  action: 'text-ink-muted hover:bg-action-soft hover:text-action-ink',
  danger: 'text-danger hover:bg-danger-soft hover:text-danger-ink',
  success: 'text-success hover:bg-success-soft hover:text-success-ink',
};

interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'aria-label' | 'children'> {
  /** Nome acessível, obrigatório: botão só com ícone precisa dizer o que faz. Também vira a dica (title). */
  label: string;
  icon: ElementType<{ className?: string; strokeWidth?: number; 'aria-hidden'?: boolean | 'true' | 'false' }>;
  tone?: Tone;
  /** Troca o ícone por um indicador de carregamento (o botão continua com o mesmo nome) */
  busy?: boolean;
}

/**
 * Botão só com ícone. Alvo de toque de 44px no celular e 34px no desktop; o ícone é decorativo
 * (o nome vem de `label`).
 */
export function IconButton({ label, icon, tone = 'neutral', busy = false, className, type = 'button', ...rest }: IconButtonProps) {
  const Icon = busy ? Loader2 : icon;
  return (
    <button
      type={type}
      aria-label={label}
      title={label}
      {...rest}
      className={cn(iconBtnCls, toneCls[tone], 'disabled:cursor-not-allowed disabled:opacity-40', className)}
    >
      <Icon className={cn('h-4 w-4', busy && 'animate-spin')} strokeWidth={1.7} aria-hidden="true" />
    </button>
  );
}
