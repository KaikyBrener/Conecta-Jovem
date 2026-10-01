import { useState, useEffect, useCallback } from 'react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';
import { errorMessage } from '../lib/format';
import type { AppSettings, AppSettingsUpdate, Role } from '../types/database.types';

export const DEFAULT_SETTINGS: Pick<AppSettings, 'absence_alert_threshold' | 'low_attendance_threshold'> = {
  absence_alert_threshold: 3,
  low_attendance_threshold: 70,
};

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
    return true;
  };

  const recalculateAlerts = async (): Promise<number | null> => {
    setError(null);
    const { data, error: e } = await (supabase as any).rpc('recalculate_all_alerts');
    if (e) { setError(errorMessage(e)); return null; }
    return data as number;
  };

  return {
    settings,
    effective: settings ?? { ...DEFAULT_SETTINGS },
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

/** Coordenador: lista usuários e altera papéis (via RPC set_user_role) */
export function useUserManagement(enabled: boolean) {
  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);

  // user_roles.user_id referencia profiles(id) diretamente, então uma única
  // consulta com embed já traz role + perfil (sem precisar juntar no cliente).
  const load = useCallback(async (): Promise<ManagedUser[]> => {
    const { data, error: e } = await (supabase as any)
      .from('user_roles')
      .select('role, profiles:user_id(id, full_name, created_at)');
    if (e) throw e;
    return ((data ?? []) as { role: Role; profiles: Omit<ManagedUser, 'role'> | null }[])
      .filter((r): r is { role: Role; profiles: Omit<ManagedUser, 'role'> } => r.profiles !== null)
      .map((r) => ({ ...r.profiles, role: r.role }))
      .sort((a, b) => (a.full_name ?? '').localeCompare(b.full_name ?? '', 'pt-BR'));
  }, []);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    load()
      .then((u) => { if (!cancelled) setUsers(u); })
      .catch((err: unknown) => { if (!cancelled) setError(errorMessage(err, 'Erro ao carregar usuários.')); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [enabled, load]);

  const setUserRole = async (userId: string, role: Role): Promise<boolean> => {
    setError(null);
    const { error: e } = await (supabase as any).rpc('set_user_role', { p_user_id: userId, p_role: role });
    if (e) { setError(errorMessage(e)); return false; }
    setUsers(await load());
    return true;
  };

  return { users, loading, error, setUserRole };
}

/** Qualquer usuário: atualizar o próprio nome e senha */
export async function updateOwnName(userId: string, fullName: string): Promise<string | null> {
  const { error } = await (supabase as any).from('profiles').update({ full_name: fullName }).eq('id', userId);
  return error ? errorMessage(error) : null;
}

export async function updateOwnPassword(password: string): Promise<string | null> {
  const { error } = await supabase.auth.updateUser({ password });
  return error ? errorMessage(error) : null;
}
