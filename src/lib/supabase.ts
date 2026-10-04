import { createClient } from '@supabase/supabase-js';
import type { Database } from '../types/database.types';
import { parseAuthLinkHash, type AuthLinkInfo } from './authLink';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  throw new Error('Faltam as variáveis de ambiente VITE_SUPABASE_URL e/ou VITE_SUPABASE_PUBLISHABLE_KEY. Verifique o seu arquivo .env.');
}

// O supabase-js consome e apaga o fragmento da URL (#access_token=…&type=recovery) ao iniciar:
// o tipo do link é lido antes, para o app saber que precisa pedir uma senha nova.
export const initialAuthLink: AuthLinkInfo =
  typeof window === 'undefined' ? { type: null, errorCode: null, needsPassword: false } : parseAuthLinkHash(window.location.hash);

export const supabase = createClient<Database>(supabaseUrl, supabaseKey);
