import { useId, useRef, useState } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { supabase } from '../lib/supabase';
import { translateAuthError } from '../lib/format';
import { cn } from '../lib/utils';
import { authLinkCls, authPrimaryBtnCls, fieldCls, fieldInvalidCls, labelCls } from '../lib/authStyles';
import { AuthShell } from '../components/auth/AuthShell';
import { AuthAlert } from '../components/auth/AuthAlert';

const SEND_FALLBACK = 'Não foi possível enviar o e-mail agora. Tente novamente em instantes.';

/** "Esqueci minha senha": pede ao Supabase Auth o e-mail com o link de redefinição. */
export function RecuperarSenha() {
  const { user, loading: authLoading, passwordSetupPending } = useAuth();
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');
  const emailRef = useRef<HTMLInputElement>(null);
  const uid = useId();
  const emailId = `${uid}-email`;
  const errorId = `${uid}-error`;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    const { error: err } = await supabase.auth.resetPasswordForEmail(email.trim(), {
      // origem do próprio app (nunca vem de entrada do usuário); precisa estar nas
      // "Redirect URLs" do Supabase Auth (ver README)
      redirectTo: `${window.location.origin}/redefinir-senha`,
    });
    setLoading(false);
    if (err) {
      setError(translateAuthError(err, SEND_FALLBACK));
      // o botão desabilitado durante o envio tirou o foco: devolve ao campo de e-mail
      emailRef.current?.focus();
      return;
    }
    setSent(true);
  };

  if (!authLoading && user && !passwordSetupPending) return <Navigate to="/" replace />;

  if (sent) {
    return (
      <AuthShell title="Verifique seu e-mail">
        <div className="mt-4 space-y-5">
          {/* Mesma resposta exista ou não a conta: não revela quem tem cadastro */}
          <AuthAlert tone="success">
            Se <strong>{email.trim()}</strong> estiver cadastrado, enviamos um link para redefinir a senha.
            Ele vale por tempo limitado. Confira também a caixa de spam.
          </AuthAlert>
          <Link to="/login" className={cn(authPrimaryBtnCls, 'no-underline')}>Voltar ao login</Link>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title="Recuperar senha"
      subtitle="Informe o e-mail da sua conta e enviaremos um link para criar uma nova senha."
    >
      <form className="mt-6 space-y-5" onSubmit={handleSubmit} aria-busy={loading}>
        <div>
          <label htmlFor={emailId} className={labelCls}>E-mail</label>
          <input
            ref={emailRef}
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
            aria-describedby={error ? errorId : undefined}
            className={cn(fieldCls, 'mt-1.5', error && fieldInvalidCls)}
          />
        </div>

        {error && <AuthAlert tone="error" id={errorId}>{error}</AuthAlert>}

        <button type="submit" disabled={loading} aria-busy={loading} className={authPrimaryBtnCls}>
          {loading && <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />}
          {loading ? 'Enviando...' : 'Enviar link'}
        </button>

        <div className="text-center">
          <Link to="/login" className={authLinkCls}>Voltar ao login</Link>
        </div>
      </form>
    </AuthShell>
  );
}
