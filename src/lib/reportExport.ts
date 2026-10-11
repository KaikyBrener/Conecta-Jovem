import { toCsv, type CsvValue } from './csv';
import { formatDay, formatTimestampSP } from './format';
import { ALERT_SEVERITY_LABEL, ALERT_TYPE_NAME, FOLLOW_UP_TYPE_LABEL, TASK_PRIORITY_LABEL, TASK_STATUS_LABEL } from './labels';
import { trendText } from './overview';
import type {
  AlertsReport,
  AttendanceReport,
  FollowUpsReport,
  GeneralReport,
  GroupsReport,
  YouthReport,
} from './reportTypes';
import { situationDisplay } from './situation';

// Montagem (PURA) dos dados exportados: cada relatório vira um `ExportDoc` neutro (resumo + tabelas já
// formatadas em texto). O CSV e o PDF (lib/reportPdf.ts) são apenas duas formas de desenhar o MESMO documento,
// então os dois nunca divergem. Só entra aqui o que o servidor devolveu (já filtrado por papel/RLS).

export type ReportKind = 'general' | 'attendance' | 'followups' | 'alerts' | 'youth' | 'groups';

export interface ExportTable {
  title: string;
  headers: string[];
  rows: string[][];
  /** Texto exibido quando não há linhas */
  emptyText: string;
  /** Observação abaixo da tabela (ex.: lista cortada pelo servidor) */
  note?: string;
}

export interface ExportDoc {
  kind: ReportKind;
  title: string;
  /** Nome do arquivo sem extensão. Nunca contém dados pessoais. */
  filenameBase: string;
  /** Linhas do cabeçalho (Período, Grupo, Jovem...) */
  meta: { label: string; value: string }[];
  summary: { label: string; value: string }[];
  tables: ExportTable[];
  notes: string[];
}

export interface ExportContext {
  /** Nome do grupo filtrado; null = sem filtro */
  groupName: string | null;
  /** Texto de "sem filtro de grupo" (líder: "Todos os seus grupos") */
  allGroupsLabel?: string;
}

const DASH = '—';
const pct = (v: number | null | undefined): string => (v === null || v === undefined ? DASH : `${Math.round(v)}%`);
const n = (v: number | null | undefined): string => String(v ?? 0);

function periodLabel(p: { from: string; to: string }): string {
  return p.from === p.to ? formatDay(p.from) : `${formatDay(p.from)} a ${formatDay(p.to)}`;
}

function baseName(prefix: string, p: { from: string; to: string }): string {
  return `${prefix}_${p.from}_a_${p.to}`;
}

function groupLabel(ctx: ExportContext): string {
  return ctx.groupName ?? ctx.allGroupsLabel ?? 'Todos os grupos';
}

const EVENT_STATUS: Record<string, string> = { scheduled: 'Agendado', completed: 'Realizado', cancelled: 'Cancelado' };
const ALERT_STATUS: Record<string, string> = { open: 'Aberto', resolved: 'Resolvido', dismissed: 'Dispensado' };
const ATTENDANCE_STATE: Record<string, string> = { present: 'Presente', absent: 'Falta', not_registered: 'Não registrado' };

const label = <T extends string>(map: Record<T, string>, key: string): string =>
  (map as Record<string, string>)[key] ?? key;

function hours(h: number | null | undefined): string {
  if (h === null || h === undefined) return DASH;
  return `${h.toLocaleString('pt-BR', { maximumFractionDigits: 1 })} h`;
}

function truncationNote(shown: number, total: number, what: string): string | undefined {
  return total > shown ? `Mostrando ${shown} de ${total} ${what}. A lista completa está disponível no sistema.` : undefined;
}

