import { useState } from 'react';
import { CalendarClock, CalendarPlus, Users, XCircle } from 'lucide-react';
import type { Group } from '../../types/database.types';
import type { SeriesRow } from '../../hooks/useEventSeries';
import { Badge } from '../ui/Badge';
import { LoadingBlock } from '../ui/LoadingBlock';
import { EmptyState } from '../ui/EmptyState';
import { formatDay } from '../../lib/format';
import { describeRecurrence, maxSeriesEnd, validateExtendEnd } from '../../lib/series';
import { shiftDate } from '../../lib/periods';
import { formErrorCls, inputCls, labelCls, primaryBtnCls, secondaryBtnCls } from '../../lib/formStyles';

interface SeriesManagerProps {
  series: SeriesRow[];
  loading: boolean;
  /** Erro de leitura ou da última ação */
  error: string | null;
  allGroups: Group[];
  /** Cada ação devolve true quando deu certo (o painel aberto fecha) */
  onSetGroups: (series: SeriesRow, groupIds: string[]) => Promise<boolean>;
  onExtend: (series: SeriesRow, newEnd: string) => Promise<boolean>;
  onCancelFuture: (series: SeriesRow) => Promise<boolean>;
  onNew: () => void;
  onClose: () => void;
}

type Panel = 'groups' | 'extend' | null;

interface CardProps extends Pick<SeriesManagerProps, 'allGroups' | 'onSetGroups' | 'onExtend' | 'onCancelFuture'> {
  series: SeriesRow;
  busy: boolean;
  setBusy: (id: string | null) => void;
}

function SeriesCard({ series, allGroups, onSetGroups, onExtend, onCancelFuture, busy, setBusy }: CardProps) {
  const [panel, setPanel] = useState<Panel>(null);
  const [selected, setSelected] = useState<string[]>(series.group_ids);
  const [newEnd, setNewEnd] = useState('');
  const [localErr, setLocalErr] = useState('');
  const pendingGroups = series.group_ids.length === 0;

  const togglePanel = (p: Exclude<Panel, null>) => {
    setLocalErr('');
    setSelected(series.group_ids);
    setPanel((cur) => (cur === p ? null : p));
  };

  const run = async (action: () => Promise<boolean>) => {
    setBusy(series.id);
    const ok = await action();
    setBusy(null);
    if (ok) setPanel(null);
  };

  const submitExtend = (e: React.FormEvent) => {
    e.preventDefault();
    const invalid = validateExtendEnd(series, newEnd);
    if (invalid) { setLocalErr(invalid); return; }
    setLocalErr('');
    void run(() => onExtend(series, newEnd));
  };

  const cancelFuture = () => {
    const ok = window.confirm(
      `Cancelar os próximos encontros de "${series.name}"?\n\n` +
      'A série será encerrada e os encontros futuros ainda sem chamada serão cancelados. ' +
      'Chamadas já feitas não são afetadas, e encontros passados ou realizados continuam como estão.',
    );
    if (ok) void run(() => onCancelFuture(series));
  };

  const toggleGroup = (id: string) =>
    setSelected((prev) => (prev.includes(id) ? prev.filter((g) => g !== id) : [...prev, id]));

  return (
    <li className="rounded-card border border-gray-200 p-4 space-y-3" data-testid="serie-item">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-gray-900 break-words">{series.name}</h3>
          <p className="text-xs text-gray-500">
            {describeRecurrence(series.weekday, series.recurrence, series.start_date).replace(/^./, (c) => c.toUpperCase())}
            {' '}às {series.start_time.slice(0, 5)}
          </p>
        </div>
        <Badge color={series.active ? 'green' : 'gray'}>{series.active ? 'Ativa' : 'Encerrada'}</Badge>
      </div>

      <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
        <dt className="text-gray-500">Período</dt>
        <dd className="text-gray-800">{formatDay(series.start_date)} a {formatDay(series.end_date)}</dd>
        <dt className="text-gray-500">Encontros</dt>
        <dd className="text-gray-800">{series.events_count}</dd>
        <dt className="text-gray-500">Grupos</dt>
        <dd className="text-gray-800 break-words">
          {pendingGroups ? <Badge color="amber">Grupos pendentes</Badge> : series.group_names.join(', ')}
        </dd>
      </dl>

      {series.active && (
        <div className="flex flex-col sm:flex-row sm:flex-wrap gap-2">
          <button
            type="button"
            onClick={() => togglePanel('groups')}
            aria-expanded={panel === 'groups'}
            disabled={busy}
            className={secondaryBtnCls}
            data-testid="serie-definir-grupos"
          >
            <Users className="w-4 h-4" aria-hidden="true" /> Definir grupos dos próximos encontros
          </button>
          <button
            type="button"
            onClick={() => togglePanel('extend')}
            aria-expanded={panel === 'extend'}
            disabled={busy}
            className={secondaryBtnCls}
            data-testid="serie-estender"
          >
            <CalendarPlus className="w-4 h-4" aria-hidden="true" /> Estender até…
          </button>
          <button
            type="button"
            onClick={cancelFuture}
            disabled={busy}
            className="inline-flex items-center justify-center gap-2 px-4 py-2 text-sm font-medium text-red-700 bg-red-50 border border-red-200 rounded-control hover:bg-red-100 disabled:opacity-50 transition-colors"
            data-testid="serie-cancelar-proximos"
          >
            <XCircle className="w-4 h-4" aria-hidden="true" /> Cancelar próximos encontros
          </button>
        </div>
      )}

      {panel === 'groups' && (
        <div className="space-y-3 rounded-control bg-gray-50 p-3" data-testid="serie-painel-grupos">
          <p className="text-xs text-gray-600">
            Os grupos escolhidos valem para os próximos encontros ainda agendados. Encontros editados individualmente
            não são alterados.
          </p>
          {allGroups.length === 0 ? (
            <p className="text-sm text-gray-400">Nenhum grupo cadastrado.</p>
          ) : (
            <div className="space-y-2 max-h-40 overflow-y-auto">
              {allGroups.map((g) => (
                <label key={g.id} className="flex items-center gap-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={selected.includes(g.id)}
                    onChange={() => toggleGroup(g.id)}
                    className="h-4 w-4 text-blue-600 rounded border-gray-300 focus:ring-blue-500"
                  />
                  <span className="text-sm text-gray-800">{g.name}</span>
                </label>
              ))}
            </div>
          )}
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setPanel(null)} className={secondaryBtnCls}>Fechar</button>
            <button type="button" disabled={busy} onClick={() => run(() => onSetGroups(series, selected))} className={primaryBtnCls} data-testid="serie-aplicar-grupos">
              {busy ? 'Aplicando...' : 'Aplicar grupos'}
            </button>
          </div>
        </div>
      )}

      {panel === 'extend' && (
        <form onSubmit={submitExtend} className="space-y-3 rounded-control bg-gray-50 p-3" data-testid="serie-painel-estender" noValidate>
          {localErr && <p role="alert" className={formErrorCls}>{localErr}</p>}
          <div>
            <label htmlFor={`serie-nova-data-${series.id}`} className={labelCls}>Nova data final</label>
            <input
              id={`serie-nova-data-${series.id}`}
              type="date"
              value={newEnd}
              min={shiftDate(series.end_date, 1)}
              max={maxSeriesEnd(series.start_date)}
              onChange={(e) => setNewEnd(e.target.value)}
              className={inputCls}
            />
            <p className="mt-1 text-xs text-gray-500">
              Atual: {formatDay(series.end_date)}. O máximo são 2 anos desde {formatDay(series.start_date)}.
            </p>
          </div>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setPanel(null)} className={secondaryBtnCls}>Fechar</button>
            <button type="submit" disabled={busy} className={primaryBtnCls} data-testid="serie-confirmar-extensao">
              {busy ? 'Estendendo...' : 'Estender série'}
            </button>
          </div>
        </form>
      )}
    </li>
  );
}

