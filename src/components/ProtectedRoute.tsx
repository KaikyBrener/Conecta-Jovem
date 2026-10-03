import { Navigate, Outlet } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { ProfileLoadError } from './auth/ProfileLoadError';
import type { Role } from '../types/database.types';

interface ProtectedRouteProps {
  allowedRoles?: Role[];
}

export const ProtectedRoute = ({ allowedRoles }: ProtectedRouteProps) => {
  const { user, role, loading, sessionLost, profileError } = useAuth();

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="animate-spin rounded-full h-8 w-8 border-t-2 border-b-2 border-blue-600"></div>
      </div>
    );
  }

  if (!user) {
    // Se a sessão acabou sozinha (expirou, revogada, encerrada em outra aba) o login explica o motivo
    return <Navigate to="/login" replace state={sessionLost ? { reason: 'expired' } : undefined} />;
  }

  // Autenticado, mas perfil/papel não carregaram (rede, linha ausente): não abrir o app "pela metade".
  // Falha fechado — sem papel conhecido nenhuma rota protegida é exibida.
  if (!role || profileError) {
    return <ProfileLoadError />;
  }

  // Falha fechado: se a rota exige papéis específicos e o papel ainda não foi
  // carregado (null), nega o acesso em vez de liberar. A UI não é a barreira
  // de autorização real (isso é garantido pelo RLS no Supabase), mas o guard
  // de rota não deve abrir uma exceção por ausência de dado.
  if (allowedRoles && !allowedRoles.includes(role)) {
    return <Navigate to="/" replace />;
  }

  return <Outlet />;
};
