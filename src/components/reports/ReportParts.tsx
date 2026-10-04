import type { ReactNode } from 'react';
import { formatPercent } from '../../lib/format';
import type { ExportTable } from '../../lib/reportExport';
import { cn } from '../../lib/utils';

/** Barra fina de percentual (um só tom) com o valor em texto */
export function RateBar({ value }: { value: number | null }) {
  return (
    <div className="flex items-center gap-2 min-w-24">
      <div className="flex-1 h-1.5 rounded-full bg-gray-100 overflow-hidden" aria-hidden="true">
        {value !== null && <div className="h-full rounded-full bg-blue-600" style={{ width: `${Math.min(100, Math.max(value, 2))}%` }} />}
      </div>
      <span className="w-10 text-right text-xs font-medium text-gray-700 tabular-nums">{formatPercent(value)}</span>
    </div>
  );
}

export function Stat({ label, value, hint, testId }: { label: string; value: string; hint?: string; testId?: string }) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 p-4" data-testid={testId}>
      <p className="text-xs text-gray-500">{label}</p>
      <p className="text-2xl font-bold text-gray-900 mt-1 tabular-nums">{value}</p>
      {hint && <p className="text-[11px] text-gray-500 mt-0.5">{hint}</p>}
    </div>
  );
}

export function StatGrid({ children, cols = 4 }: { children: ReactNode; cols?: 3 | 4 }) {
  return <div className={cn('grid grid-cols-2 gap-3', cols === 4 ? 'lg:grid-cols-4' : 'lg:grid-cols-3')}>{children}</div>;
}

export function Section({ title, hint, children, testId }: { title: string; hint?: string; children: ReactNode; testId?: string }) {
  return (
    <section className="bg-white rounded-xl border border-gray-200 overflow-hidden" data-testid={testId}>
      <div className="px-4 py-3 border-b border-gray-100">
        <h3 className="text-sm font-semibold text-gray-900">{title}</h3>
        {hint && <p className="text-xs text-gray-500 mt-0.5">{hint}</p>}
      </div>
      {children}
    </section>
  );
}

export function Note({ children }: { children: ReactNode }) {
  return <p className="px-4 py-2 text-xs text-gray-500 border-t border-gray-100">{children}</p>;
}

export function EmptyText({ children }: { children: ReactNode }) {
  return <p className="px-4 py-6 text-sm text-gray-500 text-center">{children}</p>;
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
        <table className="w-full text-sm" data-testid={testId}>
          <caption className="sr-only">{caption}</caption>
          <thead className="bg-gray-50 text-xs text-gray-500">
            <tr>
              {columns.map((c) => (
                <th key={c.key} scope="col" className={cn('px-4 py-2 font-medium text-left', c.align && ALIGN[c.align])}>{c.header}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {rows.map((row, i) => (
              <tr key={rowKey(row, i)}>
                {columns.map((c) => (
                  <td key={c.key} className={cn('px-4 py-2.5 text-gray-700 align-top', c.align && ALIGN[c.align])}>{c.render(row)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <ul className="md:hidden divide-y divide-gray-100" data-testid={testId ? `${testId}-cartoes` : undefined} aria-label={caption}>
        {rows.map((row, i) => (
          <li key={rowKey(row, i)} className="px-4 py-3 space-y-1.5">
            <div className="text-sm font-medium text-gray-900 break-words">{primary.render(row)}</div>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
              {rest.map((c) => (
                <div key={c.key} className="flex items-baseline justify-between gap-2 min-w-0">
                  <dt className="text-gray-500 flex-shrink-0">{c.header}</dt>
                  <dd className="text-gray-800 text-right min-w-0 break-words">{c.render(row)}</dd>
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
