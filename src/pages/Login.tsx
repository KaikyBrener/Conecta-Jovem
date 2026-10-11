import { useEffect, useId, useRef, useState } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { Loader2, LogIn, Mail } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { supabase } from '../lib/supabase';
import { translateAuthError } from '../lib/format';
import { cn } from '../lib/utils';
import {
  authLinkCls, authPrimaryBtnCls, fieldCls, fieldIconCls, fieldInvalidCls, fieldWithIconCls, labelCls,
} from '../lib/authStyles';
import { AuthShell } from '../components/auth/AuthShell';
import { AuthAlert } from '../components/auth/AuthAlert';
import { PasswordInput } from '../components/auth/PasswordInput';

export const Login = () => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const navigate = useNavigate();
  const location = useLocation();
  const { user, loading: authLoading } = useAuth();
  const passwordRef = useRef<HTMLInputElement>(null);
  // ProtectedRoute envia { reason: 'expired' } quando a sessão acabou sem o usuário pedir.
  // Lido uma vez e limpo do history.state logo depois, para o aviso não reaparecer ao recarregar.
  const stateReason = (location.state as { reason?: string } | null)?.reason;
  const [sessionEnded] = useState(stateReason === 'expired');
  useEffect(() => {
    if (stateReason === 'expired') navigate(`${location.pathname}${location.search}`, { replace: true, state: null });
  }, [stateReason, navigate, location.pathname, location.search]);

  const uid = useId();
  const emailId = `${uid}-email`;
  const passwordId = `${uid}-password`;
  const errorId = `${uid}-error`;

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');

    const { error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (error) {
      setError(translateAuthError(error));
      setLoading(false);
      // O botão fica desabilitado durante o envio e o foco iria para o <body>: leva ao campo de senha
      // (somente leitura durante o envio, mas focável) com o texto selecionado, pronto para redigitar.
      passwordRef.current?.focus();
      passwordRef.current?.select();
    } else {
      navigate('/');
    }
  };

  if (!authLoading && user) return <Navigate to="/" replace />;

  const describedBy = error ? errorId : undefined;

  return (
    <AuthShell
      title="Entrar"
      icon={LogIn}
      subtitle="Acesse o sistema com seu e-mail e senha."
      footer="Acesso restrito a membros da equipe."
    >
      {sessionEnded && !error && (
        <div className="mt-4">
          <AuthAlert tone="info">Sua sessão foi encerrada. Entre novamente para continuar.</AuthAlert>
        </div>
      )}

      <form className="mt-6 space-y-5" onSubmit={handleLogin} aria-busy={loading}>
        <div>
          <label htmlFor={emailId} className={labelCls}>E-mail</label>
          <div className="relative mt-1.5">
            <Mail className={fieldIconCls} aria-hidden="true" />
            <input
              id={emailId}
              type="email"
              name="email"
              required
              autoComplete="email"
              inputMode="email"
              autoCapitalize="none"
              spellCheck={false}
              placeholder="nome@exemplo.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              readOnly={loading}
              aria-invalid={error ? true : undefined}
              aria-describedby={describedBy}
              className={cn(fieldCls, fieldWithIconCls, error && fieldInvalidCls)}
            />
          </div>
        </div>

        <div>
          <PasswordInput
            id={passwordId}
            inputRef={passwordRef}
            name="password"
            label="Senha"
            placeholder="Digite sua senha"
            autoComplete="current-password"
            value={password}
            onChange={setPassword}
            readOnly={loading}
            invalid={!!error}
            describedBy={describedBy}
          />
          <div className="mt-2 text-right">
            <Link to="/recuperar-senha" className={authLinkCls}>Esqueci minha senha</Link>
          </div>
        </div>

        {error && <AuthAlert tone="error" id={errorId}>{error}</AuthAlert>}

        <button type="submit" disabled={loading} aria-busy={loading} className={authPrimaryBtnCls}>
          {loading && <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />}
          {loading ? 'Entrando...' : 'Entrar'}
        </button>
      </form>
    </AuthShell>
  );
};
