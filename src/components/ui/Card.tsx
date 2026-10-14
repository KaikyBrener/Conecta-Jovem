import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { cn } from '../../lib/utils';

/** Painel do design system: superfície branca, borda de 1px, raio 8 e nenhuma sombra. */
const cardCls = 'bg-surface border border-line rounded-card';

/** Superfície básica. Aceita classes extras (ex.: `p-4`). */
export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn(cardCls, className)}>{children}</div>;
}

/** Bloco de conteúdo com espaçamento interno padrão (filtros, formulários de uma seção). */
export function SectionCard({ children, className, testId }: { children: ReactNode; className?: string; testId?: string }) {
  return <div className={cn(cardCls, 'p-4 sm:px-5', className)} data-testid={testId}>{children}</div>;
}

interface PanelProps {
  title: ReactNode;
  /** Explicação curta sob o título */
  hint?: ReactNode;
  /** Link ou botão à direita do título */
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  testId?: string;
}

/** Seção com título: listas, tabelas e gráficos de uma tela. O conteúdo define o próprio espaçamento. */
export function Panel({ title, hint, action, children, className, testId }: PanelProps) {
  return (
    <section className={cn(cardCls, 'overflow-hidden', className)} data-testid={testId}>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-line-soft px-4 py-3 sm:px-5 sm:py-3.5">
        <div className="min-w-0">
          <h3 className="text-heading text-ink">{title}</h3>
          {hint && <p className="mt-0.5 text-caption text-ink-muted">{hint}</p>}
        </div>
        {action && <div className="flex-shrink-0">{action}</div>}
      </div>
      {children}
    </section>
  );
}

/** Link discreto para o `action` de um Panel ("Ver todos") */
export function PanelLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link to={to} className="whitespace-nowrap rounded-tag text-label font-medium text-action hover:text-action-hover hover:underline">
      {children}
    </Link>
  );
}

/**
 * Mensagem de "nada aqui" dentro de um Panel: a frase diz o que aparece ali; `hint` orienta em uma linha.
 */
export function PanelEmpty({ children, hint, testId }: { children: ReactNode; hint?: ReactNode; testId?: string }) {
  return (
    <div className="px-4 py-5 sm:px-5" data-testid={testId}>
      <p className="text-sm font-medium text-ink">{children}</p>
      {hint && <p className="mt-1 text-label text-ink-muted">{hint}</p>}
    </div>
  );
}

/** Observação no rodapé de um Panel */
export function PanelNote({ children }: { children: ReactNode }) {
  return <p className="border-t border-line-soft px-4 py-2 text-caption text-ink-muted sm:px-5">{children}</p>;
}

interface StatProps {
  label: string;
  value: string;
  hint?: ReactNode;
  /**
   * `danger` destaca o valor em vermelho (só quando o dado é crítico; o texto de apoio explica o motivo).
   * `muted` apaga o valor: zero sem problema ou informação indisponível.
   */
  tone?: 'danger' | 'muted';
  /** Com `to`, o indicador inteiro vira um link */
  to?: string;
  testId?: string;
}

/** Indicador da faixa de resumo: rótulo, numeral em destaque e texto de apoio. Use dentro de `StatGrid`. */
export function Stat({ label, value, hint, tone, to, testId }: StatProps) {
  const body = (
    <>
      <p className="text-label font-medium text-ink-soft">{label}</p>
      {/* `text-red-600` é usado como seletor pelo E2E do painel: mantenha a classe */}
      <p className={cn('mt-1 text-[1.625rem] font-semibold leading-[1.15] tracking-[-0.02em] sm:text-stat', tone === 'danger' ? 'text-red-600' : tone === 'muted' ? 'text-ink-muted' : 'text-ink')}>
        {value}
      </p>
      {hint && <p className="mt-0.5 text-caption text-ink-muted">{hint}</p>}
    </>
  );
  const cls = 'flex min-w-0 flex-col bg-surface px-3.5 pb-3.5 pt-3 sm:px-5 sm:pb-[18px] sm:pt-4';
  if (to) {
    return (
      <Link to={to} data-testid={testId} className={cn(cls, 'transition-colors hover:bg-surface-hover focus-visible:-outline-offset-2')}>
        {body}
      </Link>
    );
  }
  return <div className={cls} data-testid={testId}>{body}</div>;
}

export { Stat as StatCard };

/**
 * Faixa de indicadores: um único bloco com divisórias de 1px (não cartões soltos). Duas colunas no celular;
 * com número ímpar de indicadores o último ocupa a linha inteira.
 */
export function StatGrid({ children, cols = 4 }: { children: ReactNode; cols?: 2 | 3 | 4 }) {
  return (
    <div
      className={cn(
        'grid grid-cols-2 gap-px overflow-hidden rounded-card border border-line bg-line',
        '[&>*:last-child:nth-child(odd)]:col-span-2',
        cols === 4 && 'lg:grid-cols-4 lg:[&>*:last-child:nth-child(odd)]:col-span-1',
        cols === 3 && 'lg:grid-cols-3 lg:[&>*:last-child:nth-child(odd)]:col-span-1',
      )}
    >
      {children}
    </div>
  );
}

interface TabsProps<T extends string> {
  tabs: { key: T; label: string }[];
  value: T;
  onChange: (key: T) => void;
  /** Nome acessível do conjunto de abas */
  label: string;
  /** Prefixo dos ids (`<prefixo>-<chave>`), para `aria-labelledby` do painel */
  idPrefix: string;
  /** id do painel controlado */
  panelId: string;
  testIdPrefix?: string;
}

/** Abas do design system (34px, raio 6): a ativa em azul cheio, as demais em contorno. */
export function Tabs<T extends string>({ tabs, value, onChange, label, idPrefix, panelId, testIdPrefix }: TabsProps<T>) {
  return (
    <div role="tablist" aria-label={label} className="flex flex-wrap gap-2">
      {tabs.map((t) => (
        <button
          key={t.key}
          type="button"
          role="tab"
          id={`${idPrefix}-${t.key}`}
          aria-selected={value === t.key}
          aria-controls={panelId}
          data-testid={testIdPrefix ? `${testIdPrefix}-${t.key}` : undefined}
          onClick={() => onChange(t.key)}
          className={cn(
            'inline-flex min-h-11 items-center rounded-control border px-3 text-label font-medium transition-colors md:min-h-[34px]',
            value === t.key
              ? 'border-action bg-action text-on-action'
              : 'border-line-strong bg-surface text-ink-soft hover:bg-surface-hover',
          )}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}
