import { useId, useRef, useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { initialAuthLink, supabase } from '../lib/supabase';
import { translateAuthError } from '../lib/format';
import { logError } from '../lib/logger';
import { cn } from '../lib/utils';
import { authLinkCls, authPrimaryBtnCls } from '../lib/authStyles';
import { AuthShell } from '../components/auth/AuthShell';
import { AuthAlert } from '../components/auth/AuthAlert';
import { PasswordInput } from '../components/auth/PasswordInput';

const MIN_LENGTH = 6; // mesmo mínimo de Configurações; o Supabase aplica a política real do projeto
const SAVE_FALLBACK = 'Não foi possível salvar a nova senha. Tente novamente.';

/**
 * Destino dos links de e-mail do Supabase Auth: recuperação de senha e convite de usuário.
 * Chegando por um link válido o usuário já está autenticado (sessão do link) e só falta escolher a senha.
 */
export function RedefinirSenha() {
  const { user, loading: authLoading, passwordSetupPending, finishPasswordSetup } = useAuth();
  const navigate = useNavigate();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  // Ao concluir, finishPasswordSetup() faria o redirect "autenticado sem link → Configurações" disparar
  // antes do navigate('/'): este flag mantém a tela estável até a navegação terminar.
  const [done, setDone] = useState(false);
  const passwordRef = useRef<HTMLInputElement>(null);
  const confirmRef = useRef<HTMLInputElement>(null);
  const uid = useId();
  const errorId = `${uid}-error`;
  const isInvite = initialAuthLink.type === 'invite';

  if (authLoading) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-gray-50" role="status" aria-label="Verificando o link">
        <Loader2 className="h-8 w-8 animate-spin text-blue-600 motion-reduce:animate-none" aria-hidden="true" />
      </div>
    );
  }

  // Autenticado normalmente (sem link): trocar senha é em Configurações
  if (user && !passwordSetupPending && !done) return <Navigate to="/settings" replace />;

  // Sem sessão: link expirado/já usado/inválido, ou página aberta diretamente
  if (!user) {
    return (
      <AuthShell title="Link inválido ou expirado">
        <div className="mt-4 space-y-5">
          <AuthAlert tone="error">
            Este link não é mais válido. Links de e-mail expiram e só podem ser usados uma vez.
          </AuthAlert>
          <Link to="/recuperar-senha" onClick={finishPasswordSetup} className={cn(authPrimaryBtnCls, 'no-underline')}>
            Pedir um novo link
          </Link>
          <div className="text-center">
            <Link to="/login" onClick={finishPasswordSetup} className={authLinkCls}>Voltar ao login</Link>
          </div>
        </div>
      </AuthShell>
    );
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    // Após um erro o foco vai ao primeiro campo inválido (o botão desabilitado durante o envio o tira do lugar)
    if (password.length < MIN_LENGTH) {
      setError(`A senha deve ter pelo menos ${MIN_LENGTH} caracteres.`);
      passwordRef.current?.focus();
      return;
    }
    if (password !== confirm) {
      setError('As senhas não conferem.');
      confirmRef.current?.focus();
      return;
    }
    setLoading(true);
    const { error: err } = await supabase.auth.updateUser({ password });
    setLoading(false);
    if (err) {
      setError(translateAuthError(err, SAVE_FALLBACK));
      passwordRef.current?.focus();
      return;
    }
    // A senha mudou: tenta encerrar as OUTRAS sessões (ex.: quem tinha o acesso comprometido). A atual
    // continua. A troca já deu certo: falha aqui não bloqueia o fluxo, só é registrada.
    const { error: signOutError } = await supabase.auth.signOut({ scope: 'others' });
    if (signOutError) logError('Senha definida, mas não foi possível encerrar as outras sessões.', signOutError);
    setDone(true);
    finishPasswordSetup();
    navigate('/', { replace: true });
  };

  return (
    <AuthShell
      title={isInvite ? 'Defina sua senha' : 'Redefinir senha'}
      subtitle={
        isInvite
          ? 'Bem-vindo ao Conecta Jovem! Escolha uma senha para acessar o sistema nas próximas vezes.'
          : 'Escolha uma nova senha para a sua conta.'
      }
    >
      <form className="mt-6 space-y-5" onSubmit={handleSubmit} aria-busy={loading} noValidate>
        <PasswordInput
          id={`${uid}-pw`}
          inputRef={passwordRef}
          name="new-password"
          label="Nova senha"
          autoComplete="new-password"
          value={password}
          onChange={setPassword}
          readOnly={loading}
          invalid={!!error}
          describedBy={error ? errorId : `${uid}-hint`}
        />
        <p id={`${uid}-hint`} className="-mt-3 text-xs text-gray-500">Mínimo de {MIN_LENGTH} caracteres.</p>
        <PasswordInput
          id={`${uid}-pw2`}
          inputRef={confirmRef}
          name="confirm-password"
          label="Confirmar senha"
          autoComplete="new-password"
          value={confirm}
          onChange={setConfirm}
          readOnly={loading}
          invalid={!!error}
          describedBy={error ? errorId : undefined}
        />

        {error && <AuthAlert tone="error" id={errorId}>{error}</AuthAlert>}

        <button type="submit" disabled={loading} aria-busy={loading} className={authPrimaryBtnCls}>
          {loading && <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />}
          {loading ? 'Salvando...' : isInvite ? 'Definir senha e entrar' : 'Salvar nova senha'}
        </button>
      </form>
    </AuthShell>
  );
}
