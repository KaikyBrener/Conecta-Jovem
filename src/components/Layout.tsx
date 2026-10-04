import { Suspense, useEffect, useState } from 'react';
import { Outlet, Link, useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { useTheme } from '../contexts/ThemeContext';
import { useOpenAlertsCount } from '../hooks/useAlerts';
import {
  Home, Users, UsersRound, Calendar, LogOut, Settings, AlertTriangle, ListChecks, BarChart3, Menu, X, Loader2, ChevronRight, Sun, Moon,
  PanelLeftClose, PanelLeftOpen, Search, History,
} from 'lucide-react';
import { cn } from '../lib/utils';
import { ErrorBoundary } from './ErrorBoundary';
import { GlobalSearch } from './search/GlobalSearch';
import { isSearchShortcut } from '../lib/globalSearch';

interface NavItem {
  name: string;
  path: string;
  icon: React.ElementType;
  badge?: number;
}

const isActivePath = (pathname: string, path: string) =>
  path === '/' ? pathname === '/' : pathname === path || pathname.startsWith(`${path}/`) ||
    (path === '/encontros' && pathname.startsWith('/chamada/'));

const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/i.test(navigator.userAgent);

const SIDEBAR_COLLAPSED_KEY = 'conecta-jovem-sidebar-collapsed';

const readSidebarCollapsed = () => {
  try {
    return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === '1';
  } catch {
    return false;
  }
};

const ThemeToggleButton = ({ className }: { className?: string }) => {
  const { theme, toggleTheme } = useTheme();
  const isDark = theme === 'dark';
  return (
    <button
      onClick={toggleTheme}
      aria-label={isDark ? 'Ativar modo claro' : 'Ativar modo escuro'}
      title={isDark ? 'Ativar modo claro' : 'Ativar modo escuro'}
      className={cn(
        'rounded-lg p-1.5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500',
        className
      )}
    >
      {isDark ? <Sun className="w-[18px] h-[18px]" /> : <Moon className="w-[18px] h-[18px]" />}
    </button>
  );
};

const SidebarToggleButton = ({ collapsed, onClick }: { collapsed: boolean; onClick: () => void }) => (
  <button
    onClick={onClick}
    aria-label={collapsed ? 'Expandir menu lateral' : 'Recolher menu lateral'}
    title={collapsed ? 'Expandir menu lateral' : 'Recolher menu lateral'}
    className="flex-shrink-0 rounded-lg p-1.5 text-navy-200 hover:bg-navy-800 hover:text-white transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
  >
    {collapsed ? <PanelLeftOpen className="w-[18px] h-[18px]" /> : <PanelLeftClose className="w-[18px] h-[18px]" />}
  </button>
);

export const Layout = () => {
  const { signOut, profile, role } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [moreOpen, setMoreOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(readSidebarCollapsed);
  // Atualiza a cada navegação (ex.: após resolver um alerta e voltar para outra tela)
  const openAlerts = useOpenAlertsCount(location.pathname);

  useEffect(() => {
    try {
      localStorage.setItem(SIDEBAR_COLLAPSED_KEY, sidebarCollapsed ? '1' : '0');
    } catch {
      // localStorage indisponível (modo privado/bloqueado); preferência só dura a sessão atual
    }
  }, [sidebarCollapsed]);

  // Atalho Ctrl/⌘+K abre a busca global em qualquer tela
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!isSearchShortcut(e)) return;
      e.preventDefault();
      setSearchOpen(true);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

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
    { name: 'Histórico', path: '/historico', icon: History },
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
      <aside
        className={cn(
          'hidden md:flex flex-col bg-navy-900 md:sticky md:top-0 md:h-screen transition-[width] duration-200 ease-in-out',
          sidebarCollapsed ? 'w-16' : 'w-64'
        )}
      >
        <div className={cn('border-b border-white/10', sidebarCollapsed ? 'px-2 py-4' : 'px-6 py-5')}>
          <div className={cn('flex items-center', sidebarCollapsed ? 'justify-center' : 'justify-between')}>
            {!sidebarCollapsed && (
              <h1 className="text-xl font-bold text-white tracking-tight truncate">
                Conecta <span className="text-blue-400">Jovem</span>
              </h1>
            )}
            <SidebarToggleButton collapsed={sidebarCollapsed} onClick={() => setSidebarCollapsed((c) => !c)} />
          </div>
          <div className={cn('mt-3 flex items-center gap-2', sidebarCollapsed && 'justify-center')}>
            <div
              className="w-7 h-7 rounded-full bg-navy-700 text-navy-100 text-xs font-semibold flex items-center justify-center uppercase flex-shrink-0"
              title={sidebarCollapsed ? profile?.full_name || 'Usuário' : undefined}
            >
              {(profile?.full_name || 'U').charAt(0)}
            </div>
            {!sidebarCollapsed && (
              <div className="min-w-0">
                <p className="text-sm text-white truncate leading-tight">{profile?.full_name || 'Usuário'}</p>
                <p className="text-[11px] text-navy-300 leading-tight">
                  {role === 'coordinator' ? 'Coordenador' : 'Líder'}
                </p>
              </div>
            )}
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
                title={sidebarCollapsed ? item.name : undefined}
                className={cn(
                  'relative flex items-center rounded-lg text-sm transition-colors',
                  sidebarCollapsed ? 'justify-center p-2' : 'gap-3 px-3 py-2',
                  isActive
                    ? 'bg-blue-600 text-white font-medium shadow-sm'
                    : 'text-navy-200 hover:bg-navy-800 hover:text-white'
                )}
              >
                <Icon className="w-[18px] h-[18px] flex-shrink-0" />
                {!sidebarCollapsed && (
                  <>
                    <span>{item.name}</span>
                    <Badge n={item.badge} />
                  </>
                )}
                {sidebarCollapsed && !!item.badge && (
                  <span className="absolute top-1 right-1.5 w-2 h-2 rounded-full bg-red-500" />
                )}
              </Link>
            );
          })}
        </nav>
        <div className="p-3 border-t border-white/10">
          <button
            onClick={handleLogout}
            title={sidebarCollapsed ? 'Encerrar sessão' : undefined}
            className={cn(
              'flex items-center w-full text-sm text-navy-200 hover:bg-navy-800 hover:text-white rounded-lg transition-colors',
              sidebarCollapsed ? 'justify-center p-2' : 'gap-3 px-3 py-2'
            )}
          >
            <LogOut className="w-[18px] h-[18px]" />
            {!sidebarCollapsed && <span>Encerrar sessão</span>}
          </button>
        </div>
      </aside>

      {/* Main Content */}
      {/* Sem overflow-y: quem rola é o documento. Um overflow-y-auto aqui criaria um container de
          rolagem que nunca rola (altura = conteúdo) e quebraria todo `sticky` das páginas. */}
      <main className="flex-1 min-w-0 overflow-x-clip pb-20 md:pb-0">
        {/* Header Mobile */}
        <header className="md:hidden bg-navy-900 px-4 py-3 flex justify-between items-center sticky top-0 z-10">
          <h1 className="text-lg font-bold text-white">
            Conecta <span className="text-blue-400">Jovem</span>
          </h1>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setSearchOpen(true)}
              aria-label="Abrir busca global"
              data-testid="busca-global-abrir-mobile"
              className="rounded-lg p-1.5 text-navy-200 hover:bg-navy-800 hover:text-white transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
            >
              <Search className="w-[18px] h-[18px]" />
            </button>
            <ThemeToggleButton className="text-navy-200 hover:bg-navy-800 hover:text-white" />
            <button onClick={handleLogout} className="text-navy-200 p-1" aria-label="Encerrar sessão">
              <LogOut className="w-5 h-5" />
            </button>
          </div>
        </header>

        {/* Topbar - Desktop: breadcrumb */}
        <div className="hidden md:flex items-center justify-between gap-2 bg-white border-b border-gray-200 px-6 py-3 sticky top-0 z-10 text-sm">
          <div className="flex items-center gap-2">
            <span className="text-gray-400">Início</span>
            {currentNavItem && currentNavItem.path !== '/' && (
              <>
                <ChevronRight className="w-3.5 h-3.5 text-gray-300" />
                <span className="text-gray-700 font-medium">{currentNavItem.name}</span>
              </>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setSearchOpen(true)}
              aria-label="Abrir busca global"
              data-testid="busca-global-abrir"
              className="flex w-64 items-center gap-2 rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-left text-gray-400 hover:bg-gray-50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
            >
              <Search className="w-4 h-4 flex-shrink-0" aria-hidden="true" />
              <span className="flex-1 truncate">Buscar...</span>
              <kbd className="rounded border border-gray-200 px-1.5 text-[11px] font-sans text-gray-500">{IS_MAC ? '⌘K' : 'Ctrl K'}</kbd>
            </button>
            <ThemeToggleButton className="text-gray-500 hover:bg-gray-100 hover:text-gray-700" />
          </div>
        </div>

        <div className="p-4 md:p-6 max-w-6xl mx-auto">
          {/* Erro numa página não derruba o menu; trocar de rota limpa o erro */}
          <ErrorBoundary key={location.pathname} variant="page">
            <Suspense
              fallback={
                <div className="flex justify-center py-16">
                  <Loader2 className="w-6 h-6 text-blue-600 animate-spin" />
                </div>
              }
            >
              <Outlet />
            </Suspense>
          </ErrorBoundary>
        </div>
      </main>

      {searchOpen && <GlobalSearch onClose={() => setSearchOpen(false)} />}

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
              <span>Encerrar sessão</span>
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
