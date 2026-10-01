import { Loader2 } from 'lucide-react';

export function LoadingBlock({ size = 'lg' }: { size?: 'sm' | 'lg' }) {
  return (
    <div className={size === 'lg' ? 'flex justify-center py-16' : 'flex justify-center py-6'}>
      <Loader2 className={size === 'lg' ? 'w-6 h-6 text-blue-600 animate-spin' : 'w-5 h-5 text-blue-600 animate-spin'} />
    </div>
  );
}
