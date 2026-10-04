import { describe, expect, it } from 'vitest';
import {
  flattenResults,
  groupSearchTerm,
  hitHref,
  isSearchShortcut,
  isSearchable,
  moveActive,
  normalizeSearchTerm,
  parseGlobalSearch,
} from './globalSearch';

const payload = {
  youth: [
    { id: 'y1', full_name: 'Ana Souza', group_name: 'Alfa', is_active: true },
    { id: 'y2', full_name: 'Bruno', group_name: null, is_active: false },
    { id: null, full_name: 'sem id' },
  ],
  groups: [{ id: 'g1', name: 'Alfa', leader_name: 'Carla' }, { id: 'g2', name: 'Beta', leader_name: null }],
  events: [{ id: 'e1', title: 'Culto de jovens', event_date: '2026-10-03T22:30:00+00:00', status: 'scheduled' }],
};

describe('parseGlobalSearch', () => {
  it('organiza jovens, grupos e encontros e descarta itens sem id', () => {
    const r = parseGlobalSearch(payload);
    expect(r.youth.map((y) => y.id)).toEqual(['y1', 'y2']);
    expect(r.youth[0]).toMatchObject({ title: 'Ana Souza', subtitle: 'Alfa', inactive: false });
    expect(r.youth[1]).toMatchObject({ subtitle: 'Sem grupo', inactive: true });
    expect(r.groups[0]).toMatchObject({ title: 'Alfa', subtitle: 'Líder: Carla' });
    expect(r.groups[1].subtitle).toBe('Sem líder');
    expect(r.events[0]).toMatchObject({ title: 'Culto de jovens', status: 'scheduled' });
    expect(flattenResults(r).length).toBe(5);
  });

  it('payload inesperado vira resultado vazio', () => {
    for (const bad of [null, undefined, 'x', 3, [], {}, { youth: 'x', groups: {}, events: [1, null] }]) {
      expect(flattenResults(parseGlobalSearch(bad)).length).toBe(0);
    }
  });
});

describe('navegação', () => {
  const r = parseGlobalSearch(payload);

  it('a lista plana segue a ordem da tela: jovens, grupos, encontros', () => {
    expect(flattenResults(r).map((h) => h.kind)).toEqual(['youth', 'youth', 'group', 'group', 'event']);
  });

  it('destinos de cada tipo', () => {
    const [y, , g, , e] = flattenResults(r);
    expect(hitHref(y)).toBe('/jovens?ficha=y1');
    expect(hitHref(g)).toBe('/grupos?busca=Alfa');
    expect(hitHref(e)).toBe('/encontros?evento=e1');
    expect(hitHref({ kind: 'group', id: 'x', title: 'Jovens & Cia/1', subtitle: '' })).toBe('/grupos?busca=Jovens%20%26%20Cia%2F1');
  });

  it('o termo do grupo não contém caracteres que a busca remove', () => {
    expect(groupSearchTerm('Jovens (A)')).toBe('Jovens');
    expect(groupSearchTerm('Alfa')).toBe('Alfa');
    expect(groupSearchTerm('A, Bravo "1"')).toBe('Bravo');
  });

  it('moveActive é circular e lida com lista vazia', () => {
    expect(moveActive(0, 1, 3)).toBe(1);
    expect(moveActive(2, 1, 3)).toBe(0);
    expect(moveActive(0, -1, 3)).toBe(2);
    expect(moveActive(-1, 1, 3)).toBe(0);
    expect(moveActive(-1, -1, 3)).toBe(2);
    expect(moveActive(0, 1, 0)).toBe(-1);
  });
});

describe('entrada', () => {
  it('exige 2 caracteres depois de normalizar espaços', () => {
    expect(normalizeSearchTerm('  ana   souza ')).toBe('ana souza');
    expect(isSearchable('a')).toBe(false);
    expect(isSearchable('  a  ')).toBe(false);
    expect(isSearchable('an')).toBe(true);
  });

  it('atalho Ctrl/⌘+K, sem Shift/Alt', () => {
    expect(isSearchShortcut({ key: 'k', ctrlKey: true, metaKey: false })).toBe(true);
    expect(isSearchShortcut({ key: 'K', ctrlKey: false, metaKey: true })).toBe(true);
    expect(isSearchShortcut({ key: 'k', ctrlKey: false, metaKey: false })).toBe(false);
    expect(isSearchShortcut({ key: 'k', ctrlKey: true, metaKey: false, shiftKey: true })).toBe(false);
    expect(isSearchShortcut({ key: 'j', ctrlKey: true, metaKey: false })).toBe(false);
  });
});
