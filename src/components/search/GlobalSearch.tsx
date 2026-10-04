import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertCircle, Calendar, Loader2, Search, User, UsersRound, X } from 'lucide-react';
import { useDebouncedValue } from '../../hooks/useDebouncedValue';
import { useGlobalSearch } from '../../hooks/useGlobalSearch';
import {
  SEARCH_MIN_CHARS,
  SEARCH_SECTIONS,
  flattenResults,
  hitHref,
  isSearchable,
  moveActive,
  normalizeSearchTerm,
  type SearchHit,
} from '../../lib/globalSearch';
import { formatTimestampSP } from '../../lib/format';
import { cn } from '../../lib/utils';

const EVENT_STATUS_LABEL: Record<string, string> = {
  scheduled: 'Agendado',
  completed: 'Realizado',
  cancelled: 'Cancelado',
};

const KIND_ICON = { youth: User, group: UsersRound, event: Calendar } as const;

function hitSubtitle(hit: SearchHit): string {
  if (hit.kind === 'event') {
    const parts = [hit.date ? formatTimestampSP(hit.date) : null, hit.status ? EVENT_STATUS_LABEL[hit.status] ?? null : null];
    return parts.filter(Boolean).join(' · ');
  }
  return hit.subtitle;
}

interface GlobalSearchProps {
  onClose: () => void;
}

/**
 * Paleta de busca global (Ctrl/⌘+K). Montada só enquanto aberta: o foco vai para o campo, Esc fecha, setas + Enter
 * navegam (combobox + listbox com aria-activedescendant) e o foco volta ao elemento que a abriu. No mobile ocupa a
 * tela toda. O que aparece é decidido pelo RLS no banco (RPC global_search).
 */
