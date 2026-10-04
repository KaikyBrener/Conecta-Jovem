// Geração/download de CSV compatível com Excel pt-BR (separador ';' e BOM UTF-8)

export type CsvValue = string | number | boolean | null | undefined;

/** Marca de ordem de bytes UTF-8: faz o Excel abrir o arquivo com os acentos corretos. */
const BOM = String.fromCharCode(0xfeff);

/**
 * Neutraliza "injeção de fórmula" (CSV injection): o Excel/Planilhas executam como fórmula uma célula de texto que
 * começa com = + - @ (ou TAB/CR). O prefixo ' faz a célula ser lida como texto. Vale só para TEXTO: números
 * (typeof number) são gravados como vieram.
 */
export function neutralizeFormula(text: string): string {
  return /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
}

function escapeCell(value: CsvValue): string {
  if (value === null || value === undefined) return '';
  const s = typeof value === 'string' ? neutralizeFormula(value) : String(value);
  return /[";\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(headers: string[], rows: CsvValue[][]): string {
  return [headers, ...rows].map((r) => r.map(escapeCell).join(';')).join('\r\n');
}

/** Dispara o download de um Blob (URL blob: local — não é bloqueada pela CSP, que não restringe downloads por âncora). */
export function downloadBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // adiado: alguns navegadores iniciam o download de forma assíncrona
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function downloadCsv(filename: string, csv: string): void {
  downloadBlob(filename, new Blob([BOM + csv], { type: 'text/csv;charset=utf-8' }));
}