/** Lista as séries (ativa, período, nº de encontros) e oferece as ações de gerenciamento. Somente coordenador. */
export function SeriesManager({ series, loading, error, allGroups, onSetGroups, onExtend, onCancelFuture, onNew, onClose }: SeriesManagerProps) {
  const [busyId, setBusyId] = useState<string | null>(null);

  return (
    <div className="space-y-4">
      {error && <p role="alert" className={formErrorCls}>{error}</p>}

      {loading && series.length === 0 && <LoadingBlock size="sm" />}

      {!loading && !error && series.length === 0 && (
        <EmptyState
          bare
          icon={CalendarClock}
          title="Nenhuma série de encontros criada ainda."
          action={<button type="button" onClick={onNew} className="mt-3 text-blue-600 text-sm font-medium hover:underline">Criar a primeira série</button>}
        />
      )}

      {series.length > 0 && (
        <ul className="space-y-3" aria-label="Séries de encontros">
          {series.map((s) => (
            <SeriesCard
              key={s.id}
              series={s}
              allGroups={allGroups}
              onSetGroups={onSetGroups}
              onExtend={onExtend}
              onCancelFuture={onCancelFuture}
              busy={busyId === s.id}
              setBusy={setBusyId}
            />
          ))}
        </ul>
      )}

      <div className="flex flex-col-reverse gap-2 border-t border-line-soft pt-4 sm:flex-row sm:justify-end sm:gap-3">
        <button type="button" onClick={onClose} className={secondaryBtnCls}>Fechar</button>
        {series.length > 0 && (
          <button type="button" onClick={onNew} className={primaryBtnCls}>Nova série</button>
        )}
      </div>
    </div>
  );
}
