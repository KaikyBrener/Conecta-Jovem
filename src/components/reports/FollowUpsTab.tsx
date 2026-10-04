import { useFollowUpsReport } from '../../hooks/useReports';
import { buildFollowUpsDoc } from '../../lib/reportExport';
import { formatDay } from '../../lib/format';
import type { FollowUpsReport } from '../../lib/reportTypes';
import { cn } from '../../lib/utils';
import { DataTable, ExportTableView, Note, Section, Stat, StatGrid, type Column } from './ReportParts';
import { ReportShell, type ReportTabProps } from './ReportShell';

type NextAction = FollowUpsReport['next_actions']['items'][number];

const nextColumns: Column<NextAction>[] = [
  {
    key: 'd',
    header: 'Prazo',
    render: (i) => (
      <span className={cn(i.overdue && 'text-red-600 font-medium')} data-vencida={i.overdue ? 'true' : 'false'}>
        {formatDay(i.next_action_due)}{i.overdue && ' · vencida'}
      </span>
    ),
  },
  { key: 'y', header: 'Jovem', primary: true, render: (i) => i.youth_name },
  { key: 'a', header: 'Próxima ação', render: (i) => i.next_action ?? 'não descrita' },
  { key: 'r', header: 'Responsável', render: (i) => i.responsible_name ?? '—' },
];

export function FollowUpsTab({ range, groupId, groupName, allGroupsLabel }: ReportTabProps) {
  const state = useFollowUpsReport(range, groupId);
  const ctx = { groupName, allGroupsLabel };
  return (
    <ReportShell state={state} build={(r) => buildFollowUpsDoc(r, ctx)}>
      {(r) => {
        const na = r.next_actions;
        const doc = buildFollowUpsDoc(r, ctx);
        return (
          <div className="space-y-4" data-testid="relatorio-acompanhamento">
            <StatGrid>
              <Stat label="Acompanhamentos" value={String(r.total)} hint="no período" />
              <Stat label="Jovens alcançados" value={String(r.youth_reached)} hint="no período" />
              <Stat label="Próximas ações pendentes" value={String(na.pending)} hint={`${na.upcoming} no prazo · agora`} />
              <Stat label="Próximas ações vencidas" value={String(na.overdue)} hint="agora" />
            </StatGrid>
            <ExportTableView table={doc.tables[0]} />
            <ExportTableView table={doc.tables[1]} />
            <p className="text-xs text-gray-500">
              {r.transfers.count} {r.transfers.count === 1 ? 'transferência' : 'transferências'} de responsável no período
              ({r.transfers.follow_ups} {r.transfers.follow_ups === 1 ? 'acompanhamento' : 'acompanhamentos'}).
            </p>
            <Section title="Próximas ações pendentes" hint="Situação atual: não depende do período escolhido." testId="rel-proximas-acoes">
              <DataTable
                columns={nextColumns}
                rows={na.items}
                rowKey={(i) => i.follow_up_id}
                caption="Próximas ações pendentes"
                emptyText="Nenhuma próxima ação pendente."
                testId="tabela-proximas-acoes"
              />
              {na.pending > na.items.length && <Note>Mostrando {na.items.length} de {na.pending} ações (por prazo).</Note>}
            </Section>
          </div>
        );
      }}
    </ReportShell>
  );
}
