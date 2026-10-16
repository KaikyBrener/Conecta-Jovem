import { useState, type ReactNode } from 'react';
import { Download, FileText, Loader2 } from 'lucide-react';
import { ErrorBanner } from '../ErrorBanner';
import { LoadingBlock } from '../ui/LoadingBlock';
import { RefreshingNote } from '../ui/RefreshingNote';
import { useToast } from '../../contexts/ToastContext';
import { downloadCsv } from '../../lib/csv';
import { errorMessage } from '../../lib/format';
import { docToCsv, type ExportDoc } from '../../lib/reportExport';
import { secondaryBtnCls } from '../../lib/formStyles';
import type { DateRange } from '../../lib/periods';

/** Propriedades comuns das abas de relatório */
export interface ReportTabProps {
  /** null = período inválido (nada é consultado; a página mostra o motivo) */
  range: DateRange | null;
  /** null = todos os grupos do escopo */
  groupId: string | null;
  groupName: string | null;
  /** "Todos os grupos" (coordenador) ou "Todos os seus grupos" (líder), usado nos arquivos exportados */
  allGroupsLabel: string;
}

type Busy = 'csv' | 'pdf' | null;

/** Botões de exportação. O documento é montado só no clique, a partir do que o servidor devolveu (já filtrado pelo RLS). */
function ExportButtons({ getDoc, disabled }: { getDoc: () => ExportDoc; disabled: boolean }) {
  const toast = useToast();
  const [busy, setBusy] = useState<Busy>(null);

  const exportCsv = () => {
    try {
      const doc = getDoc();
      downloadCsv(`${doc.filenameBase}.csv`, docToCsv(doc, new Date()));
      toast.success('Arquivo CSV gerado.');
    } catch (err: unknown) {
      toast.error(errorMessage(err, 'Erro ao gerar o CSV.'));
    }
  };

  const exportPdf = async () => {
    setBusy('pdf');
    try {
      const doc = getDoc();
      // jsPDF é grande: só é baixado quando alguém exporta
      const { downloadReportPdf } = await import('../../lib/reportPdf');
      downloadReportPdf(doc, new Date());
      toast.success('Arquivo PDF gerado.');
    } catch (err: unknown) {
      toast.error(errorMessage(err, 'Erro ao gerar o PDF.'));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Exportar relatório">
      <button type="button" onClick={exportCsv} disabled={disabled} data-testid="exportar-csv" aria-label="Exportar CSV" className={secondaryBtnCls}>
        <Download className="w-4 h-4" aria-hidden="true" /> Exportar CSV
      </button>
      <button type="button" onClick={() => void exportPdf()} disabled={disabled || busy === 'pdf'} data-testid="exportar-pdf" aria-label="Exportar PDF" className={secondaryBtnCls}>
        {busy === 'pdf' ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> : <FileText className="w-4 h-4" aria-hidden="true" />}
        Exportar PDF
      </button>
    </div>
  );
}

interface ReportShellProps<T> {
  state: { data: T | null; loading: boolean; error: string | null };
  /** Monta o documento exportado (CSV/PDF) a partir dos dados */
  build: (data: T) => ExportDoc;
  children: (data: T) => ReactNode;
}

/**
 * Casca comum das abas: erro (banner), carregando, exportação e conteúdo. Mantém o resultado anterior na tela,
 * esmaecido, enquanto o novo carrega.
 */
export function ReportShell<T>({ state, build, children }: ReportShellProps<T>) {
  const { data, loading, error } = state;
  return (
    <div className="space-y-4" aria-busy={loading}>
      <ErrorBanner message={error} />
      {loading && !data && <LoadingBlock />}
      {data && (
        <>
          <div className="flex justify-end">
            <ExportButtons getDoc={() => build(data)} disabled={loading} />
          </div>
          <div className={loading ? 'space-y-4 opacity-60 transition-opacity' : 'space-y-4'}>{children(data)}</div>
          <RefreshingNote show={loading} />
        </>
      )}
    </div>
  );
}