// ── Geral ───────────────────────────────────────────────────────────────────
export function buildGeneralDoc(r: GeneralReport, ctx: ExportContext): ExportDoc {
  return {
    kind: 'general',
    title: 'Relatório geral',
    filenameBase: baseName('relatorio-geral', r.period),
    meta: [
      { label: 'Período', value: periodLabel(r.period) },
      { label: 'Grupo', value: groupLabel(ctx) },
    ],
    summary: [
      { label: 'Jovens ativos (agora)', value: n(r.active_youth) },
      { label: 'Encontros realizados', value: n(r.events.held) },
      { label: 'Frequência no período', value: pct(r.attendance.rate) },
      { label: 'Registros de chamada', value: n(r.attendance.registered) },
    ],
    tables: [
      {
        title: 'Frequência e encontros',
        headers: ['Indicador', 'Valor', 'Referência'],
        emptyText: '',
        rows: [
          ['Encontros realizados', n(r.events.held), 'No período'],
          ['Encontros cancelados', n(r.events.cancelled), 'No período'],
          ['Presenças', n(r.attendance.present), 'No período'],
          ['Faltas', n(r.attendance.absent), 'No período'],
          ['Registros de chamada', n(r.attendance.registered), 'No período'],
          ['Frequência', pct(r.attendance.rate), 'No período'],
        ],
      },
      {
        title: 'Alertas',
        headers: ['Indicador', 'Valor', 'Referência'],
        emptyText: '',
        rows: [
          ['Abertos', n(r.alerts.open_now), 'Situação atual'],
          ['Criados', n(r.alerts.created), 'No período'],
          ['Resolvidos', n(r.alerts.resolved), 'No período'],
          ['Dispensados', n(r.alerts.dismissed), 'No período'],
        ],
      },
      {
        title: 'Acompanhamento',
        headers: ['Indicador', 'Valor', 'Referência'],
        emptyText: '',
        rows: [
          ['Acompanhamentos registrados', n(r.follow_ups.total), 'No período'],
          ['Jovens alcançados', n(r.follow_ups.youth_reached), 'No período'],
          ['Ações em aberto', n(r.actions.open_now), 'Situação atual'],
          ['Ações atrasadas', n(r.actions.overdue_now), 'Situação atual'],
          ['Ações criadas', n(r.actions.created), 'No período'],
          ['Ações concluídas', n(r.actions.completed), 'No período'],
        ],
      },
    ],
    notes: ['Frequência = presenças / registros de chamada de jovens ativos. Encontros cancelados e chamadas não registradas não contam.'],
  };
}

// ── Frequência ──────────────────────────────────────────────────────────────
export function buildAttendanceDoc(r: AttendanceReport, ctx: ExportContext): ExportDoc {
  const ab = r.youth_absences;
  return {
    kind: 'attendance',
    title: 'Relatório de frequência',
    filenameBase: baseName('relatorio-frequencia', r.period),
    meta: [
      { label: 'Período', value: periodLabel(r.period) },
      { label: 'Grupo', value: groupLabel(ctx) },
    ],
    summary: [
      { label: 'Frequência', value: pct(r.summary.rate) },
      { label: 'Presenças', value: n(r.summary.present) },
      { label: 'Faltas', value: n(r.summary.absent) },
      { label: 'Encontros (não cancelados)', value: n(r.summary.events) },
      { label: 'Encontros com chamada', value: n(r.summary.events_with_records) },
      { label: 'Encontros cancelados', value: n(r.summary.events_cancelled) },
    ],
    tables: [
      {
        title: 'Frequência por encontro',
        headers: ['Data', 'Encontro', 'Situação', 'Presentes', 'Faltas', 'Registros', 'Frequência'],
        emptyText: 'Nenhum encontro no período.',
        rows: r.by_event.map((e) => [
          formatTimestampSP(e.event_date),
          e.title,
          label(EVENT_STATUS, e.status),
          n(e.present),
          n(e.absent),
          n(e.registered),
          pct(e.rate),
        ]),
      },
      {
        title: 'Frequência por grupo',
        headers: ['Grupo', 'Encontros', 'Presentes', 'Faltas', 'Registros', 'Frequência'],
        emptyText: 'Nenhum registro de chamada por grupo no período.',
        rows: r.by_group.map((g) => [g.name, n(g.events), n(g.present), n(g.absent), n(g.registered), pct(g.rate)]),
      },
      {
        title: `Jovens com ${ab.min_absences} ou mais faltas`,
        headers: ['Jovem', 'Grupo', 'Faltas', 'Registros'],
        emptyText: `Nenhum jovem com ${ab.min_absences} ou mais faltas no período.`,
        rows: ab.items.map((y) => [y.full_name, y.group_name ?? 'Sem grupo', n(y.absences), n(y.registered)]),
        note: truncationNote(ab.items.length, ab.total, 'jovens'),
      },
    ],
    notes: ['Chamadas não registradas não são contadas como falta.'],
  };
}

