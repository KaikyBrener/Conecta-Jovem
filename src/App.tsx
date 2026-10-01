import { lazy, Suspense } from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { AuthProvider } from './contexts/AuthContext';
import { ProtectedRoute } from './components/ProtectedRoute';
import { Layout } from './components/Layout';
import { Login } from './pages/Login';

// Páginas carregadas sob demanda (reduz o bundle inicial)
const Dashboard = lazy(() => import('./pages/Dashboard').then((m) => ({ default: m.Dashboard })));
const Jovens = lazy(() => import('./pages/Jovens').then((m) => ({ default: m.Jovens })));
const Grupos = lazy(() => import('./pages/Grupos').then((m) => ({ default: m.Grupos })));
const Encontros = lazy(() => import('./pages/Encontros').then((m) => ({ default: m.Encontros })));
const Chamada = lazy(() => import('./pages/Chamada').then((m) => ({ default: m.Chamada })));
const Alertas = lazy(() => import('./pages/Alertas').then((m) => ({ default: m.Alertas })));
const Tarefas = lazy(() => import('./pages/Tarefas').then((m) => ({ default: m.Tarefas })));
const Relatorios = lazy(() => import('./pages/Relatorios').then((m) => ({ default: m.Relatorios })));
const Configuracoes = lazy(() => import('./pages/Configuracoes').then((m) => ({ default: m.Configuracoes })));

function PageLoader() {
  return (
    <div className="flex justify-center py-16">
      <Loader2 className="w-6 h-6 text-blue-600 animate-spin" />
    </div>
  );
}

function App() {
  return (
    <AuthProvider>
      <Router>
        <Suspense fallback={<PageLoader />}>
          <Routes>
            <Route path="/login" element={<Login />} />

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
                {/* Todos acessam; seções de sistema/usuários só aparecem para coordenadores */}
                <Route path="/settings" element={<Configuracoes />} />
              </Route>
            </Route>

            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Suspense>
      </Router>
    </AuthProvider>
  );
}

export default App;
