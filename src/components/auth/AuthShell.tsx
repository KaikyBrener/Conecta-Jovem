import type { ReactNode } from 'react';
import { BellRing, ClipboardCheck, HeartHandshake, LockKeyhole, type LucideIcon } from 'lucide-react';
import { Logo } from '../ui/Logo';

const highlights = [
  { icon: ClipboardCheck, title: 'Chamada', text: 'Registre a presença de cada encontro em poucos toques.' },
  { icon: BellRing, title: 'Alertas de faltas', text: 'Saiba quando um jovem precisa de atenção.' },
  { icon: HeartHandshake, title: 'Acompanhamento', text: 'Organize tarefas e cuidado com cada jovem.' },
];

interface AuthShellProps {
  title: string;
  subtitle?: string;
  children: ReactNode;
  /** Linha final do card (links secundários, avisos) */
  footer?: ReactNode;
  /** Ícone do selo no topo do card (padrão: cadeado). */
  icon?: LucideIcon;
}

/** Casca das telas de autenticação: painel de marca (desktop) + card central. */
export function AuthShell({ title, subtitle, children, footer, icon: Icon = LockKeyhole }: AuthShellProps) {
  return (
    <div className="min-h-dvh bg-gray-50 lg:grid lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
      {/* Painel de marca - Desktop */}
      <aside className="relative hidden overflow-hidden bg-navy-900 text-white lg:flex lg:flex-col lg:justify-between lg:p-12 xl:p-16">
        <div aria-hidden="true" className="pointer-events-none absolute -right-24 -top-24 h-80 w-80 rounded-full border border-white/5" />
        <div aria-hidden="true" className="pointer-events-none absolute -right-8 -top-8 h-48 w-48 rounded-full border border-white/5" />
        <div aria-hidden="true" className="pointer-events-none absolute -bottom-32 -left-24 h-96 w-96 rounded-full bg-blue-500/5" />

        <div className="relative -ml-3">
          <Logo variant="escuro" tamanho="xl" />
        </div>

        <div className="relative max-w-md">
          <p className="text-3xl font-semibold leading-tight tracking-tight">
            Cuidar de cada jovem começa por conhecer a sua presença.
          </p>
          <p className="mt-4 text-base text-navy-200">
            Gestão do ministério jovem em um só lugar: grupos, encontros, chamada e acompanhamento.
          </p>

          <ul className="mt-10 space-y-3">
            {highlights.map(({ icon: Icon, title: t, text }) => (
              <li key={t} className="flex items-start gap-4 rounded-xl border border-white/10 bg-navy-800/60 p-4">
                <span className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg bg-blue-600/20 text-blue-300">
                  <Icon className="h-5 w-5" aria-hidden="true" />
                </span>
                <div className="min-w-0">
                  <p className="text-sm font-medium text-white">{t}</p>
                  <p className="mt-0.5 text-sm text-navy-300">{text}</p>
                </div>
              </li>
            ))}
          </ul>
        </div>

        <p className="relative text-xs text-navy-300">Sistema de gestão do ministério jovem</p>
      </aside>

      {/* Área do formulário */}
      <main className="flex min-h-dvh flex-col justify-center px-4 py-8 sm:px-6 lg:min-h-0 lg:py-12">
        <div className="mx-auto w-full max-w-md">
          {/* Identidade compacta - Mobile/tablet */}
          <div className="mb-6 flex flex-col items-center text-center lg:hidden">
            {/* claro no tema claro; no modo escuro (.dark) entra a variante para fundo escuro (regras em index.css) */}
            <Logo variant="claro" tamanho="xl" className="logo-tema-claro" />
            <Logo variant="escuro" tamanho="xl" className="logo-tema-escuro" />
            <p className="mt-1 text-sm text-gray-500">Gestão do ministério jovem</p>
          </div>

          <div className="rounded-2xl border border-gray-200/80 bg-white px-6 py-8 shadow-xl shadow-gray-900/5 sm:px-10 sm:py-10">
            <span className="mb-5 flex h-12 w-12 items-center justify-center rounded-xl bg-blue-50 text-blue-700 ring-1 ring-blue-100">
              <Icon className="h-6 w-6" aria-hidden="true" />
            </span>
            <h1 className="text-3xl font-bold tracking-tight text-gray-900">{title}</h1>
            {subtitle && <p className="mt-2 text-base leading-relaxed text-gray-600">{subtitle}</p>}
            {children}
            {footer && (
              <div className="mt-8 flex items-center justify-center gap-1.5 border-t border-gray-100 pt-5 text-center text-xs text-gray-500">
                <LockKeyhole className="h-3.5 w-3.5 flex-shrink-0" aria-hidden="true" />
                <span>{footer}</span>
              </div>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
