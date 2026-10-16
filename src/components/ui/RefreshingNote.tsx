import { Loader2 } from 'lucide-react';

/**
 * "Atualizando…" do DS-5: aparece abaixo de uma lista que já tem resultado enquanto a nova consulta (filtro ou
 * página) não termina. O resultado anterior continua na tela, esmaecido pela própria lista.
 */
export function RefreshingNote({ show }: { show: boolean }) {
  if (!show) return null;
  return (
    <div role="status" className="flex items-center gap-2 px-1 text-caption text-ink-muted" data-testid="lista-atualizando">
      <Loader2 className="h-3.5 w-3.5 flex-shrink-0 animate-spin text-action motion-reduce:animate-none" aria-hidden="true" />
      Atualizando…
    </div>
  );
}
