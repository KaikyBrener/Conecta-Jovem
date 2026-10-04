import { describe, expect, it } from 'vitest';
import { parseEventParam, parseHistoryYouthParam, parseSearchParam, parseTaskFilterParam, parseYouthSheetParam } from './deepLinks';

describe('parseEventParam / parseHistoryYouthParam', () => {
  const id = '3F2504E0-4F89-41D3-9A0C-0305E82C3301';
  it('aceita UUID e normaliza', () => {
    expect(parseEventParam(id)).toBe(id.toLowerCase());
    expect(parseHistoryYouthParam(` ${id} `)).toBe(id.toLowerCase());
  });
  it('rejeita lixo e ausente', () => {
    expect(parseEventParam('abc')).toBeNull();
    expect(parseEventParam(null)).toBeNull();
    expect(parseHistoryYouthParam("1' or '1'='1")).toBeNull();
  });
});

describe('parseSearchParam', () => {
  it('apara, colapsa espaços e remove caracteres de controle', () => {
    expect(parseSearchParam('  Grupo   Alfa ')).toBe('Grupo Alfa');
    expect(parseSearchParam('a\u0000b\nc')).toBe('a b c');
  });
  it('limita o tamanho', () => {
    expect(parseSearchParam('x'.repeat(200)).length).toBe(80);
  });
  it('ausente ou vazio vira string vazia', () => {
    expect(parseSearchParam(null)).toBe('');
    expect(parseSearchParam(undefined)).toBe('');
    expect(parseSearchParam('   ')).toBe('');
  });
});

describe('parseYouthSheetParam', () => {
  it('aceita UUID e normaliza para minúsculas', () => {
    expect(parseYouthSheetParam('3F2504E0-4F89-41D3-9A0C-0305E82C3301')).toBe('3f2504e0-4f89-41d3-9a0c-0305e82c3301');
    expect(parseYouthSheetParam(' 3f2504e0-4f89-41d3-9a0c-0305e82c3301 ')).toBe('3f2504e0-4f89-41d3-9a0c-0305e82c3301');
  });
  it('rejeita ausente, vazio e não-UUID', () => {
    expect(parseYouthSheetParam(null)).toBeNull();
    expect(parseYouthSheetParam(undefined)).toBeNull();
    expect(parseYouthSheetParam('')).toBeNull();
    expect(parseYouthSheetParam('123')).toBeNull();
    expect(parseYouthSheetParam("x'; drop table youth;--")).toBeNull();
  });
});

describe('parseTaskFilterParam', () => {
  it('atrasadas vira o filtro interno overdue', () => {
    expect(parseTaskFilterParam('atrasadas')).toBe('overdue');
    expect(parseTaskFilterParam('ATRASADAS')).toBe('overdue');
  });
  it('mapeia os demais filtros conhecidos', () => {
    expect(parseTaskFilterParam('abertas')).toBe('open');
    expect(parseTaskFilterParam('encerradas')).toBe('done');
    expect(parseTaskFilterParam('todas')).toBe('all');
  });
  it('desconhecido ou ausente não altera o filtro', () => {
    expect(parseTaskFilterParam('overdue')).toBeNull();
    expect(parseTaskFilterParam('')).toBeNull();
    expect(parseTaskFilterParam(null)).toBeNull();
  });
});
