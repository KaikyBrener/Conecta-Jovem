// Links enviados por e-mail pelo Supabase Auth (recuperação de senha, convite) chegam ao app com os
// tokens no fragmento da URL: `#access_token=…&type=recovery` ou, quando o link é inválido/expirado,
// `#error=access_denied&error_code=otp_expired&error_description=…`.
// O supabase-js consome e limpa esse fragmento ao iniciar, por isso ele precisa ser lido ANTES
// (ver src/lib/supabase.ts).

export interface AuthLinkInfo {
  /** `type` do link: recovery | invite | signup | magiclink | email_change | null */
  type: string | null;
  /** código do erro (ex.: otp_expired) quando o link veio inválido/expirado */
  errorCode: string | null;
  /** true quando o usuário precisa definir uma senha (recuperação, convite) ou o link falhou */
  needsPassword: boolean;
}

export function parseAuthLinkHash(hash: string): AuthLinkInfo {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  const type = params.get('type');
  const errorCode = params.get('error_code') ?? (params.get('error') ? 'access_denied' : null);
  return {
    type,
    errorCode,
    needsPassword: type === 'recovery' || type === 'invite' || errorCode !== null,
  };
}
