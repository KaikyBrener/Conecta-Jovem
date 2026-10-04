import { useMemo, useState } from 'react';
import type { Group } from '../../types/database.types';
import { appToday, formatDay } from '../../lib/format';
import {
  RECURRENCES,
  RECURRENCE_LABEL,
  SERIES_NAME_MAX,
  WEEKDAY_NAMES,
  WEEKDAY_OPTIONS,
  describeRecurrence,
  maxSeriesEnd,
  previewSentence,
  seriesDates,
  validateSeriesInput,
  weekdayOf,
  type SeriesInput,
  type SeriesRecurrence,
} from '../../lib/series';
import { formErrorCls, inputCls, labelCls, primaryBtnCls, secondaryBtnCls } from '../../lib/formStyles';

interface SeriesFormProps {
  allGroups: Group[];
  /** Devolve true quando a série foi criada (a tela pai fecha o modal) */
  onSubmit: (input: SeriesInput, description: string, groupIds: string[]) => Promise<boolean>;
  onCancel: () => void;
  loading: boolean;
  /** Erro devolvido pelo servidor na criação */
  error: string | null;
}

type Step = 'edit' | 'confirm';
type GroupsMode = 'now' | 'later';

const PREVIEW_LIMIT = 8;

const shortDate = (date: string) => `${WEEKDAY_NAMES[weekdayOf(date)].slice(0, 3)}, ${formatDay(date)}`;

/**
 * Nova série de encontros recorrentes (coordenador). Dois passos: dados → confirmação com a prévia das datas
 * ("Serão criados N encontros"), calculada no cliente pela mesma regra do banco (lib/series). Os grupos são
 * opcionais: "Definir depois" deixa os encontros com o aviso "Grupos pendentes".
 */
