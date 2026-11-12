import { ShieldCheck } from 'lucide-react';
import { useAsyncValue } from '../../hooks/useAsyncValue';
import { formatTimestampSP } from '../../lib/format';
import { supabase } from '../../lib/supabase';

async function loadProfileName(id: string): Promise<string | null> {
  const { data, error } = await (supabase as any).from('profiles').select('full_name').eq('id', id).maybeSingle();
  if (error) throw error;
  return (data?.full_name as string | undefined) ?? null;
}

/**
 * Registro da anonimização na ficha (migration 025): quando foi e, para quem pode ver o perfil, por quem.
 * O líder só lê o próprio perfil (RLS): para ele aparece só a data. O registro completo fica no Histórico.
 */
export function AnonymizedNote({ at, by }: { at: string; by: string | null | undefined }) {
  const { data: name } = useAsyncValue<string | null>(by ?? null, () => loadProfileName(by!), null, 'Erro ao carregar quem anonimizou.');
  return (
    <p data-testid="jovem-anonimizado-em" className="flex items-start gap-2 rounded-control border border-line bg-canvas px-3 py-2 text-sm text-ink-soft">
      <ShieldCheck className="mt-0.5 h-4 w-4 flex-shrink-0 text-ink-muted" aria-hidden="true" />
      <span>Dados anonimizados em {formatTimestampSP(at)}{name ? <> por <strong className="font-medium text-ink">{name}</strong></> : null}.</span>
    </p>
  );
}
