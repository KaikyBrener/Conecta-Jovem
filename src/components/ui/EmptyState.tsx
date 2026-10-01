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
    <div className={bare ? 'text-center py-12 text-gray-400' : 'text-center py-16 text-gray-400 bg-white border border-gray-200 rounded-xl'}>
      <Icon className="w-10 h-10 mx-auto mb-3 opacity-40" />
      <p className="text-sm">{title}</p>
      {action}
    </div>
  );
}
