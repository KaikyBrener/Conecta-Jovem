import { useId, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { anonymizeConfirmationMatches } from '../../lib/anonymize';
import { formErrorCls, inputCls, labelCls, secondaryBtnCls } from '../../lib/formStyles';

interface AnonymizeYouthFormProps {
  youthName: string;
  loading: boolean;
  error: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}

/** Confirmação da anonimização (irreversível): explica o que some e o que fica e exige digitar o nome do jovem. */
export function AnonymizeYouthForm({ youthName, loading, error, onConfirm, onCancel }: AnonymizeYouthFormProps) {
  const [typed, setTyped] = useState('');
  const uid = useId();
  const canConfirm = anonymizeConfirmationMatches(typed, youthName) && !loading;

  return (
    <form
      className="space-y-4"
      aria-busy={loading}
      onSubmit={(e) => { e.preventDefault(); if (canConfirm) onConfirm(); }}
    >
      <div role="note" className="flex items-start gap-2 text-sm text-red-800 bg-red-50 border border-red-200 rounded-control px-3 py-2">
        <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" aria-hidden="true" />
        <p>
          Esta ação é <strong>IRREVERSÍVEL</strong>. Os dados pessoais de <strong>{youthName}</strong> serão apagados e
          não poderão ser recuperados.
        </p>
      </div>

      <div className="text-sm text-gray-700 space-y-2">
        <p className="font-medium text-gray-900">Será apagado:</p>
        <ul className="list-disc pl-5 space-y-0.5">
          <li>nome (passa a ser "Jovem anonimizado"), data de nascimento e gênero;</li>
          <li>telefone, e-mail, endereço e observações;</li>
          <li>os textos de presença, tarefas, acompanhamentos, alertas e e-mails deste jovem.</li>
        </ul>
        <p className="font-medium text-gray-900">Será mantido:</p>
        <ul className="list-disc pl-5 space-y-0.5">
          <li>o grupo e os registros de presença e falta, para as estatísticas;</li>
          <li>o jovem fica inativo.</li>
        </ul>
      </div>

      <div className="space-y-1">
        <label htmlFor={`${uid}-confirm`} className={labelCls}>
          Para confirmar, digite o nome do jovem: <strong>{youthName}</strong>
        </label>
        <input
          id={`${uid}-confirm`}
          className={inputCls}
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          readOnly={loading}
          autoComplete="off"
          spellCheck={false}
        />
      </div>

      {error && <p role="alert" className={formErrorCls}>{error}</p>}

      <div className="flex flex-wrap gap-2 justify-end pt-2 border-t border-gray-100">
        <button type="button" onClick={onCancel} disabled={loading} className={secondaryBtnCls}>
          Cancelar
        </button>
        <button
          type="submit"
          disabled={!canConfirm}
          className="px-3 py-2 text-sm font-medium text-white bg-red-600 rounded-control hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {loading ? 'Anonimizando...' : 'Anonimizar definitivamente'}
        </button>
      </div>
    </form>
  );
}
