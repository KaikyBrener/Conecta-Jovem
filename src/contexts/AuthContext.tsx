import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { User, Session } from '@supabase/supabase-js';
import { initialAuthLink, supabase } from '../lib/supabase';
import { logError } from '../lib/logger';
import type { Profile, Role } from '../types/database.types';

interface AuthContextType {
  session: Session | null;
  user: User | null;
  profile: Profile | null;
  role: Role | null;
  loading: boolean;
  /** Estamos autenticados mas não conseguimos carregar perfil/papel (rede, linha ausente) */
  profileError: boolean;
  /** A sessão acabou sem o usuário pedir (expirou, revogada, encerrada em outra aba) */
  sessionLost: boolean;
  /** Veio de um link de recuperação/convite: o usuário precisa definir uma senha */
  passwordSetupPending: boolean;
  finishPasswordSetup: () => void;
  signOut: () => Promise<void>;
  refreshProfile: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType>({
  session: null,
  user: null,
  profile: null,
  role: null,
  loading: true,
  profileError: false,
  sessionLost: false,
  passwordSetupPending: false,
  finishPasswordSetup: () => {},
  signOut: async () => {},
  refreshProfile: async () => {},
});

export const AuthProvider = ({ children }: { children: ReactNode }) => {
  const [session, setSession] = useState<Session | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [role, setRole] = useState<Role | null>(null);
  const [loading, setLoading] = useState(true);
  const [profileError, setProfileError] = useState(false);
  const [sessionLost, setSessionLost] = useState(false);
  const [passwordSetupPending, setPasswordSetupPending] = useState(initialAuthLink.needsPassword);
  // Evita buscar o perfil de novo em eventos como TOKEN_REFRESHED
  const loadedUserId = useRef<string | null>(null);
  // Distinguem "usuário saiu" de "a sessão acabou sozinha"
  const hadUser = useRef(false);
  const manualSignOut = useRef(false);

  const fetchUserData = useCallback(async (userId: string) => {
    let failed = false;
    let nextProfile: Profile | null = null;
    let nextRole: Role | null = null;
    try {
      const [profileResponse, roleResponse]: [any, any] = await Promise.all([
        (supabase as any).from('profiles').select('*').eq('id', userId).single(),
        (supabase as any).from('user_roles').select('role').eq('user_id', userId).single(),
      ]);

      if (profileResponse.error) { failed = true; logError('Erro ao carregar o perfil', profileResponse.error); }
      else if (profileResponse.data) nextProfile = profileResponse.data as Profile;

      if (roleResponse.error) { failed = true; logError('Erro ao carregar o papel do usuário', roleResponse.error); }
      else if (roleResponse.data) nextRole = roleResponse.data.role as Role;
    } catch (err) {
      failed = true;
      logError('Erro inesperado ao carregar o usuário', err);
    }
    // A resposta pode chegar depois de um logout/troca de usuário: descarta para não
    // aplicar perfil/papel de outra pessoa ao usuário atual.
    if (loadedUserId.current !== userId) return;
    // Sempre substitui (nunca "mantém o anterior"): se a busca falhar, não sobra papel antigo em cache.
    setProfile(nextProfile);
    setRole(nextRole);
    setProfileError(failed || !nextRole);
    setLoading(false);
  }, []);

  useEffect(() => {
    // onAuthStateChange emite INITIAL_SESSION ao assinar, então não é preciso getSession().
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, newSession) => {
      if (event === 'PASSWORD_RECOVERY') setPasswordSetupPending(true);
      if (event === 'SIGNED_IN') setSessionLost(false);
      if (event === 'SIGNED_OUT' && hadUser.current && !manualSignOut.current) setSessionLost(true);
      hadUser.current = !!newSession?.user;
      if (!newSession) manualSignOut.current = false;

      setSession(newSession);
      setUser(newSession?.user ?? null);

      const uid = newSession?.user?.id ?? null;
      if (!uid) {
        loadedUserId.current = null;
        setProfile(null);
        setRole(null);
        setProfileError(false);
        setLoading(false);
        return;
      }
      if (loadedUserId.current === uid) return;
      loadedUserId.current = uid;
      setLoading(true);
      // Não chamar o Supabase de forma síncrona dentro do callback (pode travar o cliente).
      setTimeout(() => { void fetchUserData(uid); }, 0);
    });

    return () => {
      subscription.unsubscribe();
    };
  }, [fetchUserData]);

  const signOut = async () => {
    manualSignOut.current = true;
    await supabase.auth.signOut();
  };

  const refreshProfile = useCallback(async () => {
    if (user) await fetchUserData(user.id);
  }, [user, fetchUserData]);

  const finishPasswordSetup = useCallback(() => setPasswordSetupPending(false), []);

  return (
    <AuthContext.Provider
      value={{
        session, user, profile, role, loading, profileError, sessionLost,
        passwordSetupPending, finishPasswordSetup, signOut, refreshProfile,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};

// eslint-disable-next-line react-refresh/only-export-components
export const useAuth = () => useContext(AuthContext);
