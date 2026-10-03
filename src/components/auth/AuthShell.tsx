import type { ReactNode } from 'react';
import { BellRing, ClipboardCheck, HeartHandshake } from 'lucide-react';

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

/** Casca das telas de autenticação: painel de marca (desktop) + card central. */
export function AuthShell({ title, subtitle, children, footer }: AuthShellProps) {
  return (
    <div className="min-h-dvh bg-gray-50 lg:grid lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
      {/* Painel de marca - Desktop */}
      <aside className="relative hidden overflow-hidden bg-navy-900 text-white lg:flex lg:flex-col lg:justify-between lg:p-12 xl:p-16">
        <div aria-hidden="true" className="pointer-events-none absolute -right-24 -top-24 h-80 w-80 rounded-full border border-white/5" />
        <div aria-hidden="true" className="pointer-events-none absolute -right-8 -top-8 h-48 w-48 rounded-full border border-white/5" />
        <div aria-hidden="true" className="pointer-events-none absolute -bottom-32 -left-24 h-96 w-96 rounded-full bg-blue-500/5" />

        <p className="relative text-2xl font-bold tracking-tight">
          Conecta <span className="text-blue-400">Jovem</span>
        </p>

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
          <div className="mb-6 text-center lg:hidden">
            <p className="text-2xl font-bold tracking-tight text-gray-900">
              Conecta <span className="text-blue-700">Jovem</span>
            </p>
            <p className="mt-1 text-sm text-gray-500">Gestão do ministério jovem</p>
          </div>

          <div className="rounded-xl border border-gray-200 bg-white px-5 py-7 shadow-sm sm:px-8 sm:py-8">
            <h1 className="text-2xl font-semibold tracking-tight text-gray-900">{title}</h1>
            {subtitle && <p className="mt-1 text-sm text-gray-600">{subtitle}</p>}
            {children}
            {footer && <div className="mt-6 border-t border-gray-100 pt-4 text-center text-xs text-gray-500">{footer}</div>}
          </div>
        </div>
      </main>
    </div>
  );
}
