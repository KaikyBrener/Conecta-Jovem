import { useMemo, useState } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { useReportGroups } from '../hooks/useReports';
import { PageHeader } from '../components/ui/PageHeader';
import { Tabs } from '../components/ui/Card';
import { FilterChips } from '../components/ui/FilterChips';
import { ErrorBanner } from '../components/ErrorBanner';
import { GeneralTab } from '../components/reports/GeneralTab';
import { AttendanceTab } from '../components/reports/AttendanceTab';
import { FollowUpsTab } from '../components/reports/FollowUpsTab';
import { AlertsTab } from '../components/reports/AlertsTab';
import { YouthTab } from '../components/reports/YouthTab';
import { GroupsTab } from '../components/reports/GroupsTab';
import type { ReportTabProps } from '../components/reports/ReportShell';
import { appToday, formatDay } from '../lib/format';
import { inputCls, labelCls } from '../lib/formStyles';
import { PERIOD_PRESETS, resolvePeriod, validateRange, type DateRange, type PeriodPreset } from '../lib/periods';
import { cn } from '../lib/utils';

type Tab = 'general' | 'attendance' | 'followups' | 'alerts' | 'youth' | 'groups';

const TABS: { key: Tab; label: string; usesGroupFilter: boolean }[] = [
  { key: 'general', label: 'Geral', usesGroupFilter: true },
  { key: 'attendance', label: 'Frequência', usesGroupFilter: true },
  { key: 'followups', label: 'Acompanhamento', usesGroupFilter: true },
  { key: 'alerts', label: 'Alertas', usesGroupFilter: true },
  { key: 'youth', label: 'Individual', usesGroupFilter: false },
  { key: 'groups', label: 'Grupos', usesGroupFilter: false },
];

export function Relatorios() {
  const { role } = useAuth();
  const today = useMemo(() => appToday(), []);
  const [tab, setTab] = useState<Tab>('general');
  const [preset, setPreset] = useState<PeriodPreset>('last30');
  const [custom, setCustom] = useState<DateRange>(() => resolvePeriod('last30', today));
  const [groupId, setGroupId] = useState('all');

  const { groups, error: groupsError } = useReportGroups();

  const range = useMemo(() => resolvePeriod(preset, today, custom), [preset, today, custom]);
  // Só o período personalizado pode ser inválido (os prontos são sempre válidos)
  const rangeError = preset === 'custom' ? validateRange(range) : null;
  const validRange = rangeError ? null : range;

  const current = TABS.find((t) => t.key === tab) ?? TABS[0];
  const allGroupsLabel = role === 'leader' ? 'Todos os seus grupos' : 'Todos os grupos';
  const selectedGroup = current.usesGroupFilter ? groups.find((g) => g.id === groupId) ?? null : null;

  const tabProps: ReportTabProps = {
    range: validRange,
    groupId: selectedGroup ? selectedGroup.id : null,
    groupName: selectedGroup ? selectedGroup.name : null,
    allGroupsLabel,
  };

  return (
    <div className="space-y-5">
      <PageHeader
        title="Relatórios"
        subtitle="Frequência, acompanhamento e alertas no período. Encontros cancelados e chamadas não registradas não contam como falta."
      />

      {/* Filtros */}
      <div className="bg-white rounded-card border border-gray-200 p-4 space-y-4">
        <div className="space-y-2">
          <p className={labelCls} id="rel-periodo-rotulo">Período</p>
          <div role="group" aria-labelledby="rel-periodo-rotulo" data-testid="rel-periodos">
            <FilterChips options={PERIOD_PRESETS.map((p) => ({ label: p.label, value: p.value }))} value={preset} onChange={setPreset} />
          </div>
        </div>

        {preset === 'custom' && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 max-w-lg">
            <div>
              <label className={labelCls} htmlFor="rel-de">Data inicial</label>
              <input
                id="rel-de"
                type="date"
                value={custom.from}
                onChange={(e) => setCustom((c) => ({ ...c, from: e.target.value }))}
                aria-invalid={rangeError ? true : undefined}
                className={inputCls}
              />
            </div>
            <div>
              <label className={labelCls} htmlFor="rel-ate">Data final</label>
              <input
                id="rel-ate"
                type="date"
                value={custom.to}
                onChange={(e) => setCustom((c) => ({ ...c, to: e.target.value }))}
                aria-invalid={rangeError ? true : undefined}
                className={inputCls}
              />
            </div>
          </div>
        )}

        {current.usesGroupFilter && (
          <div className="max-w-sm">
            <label className={labelCls} htmlFor="rel-grupo">Grupo</label>
            <select id="rel-grupo" value={groupId} onChange={(e) => setGroupId(e.target.value)} className={cn(inputCls, 'bg-white')}>
              <option value="all">{allGroupsLabel}</option>
              {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
            </select>
          </div>
        )}

        {validRange && (
          <p className="text-xs text-gray-500" data-testid="rel-periodo">
            Período: {validRange.from === validRange.to ? formatDay(validRange.from) : `${formatDay(validRange.from)} a ${formatDay(validRange.to)}`}
            {current.key === 'youth' || current.key === 'groups' ? '' : selectedGroup ? ` · ${selectedGroup.name}` : ` · ${allGroupsLabel.toLowerCase()}`}
          </p>
        )}
      </div>

      <ErrorBanner message={rangeError} />
      <ErrorBanner message={groupsError} />

      {/* Abas */}
      <Tabs tabs={TABS} value={tab} onChange={setTab} label="Tipo de relatório" idPrefix="rel-aba" panelId="rel-painel" testIdPrefix="rel-aba" />

      <div role="tabpanel" id="rel-painel" aria-labelledby={`rel-aba-${tab}`}>
        {tab === 'general' && <GeneralTab {...tabProps} />}
        {tab === 'attendance' && <AttendanceTab {...tabProps} />}
        {tab === 'followups' && <FollowUpsTab {...tabProps} />}
        {tab === 'alerts' && <AlertsTab {...tabProps} />}
        {tab === 'youth' && <YouthTab {...tabProps} />}
        {tab === 'groups' && <GroupsTab {...tabProps} />}
      </div>
    </div>
  );
}
