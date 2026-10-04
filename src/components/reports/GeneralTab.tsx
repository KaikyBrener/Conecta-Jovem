import { useGeneralReport } from '../../hooks/useReports';
import { buildGeneralDoc } from '../../lib/reportExport';
import { formatPercent } from '../../lib/format';
import { ExportTableView, Stat, StatGrid } from './ReportParts';
import { ReportShell, type ReportTabProps } from './ReportShell';

export function GeneralTab({ range, groupId, groupName, allGroupsLabel }: ReportTabProps) {
  const state = useGeneralReport(range, groupId);
  const ctx = { groupName, allGroupsLabel };
  return (
    <ReportShell state={state} build={(r) => buildGeneralDoc(r, ctx)}>
      {(r) => (
        <div className="space-y-4" data-testid="relatorio-geral">
          <StatGrid>
            <Stat
              testId="rel-frequencia"
              label="Frequência"
              value={formatPercent(r.attendance.rate)}
              hint={r.attendance.registered > 0 ? `${r.attendance.registered} registros de chamada` : 'sem chamadas no período'}
            />
            <Stat label="Encontros realizados" value={String(r.events.held)} hint={`${r.events.cancelled} cancelado(s)`} />
            <Stat label="Alertas abertos agora" value={String(r.alerts.open_now)} hint={`${r.alerts.created} criado(s) no período`} />
            <Stat label="Ações atrasadas agora" value={String(r.actions.overdue_now)} hint={`${r.actions.completed} concluída(s) no período`} />
          </StatGrid>
          <p className="text-xs text-gray-500">
            {r.active_youth} {r.active_youth === 1 ? 'jovem ativo' : 'jovens ativos'} agora. Itens com referência &quot;Situação atual&quot; não dependem do período escolhido.
          </p>
          {buildGeneralDoc(r, ctx).tables.map((t) => (
            <ExportTableView key={t.title} table={t} />
          ))}
        </div>
      )}
    </ReportShell>
  );
}
