import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { User, Session } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';
import type { Profile, Role } from '../types/database.types';

interface AuthContextType {
  session: Session | null;
  user: User | null;
  profile: Profile | null;
  role: Role | null;
  loading: boolean;
  signOut: () => Promise<void>;
  refreshProfile: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType>({
  session: null,
  user: null,
  profile: null,
  role: null,
  loading: true,
  signOut: async () => {},
  refreshProfile: async () => {},
});

export const AuthProvider = ({ children }: { children: ReactNode }) => {
  const [session, setSession] = useState<Session | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [role, setRole] = useState<Role | null>(null);
  const [loading, setLoading] = useState(true);
  // Evita buscar o perfil de novo em eventos como TOKEN_REFRESHED
  const loadedUserId = useRef<string | null>(null);

  const fetchUserData = useCallback(async (userId: string) => {
    try {
      const [profileResponse, roleResponse]: [any, any] = await Promise.all([
        (supabase as any).from('profiles').select('*').eq('id', userId).single(),
        (supabase as any).from('user_roles').select('role').eq('user_id', userId).single(),
      ]);

      if (profileResponse.error) console.error('Error fetching profile:', profileResponse.error);
      else if (profileResponse.data) setProfile(profileResponse.data as Profile);

      if (roleResponse.error) console.error('Error fetching role:', roleResponse.error);
      else if (roleResponse.data) setRole(roleResponse.data.role as Role);
    } catch (err) {
      console.error('Unexpected error fetching user data:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // onAuthStateChange emite INITIAL_SESSION ao assinar, então não é preciso getSession().
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, newSession) => {
      setSession(newSession);
      setUser(newSession?.user ?? null);

      const uid = newSession?.user?.id ?? null;
      if (!uid) {
        loadedUserId.current = null;
        setProfile(null);
        setRole(null);
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
    await supabase.auth.signOut();
  };

  const refreshProfile = useCallback(async () => {
    if (user) await fetchUserData(user.id);
  }, [user, fetchUserData]);

  return (
    <AuthContext.Provider value={{ session, user, profile, role, loading, signOut, refreshProfile }}>
      {children}
    </AuthContext.Provider>
  );
};

// eslint-disable-next-line react-refresh/only-export-components
export const useAuth = () => useContext(AuthContext);
