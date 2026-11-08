import { cn } from '../../lib/utils';

interface ProgressBarProps {
  /** Percentual de 0 a 100 (fora disso, é limitado) */
  value: number;
  /** Largura mínima visível, em %, para um valor pequeno não sumir (ex.: 2) */
  min?: number;
  className?: string;
}

/**
 * Barra fina de progresso (um só tom). É desenhada em SVG, com a largura em atributo de apresentação: o projeto não
 * usa o atributo `style` (a CSP só aceita `style-src 'self'`). É decorativa (`aria-hidden`): o valor sempre aparece
 * em texto ao lado ou o contêiner leva `role="progressbar"`.
 */
export function ProgressBar({ value, min = 0, className }: ProgressBarProps) {
  const pct = Math.min(100, Math.max(min, Number.isFinite(value) ? value : 0));
  return (
    <svg
      width="100%"
      height="6"
      aria-hidden="true"
      focusable="false"
      className={cn('block h-1.5 w-full overflow-hidden rounded-full', className)}
    >
      <rect width="100%" height="6" className="fill-line-soft" />
      <rect width={`${pct}%`} height="6" className="fill-action" />
    </svg>
  );
}
