import { useId, useRef, useState } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { KeyRound, Loader2, Mail } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { supabase } from '../lib/supabase';
import { RECOVER_NEUTRAL_MESSAGE, recoverErrorMessage } from '../lib/format';
import { logError } from '../lib/logger';
import { cn } from '../lib/utils';
import {
  authLinkCls, authPrimaryBtnCls, fieldCls, fieldIconCls, fieldInvalidCls, fieldWithIconCls, labelCls,
} from '../lib/authStyles';
import { AuthShell } from '../components/auth/AuthShell';
import { AuthAlert } from '../components/auth/AuthAlert';

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
    const message = recoverErrorMessage(err);
    if (message) {
      // registro sanitizado (sem e-mail nem token; ver lib/logger.ts) para diagnosticar falha de envio
      logError('Pedido de redefinição de senha falhou.', err);
      setError(message);
      // o botão desabilitado durante o envio tirou o foco: devolve ao campo de e-mail
      emailRef.current?.focus();
      return;
    }
    // sucesso OU conta inexistente: a mesma tela, com a mesma mensagem
    setSent(true);
  };

  if (!authLoading && user && !passwordSetupPending) return <Navigate to="/" replace />;

  if (sent) {
    return (
      <AuthShell title="Verifique seu e-mail">
        <div className="mt-4 space-y-5">
          {/* Mesma resposta exista ou não a conta: não revela quem tem cadastro */}
          <AuthAlert tone="success">{RECOVER_NEUTRAL_MESSAGE}</AuthAlert>
          <p className="text-sm text-gray-600">
            O link vale por tempo limitado e só pode ser usado uma vez. Confira também a caixa de spam.
          </p>
          <Link to="/login" className={cn(authPrimaryBtnCls, 'no-underline')}>Voltar ao login</Link>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title="Recuperar senha"
      icon={KeyRound}
      subtitle="Informe o e-mail da sua conta e enviaremos um link para criar uma nova senha."
    >
      <form className="mt-6 space-y-5" onSubmit={handleSubmit} aria-busy={loading}>
        <div>
          <label htmlFor={emailId} className={labelCls}>E-mail</label>
          <div className="relative mt-1.5">
            <Mail className={fieldIconCls} aria-hidden="true" />
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
              className={cn(fieldCls, fieldWithIconCls, error && fieldInvalidCls)}
            />
          </div>
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
