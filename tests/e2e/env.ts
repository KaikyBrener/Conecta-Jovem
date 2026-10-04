// Constantes compartilhadas entre playwright.config.ts, o servidor falso e as specs.
// O app de teste SEMPRE aponta para o Supabase falso local — nunca para o .env real
// (variáveis de ambiente do processo têm prioridade sobre .env no Vite).
export const FAKE_SUPABASE_PORT = Number(process.env.E2E_SUPABASE_PORT ?? 54321);
export const APP_PORT = Number(process.env.E2E_APP_PORT ?? 5174);

export const SUPABASE_URL = `http://127.0.0.1:${FAKE_SUPABASE_PORT}`;
export const APP_URL = `http://127.0.0.1:${APP_PORT}`;
export const ANON_KEY = 'e2e-anon-key';
/** Exigido pelos endpoints /__test/* do servidor falso (uma página qualquer não consegue chamá-los). */
export const CONTROL_TOKEN = 'e2e-control-token';

/** Chave do localStorage onde o supabase-js guarda a sessão (sb-<1º label do host>-auth-token). */
export const AUTH_STORAGE_KEY = `sb-${new URL(SUPABASE_URL).hostname.split('.')[0]}-auth-token`;
