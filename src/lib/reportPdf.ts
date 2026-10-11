import { jsPDF } from 'jspdf';
import { autoTable } from 'jspdf-autotable';
import { downloadBlob } from './csv';
import { generatedAtLabel, toPdfText, type ExportDoc } from './reportExport';

// Desenho do PDF (jsPDF + jspdf-autotable), executado no navegador, sem serviço externo.
// Este módulo é carregado por import() dinâmico SÓ ao exportar (ver pages/Relatorios): jsPDF não entra no
// bundle principal. Toda a montagem dos dados está em lib/reportExport.ts (pura e testada); aqui só se desenha.

const MARGIN_X = 14;
const TOP_FIRST = 16;
const TOP_NEXT = 24;
const BOTTOM = 20;

const BLUE: [number, number, number] = [37, 99, 235];
const INK: [number, number, number] = [17, 24, 39];
const MUTED: [number, number, number] = [107, 114, 128];
const LINE: [number, number, number] = [209, 213, 219];
const ZEBRA: [number, number, number] = [243, 244, 246];

export const CONFIDENTIAL_FOOTER = 'Documento confidencial — contém dados pessoais';

const t = toPdfText;

/** Monta o PDF (documento jsPDF) a partir do documento de exportação. */
export function buildReportPdf(doc: ExportDoc, generatedAt: Date): jsPDF {
  const pdf = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' });
  pdf.setProperties({ title: t(`${doc.title} - ConectJovem`), author: 'ConectJovem', creator: 'ConectJovem' });
  const pageW = pdf.internal.pageSize.getWidth();
  const pageH = pdf.internal.pageSize.getHeight();
  const contentW = pageW - MARGIN_X * 2;

  // ── Cabeçalho (primeira página) ──
  let y = TOP_FIRST;
  pdf.setFont('helvetica', 'bold').setFontSize(10).setTextColor(...BLUE);
  pdf.text('ConectJovem', MARGIN_X, y);
  y += 8;
  pdf.setFont('helvetica', 'bold').setFontSize(18).setTextColor(...INK);
  pdf.text(t(doc.title), MARGIN_X, y);
  y += 7;
  pdf.setFont('helvetica', 'normal').setFontSize(10).setTextColor(...MUTED);
  for (const m of [...doc.meta, { label: 'Gerado em', value: generatedAtLabel(generatedAt) }]) {
    const lines = pdf.splitTextToSize(t(`${m.label}: ${m.value}`), contentW) as string[];
    pdf.text(lines, MARGIN_X, y);
    y += 4.8 * lines.length;
  }
  y += 1;
  pdf.setDrawColor(...LINE).setLineWidth(0.3).line(MARGIN_X, y, pageW - MARGIN_X, y);
  y += 6;

  // y final da última tabela desenhada (capturado pelo gancho de página: a tabela pode ter virado de página)
  let endY = y;
  const margin = { top: TOP_NEXT, left: MARGIN_X, right: MARGIN_X, bottom: BOTTOM };
  const common = {
    margin,
    styles: { font: 'helvetica', fontSize: 8.5, cellPadding: 1.8, textColor: INK, lineColor: LINE, lineWidth: 0.1, overflow: 'linebreak' as const },
    didDrawPage: (data: { cursor: { y: number } | null }) => {
      if (data.cursor) endY = data.cursor.y;
    },
  };
  const ensureRoom = (needed: number) => {
    if (endY + needed > pageH - BOTTOM) {
      pdf.addPage();
      endY = TOP_NEXT;
    }
  };
  const heading = (text: string) => {
    ensureRoom(26);
    pdf.setFont('helvetica', 'bold').setFontSize(11).setTextColor(...INK);
    pdf.text(t(text), MARGIN_X, endY);
    endY += 2.5;
  };

  // ── Resumo no topo: pares rótulo/valor em 2 colunas ──
  if (doc.summary.length) {
    heading('Resumo');
    const body: string[][] = [];
    for (let i = 0; i < doc.summary.length; i += 2) {
      const a = doc.summary[i];
      const b = doc.summary[i + 1];
      body.push([t(a.label), t(a.value), b ? t(b.label) : '', b ? t(b.value) : '']);
    }
    autoTable(pdf, {
      ...common,
      startY: endY,
      body,
      theme: 'plain',
      styles: { ...common.styles, fontSize: 9, cellPadding: { top: 2, bottom: 2, left: 2.5, right: 2.5 } },
      columnStyles: {
        0: { textColor: MUTED, cellWidth: contentW * 0.27 },
        1: { fontStyle: 'bold', cellWidth: contentW * 0.23 },
        2: { textColor: MUTED, cellWidth: contentW * 0.27 },
        3: { fontStyle: 'bold', cellWidth: contentW * 0.23 },
      },
      didParseCell: (data) => {
        data.cell.styles.fillColor = ZEBRA;
        data.cell.styles.lineWidth = 0;
      },
    });
    endY += 7;
  }

  // ── Tabelas ──
  for (const table of doc.tables) {
    heading(table.title);
    const empty = table.rows.length === 0;
    autoTable(pdf, {
      ...common,
      startY: endY,
      head: [table.headers.map(t)],
      body: empty
        ? [[{ content: t(table.emptyText || 'Sem registros.'), colSpan: table.headers.length, styles: { textColor: MUTED, fontStyle: 'italic' as const } }]]
        : table.rows.map((r) => r.map(t)),
      theme: 'grid',
      headStyles: { fillColor: BLUE, textColor: 255, fontStyle: 'bold' },
      alternateRowStyles: { fillColor: ZEBRA },
      showHead: 'everyPage',
    });
    endY += 2;
    if (table.note) {
      ensureRoom(8);
      pdf.setFont('helvetica', 'italic').setFontSize(8).setTextColor(...MUTED);
      const lines = pdf.splitTextToSize(t(table.note), contentW) as string[];
      pdf.text(lines, MARGIN_X, endY + 2);
      endY += 3.5 * lines.length + 1;
    }
    endY += 6;
  }

  // ── Observações ──
  if (doc.notes.length) {
    heading('Observações');
    pdf.setFont('helvetica', 'normal').setFontSize(8.5).setTextColor(...MUTED);
    for (const note of doc.notes) {
      const lines = pdf.splitTextToSize(t(note), contentW) as string[];
      ensureRoom(4 * lines.length + 4);
      pdf.text(lines, MARGIN_X, endY + 3);
      endY += 4 * lines.length + 1.5;
    }
  }

  // ── Cabeçalho das páginas seguintes, rodapé e "Página x de y" (só no final, quando o total é conhecido) ──
  const total = pdf.getNumberOfPages();
  for (let page = 1; page <= total; page += 1) {
    pdf.setPage(page);
    if (page > 1) {
      pdf.setFont('helvetica', 'normal').setFontSize(8).setTextColor(...MUTED);
      pdf.text(t(`ConectJovem · ${doc.title}`), MARGIN_X, 12);
      pdf.setDrawColor(...LINE).setLineWidth(0.2).line(MARGIN_X, 14.5, pageW - MARGIN_X, 14.5);
    }
    pdf.setDrawColor(...LINE).setLineWidth(0.2).line(MARGIN_X, pageH - 14, pageW - MARGIN_X, pageH - 14);
    pdf.setFont('helvetica', 'normal').setFontSize(8).setTextColor(...MUTED);
    pdf.text(t(CONFIDENTIAL_FOOTER), MARGIN_X, pageH - 9.5);
    pdf.text(`Página ${page} de ${total}`, pageW - MARGIN_X, pageH - 9.5, { align: 'right' });
  }
  return pdf;
}

/** Gera e baixa o PDF. O nome do arquivo vem do documento (nunca contém dados pessoais). */
export function downloadReportPdf(doc: ExportDoc, generatedAt: Date = new Date()): void {
  const pdf = buildReportPdf(doc, generatedAt);
  downloadBlob(`${doc.filenameBase}.pdf`, pdf.output('blob'));
}
