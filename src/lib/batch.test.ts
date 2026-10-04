import { describe, expect, it } from 'vitest';
import { addToSelection, batchHadEffect, batchSummary, buildYouthCsv, parseBatchResult, BATCH_MAX } from './batch';
import type { Youth } from '../types/database.types';

const youth = (id: string, over: Partial<Youth> = {}): Youth => ({
  id, full_name: `Jovem ${id}`, birth_date: null, gender: null, phone: null, email: null, address: null, notes: null,
  is_active: true, group_id: null, created_by: 'u', created_at: '', updated_at: '', ...over,
});

describe('parseBatchResult', () => {
  it('lê o jsonb da RPC e conta os ids ignorados', () => {
    expect(parseBatchResult({ requested: 14, updated: 12, unchanged: 0, skipped: ['a', 'b'] })).toEqual({
      requested: 14, updated: 12, unchanged: 0, skipped: 2,
    });
  });
  it('payload inesperado vira zeros', () => {
    expect(parseBatchResult(null)).toEqual({ requested: 0, updated: 0, unchanged: 0, skipped: 0 });
    expect(parseBatchResult({ updated: -3, skipped: 'x' })).toEqual({ requested: 0, updated: 0, unchanged: 0, skipped: 0 });
  });
});

describe('batchSummary / batchHadEffect', () => {
  it('resume atualizados e sem permissão', () => {
    expect(batchSummary({ requested: 14, updated: 12, unchanged: 0, skipped: 2 })).toBe('12 atualizados, 2 sem permissão.');
    expect(batchSummary({ requested: 1, updated: 1, unchanged: 0, skipped: 0 })).toBe('1 atualizado.');
  });
  it('inclui os que já estavam no estado pedido', () => {
    expect(batchSummary({ requested: 5, updated: 3, unchanged: 2, skipped: 0 })).toBe('3 atualizados, 2 já estavam assim.');
    expect(batchSummary({ requested: 1, updated: 0, unchanged: 1, skipped: 0 })).toBe(
      'Nenhuma alteração: os jovens selecionados já estavam nesse estado.',
    );
  });
  it('só sem permissão', () => {
    expect(batchSummary({ requested: 2, updated: 0, unchanged: 0, skipped: 2 })).toBe('2 sem permissão.');
    expect(batchHadEffect({ requested: 2, updated: 0, unchanged: 0, skipped: 2 })).toBe(false);
    expect(batchHadEffect({ requested: 2, updated: 1, unchanged: 0, skipped: 1 })).toBe(true);
    expect(batchHadEffect({ requested: 2, updated: 0, unchanged: 2, skipped: 0 })).toBe(true);
  });
});

describe('addToSelection', () => {
  it('soma sem duplicar e sem alterar o Map original', () => {
    const base = new Map([['1', youth('1')]]);
    const { selection, rejected } = addToSelection(base, [youth('1'), youth('2')]);
    expect([...selection.keys()]).toEqual(['1', '2']);
    expect(rejected).toBe(0);
    expect(base.size).toBe(1);
  });
  it('respeita o limite por lote', () => {
    const many = Array.from({ length: BATCH_MAX + 5 }, (_, i) => youth(String(i)));
    const { selection, rejected } = addToSelection(new Map(), many);
    expect(selection.size).toBe(BATCH_MAX);
    expect(rejected).toBe(5);
  });
});

describe('buildYouthCsv', () => {
  it('exporta só os campos visíveis na lista e neutraliza fórmulas', () => {
    const csv = buildYouthCsv(
      [youth('1', { full_name: '=cmd', phone: '+55 11 99999-0000', email: 'a@b.c', group_id: 'g', is_active: false }), youth('2')],
      (g) => (g ? 'Alfa' : 'Sem grupo'),
    );
    const lines = csv.split('\r\n');
    expect(lines[0]).toBe('Nome;Grupo;Telefone;E-mail;Status');
    expect(lines[1]).toBe("'=cmd;Alfa;'+55 11 99999-0000;a@b.c;Inativo");
    expect(lines[2]).toBe('Jovem 2;Sem grupo;;;Ativo');
  });
});
