import { useAlertsReport } from '../../hooks/useReports';
import { buildAlertsDoc } from '../../lib/reportExport';
import { ExportTableView, Stat, StatGrid } from './ReportParts';
import { ReportShell, type ReportTabProps } from './ReportShell';

export function AlertsTab({ range, groupId, groupName, allGroupsLabel }: ReportTabProps) {
  const state = useAlertsReport(range, groupId);
  const ctx = { groupName, allGroupsLabel };
  return (
    <ReportShell state={state} build={(r) => buildAlertsDoc(r, ctx)}>
      {(r) => {
        const doc = buildAlertsDoc(r, ctx);
        const avg = doc.summary.find((s) => s.label === 'Tempo médio até resolver')?.value ?? '—';
        return (
          <div className="space-y-4" data-testid="relatorio-alertas">
            <StatGrid>
              <Stat label="Abertos agora" value={String(r.open_now.total)} hint={`${r.open_now.critical} crítico(s) · ${r.open_now.attention} em atenção`} />
              <Stat label="Criados no período" value={String(r.created.total)} hint={`${r.created.critical} crítico(s) · ${r.created.attention} em atenção`} />
              <Stat label="Resolvidos no período" value={String(r.resolved)} hint={`${r.resolved_automatically} automaticamente`} />
              <Stat
                label="Dispensados no período"
                value={String(r.dismissed)}
                hint={r.avg_resolution_hours !== null ? `tempo médio para resolver: ${avg}` : 'sem alertas resolvidos para medir o tempo'}
              />
            </StatGrid>
            {doc.tables.map((t) => <ExportTableView key={t.title} table={t} />)}
            <p className="text-xs text-gray-500">&quot;Abertos agora&quot; mostra a situação de hoje e não depende do período escolhido.</p>
          </div>
        );
      }}
    </ReportShell>
  );
}
