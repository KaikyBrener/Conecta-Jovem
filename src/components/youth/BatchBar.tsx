import { Download, UserCheck, UserX, UsersRound, X } from 'lucide-react';
import { BATCH_MAX } from '../../lib/batch';
import { secondaryBtnCls } from '../../lib/formStyles';

interface BatchBarProps {
  count: number;
  busy: boolean;
  atLimit: boolean;
  /** Erro da última ação em lote, mostrado junto à barra (a lista pode estar fora da tela) */
  error?: string | null;
  onChangeGroup: () => void;
  onActivate: () => void;
  onDeactivate: () => void;
  onExport: () => void;
  onClear: () => void;
}

/** Barra de ações em lote dos jovens selecionados. Fixa acima da navegação inferior no mobile. */
export function BatchBar({ count, busy, atLimit, error, onChangeGroup, onActivate, onDeactivate, onExport, onClear }: BatchBarProps) {
  return (
    <div
      role="region"
      aria-label="Ações em lote"
      data-testid="lote-barra"
      className="sticky bottom-20 md:bottom-4 z-20 rounded-xl border border-blue-200 bg-white p-3 shadow-lg"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
        <p className="text-sm font-semibold text-gray-900" role="status" data-testid="lote-contador">
          {count === 1 ? '1 selecionado' : `${count} selecionados`}
          {atLimit && <span className="ml-2 text-xs font-normal text-amber-700">Limite de {BATCH_MAX} por lote.</span>}
        </p>
        <button
          type="button"
          onClick={onClear}
          className="inline-flex items-center gap-1 text-xs font-medium text-gray-600 hover:text-gray-900 rounded px-1 py-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
          data-testid="lote-limpar"
        >
          <X className="w-3.5 h-3.5" aria-hidden="true" /> Limpar seleção
        </button>
      </div>
      {error && <p role="alert" className="mb-2 text-sm text-red-700">{error}</p>}
      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={onChangeGroup} disabled={busy} className={secondaryBtnCls} data-testid="lote-alterar-grupo">
          <UsersRound className="w-4 h-4" aria-hidden="true" /> Alterar grupo
        </button>
        <button type="button" onClick={onActivate} disabled={busy} className={secondaryBtnCls} data-testid="lote-ativar">
          <UserCheck className="w-4 h-4" aria-hidden="true" /> Ativar
        </button>
        <button type="button" onClick={onDeactivate} disabled={busy} className={secondaryBtnCls} data-testid="lote-desativar">
          <UserX className="w-4 h-4" aria-hidden="true" /> Desativar
        </button>
        <button type="button" onClick={onExport} disabled={busy} className={secondaryBtnCls} data-testid="lote-exportar">
          <Download className="w-4 h-4" aria-hidden="true" /> Exportar CSV
        </button>
      </div>
    </div>
  );
}
