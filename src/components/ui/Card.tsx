import type { ReactNode } from 'react';
import { cn } from '../../lib/utils';

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('bg-white border border-gray-200 rounded-xl', className)}>{children}</div>;
}
