import type { ReactNode } from 'react';

export type BadgeColor = 'gray' | 'blue' | 'green' | 'amber' | 'red' | 'indigo';

const COLOR_CLS: Record<BadgeColor, string> = {
  gray: 'bg-gray-100 text-gray-600',
  blue: 'bg-blue-50 text-blue-700',
  green: 'bg-green-50 text-green-700',
  amber: 'bg-amber-50 text-amber-700',
  red: 'bg-red-50 text-red-700',
  indigo: 'bg-indigo-50 text-indigo-700',
};

interface BadgeProps {
  color?: BadgeColor;
  children: ReactNode;
}

export function Badge({ color = 'gray', children }: BadgeProps) {
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium whitespace-nowrap ${COLOR_CLS[color]}`}>
      {children}
    </span>
  );
}
