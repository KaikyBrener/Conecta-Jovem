import { describe, expect, it } from 'vitest';
import { neutralizeFormula, toCsv } from './csv';

describe('csv: injeção de fórmula', () => {
  it('prefixa texto que começa com = + - @ TAB ou CR', () => {
    for (const s of ['=SOMA(A1)', '+55 11 99999', '-1+1', '@cmd', '\tx', '\rx']) {
      expect(neutralizeFormula(s)).toBe(`'${s}`);
    }
  });

  it('não altera texto comum, vazio ou com o gatilho no meio', () => {
    for (const s of ['Maria', '', 'a=b', 'Grupo - Jovens', '12/10/2026', "'já prefixado"]) {
      expect(neutralizeFormula(s)).toBe(s);
    }
  });

  it('toCsv aplica em texto, mas não em números', () => {
    const csv = toCsv(['Nome', 'Delta'], [['=HYPERLINK("x")', -5], ['+1', 3]]);
    expect(csv).toBe('Nome;Delta\r\n"\'=HYPERLINK(""x"")";-5\r\n\'+1;3');
  });
});
