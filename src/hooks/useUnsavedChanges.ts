import { createContext, useContext, useEffect, useId } from 'react';

/**
 * Registro, por janela (`Modal`), de quem declarou ter dados ainda não salvos. A janela cria o conjunto e o
 * entrega por contexto; `useUnsavedChanges` acrescenta ou retira a marca de quem o chama.
 */
export const UnsavedChangesContext = createContext<Set<string> | null>(null);

/**
 * Declara à janela em volta que há dados ainda não salvos, para ela perguntar antes de fechar por Esc, clique fora
 * ou no botão "Fechar janela".
 *
 * Só é preciso quando os campos saem da tela com os dados ainda por salvar (ex.: o passo de conferência de um
 * formulário em etapas). Enquanto os campos de um `<form>` estão na tela, o `Modal` percebe sozinho o que a pessoa
 * alterou. Fora de uma janela, não faz nada.
 */
export function useUnsavedChanges(unsaved: boolean): void {
  const registry = useContext(UnsavedChangesContext);
  const id = useId();
  useEffect(() => {
    if (!registry || !unsaved) return;
    registry.add(id);
    return () => { registry.delete(id); };
  }, [registry, id, unsaved]);
}
