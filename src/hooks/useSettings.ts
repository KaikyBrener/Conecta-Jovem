import { useState, useEffect } from 'react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';
import { errorMessage, translateAuthError } from '../lib/format';
import { logError } from '../lib/logger';
import { notifyAlertsChanged } from '../lib/alertsBus';
import { usePagedList } from './usePagedList';
import type { AppSettings, AppSettingsUpdate, Role } from '../types/database.types';

async function loadSettings(): Promise<AppSettings | null> {
  const { data, error } = await (supabase as any).from('app_settings').select('*').maybeSingle();
  if (error) throw error;
  return (data as AppSettings | null) ?? null;
}

/** Parâmetros do sistema (leitura para todos os usuários autenticados) */
export function useAppSettings() {
  const { user } = useAuth();
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    loadSettings()
      .then((s) => { if (!cancelled) setSettings(s); })
      .catch((err: unknown) => { if (!cancelled) setError(errorMessage(err, 'Erro ao carregar configurações.')); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [user]);

  const updateSettings = async (payload: AppSettingsUpdate): Promise<boolean> => {
    setError(null);
    const { data, error: e } = await (supabase as any)
      .from('app_settings')
      .update(payload)
      .eq('id', true)
      .select()
      .maybeSingle();
    if (e) { setError(errorMessage(e)); return false; }
    // RLS bloqueia silenciosamente (0 linhas) quando não é coordenador
    if (!data) { setError('Sem permissão para alterar as configurações.'); return false; }
    setSettings(data as AppSettings);
    notifyAlertsChanged(); // mudar limites recalcula alertas no banco
    return true;
  };

  const recalculateAlerts = async (): Promise<number | null> => {
    setError(null);
    const { data, error: e } = await (supabase as any).rpc('recalculate_all_alerts');
    if (e) { setError(errorMessage(e)); return null; }
    notifyAlertsChanged();
    return data as number;
  };

  return {
    settings,
    loading,
    error,
    updateSettings,
    recalculateAlerts,
  };
}

export interface ManagedUser {
  id: string;
  full_name: string | null;
  role: Role;
  created_at: string;
}

type RawProfile = {
  id: string;
  full_name: string | null;
  created_at: string;
  // user_roles.user_id é PK → relação 1:1 (objeto); aceita array por segurança
  user_roles: { role: Role } | { role: Role }[] | null;
};

/**
 * Coordenador: lista usuários paginados no servidor e altera papéis (via RPC set_user_role).
 * Parte de profiles (1 linha por usuário) com o papel embutido, ordenado por nome.
 */
export function useUserManagement(enabled: boolean) {
  const [mutationError, setMutationError] = useState<string | null>(null);

  const list = usePagedList<ManagedUser>({
    enabled,
    filters: [],
    errorFallback: 'Erro ao carregar usuários.',
    fetchPage: async ({ from, to }) => {
      const { data, count, error } = await (supabase as any)
        .from('profiles')
        .select('id, full_name, created_at, user_roles(role)', { count: 'exact' })
        .order('full_name', { ascending: true, nullsFirst: false })
        .order('id')
        .range(from, to);
      if (error) throw error;
      const rows = ((data ?? []) as RawProfile[]).map((p): ManagedUser => {
        const ur = Array.isArray(p.user_roles) ? p.user_roles[0] : p.user_roles;
        return { id: p.id, full_name: p.full_name, created_at: p.created_at, role: ur?.role ?? 'leader' };
      });
      return { rows, total: count ?? 0 };
    },
  });
  const { refetch } = list;

  const setUserRole = async (userId: string, role: Role): Promise<boolean> => {
    setMutationError(null);
    const { error: e } = await (supabase as any).rpc('set_user_role', { p_user_id: userId, p_role: role });
    if (e) { setMutationError(errorMessage(e)); return false; }
    refetch();
    return true;
  };

  return {
    users: list.rows,
    total: list.total,
    page: list.page,
    setPage: list.setPage,
    pageSize: list.pageSize,
    totalPages: list.totalPages,
    loading: list.loading,
    error: mutationError ?? list.error,
    setUserRole,
  };
}

/** Qualquer usuário: atualizar o próprio nome e senha */
export async function updateOwnName(userId: string, fullName: string): Promise<string | null> {
  const { error } = await (supabase as any).from('profiles').update({ full_name: fullName }).eq('id', userId);
  return error ? errorMessage(error) : null;
}

export async function updateOwnPassword(password: string): Promise<string | null> {
  const { error } = await supabase.auth.updateUser({ password });
  if (!error) {
    // A senha mudou: tenta encerrar as OUTRAS sessões; a atual continua. A troca já deu certo, então uma
    // falha aqui não vira erro para o usuário: só é registrada.
    const { error: signOutError } = await supabase.auth.signOut({ scope: 'others' });
    if (signOutError) logError('Senha alterada, mas não foi possível encerrar as outras sessões.', signOutError);
  }
  // texto do GoTrue é em inglês: traduz (e não expõe mensagens internas desconhecidas)
  return error ? translateAuthError(error, 'Não foi possível alterar a senha. Tente novamente.') : null;
}
