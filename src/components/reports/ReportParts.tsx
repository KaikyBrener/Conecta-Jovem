import type { ReactNode } from 'react';
import { formatPercent } from '../../lib/format';
import type { ExportTable } from '../../lib/reportExport';
import { cn } from '../../lib/utils';
import { Panel as Section, PanelEmpty as EmptyText, PanelNote as Note } from '../ui/Card';

export { Stat, StatGrid } from '../ui/Card';
export { Section, Note, EmptyText };

/** Barra fina de percentual (um só tom) com o valor em texto */
export function RateBar({ value }: { value: number | null }) {
  return (
    <div className="flex items-center gap-2 min-w-24">
      <div className="flex-1 h-1.5 rounded-full bg-line-soft overflow-hidden" aria-hidden="true">
        {value !== null && <div className="h-full bg-action" style={{ width: `${Math.min(100, Math.max(value, 2))}%` }} />}
      </div>
      <span className="w-10 text-right text-caption font-medium text-ink">{formatPercent(value)}</span>
    </div>
  );
}

export interface Column<T> {
  key: string;
  header: string;
  render: (row: T) => ReactNode;
  align?: 'right' | 'center';
  /** Coluna que vira o título do cartão no mobile */
  primary?: boolean;
}

interface DataTableProps<T> {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T, index: number) => string;
  caption: string;
  emptyText: string;
  testId?: string;
}

const ALIGN = { right: 'text-right', center: 'text-center' } as const;

/**
 * Tabela no desktop; cartões no mobile (sem rolagem horizontal). Tabela larga demais rola dentro do próprio
 * bloco, nunca a página inteira.
 */
export function DataTable<T>({ columns, rows, rowKey, caption, emptyText, testId }: DataTableProps<T>) {
  if (rows.length === 0) return <EmptyText>{emptyText}</EmptyText>;
  const primary = columns.find((c) => c.primary) ?? columns[0];
  const rest = columns.filter((c) => c !== primary);

  return (
    <>
      <div className="hidden md:block overflow-x-auto">
        <table className="w-full border-collapse text-table" data-testid={testId}>
          <caption className="sr-only">{caption}</caption>
          <thead>
            <tr>
              {columns.map((c) => (
                <th key={c.key} scope="col" className={cn('px-4 py-2 text-left sm:first:pl-5 sm:last:pr-5', c.align && ALIGN[c.align])}>{c.header}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={rowKey(row, i)} className="border-t border-line-soft transition-colors hover:bg-surface-hover">
                {columns.map((c) => (
                  <td key={c.key} className={cn('px-4 py-2.5 text-ink-soft align-top sm:first:pl-5 sm:last:pr-5', c.align && ALIGN[c.align])}>{c.render(row)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <ul className="md:hidden divide-y divide-line-soft" data-testid={testId ? `${testId}-cartoes` : undefined} aria-label={caption}>
        {rows.map((row, i) => (
          <li key={rowKey(row, i)} className="px-4 py-3 space-y-1.5">
            <div className="text-sm font-semibold text-ink break-words">{primary.render(row)}</div>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
              {rest.map((c) => (
                <div key={c.key} className="flex items-baseline justify-between gap-2 min-w-0">
                  <dt className="text-ink-muted flex-shrink-0">{c.header}</dt>
                  <dd className="text-ink text-right min-w-0 break-words">{c.render(row)}</dd>
                </div>
              ))}
            </dl>
          </li>
        ))}
      </ul>
    </>
  );
}

/** Mostra na tela exatamente a tabela que será exportada (mesmo texto do CSV/PDF). */
export function ExportTableView({ table, testId }: { table: ExportTable; testId?: string }) {
  const columns: Column<string[]>[] = table.headers.map((header, i) => ({
    key: String(i),
    header: header || 'Item',
    primary: i === 0,
    render: (row) => row[i],
  }));
  return (
    <Section title={table.title} testId={testId}>
      <DataTable
        columns={columns}
        rows={table.rows}
        rowKey={(_, i) => String(i)}
        caption={table.title}
        emptyText={table.emptyText || 'Sem registros.'}
      />
      {table.note && <Note>{table.note}</Note>}
    </Section>
  );
}
