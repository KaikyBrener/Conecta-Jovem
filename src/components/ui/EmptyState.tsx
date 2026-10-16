import type { ReactNode } from 'react';

interface EmptyStateProps {
  icon: React.ElementType;
  title: string;
  /** Frase curta abaixo do título (o que aparece ali / o que fazer) */
  hint?: string;
  action?: ReactNode;
  /** Usar dentro de um contêiner que já tem fundo/borda (ex.: dentro de uma tabela) */
  bare?: boolean;
}

/** Estado vazio do DS-5: ícone num círculo de 44px, título 14.5/600, ajuda opcional e, se houver, uma ação. */
export function EmptyState({ icon: Icon, title, hint, action, bare = false }: EmptyStateProps) {
  return (
    <div
      className={
        bare
          ? 'flex flex-col items-center gap-1.5 px-4 py-7 text-center'
          : 'flex flex-col items-center gap-1.5 rounded-card border border-line bg-surface px-4 py-7 text-center'
      }
    >
      <div className="mb-1.5 flex h-11 w-11 items-center justify-center rounded-full bg-surface-muted text-ink-faint" aria-hidden="true">
        <Icon className="h-[22px] w-[22px]" strokeWidth={1.5} />
      </div>
      <p className="max-w-[420px] text-[0.90625rem] font-semibold text-ink">{title}</p>
      {hint && <p className="max-w-[420px] text-label text-ink-muted">{hint}</p>}
      {action}
    </div>
  );
}