// ── Acompanhamento ──────────────────────────────────────────────────────────
export function buildFollowUpsDoc(r: FollowUpsReport, ctx: ExportContext): ExportDoc {
  const na = r.next_actions;
  return {
    kind: 'followups',
    title: 'Relatório de acompanhamento',
    filenameBase: baseName('relatorio-acompanhamento', r.period),
    meta: [
      { label: 'Período', value: periodLabel(r.period) },
      { label: 'Grupo', value: groupLabel(ctx) },
    ],
    summary: [
      { label: 'Acompanhamentos no período', value: n(r.total) },
      { label: 'Jovens alcançados', value: n(r.youth_reached) },
      { label: 'Próximas ações pendentes (agora)', value: n(na.pending) },
      { label: 'Próximas ações vencidas (agora)', value: n(na.overdue) },
    ],
    tables: [
      {
        title: 'Por tipo de acompanhamento',
        headers: ['Tipo', 'Quantidade'],
        emptyText: 'Nenhum acompanhamento no período.',
        rows: r.by_type.map((t) => [label(FOLLOW_UP_TYPE_LABEL, t.type), n(t.count)]),
      },
      {
        title: 'Por responsável',
        headers: ['Responsável', 'Quantidade'],
        emptyText: 'Nenhum acompanhamento no período.',
        rows: r.by_responsible.map((x) => [x.name ?? 'Sem responsável', n(x.count)]),
      },
      {
        title: 'Transferências de responsável',
        headers: ['Transferências', 'Acompanhamentos transferidos'],
        emptyText: '',
        rows: [[n(r.transfers.count), n(r.transfers.follow_ups)]],
      },
      {
        title: 'Próximas ações pendentes (situação atual)',
        headers: ['Prazo', 'Jovem', 'Próxima ação', 'Responsável', 'Situação'],
        emptyText: 'Nenhuma próxima ação pendente.',
        rows: na.items.map((i) => [
          formatDay(i.next_action_due),
          i.youth_name,
          i.next_action ?? DASH,
          i.responsible_name ?? DASH,
          i.overdue ? 'Vencida' : 'No prazo',
        ]),
        note: truncationNote(na.items.length, na.pending, 'ações'),
      },
    ],
    notes: ['As próximas ações refletem a situação de hoje e não dependem do período escolhido.'],
  };
}

// ── Alertas ─────────────────────────────────────────────────────────────────
export function buildAlertsDoc(r: AlertsReport, ctx: ExportContext): ExportDoc {
  const row = (name: string, x: { created: number; resolved: number; dismissed: number; open_now: number }) => [
    name,
    n(x.created),
    n(x.resolved),
    n(x.dismissed),
    n(x.open_now),
  ];
  const headers = ['', 'Criados', 'Resolvidos', 'Dispensados', 'Abertos agora'];
  return {
    kind: 'alerts',
    title: 'Relatório de alertas',
    filenameBase: baseName('relatorio-alertas', r.period),
    meta: [
      { label: 'Período', value: periodLabel(r.period) },
      { label: 'Grupo', value: groupLabel(ctx) },
    ],
    summary: [
      { label: 'Abertos agora', value: `${r.open_now.total} (${r.open_now.critical} críticos, ${r.open_now.attention} em atenção)` },
      { label: 'Criados no período', value: `${r.created.total} (${r.created.critical} críticos, ${r.created.attention} em atenção)` },
      { label: 'Resolvidos no período', value: `${r.resolved} (${r.resolved_automatically} automaticamente)` },
      { label: 'Dispensados no período', value: n(r.dismissed) },
      { label: 'Tempo médio até resolver', value: hours(r.avg_resolution_hours) },
    ],
    tables: [
      {
        title: 'Por tipo de alerta',
        headers: ['Tipo', ...headers.slice(1)],
        emptyText: 'Nenhum alerta.',
        rows: r.by_type.map((t) => row(label(ALERT_TYPE_NAME, t.type), t)),
      },
      {
        title: 'Por gravidade',
        headers: ['Gravidade', ...headers.slice(1)],
        emptyText: 'Nenhum alerta.',
        rows: r.by_severity.map((s) => row(label(ALERT_SEVERITY_LABEL, s.severity), s)),
      },
    ],
    notes: ['"Abertos agora" mostra a situação de hoje e não depende do período escolhido.'],
  };
}

