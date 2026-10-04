import { logError } from './logger';

/**
 * Captura o que escapa do React: exceções fora da árvore (handlers, timers) e promessas rejeitadas
 * sem tratamento. Só registra (sanitizado) — não muda o comportamento da tela.
 */
export function installGlobalErrorHandlers(target: Window = window): void {
  target.addEventListener('error', (event) => {
    // aviso inofensivo do navegador, sem erro real por trás
    if (/ResizeObserver loop/i.test(event.message)) return;
    logError('Erro não tratado', event.error ?? event.message);
  });
  target.addEventListener('unhandledrejection', (event) => {
    logError('Promessa rejeitada sem tratamento', event.reason);
  });
}
