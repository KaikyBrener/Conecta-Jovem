import { Fragment, Suspense, useEffect, useState } from 'react';
import { Outlet, Link, useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { useTheme } from '../contexts/ThemeContext';
import { useOpenAlertsCount } from '../hooks/useAlerts';
import {
  Home, Users, UsersRound, Calendar, LogOut, Settings, AlertTriangle, ListChecks, BarChart3, Menu, X, ChevronRight, Sun, Moon,
  PanelLeftClose, PanelLeftOpen, Search, History,
} from 'lucide-react';
import { cn } from '../lib/utils';
import { ErrorBoundary } from './ErrorBoundary';
import { GlobalSearch } from './search/GlobalSearch';
import { isSearchShortcut } from '../lib/globalSearch';
import { Logo } from './ui/Logo';
import { LoadingBlock } from './ui/LoadingBlock';

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

/* Ícones de traço do design system: 18px no menu, 20px nas barras do celular, 1,7px de espessura */
const NAV_ICON = { className: 'h-[18px] w-[18px] flex-shrink-0', strokeWidth: 1.7, 'aria-hidden': true } as const;
const BAR_ICON = { className: 'h-5 w-5 flex-shrink-0', strokeWidth: 1.7, 'aria-hidden': true } as const;

/* Itens do menu lateral (sobre o azul-marinho) */
const sideItemCls = 'relative flex items-center rounded-control text-sm transition-colors';
const sideIdleCls = 'text-brand-ink hover:bg-white/[0.06] hover:text-white';

/* Botões de ícone do cabeçalho do celular: alvo de 44px */
const mobileHeaderBtnCls =
  'inline-flex h-11 w-11 items-center justify-center rounded-card text-brand-ink transition-colors hover:bg-white/[0.06] hover:text-white';

const ThemeToggleButton = ({ className, iconClassName }: { className?: string; iconClassName?: string }) => {
  const { theme, toggleTheme } = useTheme();
  const isDark = theme === 'dark';
  const Icon = isDark ? Sun : Moon;
  return (
    <button
      type="button"
      onClick={toggleTheme}
      aria-label={isDark ? 'Ativar modo claro' : 'Ativar modo escuro'}
      title={isDark ? 'Ativar modo claro' : 'Ativar modo escuro'}
      className={className}
    >
      <Icon className={iconClassName ?? 'h-[18px] w-[18px]'} strokeWidth={1.7} aria-hidden="true" />
    </button>
  );
};

const SidebarToggleButton = ({ collapsed, onClick }: { collapsed: boolean; onClick: () => void }) => (
  <button
    type="button"
    onClick={onClick}
    aria-label={collapsed ? 'Expandir menu lateral' : 'Recolher menu lateral'}
    title={collapsed ? 'Expandir menu lateral' : 'Recolher menu lateral'}
    className="inline-flex h-[30px] w-[30px] flex-shrink-0 items-center justify-center rounded-control text-brand-muted transition-colors hover:bg-white/[0.06] hover:text-white"
  >
    {collapsed ? <PanelLeftOpen {...NAV_ICON} /> : <PanelLeftClose {...NAV_ICON} />}
  </button>
);

/** Contador de alertas abertos (pílula vermelha): sempre com o número em texto */
const CounterPill = ({ n, className }: { n: number; className?: string }) => (
  <span className={cn('flex items-center justify-center rounded-full bg-counter font-semibold text-white', className)}>
    {n > 99 ? '99+' : n}
  </span>
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
  const userName = profile?.full_name || 'Usuário';
  const roleLabel = role === 'coordinator' ? 'Coordenador' : 'Líder';

  // Mobile: 4 atalhos fixos + "Mais"
  const primaryMobile = ['/', '/jovens', '/encontros', '/alertas'];
  const mobileMain = navItems.filter((i) => primaryMobile.includes(i.path));
  const mobileMore = navItems.filter((i) => !primaryMobile.includes(i.path));
  const moreActive = mobileMore.some((i) => isActivePath(location.pathname, i.path));

  return (
    <div className="min-h-screen bg-canvas flex flex-col md:flex-row">
      {/* Menu lateral - Desktop (a partir de 768px): 256px, recolhe para 64px */}
      <aside
        className={cn(
          'on-brand hidden md:flex flex-col bg-brand text-brand-ink md:sticky md:top-0 md:h-screen md:border-r md:border-brand-line transition-[width] duration-200 ease-in-out',
          sidebarCollapsed ? 'w-16' : 'w-64'
        )}
      >
        <div className={cn('flex items-center', sidebarCollapsed ? 'flex-col gap-3 px-2 pb-3 pt-4' : 'justify-between gap-2 pb-4 pl-5 pr-4 pt-5')}>
          <h1 className="flex min-w-0 items-center">
            {sidebarCollapsed ? <Logo variant="icone" tamanho="sm" /> : <Logo variant="escuro" tamanho="md" className="-ml-2.5" />}
          </h1>
          <SidebarToggleButton collapsed={sidebarCollapsed} onClick={() => setSidebarCollapsed((c) => !c)} />
        </div>

        <div className={cn('flex items-center gap-3 border-y border-brand-line', sidebarCollapsed ? 'justify-center px-2 py-3' : 'px-5 py-3.5')}>
          <div
            className="flex h-[34px] w-[34px] flex-shrink-0 items-center justify-center rounded-full bg-brand-line text-sm font-semibold uppercase text-white"
            title={sidebarCollapsed ? userName : undefined}
          >
            {userName.charAt(0)}
          </div>
          {!sidebarCollapsed && (
            <div className="min-w-0 leading-[1.3]">
              <p className="truncate text-sm font-medium text-white">{userName}</p>
              <p className="text-caption text-brand-muted">{roleLabel}</p>
            </div>
          )}
        </div>

        <nav className={cn('flex flex-1 flex-col gap-0.5 overflow-y-auto py-4', sidebarCollapsed ? 'px-2' : 'px-3')}>
          {navItems.map((item) => {
            const Icon = item.icon;
            const isActive = isActivePath(location.pathname, item.path);
            return (
              <Fragment key={item.path}>
                {/* Configurações fica separada das telas do dia a dia por um divisor */}
                {item.path === '/settings' && <div className="mx-0 mb-1.5 mt-2 border-t border-brand-line" aria-hidden="true" />}
                <Link
                  to={item.path}
                  title={sidebarCollapsed ? item.name : undefined}
                  aria-current={isActive ? 'page' : undefined}
                  className={cn(
                    sideItemCls,
                    sidebarCollapsed ? 'justify-center p-[9px]' : 'gap-3 px-3 py-[9px]',
                    // `bg-blue-600` é usado como seletor pelo E2E de navegação: mantenha a classe
                    isActive ? 'bg-blue-600 text-white font-medium' : sideIdleCls
                  )}
                >
                  <Icon {...NAV_ICON} />
                  {!sidebarCollapsed && (
                    <>
                      <span className="flex-1">{item.name}</span>
                      {!!item.badge && <CounterPill n={item.badge} className="min-w-5 px-[7px] text-xs" />}
                    </>
                  )}
                  {sidebarCollapsed && !!item.badge && (
                    <span className="absolute right-2 top-1.5 h-2 w-2 rounded-full bg-counter" />
                  )}
                </Link>
              </Fragment>
            );
          })}
        </nav>

        <div className={cn('border-t border-brand-line', sidebarCollapsed ? 'p-2' : 'p-3')}>
          <button
            type="button"
            onClick={handleLogout}
            title={sidebarCollapsed ? 'Encerrar sessão' : undefined}
            className={cn(sideItemCls, sideIdleCls, 'w-full', sidebarCollapsed ? 'justify-center p-[9px]' : 'gap-3 px-3 py-[9px]')}
          >
            <LogOut {...NAV_ICON} />
            {!sidebarCollapsed && <span>Encerrar sessão</span>}
          </button>
        </div>
      </aside>

      {/* Conteúdo */}
      {/* Sem overflow-y: quem rola é o documento. Um overflow-y-auto aqui criaria um container de
          rolagem que nunca rola (altura = conteúdo) e quebraria todo `sticky` das páginas. */}
      <main className="flex-1 min-w-0 overflow-x-clip pb-20 md:pb-0">
        {/* Cabeçalho - Celular: faixa azul-marinho de 56px com logotipo, busca, tema e sair */}
        <header className="on-brand md:hidden sticky top-0 z-10 flex h-14 items-center justify-between bg-brand pl-2 pr-1">
          <h1 className="flex items-center">
            <Logo variant="escuro" tamanho="md" />
          </h1>
          <div className="flex items-center">
            <button
              type="button"
              onClick={() => setSearchOpen(true)}
              aria-label="Abrir busca global"
              data-testid="busca-global-abrir-mobile"
              className={mobileHeaderBtnCls}
            >
              <Search {...BAR_ICON} />
            </button>
            <ThemeToggleButton className={mobileHeaderBtnCls} iconClassName="h-5 w-5" />
            <button type="button" onClick={handleLogout} className={mobileHeaderBtnCls} aria-label="Encerrar sessão">
              <LogOut {...BAR_ICON} />
            </button>
          </div>
        </header>

        {/* Barra superior - Desktop: caminho (Início > Tela), busca global e tema */}
        <div className="hidden md:flex flex-wrap items-center justify-between gap-3 bg-surface border-b border-line px-[clamp(1rem,3vw,2.5rem)] py-3 sticky top-0 z-10">
          <div className="flex items-center gap-2 text-label">
            <span className="text-ink-muted">Início</span>
            {currentNavItem && currentNavItem.path !== '/' && (
              <>
                <ChevronRight className="h-3.5 w-3.5 text-ink-faint" aria-hidden="true" />
                <span className="font-medium text-ink">{currentNavItem.name}</span>
              </>
            )}
          </div>
          <div className="flex items-center gap-2.5">
            <button
              type="button"
              onClick={() => setSearchOpen(true)}
              aria-label="Abrir busca global"
              data-testid="busca-global-abrir"
              className="flex w-[300px] max-w-full items-center gap-2.5 rounded-control border border-line bg-surface px-3 py-2 text-left text-label text-ink-muted transition-colors hover:border-line-strong"
            >
              <Search className="h-4 w-4 flex-shrink-0" strokeWidth={1.7} aria-hidden="true" />
              <span className="flex-1 truncate">Buscar...</span>
              <kbd className="rounded-tag border border-line bg-canvas px-1.5 font-sans text-[0.71875rem] text-ink-muted">{IS_MAC ? '⌘K' : 'Ctrl K'}</kbd>
            </button>
            <ThemeToggleButton className="inline-flex h-[34px] w-[34px] items-center justify-center rounded-control border border-line bg-surface text-ink transition-colors hover:bg-surface-hover" />
          </div>
        </div>

        {/* Página: margem lateral entre 16 e 40px; conteúdo até 1120px */}
        <div className="mx-auto max-w-[70rem] box-content px-4 pb-8 pt-5 md:px-[clamp(1rem,3vw,2.5rem)] md:pb-12 md:pt-8">
          {/* Erro numa página não derruba o menu; trocar de rota limpa o erro */}
          <ErrorBoundary key={location.pathname} variant="page">
            <Suspense fallback={<LoadingBlock />}>
              <Outlet />
            </Suspense>
          </ErrorBoundary>
        </div>
      </main>

      {searchOpen && <GlobalSearch onClose={() => setSearchOpen(false)} />}

      {/* Menu "Mais" - Celular: folha inferior acima da barra de navegação */}
      {moreOpen && (
        <div className="md:hidden fixed inset-0 z-40 bg-navy-950/60" onClick={() => setMoreOpen(false)}>
          <div
            className="absolute bottom-16 inset-x-0 bg-surface rounded-t-sheet border-t border-line shadow-xl px-2 pb-2 pt-3"
            onClick={(e) => e.stopPropagation()}
          >
            <p className="px-3 pb-2 text-caption text-ink-muted">
              {userName} · {roleLabel}
            </p>
            {mobileMore.map((item) => {
              const Icon = item.icon;
              const isActive = isActivePath(location.pathname, item.path);
              return (
                <Link
                  key={item.path}
                  to={item.path}
                  onClick={() => setMoreOpen(false)}
                  aria-current={isActive ? 'page' : undefined}
                  className={cn(
                    'flex min-h-12 items-center gap-3 rounded-control px-3 text-sm',
                    isActive ? 'bg-action-soft font-medium text-action-ink' : 'text-ink'
                  )}
                >
                  <Icon {...BAR_ICON} />
                  <span>{item.name}</span>
                </Link>
              );
            })}
            <div className="my-1 border-t border-line-soft" aria-hidden="true" />
            <button type="button" onClick={handleLogout} className="flex min-h-12 w-full items-center gap-3 rounded-control px-3 text-sm text-danger-ink">
              <LogOut {...BAR_ICON} />
              <span>Encerrar sessão</span>
            </button>
          </div>
        </div>
      )}

      {/* Barra inferior - Celular: quatro atalhos fixos e "Mais" */}
      <nav className="md:hidden fixed bottom-0 z-50 w-full bg-surface border-t border-line flex justify-around items-center h-16 pb-safe">
        {mobileMain.map((item) => {
          const Icon = item.icon;
          const isActive = isActivePath(location.pathname, item.path);
          return (
            <Link
              key={item.path}
              to={item.path}
              onClick={() => setMoreOpen(false)}
              aria-current={isActive ? 'page' : undefined}
              className={cn(
                'relative flex h-full w-full flex-col items-center justify-center gap-1 focus-visible:-outline-offset-2',
                isActive ? 'text-action' : 'text-ink-muted'
              )}
            >
              <Icon {...BAR_ICON} />
              {!!item.badge && (
                <CounterPill n={item.badge} className="absolute left-1/2 top-2 ml-1.5 h-4 min-w-4 px-1 text-[0.625rem]" />
              )}
              <span className="text-[0.6875rem] font-medium leading-none">{item.name}</span>
            </Link>
          );
        })}
        <button
          type="button"
          onClick={() => setMoreOpen((o) => !o)}
          className={cn(
            'flex h-full w-full flex-col items-center justify-center gap-1 focus-visible:-outline-offset-2',
            moreOpen || moreActive ? 'text-action' : 'text-ink-muted'
          )}
          aria-expanded={moreOpen}
        >
          {moreOpen ? <X {...BAR_ICON} /> : <Menu {...BAR_ICON} />}
          <span className="text-[0.6875rem] font-medium leading-none">Mais</span>
        </button>
      </nav>
    </div>
  );
};
