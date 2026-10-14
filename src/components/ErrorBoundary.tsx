import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import { TriangleAlert } from 'lucide-react';
import { logError } from '../lib/logger';

interface Props {
  children: ReactNode;
  /** app: tela cheia (raiz). page: dentro do Layout, a navegação continua visível (o Layout usa key={rota}, então trocar de página limpa o erro). */
  variant?: 'app' | 'page';
}

interface State {
  failed: boolean;
  incidentId: string | null;
}

const btnCls =
  'inline-flex items-center justify-center rounded-control px-4 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500';

/**
 * Rede de segurança para erros inesperados de renderização: em vez de tela em branco, explica,
 * oferece uma saída e mostra só o CÓDIGO do incidente (o detalhe técnico — sanitizado — vai
 * para o logger; mensagem e stack nunca aparecem na tela).
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { failed: false, incidentId: null };

  static getDerivedStateFromError(): Partial<State> {
    return { failed: true };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    // info.componentStack só ajuda a depurar localmente; não vai ao registro
    void info;
    this.setState({ incidentId: logError('Erro inesperado ao exibir a tela', error) });
  }

  private retry = () => this.setState({ failed: false, incidentId: null });

  render() {
    if (!this.state.failed) return this.props.children;
    const isApp = this.props.variant === 'app';

    return (
      <div
        role="alert"
        className={isApp ? 'flex min-h-dvh items-center justify-center bg-gray-50 px-4' : 'flex justify-center py-10'}
      >
        <div className="w-full max-w-md space-y-4 rounded-card border border-gray-200 bg-white p-6 text-center shadow-sm">
          <TriangleAlert className="mx-auto h-10 w-10 text-amber-500" aria-hidden="true" />
          <h2 className="text-lg font-semibold text-gray-900">Algo deu errado</h2>
          <p className="text-sm text-gray-600">
            Não foi possível exibir esta tela. Seus dados não foram afetados. Tente novamente; se o problema continuar,
            avise a coordenação informando o código abaixo.
          </p>
          {this.state.incidentId && (
            <p className="text-xs text-gray-500">
              Código do incidente: <span className="font-mono">{this.state.incidentId}</span>
            </p>
          )}
          <div className="flex flex-col gap-2 sm:flex-row sm:justify-center">
            {!isApp && (
              <button type="button" onClick={this.retry} className={`${btnCls} bg-blue-600 text-white hover:bg-blue-700`}>
                Tentar novamente
              </button>
            )}
            <button
              type="button"
              onClick={() => window.location.reload()}
              className={`${btnCls} ${isApp ? 'bg-blue-600 text-white hover:bg-blue-700' : 'border border-gray-300 bg-white text-gray-700 hover:bg-gray-50'}`}
            >
              Recarregar a página
            </button>
          </div>
        </div>
      </div>
    );
  }
}