export function SeriesForm({ allGroups, onSubmit, onCancel, loading, error }: SeriesFormProps) {
  const [step, setStep] = useState<Step>('edit');
  const [name, setName] = useState('');
  const [weekday, setWeekday] = useState('');
  const [startTime, setStartTime] = useState('');
  const [recurrence, setRecurrence] = useState<SeriesRecurrence>('weekly');
  const [startDate, setStartDate] = useState(() => appToday());
  const [endDate, setEndDate] = useState('');
  const [description, setDescription] = useState('');
  const [groupsMode, setGroupsMode] = useState<GroupsMode>('now');
  const [selectedGroups, setSelectedGroups] = useState<string[]>([]);
  const [err, setErr] = useState('');

  const input: SeriesInput = {
    name,
    weekday: weekday === '' ? -1 : Number(weekday),
    startTime,
    recurrence,
    startDate,
    endDate,
  };

  const dates = useMemo(
    () => (step === 'confirm' ? seriesDates(Number(weekday), recurrence, startDate, endDate) : []),
    [step, weekday, recurrence, startDate, endDate],
  );

  const toggleGroup = (id: string) =>
    setSelectedGroups((prev) => (prev.includes(id) ? prev.filter((g) => g !== id) : [...prev, id]));

  const review = (e: React.FormEvent) => {
    e.preventDefault();
    setErr('');
    const invalid = validateSeriesInput(input);
    if (invalid) { setErr(invalid); return; }
    if (groupsMode === 'now' && allGroups.length > 0 && selectedGroups.length === 0) {
      setErr('Escolha ao menos um grupo ou marque "Definir depois".');
      return;
    }
    setStep('confirm');
  };

  const confirm = async () => {
    setErr('');
    await onSubmit(input, description, groupsMode === 'now' ? selectedGroups : []);
  };

  const chosenGroupNames = allGroups.filter((g) => selectedGroups.includes(g.id)).map((g) => g.name);
  const message = err || error;

  if (step === 'confirm') {
    return (
      <div className="space-y-4" data-testid="serie-confirmacao">
        {message && <p role="alert" className={formErrorCls}>{message}</p>}

        <div className="rounded-lg bg-blue-50 border border-blue-200 px-4 py-3">
          <p className="text-sm font-semibold text-blue-700" data-testid="serie-previa-total" role="status">
            {previewSentence(dates.length)}
          </p>
          <p className="mt-1 text-sm text-gray-700">
            <strong>{name.trim()}</strong> · {describeRecurrence(Number(weekday), recurrence, startDate)} às {startTime}
          </p>
          <p className="text-xs text-gray-500">
            De {formatDay(dates[0])} a {formatDay(dates[dates.length - 1])}
          </p>
        </div>

        <ul className="max-h-40 overflow-y-auto rounded-lg border border-gray-200 divide-y divide-gray-100 text-sm" aria-label="Datas dos encontros">
          {dates.slice(0, PREVIEW_LIMIT).map((d) => (
            <li key={d} className="px-3 py-1.5 text-gray-700">{shortDate(d)}</li>
          ))}
          {dates.length > PREVIEW_LIMIT && (
            <li className="px-3 py-1.5 text-gray-500">… e mais {dates.length - PREVIEW_LIMIT} (última: {shortDate(dates[dates.length - 1])})</li>
          )}
        </ul>

        <p className="text-sm text-gray-600">
          {groupsMode === 'now' && chosenGroupNames.length > 0
            ? <>Grupos: {chosenGroupNames.join(', ')}.</>
            : <>Grupos: a definir depois. Os encontros ficarão com o aviso &quot;Grupos pendentes&quot; até você escolher os grupos.</>}
        </p>

        <div className="flex justify-end gap-3 pt-2 border-t border-gray-100">
          <button type="button" onClick={() => setStep('edit')} disabled={loading} className={secondaryBtnCls}>
            Voltar
          </button>
          <button type="button" onClick={confirm} disabled={loading} className={primaryBtnCls} data-testid="serie-confirmar">
            {loading ? 'Criando...' : `Confirmar e criar ${dates.length === 1 ? '1 encontro' : `${dates.length} encontros`}`}
          </button>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={review} className="space-y-4" noValidate>
      {message && <p role="alert" className={formErrorCls}>{message}</p>}

      <div>
        <label htmlFor="serie-nome" className={labelCls}>Nome da série *</label>
        <input
          id="serie-nome"
          type="text"
          value={name}
          maxLength={SERIES_NAME_MAX}
          onChange={(e) => setName(e.target.value)}
          className={inputCls}
          placeholder="Ex.: Culto de jovens"
        />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label htmlFor="serie-dia" className={labelCls}>Dia da semana *</label>
          <select id="serie-dia" value={weekday} onChange={(e) => setWeekday(e.target.value)} className={inputCls}>
            <option value="">Selecione...</option>
            {WEEKDAY_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="serie-horario" className={labelCls}>Horário *</label>
          <input id="serie-horario" type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} className={inputCls} />
        </div>
      </div>

      <div>
        <label htmlFor="serie-recorrencia" className={labelCls}>Recorrência *</label>
        <select
          id="serie-recorrencia"
          value={recurrence}
          onChange={(e) => setRecurrence(e.target.value as SeriesRecurrence)}
          className={inputCls}
        >
          {RECURRENCES.map((r) => (
            <option key={r} value={r}>{RECURRENCE_LABEL[r]}</option>
          ))}
        </select>
        {weekday !== '' && /^\d{4}-\d{2}-\d{2}$/.test(startDate) && (
          <p className="mt-1 text-xs text-gray-500">
            {describeRecurrence(Number(weekday), recurrence, startDate).replace(/^./, (c) => c.toUpperCase())}
          </p>
        )}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label htmlFor="serie-inicio" className={labelCls}>Data inicial *</label>
          <input id="serie-inicio" type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} className={inputCls} />
        </div>
        <div>
          <label htmlFor="serie-fim" className={labelCls}>Data final * <span className="font-normal text-gray-500">(até 2 anos)</span></label>
          <input
            id="serie-fim"
            type="date"
            value={endDate}
            min={startDate || undefined}
            max={maxSeriesEnd(startDate) || undefined}
            onChange={(e) => setEndDate(e.target.value)}
            className={inputCls}
          />
        </div>
      </div>

      <div>
        <label htmlFor="serie-descricao" className={labelCls}>Descrição</label>
        <textarea
          id="serie-descricao"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={2}
          className={inputCls}
          placeholder="Informações adicionais (opcional)..."
        />
      </div>

      <fieldset>
        <legend className={labelCls}>Grupos participantes</legend>
        <div className="mt-2 space-y-2">
          <label className="flex items-center gap-2 text-sm text-gray-800 cursor-pointer">
            <input
              type="radio"
              name="serie-grupos"
              checked={groupsMode === 'now'}
              onChange={() => setGroupsMode('now')}
              className="h-4 w-4 text-blue-600 border-gray-300 focus:ring-blue-500"
            />
            Escolher grupos agora
          </label>
          {groupsMode === 'now' && (
            allGroups.length === 0 ? (
              <p className="ml-6 text-sm text-gray-400">Nenhum grupo cadastrado.</p>
            ) : (
              <div className="ml-6 space-y-2 max-h-40 overflow-y-auto border border-gray-200 rounded-lg p-3">
                {allGroups.map((g) => (
                  <label key={g.id} className="flex items-center gap-3 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={selectedGroups.includes(g.id)}
                      onChange={() => toggleGroup(g.id)}
                      className="h-4 w-4 text-blue-600 rounded border-gray-300 focus:ring-blue-500"
                    />
                    <span className="text-sm text-gray-800">{g.name}</span>
                  </label>
                ))}
              </div>
            )
          )}
          <label className="flex items-center gap-2 text-sm text-gray-800 cursor-pointer">
            <input
              type="radio"
              name="serie-grupos"
              checked={groupsMode === 'later'}
              onChange={() => setGroupsMode('later')}
              className="h-4 w-4 text-blue-600 border-gray-300 focus:ring-blue-500"
            />
            Definir depois
          </label>
          {groupsMode === 'later' && (
            <p className="ml-6 text-xs text-gray-500">
              Os encontros serão criados sem grupos e ficam com o aviso &quot;Grupos pendentes&quot; até você defini-los.
            </p>
          )}
        </div>
      </fieldset>

      <div className="flex justify-end gap-3 pt-2 border-t border-gray-100">
        <button type="button" onClick={onCancel} className={secondaryBtnCls}>
          Cancelar
        </button>
        <button type="submit" className={primaryBtnCls} data-testid="serie-revisar">
          Revisar datas
        </button>
      </div>
    </form>
  );
}
