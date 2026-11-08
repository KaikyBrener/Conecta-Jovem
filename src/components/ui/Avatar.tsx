import { cn } from '../../lib/utils';

const TONES = [
  'bg-avatar-1 text-avatar-1-ink',
  'bg-avatar-2 text-avatar-2-ink',
  'bg-avatar-3 text-avatar-3-ink',
  'bg-avatar-4 text-avatar-4-ink',
] as const;

const SIZES = {
  sm: 'h-8 w-8 text-label',
  md: 'h-9 w-9 text-sm',
  lg: 'h-10 w-10 text-base',
} as const;

/** Matiz estável por nome: a mesma pessoa tem sempre a mesma cor, em qualquer tela. */
function avatarTone(name: string): number {
  let sum = 0;
  for (const ch of name.trim().toLowerCase()) sum += ch.codePointAt(0) ?? 0;
  return sum % TONES.length;
}

interface AvatarProps {
  /** Nome de quem (ou do que) o avatar representa; a inicial e a cor saem dele */
  name: string;
  size?: keyof typeof SIZES;
  /** `circle` para pessoas, `square` para grupos */
  shape?: 'circle' | 'square';
  className?: string;
}

/**
 * Inicial colorida. É decorativa: o nome já aparece em texto ao lado, então fica fora da árvore de
 * acessibilidade. A cor nunca carrega significado de estado.
 */
export function Avatar({ name, size = 'md', shape = 'circle', className }: AvatarProps) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'inline-flex flex-shrink-0 items-center justify-center font-semibold uppercase',
        shape === 'circle' ? 'rounded-full' : 'rounded-card',
        SIZES[size],
        TONES[avatarTone(name)],
        className,
      )}
    >
      {name.trim().charAt(0)}
    </span>
  );
}
