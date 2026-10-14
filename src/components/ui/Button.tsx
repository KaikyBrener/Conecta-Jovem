import type { ButtonHTMLAttributes, ElementType, ReactNode } from 'react';
import { Loader2 } from 'lucide-react';
import { cn } from '../../lib/utils';
import {
  dangerBtnCls, dangerOutlineBtnCls, ghostBtnCls, primaryBtnCls, secondaryBtnCls,
  smallBtnCls, smallDangerBtnCls, smallGhostBtnCls, smallPrimaryBtnCls,
} from '../../lib/formStyles';

type Variant = 'primary' | 'secondary' | 'danger' | 'danger-outline' | 'ghost';
type Size = 'md' | 'sm';

const CLS: Record<Size, Record<Variant, string>> = {
  md: {
    primary: primaryBtnCls,
    secondary: secondaryBtnCls,
    danger: dangerBtnCls,
    'danger-outline': dangerOutlineBtnCls,
    ghost: ghostBtnCls,
  },
  sm: {
    primary: smallPrimaryBtnCls,
    secondary: smallBtnCls,
    // no tamanho pequeno a ação destrutiva é sempre em contorno (o vermelho cheio fica para a confirmação)
    danger: smallDangerBtnCls,
    'danger-outline': smallDangerBtnCls,
    ghost: smallGhostBtnCls,
  },
};

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** primária (uma por janela ou bloco), secundária, destrutiva, destrutiva em contorno ou fantasma (link) */
  variant?: Variant;
  /** md = 36px no desktop e 44px no celular; sm = 30px */
  size?: Size;
  /** Ícone à esquerda do texto (lucide-react) */
  icon?: ElementType;
  /** Mostra o indicador de envio no lugar do ícone e desabilita o botão */
  loading?: boolean;
  children: ReactNode;
}

/** Botão do design system. `type` é "button" por padrão: passe "submit" nos formulários. */
export function Button({
  variant = 'secondary', size = 'md', icon: Icon, loading = false, disabled, className, children, type = 'button', ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cn(CLS[size][variant], className)}
      {...rest}
    >
      {loading
        ? <Loader2 className="h-4 w-4 flex-shrink-0 animate-spin motion-reduce:animate-none" aria-hidden="true" />
        : Icon && <Icon className="h-4 w-4 flex-shrink-0" aria-hidden="true" />}
      {children}
    </button>
  );
}
