import type { ReactNode } from 'react';

interface EmptyStateProps {
  icon: React.ElementType;
  title: string;
  action?: ReactNode;
  /** Usar dentro de um contêiner que já tem fundo/borda (ex.: dentro de uma tabela) */
  bare?: boolean;
}

export function EmptyState({ icon: Icon, title, action, bare = false }: EmptyStateProps) {
  return (
    <div className={bare ? 'px-4 py-10 text-center text-ink-muted' : 'rounded-card border border-line bg-surface px-4 py-12 text-center text-ink-muted'}>
      <Icon className="mx-auto mb-3 h-8 w-8 text-line-strong" strokeWidth={1.7} aria-hidden="true" />
      <p className="text-sm font-medium text-ink">{title}</p>
      {action}
    </div>
  );
}
