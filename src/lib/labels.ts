import type {
  ActivityAction,
  Alert,
  AlertSeverity,
  AlertType,
  CommunicationStatus,
  FailureReason,
  FollowUpType,
  RecipientKind,
  TaskPriority,
  TaskStatus,
} from '../types/database.types';

export const ALERT_SEVERITY_LABEL: Record<AlertSeverity, string> = {
  attention: 'Atenção',
  critical: 'Crítico',
};

/** Nome curto do tipo de alerta (filtros e títulos) */
export const ALERT_TYPE_NAME: Record<AlertType, string> = {
  consecutive_absences: 'Faltas seguidas',
  low_attendance: 'Frequência baixa',
  attendance_drop: 'Frequência em queda',
  no_followup: 'Sem acompanhamento',
  overdue_action: 'Ação atrasada',
};

/** Ordem de exibição dos tipos nos filtros */
export const ALERT_TYPES: AlertType[] = [
  'consecutive_absences',
  'low_attendance',
  'attendance_drop',
  'no_followup',
  'overdue_action',
];

/** Rótulo curto de um alerta, ex.: "3 faltas seguidas", "Frequência baixa", "Frequência em queda" */
export function alertTypeLabel(type: AlertType, consecutiveAbsences?: number | null): string {
  if (type === 'consecutive_absences') {
    const n = consecutiveAbsences ?? 0;
    return n > 0 ? `${n} ${n === 1 ? 'falta seguida' : 'faltas seguidas'}` : ALERT_TYPE_NAME.consecutive_absences;
  }
  return ALERT_TYPE_NAME[type] ?? 'Alerta';
}

type AlertMetrics = Pick<Alert, 'type' | 'consecutive_absences' | 'attendance_rate' | 'previous_rate' | 'sample_size'>;

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * Descrição objetiva de um alerta, só com os números que o banco calculou:
 * "3 faltas seguidas", "Frequência 40% nos últimos 8 encontros", "Sem acompanhamento há 9 dias",
 * "2 ações atrasadas". Faltando a métrica, cai no rótulo curto (nunca inventa número).
 */
export function alertDescription(a: AlertMetrics): string {
  switch (a.type) {
    case 'consecutive_absences':
      return alertTypeLabel(a.type, a.consecutive_absences);
    case 'low_attendance':
      if (a.attendance_rate === null || a.attendance_rate === undefined) return ALERT_TYPE_NAME.low_attendance;
      return a.sample_size
        ? `Frequência ${a.attendance_rate}% nos últimos ${a.sample_size} encontros`
        : `Frequência ${a.attendance_rate}%`;
    case 'attendance_drop':
      if (a.attendance_rate === null || a.attendance_rate === undefined || a.previous_rate === null || a.previous_rate === undefined) {
        return ALERT_TYPE_NAME.attendance_drop;
      }
      return `Frequência caiu de ${a.previous_rate}% para ${a.attendance_rate}% (últimos 4 encontros)`;
    case 'no_followup':
      return a.sample_size !== null && a.sample_size !== undefined
        ? `Sem acompanhamento há ${plural(a.sample_size, 'dia', 'dias')}`
        : ALERT_TYPE_NAME.no_followup;
    case 'overdue_action':
      return a.sample_size
        ? plural(a.sample_size, 'ação atrasada', 'ações atrasadas')
        : ALERT_TYPE_NAME.overdue_action;
    default:
      return 'Alerta';
  }
}

export const TASK_STATUS_LABEL: Record<TaskStatus, string> = {
  pending: 'Pendente',
  in_progress: 'Em andamento',
  done: 'Concluída',
  cancelled: 'Cancelada',
};

export const TASK_PRIORITY_LABEL: Record<TaskPriority, string> = {
  low: 'Baixa',
  medium: 'Média',
  high: 'Alta',
};

export const FOLLOW_UP_TYPE_LABEL: Record<FollowUpType, string> = {
  conversation: 'Conversa',
  call: 'Ligação',
  in_person: 'Encontro presencial',
  guidance: 'Orientação',
  return: 'Retorno',
  other: 'Outro',
};

/** Ordem dos tipos no formulário de acompanhamento */
export const FOLLOW_UP_TYPES: FollowUpType[] = ['conversation', 'call', 'in_person', 'guidance', 'return', 'other'];

/** Rótulos do histórico operacional (os 11 tipos de ação gravados pelo banco) */
export const ACTIVITY_ACTION_LABEL: Record<ActivityAction, string> = {
  attendance_recorded: 'Chamada registrada',
  follow_up_created: 'Acompanhamento registrado',
  follow_up_transferred: 'Acompanhamento transferido',
  task_created: 'Ação criada',
  task_completed: 'Ação concluída',
  alert_resolved: 'Alerta resolvido',
  alert_dismissed: 'Alerta dispensado',
  youth_group_changed: 'Grupo do jovem alterado',
  youth_activated: 'Jovem reativado',
  youth_deactivated: 'Jovem inativado',
  event_series_created: 'Série de encontros criada',
  communication_sent: 'E-mail enviado',
};

