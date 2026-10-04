import { supabase } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';
import { fetchAll } from '../lib/fetchAll';
import { searchPattern } from '../lib/pagination';
import type { DateRange } from '../lib/periods';
import type {
  AlertsReport,
  AttendanceReport,
  FollowUpsReport,
  GeneralReport,
  GroupsReport,
  YouthReport,
} from '../lib/reportTypes';
import { useAsyncValue } from './useAsyncValue';

// Relatórios: toda a agregação roda no servidor (RPCs report_*, migration 013), com o escopo do papel
// (coordenador: tudo; líder: só os jovens do grupo atual dele). O cliente só envia datas e o grupo.

type RpcArgs = Record<string, unknown>;

/** Chama uma RPC e entrega o JSON. `args === null` desliga a busca (ex.: período inválido). */
function useRpcReport<T>(fn: string, args: RpcArgs | null, errorFallback: string) {
  const { user } = useAuth();
  const key = user && args ? `${fn}|${JSON.stringify(args)}` : null;
  return useAsyncValue<T | null>(
    key,
    async () => {
      const { data, error } = await (supabase as any).rpc(fn, args);
      if (error) throw error;
      if (!data || typeof data !== 'object') throw new Error('Resposta inválida do relatório.');
      return data as T;
    },
    null,
    errorFallback,
  );
}

const range = (r: DateRange | null, extra: RpcArgs = {}): RpcArgs | null =>
  r ? { p_from: r.from, p_to: r.to, ...extra } : null;

export function useGeneralReport(r: DateRange | null, groupId: string | null) {
  return useRpcReport<GeneralReport>('report_general', range(r, { p_group_id: groupId }), 'Erro ao gerar o relatório geral.');
}

export function useAttendanceReport(r: DateRange | null, groupId: string | null, minAbsences: number) {
  return useRpcReport<AttendanceReport>(
    'report_attendance',
    range(r, { p_group_id: groupId, p_min_absences: minAbsences }),
    'Erro ao gerar o relatório de frequência.',
  );
}

export function useFollowUpsReport(r: DateRange | null, groupId: string | null) {
  return useRpcReport<FollowUpsReport>('report_followups', range(r, { p_group_id: groupId }), 'Erro ao gerar o relatório de acompanhamento.');
}

export function useAlertsReport(r: DateRange | null, groupId: string | null) {
  return useRpcReport<AlertsReport>('report_alerts', range(r, { p_group_id: groupId }), 'Erro ao gerar o relatório de alertas.');
}

export function useGroupsReport(r: DateRange | null) {
  return useRpcReport<GroupsReport>('report_groups', range(r), 'Erro ao gerar o relatório de grupos.');
}

export function useYouthReport(youthId: string | null, r: DateRange | null) {
  return useRpcReport<YouthReport>(
    'report_youth',
    youthId && r ? { p_youth_id: youthId, p_from: r.from, p_to: r.to } : null,
    'Erro ao gerar o relatório individual.',
  );
}

export interface GroupOption {
  id: string;
  name: string;
}

/** Grupos do filtro (RLS: coordenador vê todos, líder os seus). Lista que alimenta <select>: busca todas as linhas. */
export function useReportGroups() {
  const { user } = useAuth();
  const res = useAsyncValue<GroupOption[]>(
    user ? 'report-groups' : null,
    () => fetchAll<GroupOption>(() => (supabase as any).from('groups').select('id, name').order('name').order('id')),
    [],
    'Erro ao carregar os grupos.',
  );
  return { groups: res.data, loading: res.loading, error: res.error };
}

export interface YouthOption {
  id: string;
  full_name: string;
  is_active: boolean;
  group: { name: string } | null;
}

/** Busca de jovem por nome para o relatório individual (RLS limita ao escopo; no máximo 20 resultados). */
export function useYouthSearch(term: string) {
  const { user } = useAuth();
  const pattern = term.trim().length >= 2 ? searchPattern(term) : null;
  const res = useAsyncValue<YouthOption[]>(
    user && pattern ? `youth-search|${pattern}` : null,
    async () => {
      const { data, error } = await (supabase as any)
        .from('youth')
        .select('id, full_name, is_active, group:group_id(name)')
        .ilike('full_name', pattern)
        .order('full_name')
        .order('id')
        .limit(20);
      if (error) throw error;
      return (data ?? []) as YouthOption[];
    },
    [],
    'Erro ao buscar jovens.',
  );
  return { results: res.data, loading: res.loading, error: res.error, searching: pattern !== null };
}
