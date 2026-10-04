import { lazy, Suspense } from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import { ThemeProvider } from './contexts/ThemeContext';
import { ToastProvider } from './contexts/ToastContext';
import { ProtectedRoute } from './components/ProtectedRoute';
import { Layout } from './components/Layout';
import { Login } from './pages/Login';
import { RecuperarSenha } from './pages/RecuperarSenha';
import { RedefinirSenha } from './pages/RedefinirSenha';

// Páginas carregadas sob demanda (reduz o bundle inicial)
const Dashboard = lazy(() => import('./pages/Dashboard').then((m) => ({ default: m.Dashboard })));
const Jovens = lazy(() => import('./pages/Jovens').then((m) => ({ default: m.Jovens })));
const Grupos = lazy(() => import('./pages/Grupos').then((m) => ({ default: m.Grupos })));
const Encontros = lazy(() => import('./pages/Encontros').then((m) => ({ default: m.Encontros })));
const Chamada = lazy(() => import('./pages/Chamada').then((m) => ({ default: m.Chamada })));
const Alertas = lazy(() => import('./pages/Alertas').then((m) => ({ default: m.Alertas })));
const Tarefas = lazy(() => import('./pages/Tarefas').then((m) => ({ default: m.Tarefas })));
const Relatorios = lazy(() => import('./pages/Relatorios').then((m) => ({ default: m.Relatorios })));
const Historico = lazy(() => import('./pages/Historico').then((m) => ({ default: m.Historico })));
const Configuracoes = lazy(() => import('./pages/Configuracoes').then((m) => ({ default: m.Configuracoes })));

function PageLoader() {
  return (
    <div className="flex justify-center py-16">
      <Loader2 className="w-6 h-6 text-blue-600 animate-spin" />
    </div>
  );
}

// Telas que um usuário com "definição de senha pendente" ainda pode abrir
const PASSWORD_SETUP_PATHS = ['/redefinir-senha', '/recuperar-senha', '/login'];

/**
 * Quem chega por link de recuperação/convite precisa escolher uma senha antes de usar o app:
 * qualquer outra rota é redirecionada para /redefinir-senha até concluir. (A sessão do link é
 * legítima — este guard é de experiência, não de autorização; a autorização continua sendo o RLS.)
 */
function PasswordSetupGate({ children }: { children: React.ReactNode }) {
  const { passwordSetupPending } = useAuth();
  const { pathname } = useLocation();
  if (passwordSetupPending && !PASSWORD_SETUP_PATHS.includes(pathname)) {
    return <Navigate to="/redefinir-senha" replace />;
  }
  return <>{children}</>;
}

function App() {
  return (
    <ThemeProvider>
      <ToastProvider>
      <AuthProvider>
        <Router>
          <PasswordSetupGate>
          <Suspense fallback={<PageLoader />}>
            <Routes>
              <Route path="/login" element={<Login />} />
              <Route path="/recuperar-senha" element={<RecuperarSenha />} />
              <Route path="/redefinir-senha" element={<RedefinirSenha />} />

              <Route element={<ProtectedRoute />}>
                <Route element={<Layout />}>
                  <Route path="/" element={<Dashboard />} />
                  <Route path="/jovens" element={<Jovens />} />
                  <Route path="/grupos" element={<Grupos />} />
                  <Route path="/encontros" element={<Encontros />} />
                  <Route path="/chamada/:id" element={<Chamada />} />
                  <Route path="/alertas" element={<Alertas />} />
                  <Route path="/tarefas" element={<Tarefas />} />
                  <Route path="/relatorios" element={<Relatorios />} />
                  <Route path="/historico" element={<Historico />} />
                  {/* Todos acessam; seções de sistema/usuários só aparecem para coordenadores */}
                  <Route path="/settings" element={<Configuracoes />} />
                </Route>
              </Route>

              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </Suspense>
          </PasswordSetupGate>
        </Router>
      </AuthProvider>
      </ToastProvider>
    </ThemeProvider>
  );
}

export default App;