/** Ordem dos tipos no filtro do histórico */
export const ACTIVITY_ACTIONS: ActivityAction[] = [
  'attendance_recorded',
  'follow_up_created',
  'follow_up_transferred',
  'task_created',
  'task_completed',
  'alert_resolved',
  'alert_dismissed',
  'youth_group_changed',
  'youth_activated',
  'youth_deactivated',
  'event_series_created',
  'communication_sent',
];

// ── Comunicações por e-mail ──────────────────────────────────────────────────

export const COMMUNICATION_STATUS_LABEL: Record<CommunicationStatus, string> = {
  draft: 'Rascunho',
  sending: 'Enviando',
  sent: 'Enviado',
  failed: 'Falhou',
  cancelled: 'Cancelada',
};

export const RECIPIENT_KIND_LABEL: Record<RecipientKind, string> = {
  youth: 'Jovem',
  guardian: 'Responsável',
  leader: 'Líder',
  coordinator: 'Coordenador',
  other: 'Outro',
};

/** Ordem dos tipos de destinatário no formulário */
export const RECIPIENT_KINDS: RecipientKind[] = ['youth', 'guardian', 'leader', 'coordinator', 'other'];

/** Motivo da falha do envio (o servidor devolve só estes códigos; nunca texto do provedor) */
export const FAILURE_REASON_LABEL: Record<FailureReason, string> = {
  provider_not_configured: 'O envio de e-mail ainda não está configurado no servidor. Fale com o administrador.',
  provider_rejected: 'O serviço de e-mail recusou o envio. Confira os dados e tente novamente mais tarde.',
  invalid_address: 'O endereço de e-mail do destinatário parece estar incorreto. Corrija-o e tente novamente.',
  network: 'Houve um problema de conexão durante o envio. Tente novamente.',
  timeout: 'O servidor demorou demais para responder. Tente novamente em instantes.',
  unknown: 'Não foi possível enviar o e-mail. Tente novamente.',
};

export const FAILURE_REASONS: FailureReason[] = [
  'provider_not_configured', 'provider_rejected', 'invalid_address', 'network', 'timeout', 'unknown',
];

/** Mensagem do motivo; código desconhecido (registro antigo ou banco mais novo que o app) cai no genérico */
export function failureReasonLabel(reason: string | null | undefined): string {
  return (FAILURE_REASON_LABEL as Record<string, string>)[reason ?? ''] ?? FAILURE_REASON_LABEL.unknown;
}

/** Erros da requisição de envio (resposta com `{ error }`), em pt-BR */
export const SEND_ERROR_MESSAGE = {
  invalid_request: 'Pedido de envio inválido. Atualize a página e tente novamente.',
  unauthorized: 'Sua sessão expirou. Entre novamente.',
  not_found: 'Comunicação não encontrada ou sem permissão.',
  already_sent_or_in_progress: 'Este e-mail já foi enviado ou está sendo enviado. Veja o status no histórico.',
  already_sent: 'Este e-mail já foi enviado ou está sendo enviado. Veja o status no histórico.',
  in_progress: 'Este e-mail já foi enviado ou está sendo enviado. Veja o status no histórico.',
  not_sendable: 'Este e-mail não pode ser enviado agora.',
  invalid_communication: 'Esta comunicação não pode ser enviada. Confira o destinatário, o assunto e a mensagem.',
  invalid_content: 'O conteúdo do e-mail não é válido. Confira o destinatário, o assunto e a mensagem.',
  invalid_recipient: 'O destinatário não é permitido para o seu perfil.',
  rate_limited_hour: 'Limite de envios por hora atingido.',
  rate_limited_day: 'Limite de envios por dia atingido.',
  rate_limited: 'Muitos envios em pouco tempo. Aguarde um instante e tente novamente.',
  unknown: 'Não foi possível enviar o e-mail agora. Veja o status no histórico antes de tentar de novo.',
} as const;

export const SEND_UNCONFIRMED_MESSAGE = 'Não foi possível confirmar o envio. Veja o status no histórico.';

export const SEND_IN_PROGRESS_MESSAGE = 'O e-mail está sendo enviado. Acompanhe o status no histórico.';

/** Rótulo de uma ação do histórico; tipo desconhecido (banco mais novo que o app) não quebra a tela */
export function activityActionLabel(action: string): string {
  return (ACTIVITY_ACTION_LABEL as Record<string, string>)[action] ?? 'Atividade';
}

/** Título sugerido para uma nova ação criada a partir de um alerta */
export function suggestedTaskTitle(type: AlertType, youthName: string, consecutiveAbsences?: number | null): string {
  switch (type) {
    case 'low_attendance':
    case 'attendance_drop':
      return `Conversar com ${youthName} sobre a frequência`;
    case 'no_followup':
      return `Acompanhar ${youthName}`;
    case 'overdue_action':
      return `Resolver ações atrasadas de ${youthName}`;
    default:
      return `Contatar ${youthName} (${consecutiveAbsences ?? 0} faltas)`;
  }
}
