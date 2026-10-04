import { createHash } from 'node:crypto';
import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/**
 * Injeta uma Content-Security-Policy (<meta http-equiv>) no index.html SOMENTE no build.
 * - `npm run dev` (e o E2E, que roda em dev) não é afetado: o HMR do Vite precisa de scripts/WebSocket inline.
 * - O script inline de tema do index.html é liberado por hash SHA-256 calculado aqui, sem 'unsafe-inline'.
 * - `connect-src` libera apenas a origem do Supabase (VITE_SUPABASE_URL). Sem ela o build FALHA: o app
 *   também não funciona sem a variável (src/lib/supabase.ts), e uma CSP sem a origem quebraria o login.
 * Limites da meta tag (frame-ancestors, HSTS, nosniff, Referrer-Policy) dependem do host: ver README.
 */
function cspPlugin(supabaseUrl: string | undefined): Plugin {
  return {
    name: 'conecta-jovem-csp',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler(html: string) {
        if (!supabaseUrl) {
          throw new Error(
            'CSP: defina VITE_SUPABASE_URL (arquivo .env ou variável de ambiente) antes do build; ' +
              'ela define a origem permitida em connect-src.',
          );
        }
        let origin: string;
        try {
          const url = new URL(supabaseUrl);
          if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('protocolo inválido');
          origin = url.origin;
        } catch {
          throw new Error('CSP: VITE_SUPABASE_URL não é uma URL http(s) válida.');
        }

        // scripts inline (sem src): cada um recebe seu hash; qualquer outro inline será bloqueado pelo navegador.
        // O parser de HTML normaliza CRLF/CR para LF antes de o navegador calcular o hash: sem isto, um
        // index.html com CRLF (checkout no Windows) geraria um hash que não bate e o script seria bloqueado.
        const hashes = [...html.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => {
          const text = m[1].replace(/\r\n?/g, '\n');
          return `'sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}'`;
        });

        const csp = [
          `default-src 'self'`,
          `script-src 'self' ${hashes.join(' ')}`.trim(),
          `style-src 'self'`,
          `img-src 'self' data:`,
          `font-src 'self'`,
          `connect-src 'self' ${origin}`,
          `object-src 'none'`,
          `base-uri 'self'`,
          `form-action 'self'`,
          `manifest-src 'self'`,
        ].join('; ');

        // a meta vale só para o que vem DEPOIS dela: entra logo após o <meta charset> (antes de qualquer script/estilo)
        const meta = `<meta http-equiv="Content-Security-Policy" content="${csp}" />`;
        const charset = /<meta\s+charset=[^>]*>/i.exec(html);
        if (!charset) throw new Error('CSP: index.html precisa de <meta charset> para posicionar a política.');
        const at = charset.index + charset[0].length;
        return `${html.slice(0, at)}\n    ${meta}${html.slice(at)}`;
      },
    },
  };
}

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  // variáveis do processo têm prioridade sobre o .env (mesmo comportamento do Vite para import.meta.env)
  const env = { ...loadEnv(mode, process.cwd(), 'VITE_'), ...process.env };
  return {
    plugins: [
      tailwindcss(),
      react(),
      cspPlugin(env.VITE_SUPABASE_URL),
    ],
    build: {
      rolldownOptions: {
        output: {
          // Separa bibliotecas grandes em chunks próprios (melhor cache entre deploys)
          codeSplitting: {
            groups: [
              { name: 'supabase', test: /node_modules[\\/]@supabase/ },
              { name: 'react', test: /node_modules[\\/](react|react-dom|react-router|react-router-dom|scheduler)[\\/]/ },
            ],
          },
        },
      },
    },
  };
});