// ── Individual ──────────────────────────────────────────────────────────────
export function buildYouthDoc(r: YouthReport): ExportDoc {
  const s = r.situation;
  const sit = situationDisplay({ situation: s.situation, inactive: s.inactive });
  const fu = r.follow_ups;
  const ac = r.actions;
  const al = r.alerts;
  return {
    kind: 'youth',
    title: 'Relatório individual',
    // sem nome do jovem no nome do arquivo
    filenameBase: baseName('relatorio-individual', r.period),
    meta: [
      { label: 'Jovem', value: r.youth.full_name },
      { label: 'Grupo', value: r.youth.group_name ?? 'Sem grupo' },
      { label: 'Líder', value: r.youth.leader_name ?? DASH },
      { label: 'Período', value: periodLabel(r.period) },
    ],
    summary: [
      { label: 'Situação atual', value: sit.label },
      { label: 'Frequência no período', value: pct(r.attendance.rate) },
      { label: 'Presenças / faltas', value: `${r.attendance.present} / ${r.attendance.absent}` },
      { label: 'Faltas seguidas (agora)', value: n(s.consecutive_absences) },
      { label: 'Ações em aberto / atrasadas', value: `${s.open_actions} / ${s.overdue_actions}` },
      { label: 'Último acompanhamento', value: formatDay(s.last_follow_up) },
    ],
    tables: [
      {
        title: 'Motivos da situação atual',
        headers: ['Motivo'],
        emptyText: s.inactive ? 'Jovem inativo: situação não avaliada.' : 'Nenhum sinal de atenção.',
        rows: s.reasons.map((x) => [x]),
      },
      {
        title: 'Presença nos encontros',
        headers: ['Data', 'Encontro', 'Presença'],
        emptyText: 'Nenhum encontro no período.',
        rows: r.attendance.events.map((e) => [formatTimestampSP(e.event_date), e.title, label(ATTENDANCE_STATE, e.state)]),
        note: r.attendance.not_registered > 0
          ? `${r.attendance.not_registered} encontro(s) sem chamada registrada: não contam como falta.`
          : undefined,
      },
      {
        title: 'Acompanhamentos',
        headers: ['Data', 'Tipo', 'Motivo', 'Próxima ação', 'Prazo', 'Responsável'],
        emptyText: 'Nenhum acompanhamento no período.',
        rows: fu.items.map((f) => [
          formatDay(f.occurred_at),
          label(FOLLOW_UP_TYPE_LABEL, f.type),
          f.reason ?? DASH,
          f.next_action ?? DASH,
          formatDay(f.next_action_due),
          f.responsible_name ?? DASH,
        ]),
        note: truncationNote(fu.items.length, fu.total, 'acompanhamentos'),
      },
      {
        title: 'Ações',
        headers: ['Ação', 'Situação', 'Prioridade', 'Prazo', 'Concluída em'],
        emptyText: 'Nenhuma ação.',
        rows: ac.items.map((a) => [
          a.title,
          a.overdue ? `${label(TASK_STATUS_LABEL, a.status)} (atrasada)` : label(TASK_STATUS_LABEL, a.status),
          label(TASK_PRIORITY_LABEL, a.priority),
          formatDay(a.due_date),
          a.completed_at ? formatTimestampSP(a.completed_at) : DASH,
        ]),
        note: truncationNote(ac.items.length, ac.total, 'ações'),
      },
      {
        title: 'Alertas',
        headers: ['Tipo', 'Gravidade', 'Situação', 'Criado em', 'Encerrado em'],
        emptyText: 'Nenhum alerta.',
        rows: al.items.map((a) => [
          label(ALERT_TYPE_NAME, a.type),
          label(ALERT_SEVERITY_LABEL, a.severity),
          label(ALERT_STATUS, a.status),
          formatTimestampSP(a.created_at),
          a.resolved_at ? formatTimestampSP(a.resolved_at) : DASH,
        ]),
        note: truncationNote(al.items.length, al.total, 'alertas'),
      },
    ],
    notes: [
      'Documento com dados pessoais de jovem (possivelmente menor de idade): use apenas para o cuidado pastoral e não compartilhe.',
    ],
  };
}

// ── Grupos ──────────────────────────────────────────────────────────────────
export function buildGroupsDoc(r: GroupsReport, ctx: ExportContext): ExportDoc {
  const totalYouth = r.groups.reduce((acc, g) => acc + g.active_youth, 0);
  return {
    kind: 'groups',
    title: 'Relatório de grupos',
    filenameBase: baseName('relatorio-grupos', r.period),
    meta: [
      { label: 'Período', value: periodLabel(r.period) },
      { label: 'Grupos', value: groupLabel({ groupName: null, allGroupsLabel: ctx.allGroupsLabel }) },
    ],
    summary: [
      { label: 'Grupos', value: n(r.groups.length) },
      { label: 'Jovens ativos nos grupos', value: n(totalYouth) },
    ],
    tables: [
      {
        title: 'Situação atual dos grupos',
        headers: ['Grupo', 'Líder', 'Jovens ativos', 'Frequência (últimos 8 encontros)', 'Tendência', 'Jovens em atenção', 'Ações atrasadas'],
        emptyText: 'Nenhum grupo.',
        rows: r.groups.map((g) => [
          g.name,
          g.leader_name ?? DASH,
          n(g.active_youth),
          pct(g.attendance_rate),
          trendText(g.trend, g.trend_delta),
          n(g.youth_in_attention),
          n(g.overdue_actions),
        ]),
      },
      {
        title: 'Movimento no período',
        headers: ['Grupo', 'Encontros realizados', 'Registros', 'Frequência', 'Acompanhamentos', 'Alertas criados', 'Ações concluídas'],
        emptyText: 'Nenhum grupo.',
        rows: r.groups.map((g) => [
          g.name,
          n(g.period.events_held),
          n(g.period.registered),
          pct(g.period.rate),
          n(g.period.follow_ups),
          n(g.period.alerts_created),
          n(g.period.actions_completed),
        ]),
      },
    ],
    notes: [
      'Grupos em ordem alfabética (não é uma classificação). Tendência: compara os 4 encontros mais recentes com os 4 anteriores; exige 8 encontros com chamada.',
    ],
  };
}

