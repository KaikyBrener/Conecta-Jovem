import { ChevronLeft, ChevronRight } from 'lucide-react';
import { pageSummary } from '../../lib/pagination';

interface PaginationProps {
  page: number;
  totalPages: number;
  total: number;
  pageSize: number;
  onPageChange: (page: number) => void;
  /** Substantivo para o resumo: "jovens", "encontros"... */
  noun: string;
  disabled?: boolean;
}

const btnCls =
  'inline-flex items-center justify-center gap-1 px-3 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500';

/** Navegação de páginas. Some quando tudo cabe em uma página. Empilha no mobile. */
export function Pagination({ page, totalPages, total, pageSize, onPageChange, noun, disabled }: PaginationProps) {
  if (total <= pageSize) return null;
  const { first, last } = pageSummary(page, total, pageSize);

  return (
    <nav aria-label="Paginação" className="flex flex-col sm:flex-row items-center justify-between gap-3 pt-1">
      <p className="text-sm text-gray-500" aria-live="polite">
        Mostrando {first}–{last} de {total} {noun}
      </p>
      <div className="flex items-center gap-2">
        <button type="button" onClick={() => onPageChange(page - 1)} disabled={disabled || page <= 1} className={btnCls}>
          <ChevronLeft className="w-4 h-4" aria-hidden="true" /> Anterior
        </button>
        <span className="px-2 text-sm text-gray-600 tabular-nums">
          Página {page} de {totalPages}
        </span>
        <button type="button" onClick={() => onPageChange(page + 1)} disabled={disabled || page >= totalPages} className={btnCls}>
          Próxima <ChevronRight className="w-4 h-4" aria-hidden="true" />
        </button>
      </div>
    </nav>
  );
}
