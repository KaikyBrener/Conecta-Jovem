import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { AttendanceChart } from './AttendanceChart';
import { DataTable, ExportTableView } from './ReportParts';
import { GroupMetric } from '../groups/GroupMetric';

// Renderização no servidor (sem DOM): confere texto alternativo, estados vazios e textos de tendência.

describe('AttendanceChart', () => {
  const points = [
    { date: '2026-10-01', present: 8, registered: 10, rate: 80 },
    { date: '2026-10-03', present: 5, registered: 10, rate: 50 },
  ];

  it('tem título/descrição em texto e tabela com os valores', () => {
    const html = renderToStaticMarkup(<AttendanceChart points={points} title="Frequência por dia" />);
    expect(html).toContain('role="img"');
    expect(html).toContain('<title');
    expect(html).toContain('Frequência por dia');
    expect(html).toContain('2 dias com chamada, de 01/10 a 03/10. Frequência entre 50% e 80%.');
    expect(html).toContain('Ver valores');
    expect(html).toContain('01/10/2026');
    expect(html).toContain('80%');
  });

  it('sem pontos não desenha nada', () => {
    expect(renderToStaticMarkup(<AttendanceChart points={[]} title="x" />)).toBe('');
  });
});

describe('DataTable', () => {
  const columns = [
    { key: 'a', header: 'Nome', primary: true, render: (r: { n: string; v: number }) => r.n },
    { key: 'b', header: 'Valor', render: (r: { n: string; v: number }) => r.v },
  ];

  it('mostra tabela (desktop) e cartões (mobile) com os mesmos dados', () => {
    const html = renderToStaticMarkup(
      <DataTable columns={columns} rows={[{ n: 'Ana', v: 3 }]} rowKey={(r) => r.n} caption="Teste" emptyText="Vazio" testId="t" />,
    );
    expect(html).toContain('hidden md:block');
    expect(html).toContain('md:hidden');
    expect(html).toContain('<th scope="col"');
    expect(html).toContain('Ana');
    expect(html).toContain('data-testid="t-cartoes"');
  });

  it('sem linhas mostra o texto de vazio', () => {
    const html = renderToStaticMarkup(
      <DataTable columns={columns} rows={[]} rowKey={(r) => r.n} caption="Teste" emptyText="Nada por aqui." />,
    );
    expect(html).toContain('Nada por aqui.');
    expect(html).not.toContain('<table');
  });

  it('ExportTableView mostra título, linhas e observação', () => {
    const html = renderToStaticMarkup(
      <ExportTableView table={{ title: 'Faltas', headers: ['Jovem', 'Faltas'], rows: [['Ana', '4']], emptyText: '', note: 'Mostrando 1 de 2' }} />,
    );
    expect(html).toContain('Faltas');
    expect(html).toContain('Ana');
    expect(html).toContain('Mostrando 1 de 2');
  });
});

describe('GroupMetric', () => {
  const base = {
    group_id: 'g', name: 'G', leader_name: null, active_youth: 4, attendance_rate: 72, trend: 'down' as const,
    trend_delta: -14, youth_in_attention: 2, overdue_actions: 0,
  };

  it('tendência sempre em texto, com delta', () => {
    const html = renderToStaticMarkup(<GroupMetric kind="trend" indicator={base} loading={false} />);
    expect(html).toContain('em queda');
    expect(html).toContain('-14 pp');
    expect(html).toContain('data-tendencia="down"');
  });

  it('sem histórico suficiente: "dados insuficientes"', () => {
    const html = renderToStaticMarkup(<GroupMetric kind="trend" indicator={{ ...base, trend: null, trend_delta: null }} loading={false} />);
    expect(html).toContain('dados insuficientes');
  });

  it('frequência, atenção e atrasadas', () => {
    expect(renderToStaticMarkup(<GroupMetric kind="rate" indicator={base} loading={false} />)).toContain('72%');
    expect(renderToStaticMarkup(<GroupMetric kind="rate" indicator={{ ...base, attendance_rate: null }} loading={false} />)).toContain('sem chamadas');
    expect(renderToStaticMarkup(<GroupMetric kind="attention" indicator={base} loading={false} />)).toContain('2');
    expect(renderToStaticMarkup(<GroupMetric kind="overdue" indicator={undefined} loading={false} />)).toContain('—');
  });
});
