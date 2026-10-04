import { useState } from 'react';
import type { GroupRef } from '../../types/database.types';
import { formErrorCls, inputCls, labelCls, primaryBtnCls, secondaryBtnCls } from '../../lib/formStyles';

interface BatchGroupFormProps {
  count: number;
  /** Grupos que o usuário pode escolher (coordenador: todos; líder: os seus, via RLS) */
  groups: GroupRef[];
  loading: boolean;
  error: string | null;
  /** groupId null = "Sem grupo" */
  onSubmit: (groupId: string | null) => void;
  onCancel: () => void;
}

const NONE = '__none__';

/** Conteúdo do modal "Alterar grupo" da ação em lote. */
export function BatchGroupForm({ count, groups, loading, error, onSubmit, onCancel }: BatchGroupFormProps) {
  const [value, setValue] = useState('');
  const [err, setErr] = useState('');

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!value) { setErr('Escolha o grupo de destino ou "Sem grupo".'); return; }
    setErr('');
    onSubmit(value === NONE ? null : value);
  };

  const message = err || error;

  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      {message && <p role="alert" className={formErrorCls}>{message}</p>}
      <p className="text-sm text-gray-600">
        {count === 1 ? '1 jovem selecionado.' : `${count} jovens selecionados.`}
      </p>
      <div>
        <label htmlFor="lote-grupo" className={labelCls}>Novo grupo</label>
        <select id="lote-grupo" value={value} onChange={(e) => setValue(e.target.value)} className={inputCls}>
          <option value="">Selecione...</option>
          {groups.map((g) => (
            <option key={g.id} value={g.id}>{g.name}</option>
          ))}
          <option value={NONE}>Sem grupo</option>
        </select>
      </div>
      <div className="flex justify-end gap-3 pt-2 border-t border-gray-100">
        <button type="button" onClick={onCancel} disabled={loading} className={secondaryBtnCls}>Cancelar</button>
        <button type="submit" disabled={loading} className={primaryBtnCls} data-testid="lote-grupo-aplicar">
          {loading ? 'Aplicando...' : `Aplicar a ${count === 1 ? '1 jovem' : `${count} jovens`}`}
        </button>
      </div>
    </form>
  );
}
