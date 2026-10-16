import type { ReactNode } from 'react';
import { CircleAlert, CircleCheck, Info, TriangleAlert } from 'lucide-react';
import { cn } from '../lib/utils';

type BannerTone = 'error' | 'warning' | 'info' | 'success';

const TONES: Record<BannerTone, { cls: string; icon: React.ElementType }> = {
  error: { cls: 'border-danger-line bg-danger-soft text-danger-ink', icon: CircleAlert },
  warning: { cls: 'border-warning-line bg-warning-soft text-warning-ink', icon: TriangleAlert },
  info: { cls: 'border-action-line bg-action-soft text-action-ink', icon: Info },
  success: { cls: 'border-success-line bg-success-soft text-success-ink', icon: CircleCheck },
};

interface BannerProps {
  tone: BannerTone;
  children: ReactNode;
  /** Botão ou link à direita ("Tentar novamente") */
  action?: ReactNode;
  id?: string;
  className?: string;
  testId?: string;
}

/**
 * Faixa de aviso do design system: erro (role="alert", anunciado na hora), aviso, informação e sucesso
 * (role="status"). Sempre ícone + texto; a cor nunca é o único sinal.
 */
export function Banner({ tone, children, action, id, className, testId }: BannerProps) {
  const { cls, icon: Icon } = TONES[tone];
  return (
    <div
      id={id}
      role={tone === 'error' ? 'alert' : 'status'}
      data-testid={testId}
      className={cn('flex items-start gap-2.5 rounded-control border px-3.5 py-2.5 text-table', cls, className)}
    >
      <Icon className="mt-0.5 h-4 w-4 flex-shrink-0" aria-hidden="true" />
      <div className="min-w-0 flex-1">{children}</div>
      {action && <div className="flex-shrink-0">{action}</div>}
    </div>
  );
}

export function ErrorBanner({ message }: { message: string | null | undefined }) {
  if (!message) return null;
  return <Banner tone="error">{message}</Banner>;
}

export function SuccessBanner({ message }: { message: string | null | undefined }) {
  if (!message) return null;
  return <Banner tone="success">{message}</Banner>;
}
