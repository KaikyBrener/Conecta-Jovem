import { createClient } from '@supabase/supabase-js';
import type { Database } from '../types/database.types';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  throw new Error('Faltam as variáveis de ambiente VITE_SUPABASE_URL e/ou VITE_SUPABASE_PUBLISHABLE_KEY. Verifique o seu arquivo .env.');
}

export const supabase = createClient<Database>(supabaseUrl, supabaseKey);
