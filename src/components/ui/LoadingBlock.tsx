import { Loader2 } from 'lucide-react';
import { cn } from '../../lib/utils';

export function LoadingBlock({ size = 'lg' }: { size?: 'sm' | 'lg' }) {
  return (
    <div className={cn('flex items-center justify-center gap-2.5 text-label text-ink-muted', size === 'lg' ? 'py-16' : 'py-6')} role="status" aria-label="Carregando">
      <Loader2
        className={cn('text-action animate-spin motion-reduce:animate-none', size === 'lg' ? 'w-5 h-5' : 'w-4 h-4')}
        aria-hidden="true"
      />
      <span aria-hidden="true">Carregando...</span>
    </div>
  );
}
