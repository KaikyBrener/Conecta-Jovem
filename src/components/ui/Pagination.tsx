import { ChevronLeft, ChevronRight } from 'lucide-react';
import { secondaryBtnCls } from '../../lib/formStyles';
import { cn } from '../../lib/utils';
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

/* 44px no celular (alvo de toque), 34px no desktop */
const pageBtnCls = cn(secondaryBtnCls, 'gap-1 px-3 md:min-h-[34px]');

/** Navegação de páginas. Some quando tudo cabe em uma página. Empilha no mobile. */
export function Pagination({ page, totalPages, total, pageSize, onPageChange, noun, disabled }: PaginationProps) {
  if (total <= pageSize) return null;
  const { first, last } = pageSummary(page, total, pageSize);

  return (
    <nav aria-label="Paginação" className="flex flex-col sm:flex-row items-center justify-between gap-3 pt-1">
      <p className="text-label text-ink-muted" aria-live="polite">
        Mostrando {first}–{last} de {total} {noun}
      </p>
      <div className="flex items-center gap-2">
        <button type="button" onClick={() => onPageChange(page - 1)} disabled={disabled || page <= 1} className={pageBtnCls}>
          <ChevronLeft className="w-4 h-4" aria-hidden="true" /> Anterior
        </button>
        <span className="whitespace-nowrap px-1.5 text-label text-ink-soft">
          Página {page} de {totalPages}
        </span>
        <button type="button" onClick={() => onPageChange(page + 1)} disabled={disabled || page >= totalPages} className={pageBtnCls}>
          Próxima <ChevronRight className="w-4 h-4" aria-hidden="true" />
        </button>
      </div>
    </nav>
  );
}
