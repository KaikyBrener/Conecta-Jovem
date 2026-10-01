import { Suspense, useState } from 'react';
import { Outlet, Link, useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { useOpenAlertsCount } from '../hooks/useAlerts';
import {
  Home, Users, UsersRound, Calendar, LogOut, Settings, AlertTriangle, ListChecks, BarChart3, Menu, X, Loader2, ChevronRight,
} from 'lucide-react';
import { cn } from '../lib/utils';

interface NavItem {
  name: string;
  path: string;
  icon: React.ElementType;
  badge?: number;
}

const isActivePath = (pathname: string, path: string) =>
  path === '/' ? pathname === '/' : pathname === path || pathname.startsWith(`${path}/`) ||
    (path === '/encontros' && pathname.startsWith('/chamada/'));

export const Layout = () => {
  const { signOut, profile, role } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [moreOpen, setMoreOpen] = useState(false);
  // Atualiza a cada navegação (ex.: após resolver um alerta e voltar para outra tela)
  const openAlerts = useOpenAlertsCount(location.pathname);

  const handleLogout = async () => {
    setMoreOpen(false);
    await signOut();
    navigate('/login');
  };

  const navItems: NavItem[] = [
    { name: 'Início', path: '/', icon: Home },
    { name: 'Jovens', path: '/jovens', icon: Users },
    { name: 'Grupos', path: '/grupos', icon: UsersRound },
    { name: 'Encontros', path: '/encontros', icon: Calendar },
    { name: 'Alertas', path: '/alertas', icon: AlertTriangle, badge: openAlerts },
    { name: 'Tarefas', path: '/tarefas', icon: ListChecks },
    { name: 'Relatórios', path: '/relatorios', icon: BarChart3 },
    { name: 'Configurações', path: '/settings', icon: Settings },
  ];

  const currentNavItem = navItems.find((i) => isActivePath(location.pathname, i.path));

  // Mobile: 4 atalhos fixos + "Mais"
  const primaryMobile = ['/', '/jovens', '/encontros', '/alertas'];
  const mobileMain = navItems.filter((i) => primaryMobile.includes(i.path));
  const mobileMore = navItems.filter((i) => !primaryMobile.includes(i.path));
  const moreActive = mobileMore.some((i) => isActivePath(location.pathname, i.path));

  const Badge = ({ n }: { n?: number }) =>
    n ? (
      <span className="ml-auto min-w-5 h-5 px-1.5 rounded-full bg-red-500 text-white text-[10px] font-semibold flex items-center justify-center">
        {n > 99 ? '99+' : n}
      </span>
    ) : null;

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col md:flex-row">
      {/* Sidebar - Desktop */}
      <aside className="hidden md:flex flex-col w-64 bg-navy-900 md:sticky md:top-0 md:h-screen">
        <div className="px-6 py-5 border-b border-white/10">
          <h1 className="text-xl font-bold text-white tracking-tight">
            Conecta <span className="text-blue-400">Jovem</span>
          </h1>
          <div className="mt-3 flex items-center gap-2">
            <div className="w-7 h-7 rounded-full bg-navy-700 text-navy-100 text-xs font-semibold flex items-center justify-center uppercase flex-shrink-0">
              {(profile?.full_name || 'U').charAt(0)}
            </div>
            <div className="min-w-0">
              <p className="text-sm text-white truncate leading-tight">{profile?.full_name || 'Usuário'}</p>
              <p className="text-[11px] text-navy-300 leading-tight">
                {role === 'coordinator' ? 'Coordenador' : 'Líder'}
              </p>
            </div>
          </div>
        </div>
        <nav className="flex-1 px-3 py-4 space-y-0.5 overflow-y-auto">
          {navItems.map((item) => {
            const Icon = item.icon;
            const isActive = isActivePath(location.pathname, item.path);
            return (
              <Link
                key={item.path}
                to={item.path}
                className={cn(
                  'flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors',
                  isActive
                    ? 'bg-blue-600 text-white font-medium shadow-sm'
                    : 'text-navy-200 hover:bg-navy-800 hover:text-white'
                )}
              >
                <Icon className="w-[18px] h-[18px] flex-shrink-0" />
                <span>{item.name}</span>
                <Badge n={item.badge} />
              </Link>
            );
          })}
        </nav>
        <div className="p-3 border-t border-white/10">
          <button
            onClick={handleLogout}
            className="flex items-center gap-3 px-3 py-2 w-full text-sm text-navy-200 hover:bg-navy-800 hover:text-white rounded-lg transition-colors"
          >
            <LogOut className="w-[18px] h-[18px]" />
            <span>Sair</span>
          </button>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 min-w-0 overflow-y-auto pb-20 md:pb-0">
        {/* Header Mobile */}
        <header className="md:hidden bg-navy-900 px-4 py-3 flex justify-between items-center sticky top-0 z-10">
          <h1 className="text-lg font-bold text-white">
            Conecta <span className="text-blue-400">Jovem</span>
          </h1>
          <button onClick={handleLogout} className="text-navy-200 p-1" aria-label="Sair">
            <LogOut className="w-5 h-5" />
          </button>
        </header>

        {/* Topbar - Desktop: breadcrumb */}
        <div className="hidden md:flex items-center gap-2 bg-white border-b border-gray-200 px-6 py-3 sticky top-0 z-10 text-sm">
          <span className="text-gray-400">Início</span>
          {currentNavItem && currentNavItem.path !== '/' && (
            <>
              <ChevronRight className="w-3.5 h-3.5 text-gray-300" />
              <span className="text-gray-700 font-medium">{currentNavItem.name}</span>
            </>
          )}
        </div>

        <div className="p-4 md:p-6 max-w-6xl mx-auto">
          <Suspense
            fallback={
              <div className="flex justify-center py-16">
                <Loader2 className="w-6 h-6 text-blue-600 animate-spin" />
              </div>
            }
          >
            <Outlet />
          </Suspense>
        </div>
      </main>

      {/* Menu "Mais" - Mobile */}
      {moreOpen && (
        <div className="md:hidden fixed inset-0 z-40 bg-black/40" onClick={() => setMoreOpen(false)}>
          <div
            className="absolute bottom-16 inset-x-0 bg-white rounded-t-2xl shadow-xl p-3 space-y-1"
            onClick={(e) => e.stopPropagation()}
          >
            <p className="px-3 pt-1 pb-2 text-xs text-gray-500">
              {profile?.full_name || 'Usuário'} · {role === 'coordinator' ? 'Coordenador' : 'Líder'}
            </p>
            {mobileMore.map((item) => {
              const Icon = item.icon;
              return (
                <Link
                  key={item.path}
                  to={item.path}
                  onClick={() => setMoreOpen(false)}
                  className={cn(
                    'flex items-center gap-3 px-3 py-3 rounded-lg',
                    isActivePath(location.pathname, item.path) ? 'bg-blue-50 text-blue-700 font-medium' : 'text-gray-700'
                  )}
                >
                  <Icon className="w-5 h-5" />
                  <span>{item.name}</span>
                </Link>
              );
            })}
            <button onClick={handleLogout} className="flex items-center gap-3 px-3 py-3 w-full text-red-600 rounded-lg">
              <LogOut className="w-5 h-5" />
              <span>Sair</span>
            </button>
          </div>
        </div>
      )}

      {/* Bottom Navigation - Mobile */}
      <nav className="md:hidden fixed bottom-0 z-50 w-full bg-white border-t border-gray-200 flex justify-around items-center h-16 pb-safe">
        {mobileMain.map((item) => {
          const Icon = item.icon;
          const isActive = isActivePath(location.pathname, item.path);
          return (
            <Link
              key={item.path}
              to={item.path}
              onClick={() => setMoreOpen(false)}
              className={cn(
                'relative flex flex-col items-center justify-center w-full h-full space-y-1',
                isActive ? 'text-blue-600' : 'text-gray-500'
              )}
            >
              <Icon className="w-5 h-5" />
              {!!item.badge && (
                <span className="absolute top-1.5 left-1/2 ml-1.5 min-w-4 h-4 px-1 rounded-full bg-red-500 text-white text-[9px] font-semibold flex items-center justify-center">
                  {item.badge > 99 ? '99+' : item.badge}
                </span>
              )}
              <span className="text-[10px] font-medium">{item.name}</span>
            </Link>
          );
        })}
        <button
          onClick={() => setMoreOpen((o) => !o)}
          className={cn(
            'flex flex-col items-center justify-center w-full h-full space-y-1',
            moreOpen || moreActive ? 'text-blue-600' : 'text-gray-500'
          )}
          aria-expanded={moreOpen}
        >
          {moreOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
          <span className="text-[10px] font-medium">Mais</span>
        </button>
      </nav>
    </div>
  );
};
