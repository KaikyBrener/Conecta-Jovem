import type { ReactNode } from 'react';
import { BellRing, ClipboardCheck, HeartHandshake, LockKeyhole } from 'lucide-react';
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
}

/** Casca das telas de autenticação: painel de marca azul-marinho (desktop) + card central. */
export function AuthShell({ title, subtitle, children, footer }: AuthShellProps) {
  return (
    <div className="min-h-dvh bg-canvas lg:grid lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
      {/* Painel de marca - Desktop */}
      <aside className="on-brand hidden bg-brand text-white lg:flex lg:flex-col lg:justify-between lg:gap-12 lg:px-[clamp(2rem,5vw,4.5rem)] lg:py-14">
        <div className="-ml-3">
          <Logo variant="escuro" tamanho="xl" />
        </div>

        <div className="max-w-[28.75rem]">
          <p className="text-[1.875rem] font-semibold leading-tight tracking-[-0.015em]">
            Cuidar de cada jovem começa por conhecer a sua presença.
          </p>
          <p className="mt-4 text-base leading-relaxed text-brand-ink">
            Gestão do ministério jovem em um só lugar: grupos, encontros, chamada e acompanhamento.
          </p>

          <ul className="mt-9 border-t border-brand-line">
            {highlights.map(({ icon: Icon, title: t, text }) => (
              <li key={t} className="flex gap-4 border-b border-brand-line py-4">
                <span className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-control bg-brand-line text-brand-accent">
                  <Icon className="h-[18px] w-[18px]" strokeWidth={1.7} aria-hidden="true" />
                </span>
                <div className="min-w-0">
                  <p className="text-[0.90625rem] font-medium text-white">{t}</p>
                  <p className="mt-0.5 text-table text-brand-muted">{text}</p>
                </div>
              </li>
            ))}
          </ul>
        </div>

        <p className="text-caption text-brand-muted">Sistema de gestão do ministério jovem</p>
      </aside>

      {/* Área do formulário */}
      <main className="flex min-h-dvh flex-col justify-center px-4 py-8 sm:px-6 lg:min-h-0 lg:py-12">
        <div className="mx-auto w-full max-w-md">
          {/* Identidade compacta - Mobile/tablet */}
          <div className="mb-6 flex flex-col items-center text-center lg:hidden">
            {/* claro no tema claro; no modo escuro (.dark) entra a variante para fundo escuro (regras em index.css) */}
            <Logo variant="claro" tamanho="xl" className="logo-tema-claro" />
            <Logo variant="escuro" tamanho="xl" className="logo-tema-escuro" />
            <p className="mt-1 text-label text-ink-muted">Gestão do ministério jovem</p>
          </div>

          <div className="rounded-sheet border border-line bg-surface px-6 py-8 sm:p-10">
            <h1 className="text-[1.5rem] font-semibold leading-tight tracking-[-0.015em] text-ink sm:text-display">{title}</h1>
            {subtitle && <p className="mt-2 text-[0.9375rem] leading-relaxed text-ink-muted">{subtitle}</p>}
            {children}
            {footer && (
              <div className="mt-7 flex items-center justify-center gap-2 border-t border-line-soft pt-[18px] text-center text-caption text-ink-muted">
                <LockKeyhole className="h-3.5 w-3.5 flex-shrink-0" strokeWidth={1.7} aria-hidden="true" />
                <span>{footer}</span>
              </div>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
