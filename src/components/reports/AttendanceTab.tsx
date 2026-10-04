import { useState } from 'react';
import { useAttendanceReport } from '../../hooks/useReports';
import { buildAttendanceDoc, eventRowKey } from '../../lib/reportExport';
import { formatPercent, formatTimestampSP } from '../../lib/format';
import { inputCls, labelCls } from '../../lib/formStyles';
import type { AttendanceAbsenceItem, AttendanceByEvent, AttendanceByGroup } from '../../lib/reportTypes';
import { AttendanceChart } from './AttendanceChart';
import { DataTable, Note, RateBar, Section, Stat, StatGrid, type Column } from './ReportParts';
import { ReportShell, type ReportTabProps } from './ReportShell';

const EVENT_STATUS: Record<string, string> = { scheduled: 'Agendado', completed: 'Realizado', cancelled: 'Cancelado' };

const eventColumns: Column<AttendanceByEvent>[] = [
  {
    key: 'e',
    header: 'Encontro',
    primary: true,
    render: (e) => (
      <>
        <span className="text-gray-900">{e.title}</span>
        <span className="block text-xs text-gray-500">{formatTimestampSP(e.event_date)} · {EVENT_STATUS[e.status] ?? e.status}</span>
      </>
    ),
  },
  { key: 'p', header: 'Presentes', render: (e) => (e.registered > 0 ? `${e.present}/${e.registered}` : 'sem chamada') },
  { key: 'r', header: 'Frequência', render: (e) => <RateBar value={e.rate} /> },
];

const groupColumns: Column<AttendanceByGroup>[] = [
  { key: 'g', header: 'Grupo', primary: true, render: (g) => g.name },
  { key: 'e', header: 'Encontros', render: (g) => g.events },
  { key: 'p', header: 'Presentes', render: (g) => `${g.present}/${g.registered}` },
  { key: 'r', header: 'Frequência', render: (g) => <RateBar value={g.rate} /> },
];

const absenceColumns: Column<AttendanceAbsenceItem>[] = [
  { key: 'y', header: 'Jovem', primary: true, render: (y) => y.full_name },
  { key: 'g', header: 'Grupo', render: (y) => y.group_name ?? 'Sem grupo' },
  { key: 'a', header: 'Faltas', render: (y) => `${y.absences} de ${y.registered}` },
];

export function AttendanceTab({ range, groupId, groupName, allGroupsLabel }: ReportTabProps) {
  const [minAbsences, setMinAbsences] = useState(3);
  const state = useAttendanceReport(range, groupId, minAbsences);
  const ctx = { groupName, allGroupsLabel };

  return (
    <ReportShell state={state} build={(r) => buildAttendanceDoc(r, ctx)}>
      {(r) => {
        const ab = r.youth_absences;
        return (
          <div className="space-y-4" data-testid="relatorio-frequencia">
            <StatGrid>
              <Stat
                testId="rel-frequencia"
                label="Frequência"
                value={formatPercent(r.summary.rate)}
                hint={r.summary.registered > 0 ? `${r.summary.present} presenças · ${r.summary.absent} faltas` : 'sem chamadas no período'}
              />
              <Stat label="Registros de chamada" value={String(r.summary.registered)} />
              <Stat label="Encontros com chamada" value={`${r.summary.events_with_records} de ${r.summary.events}`} hint="não cancelados" />
              <Stat label="Encontros cancelados" value={String(r.summary.events_cancelled)} />
            </StatGrid>

            {r.series.length > 0 && (
              <Section title="Frequência por dia" hint="Uma barra por dia com chamada.">
                <div className="p-4">
                  <AttendanceChart points={r.series} title="Frequência por dia com chamada no período" />
                </div>
              </Section>
            )}

            <Section title="Por encontro" testId="rel-por-encontro">
              <DataTable
                columns={eventColumns}
                rows={r.by_event}
                rowKey={eventRowKey}
                caption="Frequência por encontro"
                emptyText="Nenhum encontro no período."
                testId="tabela-encontros"
              />
            </Section>

            <Section title="Por grupo" hint="Jovens que estão hoje no grupo, nos encontros dele." testId="rel-por-grupo">
              <DataTable
                columns={groupColumns}
                rows={r.by_group}
                rowKey={(g, i) => g.group_id ?? `sem-${i}`}
                caption="Frequência por grupo"
                emptyText="Nenhum registro de chamada por grupo no período."
                testId="tabela-grupos-freq"
              />
            </Section>

            <Section title="Jovens com muitas faltas" testId="rel-faltas">
              <div className="px-4 py-3 border-b border-gray-100 max-w-xs">
                <label htmlFor="rel-min-faltas" className={labelCls}>Mínimo de faltas no período</label>
                <select
                  id="rel-min-faltas"
                  value={minAbsences}
                  onChange={(e) => setMinAbsences(Number(e.target.value))}
                  className={`${inputCls} bg-white`}
                >
                  {[1, 2, 3, 4, 5].map((v) => <option key={v} value={v}>{v} ou mais</option>)}
                </select>
              </div>
              <DataTable
                columns={absenceColumns}
                rows={ab.items}
                rowKey={(y) => y.youth_id}
                caption="Jovens com muitas faltas"
                emptyText={`Nenhum jovem com ${ab.min_absences} ou mais faltas no período.`}
                testId="tabela-faltas"
              />
              {ab.total > ab.items.length && <Note>Mostrando {ab.items.length} de {ab.total} jovens (em ordem alfabética).</Note>}
            </Section>
            <p className="text-xs text-gray-500">Chamadas não registradas não são contadas como falta. Encontros cancelados não entram.</p>
          </div>
        );
      }}
    </ReportShell>
  );
}
