import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { AuthAlert } from './AuthAlert';
import { authPrimaryBtnCls } from '../../lib/authStyles';

/**
 * Usuário autenticado cujo perfil/papel não pôde ser carregado. Em vez de abrir o app sem papel
 * (e telas vazias sem explicação), pede para tentar de novo ou sair. Nenhum detalhe técnico é exibido.
 */
export function ProfileLoadError() {
  const { refreshProfile, signOut } = useAuth();
  const navigate = useNavigate();
  const [retrying, setRetrying] = useState(false);

  const retry = async () => {
    setRetrying(true);
    await refreshProfile();
    setRetrying(false);
  };

  const leave = async () => {
    await signOut();
    navigate('/login');
  };

  return (
    <div className="flex min-h-dvh items-center justify-center bg-gray-50 px-4">
      <div className="w-full max-w-md space-y-5 rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
        <h1 className="text-xl font-semibold text-gray-900">Não foi possível carregar sua conta</h1>
        <AuthAlert tone="error">
          Você está autenticado, mas não conseguimos carregar seu perfil e permissões. Verifique sua conexão e
          tente novamente. Se o problema continuar, fale com a coordenação.
        </AuthAlert>
        <button type="button" onClick={retry} disabled={retrying} aria-busy={retrying} className={authPrimaryBtnCls}>
          {retrying && <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />}
          {retrying ? 'Tentando...' : 'Tentar novamente'}
        </button>
        <button
          type="button"
          onClick={leave}
          className="w-full text-center text-sm font-medium text-gray-600 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 rounded"
        >
          Sair
        </button>
      </div>
    </div>
  );
}
