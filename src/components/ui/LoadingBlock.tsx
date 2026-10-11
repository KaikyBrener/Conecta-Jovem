import { Loader2 } from 'lucide-react';
import { cn } from '../../lib/utils';

export function LoadingBlock({ size = 'lg' }: { size?: 'sm' | 'lg' }) {
  return (
    <div className={size === 'lg' ? 'flex justify-center py-16' : 'flex justify-center py-6'} role="status" aria-label="Carregando">
      <Loader2
        className={cn('text-blue-600 animate-spin motion-reduce:animate-none', size === 'lg' ? 'w-6 h-6' : 'w-5 h-5')}
        aria-hidden="true"
      />
    </div>
  );
}
