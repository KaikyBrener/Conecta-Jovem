import { describe, expect, it } from 'vitest';
import { buildReportPdf } from './reportPdf';
import type { ExportDoc } from './reportExport';

// Sem DOM: só verifica o conteúdo gerado (a fonte padrão do PDF grava Latin-1 puro, então os acentos podem ser
// conferidos nos bytes do arquivo).

function doc(rows: number): ExportDoc {
  return {
    kind: 'attendance',
    title: 'Relatório de frequência',
    filenameBase: 'relatorio-frequencia_2026-09-04_a_2026-10-03',
    meta: [
      { label: 'Período', value: '04/09/2026 a 03/10/2026' },
      { label: 'Grupo', value: 'Todos os grupos' },
    ],
    summary: [
      { label: 'Frequência', value: '75%' },
      { label: 'Presenças', value: '60' },
      { label: 'Faltas', value: '20' },
    ],
    tables: [
      {
        title: 'Frequência por encontro',
        headers: ['Encontro', 'Presentes', 'Frequência'],
        rows: Array.from({ length: rows }, (_, i) => [`Reunião ação ${i + 1}`, String(i), '75%']),
        emptyText: 'Nenhum encontro no período.',
        note: 'Mostrando 1 de 51 jovens.',
      },
      { title: 'Vazia', headers: ['A', 'B'], rows: [], emptyText: 'Nada por aqui.' },
    ],
    notes: ['Observação de teste.'],
  };
}

function latin1(buf: ArrayBuffer): string {
  let out = '';
  for (const b of new Uint8Array(buf)) out += String.fromCharCode(b);
  return out;
}

describe('buildReportPdf', () => {
  const at = new Date('2026-10-03T13:05:00Z');

  it('gera um PDF válido com cabeçalho, rodapé e paginação "Página x de y"', () => {
    const pdf = buildReportPdf(doc(3), at);
    const text = latin1(pdf.output('arraybuffer'));
    expect(text.startsWith('%PDF-')).toBe(true);
    expect(pdf.getNumberOfPages()).toBe(1);
    expect(text).toContain('ConectJovem');
    expect(text).toContain('Gerado em: 03/10/2026 10:05');
    expect(text).toContain('P\xE1gina 1 de 1'); // á em Latin-1
    expect(text).toContain('Relat\xF3rio de frequ\xEAncia'); // ó, ê
    expect(text).toContain('Reuni\xE3o a\xE7\xE3o 1'); // ã, ç
    expect(text).toContain('Nada por aqui.'); // tabela vazia mostra o texto de vazio
    // rodapé confidencial: travessão (WinAnsi 0x97) e acentos preservados
    expect(text).toContain('Documento confidencial \x97 cont\xE9m dados pessoais');
  });

  it('quebra em várias páginas e numera todas', () => {
    const pdf = buildReportPdf(doc(120), at);
    const pages = pdf.getNumberOfPages();
    expect(pages).toBeGreaterThan(2);
    const text = latin1(pdf.output('arraybuffer'));
    expect(text).toContain(`P\xE1gina 1 de ${pages}`);
    expect(text).toContain(`P\xE1gina ${pages} de ${pages}`);
  });
});
