import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { Modal } from '../components/Modal';
import { dangerBtnCls, primaryBtnCls, secondaryBtnCls } from '../lib/formStyles';

export interface ConfirmOptions {
  /** Pergunta curta, vira o título da janela (ex.: "Excluir tarefa?") */
  title: string;
  /** Parágrafos abaixo do título */
  message?: string | string[];
  /** Verbo da ação (ex.: "Excluir", "Desativar") */
  confirmLabel: string;
  cancelLabel?: string;
  /** `danger` (padrão) para ações destrutivas ou irreversíveis */
  tone?: 'danger' | 'primary';
}

type ConfirmFn = (options: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = createContext<ConfirmFn>(() => Promise.resolve(false));

interface Pending extends ConfirmOptions {
  resolve: (ok: boolean) => void;
  id: number;
  /** rota em que a pergunta foi feita */
  path: string;
}

/**
 * Corpo da janela: foco inicial em "Cancelar" (a ação segura). Esc, Tab preso e devolução do foco a quem abriu
 * são do `Modal`, que envolve esta janela.
 */
function ConfirmBody({ pending, onAnswer }: { pending: Pending; onAnswer: (ok: boolean) => void }) {
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  const paragraphs = pending.message === undefined ? [] : Array.isArray(pending.message) ? pending.message : [pending.message];

  return (
    <div className="space-y-4">
      {paragraphs.map((p, i) => (
        <p key={i} className="text-sm text-ink-soft">{p}</p>
      ))}
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <button
          ref={cancelRef}
          type="button"
          onClick={() => onAnswer(false)}
          className={secondaryBtnCls}
          data-testid="confirmacao-cancelar"
        >
          {pending.cancelLabel ?? 'Cancelar'}
        </button>
        <button
          type="button"
          onClick={() => onAnswer(true)}
          className={pending.tone === 'primary' ? primaryBtnCls : dangerBtnCls}
          data-testid="confirmacao-confirmar"
        >
          {pending.confirmLabel}
        </button>
      </div>
    </div>
  );
}

/**
 * Confirmação em janela própria (DS-6), no lugar de `window.confirm`. Uso: `if (!(await confirm({...}))) return;`.
 * Fica acima de qualquer modal aberto (é renderizada depois do conteúdo) e abaixo dos avisos flutuantes.
 */
export function ConfirmProvider({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  const pathRef = useRef(pathname);
  useEffect(() => { pathRef.current = pathname; }, [pathname]);
  const nextId = useRef(1);
  const [pending, setPending] = useState<Pending | null>(null);
  const pendingRef = useRef<Pending | null>(null);

  const answer = useCallback((ok: boolean) => {
    const current = pendingRef.current;
    pendingRef.current = null;
    setPending(null);
    current?.resolve(ok);
  }, []);

  const confirm = useCallback<ConfirmFn>((options) => new Promise<boolean>((resolve) => {
    // uma pergunta por vez: uma nova substitui (e recusa) a anterior
    pendingRef.current?.resolve(false);
    const next: Pending = { ...options, resolve, id: nextId.current++, path: pathRef.current };
    pendingRef.current = next;
    setPending(next);
  }), []);

  // Trocou de rota (ex.: "voltar" do navegador) com a janela aberta: a pergunta era da tela anterior. Ela some
  // (só aparece na rota em que foi feita) e quem perguntou recebe "não".
  useEffect(() => {
    const current = pendingRef.current;
    if (current && current.path !== pathname) {
      pendingRef.current = null;
      current.resolve(false);
    }
  }, [pathname]);

  // desmontou com a janela aberta (troca de usuário, erro de tela): quem perguntou recebe "não"
  useEffect(() => () => { pendingRef.current?.resolve(false); }, []);

  const visible = pending && pending.path === pathname ? pending : null;

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {visible && (
        <Modal key={visible.id} title={visible.title} onClose={() => answer(false)} testId="confirmacao">
          <ConfirmBody pending={visible} onAnswer={answer} />
        </Modal>
      )}
    </ConfirmContext.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export const useConfirm = () => useContext(ConfirmContext);