export function GlobalSearch({ onClose }: GlobalSearchProps) {
  const navigate = useNavigate();
  const uid = useId();
  const listId = `${uid}-lista`;
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const debounced = useDebouncedValue(query, 250);
  const { data, loading, error } = useGlobalSearch(debounced);

  const searchable = isSearchable(query);
  const pending = searchable && normalizeSearchTerm(query) !== normalizeSearchTerm(debounced);
  const busy = searchable && (pending || loading);
  const hits = useMemo(() => (searchable ? flattenResults(data) : []), [searchable, data]);
  const activeIndex = hits.length > 0 ? Math.min(active, hits.length - 1) : -1;
  const optionId = (i: number) => `${uid}-opcao-${i}`;

  // Foco inicial no campo, rolagem do fundo travada e foco devolvido a quem abriu
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    inputRef.current?.focus();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previousOverflow;
      if (opener && document.contains(opener)) opener.focus();
    };
  }, []);

  // Mantém a opção ativa visível ao navegar com as setas
  useEffect(() => {
    if (activeIndex >= 0) document.getElementById(`${uid}-opcao-${activeIndex}`)?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, uid]);

  const go = (hit: SearchHit) => {
    onClose();
    navigate(hitHref(hit));
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key === 'Tab') {
      // foco preso na paleta: campo e botão de fechar
      const focusable = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('input, button') ?? []);
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  };

  const handleInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      setActive(moveActive(activeIndex, e.key === 'ArrowDown' ? 1 : -1, hits.length));
    } else if (e.key === 'Enter' && activeIndex >= 0) {
      e.preventDefault();
      go(hits[activeIndex]);
    }
  };

  const showEmpty = searchable && !busy && !error && hits.length === 0;

  // índice (na lista plana) do primeiro item de cada seção
  const sectionStart: Record<string, number> = {};
  SEARCH_SECTIONS.reduce((acc, section) => {
    sectionStart[section.kind] = acc;
    return acc + hits.filter((h) => h.kind === section.kind).length;
  }, 0);

  return (
    <div
      className="fixed inset-0 z-[70] flex items-stretch md:items-start md:justify-center md:px-4 md:pt-[12vh] bg-navy-950/60"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
      data-testid="busca-global-overlay"
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Busca global"
        onKeyDown={handleKeyDown}
        className="bg-white w-full h-[100dvh] md:h-auto md:max-h-[70vh] md:max-w-xl flex flex-col md:rounded-xl md:shadow-xl md:border md:border-gray-200"
      >
        <div className="flex items-center gap-2 border-b border-gray-200 px-3 py-2">
          <Search className="w-5 h-5 flex-shrink-0 text-gray-400" aria-hidden="true" />
          <input
            ref={inputRef}
            type="text"
            role="combobox"
            aria-expanded={hits.length > 0}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={activeIndex >= 0 ? optionId(activeIndex) : undefined}
            aria-label="Buscar jovens, grupos e encontros"
            placeholder="Buscar jovens, grupos e encontros..."
            autoComplete="off"
            value={query}
            onChange={(e) => { setQuery(e.target.value); setActive(0); }}
            onKeyDown={handleInputKeyDown}
            className="min-w-0 flex-1 border-0 bg-transparent py-2 text-base text-gray-900 placeholder:text-gray-400 focus:outline-none"
            data-testid="busca-global-input"
          />
          {busy && <Loader2 className="w-4 h-4 flex-shrink-0 animate-spin text-blue-600" aria-hidden="true" />}
          <button
            type="button"
            onClick={onClose}
            aria-label="Fechar busca"
            className="rounded-md p-2 text-gray-400 hover:bg-gray-100 hover:text-gray-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
          >
            <X className="w-5 h-5" aria-hidden="true" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-2" data-testid="busca-global-resultados">
          {/* Anúncio para leitores de tela */}
          <p className="sr-only" role="status" aria-live="polite">
            {busy ? 'Buscando...' : searchable && !error ? `${hits.length} ${hits.length === 1 ? 'resultado' : 'resultados'}` : ''}
          </p>

          {!searchable && (
            <p className="px-3 py-6 text-center text-sm text-gray-500" data-testid="busca-global-dica">
              Digite pelo menos {SEARCH_MIN_CHARS} caracteres para buscar jovens, grupos e encontros.
            </p>
          )}

          {searchable && busy && hits.length === 0 && (
            <p className="flex items-center justify-center gap-2 px-3 py-6 text-sm text-gray-500" data-testid="busca-global-carregando">
              <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> Buscando...
            </p>
          )}

          {error && (
            <p role="alert" className="flex items-start gap-2 m-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700" data-testid="busca-global-erro">
              <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" aria-hidden="true" /> {error}
            </p>
          )}

          {showEmpty && (
            <p className="px-3 py-6 text-center text-sm text-gray-500" data-testid="busca-global-vazio">
              Nenhum resultado para “{normalizeSearchTerm(query)}”.
            </p>
          )}

          <div id={listId} role="listbox" aria-label="Resultados da busca" className={cn(hits.length === 0 && 'hidden')}>
            {SEARCH_SECTIONS.map((section) => {
              const sectionHits = hits.filter((h) => h.kind === section.kind);
              if (sectionHits.length === 0) return null;
              const headingId = `${uid}-sec-${section.kind}`;
              const start = sectionStart[section.kind];
              const Icon = KIND_ICON[section.kind];
              return (
                <div key={section.kind} role="group" aria-labelledby={headingId} className="mb-1">
                  <p id={headingId} className="px-3 pt-2 pb-1 text-xs font-semibold uppercase tracking-wide text-gray-500">
                    {section.label}
                  </p>
                  {sectionHits.map((hit, i) => {
                    const index = start + i;
                    const isActive = index === activeIndex;
                    return (
                      <div
                        key={`${hit.kind}-${hit.id}`}
                        id={optionId(index)}
                        role="option"
                        aria-selected={isActive}
                        onMouseMove={() => { if (!isActive) setActive(index); }}
                        onClick={() => go(hit)}
                        data-testid={`busca-global-${hit.kind}`}
                        className={cn(
                          'flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2.5',
                          isActive ? 'bg-blue-50' : 'hover:bg-gray-50',
                        )}
                      >
                        <Icon className="w-4 h-4 flex-shrink-0 text-gray-400" aria-hidden="true" />
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium text-gray-900">{hit.title}</p>
                          <p className="truncate text-xs text-gray-500">{hitSubtitle(hit)}</p>
                        </div>
                        {hit.kind === 'youth' && hit.inactive && (
                          <span className="flex-shrink-0 rounded-full bg-gray-100 px-2 py-0.5 text-[11px] font-medium text-gray-600">Inativo</span>
                        )}
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
        </div>

        <div className="hidden md:flex items-center gap-4 border-t border-gray-200 px-4 py-2 text-xs text-gray-500">
          <span>↑↓ navegar</span>
          <span>Enter abrir</span>
          <span>Esc fechar</span>
        </div>
      </div>
    </div>
  );
}
