import { describe, expect, it } from 'vitest';
import { PAGE_SIZE, pageBounds, pageSummary, searchPattern, totalPages } from './pagination';

describe('pageBounds', () => {
  it('primeira página começa em 0', () => {
    expect(pageBounds(1, 25)).toEqual({ from: 0, to: 24 });
  });
  it('página seguinte avança exatamente um tamanho de página', () => {
    expect(pageBounds(2, 25)).toEqual({ from: 25, to: 49 });
    expect(pageBounds(5, 10)).toEqual({ from: 40, to: 49 });
  });
  it('página inválida (0 ou negativa) cai na primeira', () => {
    expect(pageBounds(0, 25).from).toBe(0);
    expect(pageBounds(-3, 25).from).toBe(0);
  });
  it('usa o tamanho padrão', () => {
    expect(pageBounds(2).from).toBe(PAGE_SIZE);
  });
});

describe('totalPages', () => {
  it('lista vazia ainda tem 1 página (estado vazio)', () => {
    expect(totalPages(0, 25)).toBe(1);
  });
  it('arredonda para cima', () => {
    expect(totalPages(25, 25)).toBe(1);
    expect(totalPages(26, 25)).toBe(2);
    expect(totalPages(60, 25)).toBe(3);
  });
  it('não é afetado pelo teto de 1000 linhas do PostgREST', () => {
    expect(totalPages(1001, 25)).toBe(41);
  });
});

describe('pageSummary', () => {
  it('primeira, intermediária e última página', () => {
    expect(pageSummary(1, 60, 25)).toEqual({ first: 1, last: 25 });
    expect(pageSummary(2, 60, 25)).toEqual({ first: 26, last: 50 });
    expect(pageSummary(3, 60, 25)).toEqual({ first: 51, last: 60 });
  });
  it('lista vazia mostra 0–0', () => {
    expect(pageSummary(1, 0, 25)).toEqual({ first: 0, last: 0 });
  });
  it('total exato múltiplo do tamanho da página', () => {
    expect(pageSummary(2, 50, 25)).toEqual({ first: 26, last: 50 });
  });
});

describe('searchPattern', () => {
  it('envolve o termo em curingas', () => {
    expect(searchPattern('ana')).toBe('%ana%');
  });
  it('ignora termo vazio ou só espaços', () => {
    expect(searchPattern('')).toBeNull();
    expect(searchPattern('   ')).toBeNull();
  });
  it('remove caracteres da sintaxe do PostgREST e curingas do usuário', () => {
    expect(searchPattern('a,b)c(d"e\\f*g%h')).toBe('%a b c d e f g h%');
    expect(searchPattern('%%')).toBeNull();
    // não consegue fechar o `or=(...)` nem injetar outro filtro
    expect(searchPattern('x),status.eq.done,(y')).toBe('%x status.eq.done y%');
  });
  it('preserva acentos e normaliza espaços', () => {
    expect(searchPattern('  João   Márcio ')).toBe('%João Márcio%');
  });
});
