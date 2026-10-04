import { useGroupsReport } from '../../hooks/useReports';
import { buildGroupsDoc } from '../../lib/reportExport';
import type { GroupsReportRow } from '../../lib/reportTypes';
import { GroupMetric } from '../groups/GroupMetric';
import { formatPercent } from '../../lib/format';
import { DataTable, Section, Stat, StatGrid, type Column } from './ReportParts';
import { ReportShell, type ReportTabProps } from './ReportShell';

const currentColumns: Column<GroupsReportRow>[] = [
  {
    key: 'g',
    header: 'Grupo',
    primary: true,
    render: (g) => (
      <>
        <span className="text-gray-900">{g.name}</span>
        {g.leader_name && <span className="block text-xs text-gray-500">Líder: {g.leader_name}</span>}
      </>
    ),
  },
  { key: 'y', header: 'Jovens ativos', render: (g) => g.active_youth },
  { key: 'r', header: 'Frequência (8 últimos encontros)', render: (g) => <GroupMetric kind="rate" indicator={g} loading={false} /> },
  { key: 't', header: 'Tendência', render: (g) => <GroupMetric kind="trend" indicator={g} loading={false} /> },
  { key: 'a', header: 'Em atenção', render: (g) => <GroupMetric kind="attention" indicator={g} loading={false} /> },
  { key: 'o', header: 'Ações atrasadas', render: (g) => <GroupMetric kind="overdue" indicator={g} loading={false} /> },
];

const periodColumns: Column<GroupsReportRow>[] = [
  { key: 'g', header: 'Grupo', primary: true, render: (g) => g.name },
  { key: 'e', header: 'Encontros realizados', render: (g) => g.period.events_held },
  {
    key: 'f',
    header: 'Frequência',
    render: (g) => (g.period.registered > 0 ? `${formatPercent(g.period.rate)} (${g.period.present}/${g.period.registered})` : 'sem chamadas'),
  },
  { key: 'u', header: 'Acompanhamentos', render: (g) => g.period.follow_ups },
  { key: 'l', header: 'Alertas criados', render: (g) => g.period.alerts_created },
  { key: 'c', header: 'Ações concluídas', render: (g) => g.period.actions_completed },
];

export function GroupsTab({ range, groupName, allGroupsLabel }: ReportTabProps) {
  const state = useGroupsReport(range);
  const ctx = { groupName, allGroupsLabel };
  return (
    <ReportShell state={state} build={(r) => buildGroupsDoc(r, ctx)}>
      {(r) => (
        <div className="space-y-4" data-testid="relatorio-grupos">
          <StatGrid cols={3}>
            <Stat label="Grupos" value={String(r.groups.length)} />
            <Stat label="Jovens ativos nos grupos" value={String(r.groups.reduce((a, g) => a + g.active_youth, 0))} />
            <Stat label="Jovens em atenção agora" value={String(r.groups.reduce((a, g) => a + g.youth_in_attention, 0))} />
          </StatGrid>
          <Section
            title="Situação atual dos grupos"
            hint="Em ordem alfabética. Tendência: 4 encontros mais recentes contra os 4 anteriores (mínimo de 8 com chamada)."
            testId="rel-grupos-atual"
          >
            <DataTable columns={currentColumns} rows={r.groups} rowKey={(g) => g.group_id} caption="Situação atual dos grupos" emptyText="Nenhum grupo." testId="tabela-grupos-atual" />
          </Section>
          <Section title="Movimento no período" testId="rel-grupos-periodo">
            <DataTable columns={periodColumns} rows={r.groups} rowKey={(g) => g.group_id} caption="Movimento dos grupos no período" emptyText="Nenhum grupo." testId="tabela-grupos-periodo" />
          </Section>
        </div>
      )}
    </ReportShell>
  );
}