// ── Saída ───────────────────────────────────────────────────────────────────

/** Texto do carimbo "Gerado em", no fuso do produto. */
export function generatedAtLabel(at: Date): string {
  return formatTimestampSP(at.toISOString());
}

/** CSV do documento (seções separadas por linha em branco). Mesmo padrão do lib/csv: ';' e células neutralizadas. */
export function docToCsv(doc: ExportDoc, generatedAt: Date): string {
  const blocks: string[] = [];
  const put = (headers: string[], rows: CsvValue[][]) => blocks.push(toCsv(headers, rows));

  put(['ConectJovem', doc.title], [...doc.meta.map((m): CsvValue[] => [m.label, m.value]), ['Gerado em', generatedAtLabel(generatedAt)]]);
  if (doc.summary.length) put(['Resumo', ''], doc.summary.map((s): CsvValue[] => [s.label, s.value]));
  for (const t of doc.tables) {
    const lines: CsvValue[][] = t.rows.length ? t.rows : t.emptyText ? [[t.emptyText]] : [];
    if (t.note) lines.push([t.note]);
    blocks.push([toCsv([t.title], []), toCsv(t.headers, lines)].join('\r\n'));
  }
  if (doc.notes.length) blocks.push(toCsv(['Observações'], doc.notes.map((x): CsvValue[] => [x])));
  return blocks.join('\r\n\r\n');
}

/**
 * Pontuação fora do Latin-1 que a fonte padrão do PDF (Helvetica, codificação WinAnsi/Windows-1252) desenha:
 * aspas curvas, travessões, reticências, marcador, euro e marca registrada (conferido em lib/reportPdf.test.ts).
 */
const WIN_ANSI_EXTRAS = new Set(
  ['\u2018', '\u2019', '\u201A', '\u201C', '\u201D', '\u201E', '\u2013', '\u2014', '\u2022', '\u2026', '\u20AC', '\u2122'],
);

/** O que a fonte não desenha, mas tem equivalente simples em ASCII. */
const PDF_REPLACEMENTS: Record<string, string> = {
  '\u2212': '-', '\u2192': '->', '\u2190': '<-', '\u2191': '^', '\u2193': 'v', '\u200B': '',
};

/**
 * Texto seguro para a fonte padrão do PDF: mantém TODOS os acentos do português (Latin-1) e a pontuação
 * tipográfica comum; o resto vira equivalente simples (letra sem acento, ASCII) ou "?", sem lançar erro.
 */
export function toPdfText(text: string): string {
  let out = '';
  for (const ch of text.normalize('NFC')) {
    const code = ch.codePointAt(0) ?? 0;
    if (code === 9 || code === 10 || (code >= 32 && code <= 126) || (code >= 160 && code <= 255) || WIN_ANSI_EXTRAS.has(ch)) {
      out += ch;
    } else if (PDF_REPLACEMENTS[ch] !== undefined) {
      out += PDF_REPLACEMENTS[ch];
    } else {
      // tenta o caractere base sem acento (ex.: ő -> o); marcas combinantes soltas e controles são descartados
      const base = ch.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      const c = base.codePointAt(0) ?? 0;
      if (base && c >= 32 && c <= 126) out += base;
      else if (code < 32 || (code >= 0x300 && code <= 0x36f) || code === 0xfe0f || code === 0x200d) out += '';
      else out += '?';
    }
  }
  return out;
}

/** Chave estável de uma linha de encontro; `event_id` pode ser null (encontro de outro grupo): usa posição e data. */
export function eventRowKey(e: { event_id: string | null; event_date: string }, index: number): string {
  return e.event_id ?? `outro-${index}-${e.event_date}`;
}
