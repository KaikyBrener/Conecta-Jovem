import type { AlertType, Communication, FailureReason, RecipientKind } from '../types/database.types';
import { FAILURE_REASONS, SEND_ERROR_MESSAGE } from './labels';

// Lógica PURA das comunicações por e-mail (modelos, validação e interpretação da resposta do envio). O envio em si
// é feito pelo servidor (Edge Function `send-communication`, ver useCommunications). Nada aqui toca em rede, Supabase
// ou segredos. As validações espelham, em espírito, as do banco (migration 015: is_valid_email, is_single_line_text e
// os CHECKs de tamanho); o banco continua sendo a barreira real.

export const SUBJECT_MAX = 200;
export const BODY_MAX = 5000;
export const RECIPIENT_NAME_MAX = 120;
export const EMAIL_MAX = 254;

// ── Texto ─────────────────────────────────────────────────────────────────────

/** Caracteres de controle que não podem aparecer em texto de UMA linha (CR, LF, TAB, DEL, C1, U+2028/2029). */
// eslint-disable-next-line no-control-regex -- os controles são justamente o que se quer detectar
const LINE_BREAKING_OR_CONTROL = /[\u0000-\u001f\u007f\u0080-\u009f\u2028\u2029]/;
// eslint-disable-next-line no-control-regex -- os controles são justamente o que se quer detectar
const LINE_BREAKING_OR_CONTROL_G = /[\u0000-\u001f\u007f\u0080-\u009f\u2028\u2029]/g;
/** Controles proibidos no corpo (as quebras de linha \n, \r e o TAB são permitidos) */
// eslint-disable-next-line no-control-regex -- os controles são justamente o que se quer detectar
const BODY_CONTROL_G = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

/** Tamanho em caracteres (pontos de código), como o `length()` do Postgres — um emoji conta 1. */
export function textLength(text: string): number {
  return Array.from(text).length;
}

/** O texto cabe numa linha só (sem CR, LF, TAB nem outros controles)? */
export function isSingleLineText(text: string): boolean {
  return !LINE_BREAKING_OR_CONTROL.test(text);
}

/** Troca quebras de linha e controles por espaço, junta espaços repetidos e apara. */
export function toSingleLine(text: string): string {
  return text.replace(LINE_BREAKING_OR_CONTROL_G, ' ').replace(/ {2,}/g, ' ').trim();
}

/** Normaliza o corpo: quebras viram \n e controles proibidos são removidos. */
export function normalizeBody(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(BODY_CONTROL_G, '');
}

// ── E-mail ────────────────────────────────────────────────────────────────────

// Mesma expressão do banco: local-part de 1..64 caracteres seguros, domínio com rótulos de 1..63 e TLD alfabético
// de 2..24. Sem aspas, espaços, `<>,;:?&=/` etc. (que atrapalham cabeçalhos de e-mail). Tudo limitado por tamanho
// e sem quantificadores aninhados sobre o mesmo conjunto (sem ReDoS). Em JavaScript `$` (sem a flag `m`) só casa no
// fim do texto, então "a@b.com\n" é rejeitado.
const EMAIL_RE = /^[A-Za-z0-9._+-]{1,64}@([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,24}$/;

/** Apara só espaços (como o `btrim` do banco) e põe em minúsculas. Não remove CR/LF: e-mail com quebra é inválido. */
export function normalizeEmail(email: string): string {
  return email.replace(/^ +| +$/g, '').toLowerCase();
}

/** E-mail "razoável" e seguro: uma linha, até 254 caracteres, sem '..' e sem ponto colado ao '@' ou no começo. */
export function isValidEmail(email: string): boolean {
  const e = email.replace(/^ +| +$/g, '');
  return e.length <= EMAIL_MAX && EMAIL_RE.test(e) && !/\.\./.test(e) && !/^\.|\.@/.test(e);
}

// ── Validação do formulário ───────────────────────────────────────────────────

export interface CommunicationFormValues {
  recipientEmail: string;
  recipientName: string;
  subject: string;
  body: string;
}

/** Valida destinatário (passo 1). Devolve a primeira mensagem em pt-BR ou null. */
export function validateRecipient(email: string, name: string): string | null {
  if (!email.trim()) return 'Informe o e-mail do destinatário.';
  if (!isValidEmail(email)) return 'Informe um e-mail válido, por exemplo nome@exemplo.com.';
  const n = name.trim();
  if (n && !isSingleLineText(n)) return 'O nome do destinatário não pode ter quebras de linha.';
  if (textLength(n) > RECIPIENT_NAME_MAX) return `O nome do destinatário pode ter até ${RECIPIENT_NAME_MAX} caracteres.`;
  return null;
}

/** Valida assunto e mensagem (passo 2). Devolve a primeira mensagem em pt-BR ou null. */
export function validateMessage(subject: string, body: string): string | null {
  const s = subject.trim();
  if (!s) return 'Informe o assunto.';
  if (!isSingleLineText(s)) return 'O assunto não pode ter quebras de linha.';
  if (textLength(s) > SUBJECT_MAX) return `O assunto pode ter até ${SUBJECT_MAX} caracteres.`;
  if (!normalizeBody(body).trim()) return 'Escreva a mensagem.';
  if (textLength(normalizeBody(body)) > BODY_MAX) return `A mensagem pode ter até ${BODY_MAX} caracteres.`;
  return null;
}

/** Valida tudo antes de salvar/abrir o e-mail. */
export function validateCommunicationForm(v: CommunicationFormValues): string | null {
  return validateRecipient(v.recipientEmail, v.recipientName) ?? validateMessage(v.subject, v.body);
}

/** Valores prontos para gravar: e-mail em minúsculas, nome vazio -> null, assunto numa linha, corpo normalizado. */
export function toDraftPayload(v: CommunicationFormValues): {
  recipient_email: string;
  recipient_name: string | null;
  subject: string;
  body: string;
} {
  return {
    recipient_email: normalizeEmail(v.recipientEmail),
    recipient_name: v.recipientName.trim() || null,
    subject: v.subject.trim(),
    body: normalizeBody(v.body),
  };
}

// ── Envio (resposta da Edge Function send-communication) ────────────────────────

/** Códigos de erro da REQUISIÇÃO de envio (`{ error }`); qualquer outro vira 'unknown' */
export type SendErrorCode =
  | 'invalid_request'
  | 'unauthorized'
  | 'not_found'
  | 'already_sent_or_in_progress'
  | 'already_sent'
  | 'in_progress'
  | 'not_sendable'
  | 'invalid_communication'
  | 'invalid_content'
  | 'rate_limited'
  | 'unknown';

/** O que a resposta do servidor diz, antes de olhar o estado real no banco */
export type SendOutcome =
  | { kind: 'sent'; sentAt: string | null }
  | { kind: 'failed'; reason: FailureReason }
  | { kind: 'rejected'; code: SendErrorCode; field?: string; window?: 'hour' | 'day'; retryAfterSeconds?: number }
  /** Sem resposta utilizável (rede, relay): não sabemos se o e-mail saiu */
  | { kind: 'unconfirmed' };

/** O que a tela mostra depois de tentar enviar (estado REAL do banco quando disponível) */
export type SendView =
  | { kind: 'sent'; sentAt: string | null }
  | { kind: 'failed'; reason: FailureReason }
  | { kind: 'in_progress' }
  | { kind: 'unconfirmed' }
  | { kind: 'rejected'; message: string };

const SEND_ERROR_CODES: SendErrorCode[] = [
  'invalid_request', 'unauthorized', 'not_found', 'already_sent_or_in_progress', 'already_sent', 'in_progress', 'not_sendable', 'invalid_communication', 'invalid_content', 'rate_limited',
];

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** Corpo que pode ter chegado como texto (sem content-type JSON): tenta interpretar, sem lançar. */
function asJsonBody(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'string') {
    try { return asRecord(JSON.parse(value)); } catch { return null; }
  }
  return asRecord(value);
}

/** Motivo de falha conhecido; qualquer outro valor (incluindo registros antigos) vira 'unknown'. */
export function toFailureReason(value: unknown): FailureReason {
  return FAILURE_REASONS.find((r) => r === value) ?? 'unknown';
}

/** Interpreta a resposta HTTP 200 da função: `{status:'sent'}` ou `{status:'failed', failure_reason}`. */
export function parseSendResponse(data: unknown): SendOutcome {
  const body = asJsonBody(data);
  if (body?.status === 'sent') return { kind: 'sent', sentAt: typeof body.sent_at === 'string' ? body.sent_at : null };
  if (body?.status === 'failed') return { kind: 'failed', reason: toFailureReason(body.failure_reason) };
  return { kind: 'unconfirmed' };
}

/** Interpreta uma resposta de erro HTTP da função (`{ error: '<code>' }`). Sem código conhecido: genérico. */
export function parseSendError(status: number | null, data: unknown): SendOutcome {
  const raw = asJsonBody(data)?.error;
  const code = SEND_ERROR_CODES.find((c) => c === raw);
  if (code) {
    const b = asJsonBody(data);
    const out: Extract<SendOutcome, { kind: 'rejected' }> = { kind: 'rejected', code };
    if (code === 'invalid_content' && typeof b?.field === 'string') out.field = b.field;
    if (code === 'rate_limited') {
      if (b?.window === 'hour' || b?.window === 'day') out.window = b.window;
      if (typeof b?.retry_after_seconds === 'number' && b.retry_after_seconds > 0) out.retryAfterSeconds = b.retry_after_seconds;
    }
    return out;
  }
  if (status === 401) return { kind: 'rejected', code: 'unauthorized' };
  if (status === 429) return { kind: 'rejected', code: 'rate_limited' };
  return { kind: 'rejected', code: 'unknown' };
}

/** Tempo de espera legível ("5 minutos"); arredonda para cima, sem inventar precisão. */
function waitText(seconds: number): string {
  if (seconds < 90) return 'alguns instantes';
  const min = Math.ceil(seconds / 60);
  if (min < 60) return `${min} minutos`;
  const h = Math.ceil(min / 60);
  return h === 1 ? '1 hora' : `${h} horas`;
}

/** Mensagem pt-BR de uma recusa da requisição de envio (campo/janela/espera quando o servidor informa). */
export function sendRejectedMessage(o: Extract<SendOutcome, { kind: 'rejected' }>): string {
  if (o.code === 'invalid_content' && o.field === 'recipient') return SEND_ERROR_MESSAGE.invalid_recipient;
  if (o.code === 'rate_limited' && o.window) {
    const base = o.window === 'hour' ? SEND_ERROR_MESSAGE.rate_limited_hour : SEND_ERROR_MESSAGE.rate_limited_day;
    return o.retryAfterSeconds ? `${base} Tente novamente em ${waitText(o.retryAfterSeconds)}.` : base;
  }
  return SEND_ERROR_MESSAGE[o.code];
}

/**
 * Decide o que mostrar. O estado do banco (relido depois da chamada) manda: o e-mail pode ter saído mesmo quando a
 * resposta se perdeu, ou já estar em andamento. Sem a linha, vale a resposta do servidor.
 */
export function resolveSendView(
  outcome: SendOutcome,
  row: Pick<Communication, 'status' | 'failure_reason' | 'sent_at'> | null,
): SendView {
  if (row?.status === 'sent') return { kind: 'sent', sentAt: row.sent_at };
  // Recusa do servidor (429, 422, 404...) numa linha que não está enviada nem em envio: a recusa é o que importa,
  // não o motivo antigo da falha anterior
  if (outcome.kind === 'rejected') return { kind: 'rejected', message: sendRejectedMessage(outcome) };
  if (row?.status === 'failed') return { kind: 'failed', reason: toFailureReason(row.failure_reason) };
  if (row?.status === 'sending') return { kind: 'in_progress' };
  switch (outcome.kind) {
    case 'sent': return { kind: 'sent', sentAt: outcome.sentAt };
    case 'failed': return { kind: 'failed', reason: outcome.reason };
    case 'unconfirmed': return { kind: 'unconfirmed' };
  }
}

/** Um envio preso em `sending` por mais que isto é tratado como sem resposta (o servidor retoma ao reenviar) */
export const SENDING_STUCK_MS = 5 * 60 * 1000;

/**
 * Está em `sending` há mais de 5 minutos? Usa a última tentativa (ou, na falta, a última atualização).
 * Data ausente/inválida nunca conta como travado.
 */
export function isStuckSending(
  row: Pick<Communication, 'status' | 'last_attempt_at' | 'updated_at'>,
  now: number | Date,
): boolean {
  if (row.status !== 'sending') return false;
  const since = Date.parse(row.last_attempt_at ?? row.updated_at);
  const nowMs = typeof now === 'number' ? now : now.getTime();
  return Number.isFinite(since) && Number.isFinite(nowMs) && nowMs - since > SENDING_STUCK_MS;
}

// ── Modelos de mensagem ───────────────────────────────────────────────────────

export type TemplateId =
  | 'consecutive_absences'
  | 'low_attendance'
  | 'attendance_drop'
  | 'return_after_follow_up'
  | 'free';

export const TEMPLATE_IDS: TemplateId[] = [
  'consecutive_absences',
  'low_attendance',
  'attendance_drop',
  'return_after_follow_up',
  'free',
];

export const TEMPLATE_LABEL: Record<TemplateId, string> = {
  consecutive_absences: 'Faltas seguidas',
  low_attendance: 'Frequência baixa',
  attendance_drop: 'Queda de frequência',
  return_after_follow_up: 'Retorno após acompanhamento',
  free: 'Mensagem livre',
};

/** Modelo sugerido para um alerta; os tipos sem modelo próprio (sem acompanhamento, ação atrasada) usam o livre. */
export function templateForAlert(type: AlertType | null | undefined): TemplateId {
  switch (type) {
    case 'consecutive_absences': return 'consecutive_absences';
    case 'low_attendance': return 'low_attendance';
    case 'attendance_drop': return 'attendance_drop';
    default: return 'free';
  }
}

interface TemplateText {
  subject: string;
  /** Para o próprio jovem */
  direct: string;
  /** Para responsável, líder, coordenador ou outro: fala SOBRE o jovem, em terceira pessoa */
  about: string;
}

const SIGNATURE = '\n\nUm abraço,\n{remetente}\n{grupo}';

// Tom acolhedor, sem cobrança, sem diagnóstico e SEM números de frequência (nem do jovem nem de ninguém).
// Só usam as variáveis {nome}, {grupo} e {remetente}.
const TEMPLATES: Record<TemplateId, TemplateText> = {
  consecutive_absences: {
    subject: 'Sentimos sua falta, {nome}',
    direct:
      'Olá, {nome}!\n\n' +
      'Tudo bem? Percebemos que você não tem conseguido estar com a gente nos últimos encontros e queremos que saiba que sentimos a sua falta.\n\n' +
      'Se estiver acontecendo alguma coisa ou se precisar de ajuda, pode contar conosco. Será um prazer conversar com você, sem pressa e sem cobrança.\n\n' +
      'Se quiser, responda este e-mail ou nos procure no próximo encontro.' + SIGNATURE,
    about:
      'Olá!\n\nAqui é {remetente}, escrevendo em nome do ministério jovem. ' +
      'Estamos entrando em contato a respeito de {nome}, que não tem conseguido participar dos últimos encontros. ' +
      'Sentimos a falta da presença e gostaríamos de saber se está tudo bem e se há algo em que possamos ajudar.\n\n' +
      'Ficamos à disposição para conversar com calma, quando for melhor para você.' + SIGNATURE,
  },
  low_attendance: {
    subject: 'Um convite para estar mais perto, {nome}',
    direct:
      'Olá, {nome}!\n\n' +
      'Passando para dizer que é muito bom ter você com a gente e que gostaríamos de te ver com mais frequência nos nossos encontros. Cada presença faz diferença para o grupo.\n\n' +
      'Se algo estiver dificultando a sua participação (horário, transporte, rotina...), conte para nós. Podemos pensar juntos em uma solução.' + SIGNATURE,
    about:
      'Olá!\n\nAqui é {remetente}, escrevendo em nome do ministério jovem. ' +
      'Queremos compartilhar o carinho que temos por {nome} e o desejo de ter {nome} por perto com mais frequência nos nossos encontros.\n\n' +
      'Se houver algo que esteja dificultando a participação (horário, transporte, rotina...), adoraríamos saber para ajudar no que for possível.' + SIGNATURE,
  },
  attendance_drop: {
    subject: 'Como você está, {nome}?',
    direct:
      'Olá, {nome}!\n\n' +
      'Notamos que, nas últimas semanas, você tem aparecido menos nos encontros, e queremos saber como você está. Não é uma cobrança: é cuidado.\n\n' +
      'Se quiser conversar, estamos por aqui. Pode responder este e-mail quando se sentir à vontade.' + SIGNATURE,
    about:
      'Olá!\n\nAqui é {remetente}, escrevendo em nome do ministério jovem. ' +
      'Temos notado {nome} um pouco mais distante dos encontros nas últimas semanas e gostaríamos de saber como as coisas estão. ' +
      'Nosso interesse é apenas cuidar e ajudar no que for preciso.\n\n' +
      'Ficamos à disposição para conversar.' + SIGNATURE,
  },
  return_after_follow_up: {
    subject: 'Obrigado pela conversa, {nome}',
    direct:
      'Olá, {nome}!\n\n' +
      'Foi muito bom conversar com você. Passando para reforçar que estamos à disposição e para lembrar dos próximos passos que combinamos.\n\n' +
      'Quando puder, conte como as coisas estão indo. A sua presença é sempre bem-vinda.' + SIGNATURE,
    about:
      'Olá!\n\nAqui é {remetente}, escrevendo em nome do ministério jovem. ' +
      'Estou dando um retorno depois do contato que tivemos a respeito de {nome}. Agradecemos a atenção e continuamos à disposição para ajudar no que for preciso.' +
      SIGNATURE,
  },
  free: {
    subject: 'Mensagem do ministério jovem',
    direct: 'Olá, {nome}!\n\n\n\nUm abraço,\n{remetente}\n{grupo}',
    about: 'Olá!\n\nAqui é {remetente}, escrevendo em nome do ministério jovem, a respeito de {nome}.\n\n\n\nUm abraço,\n{remetente}\n{grupo}',
  },
};

export interface TemplateVars {
  nome: string;
  grupo?: string | null;
  remetente?: string | null;
}

const VAR_MAX = 120;

/** Valor de variável seguro: UMA linha (sem CR/LF/controles), aparado e com tamanho limitado. */
function cleanVar(value: string | null | undefined, fallback: string): string {
  const v = toSingleLine(value ?? '');
  return (Array.from(v).slice(0, VAR_MAX).join('') || fallback);
}

/**
 * Substitui {nome}, {grupo} e {remetente} em UMA passada: o texto inserido não é reinterpretado (um nome
 * "{remetente}" fica literal) e `$&`, `$1` etc. não têm efeito especial. Variáveis desconhecidas não são tocadas.
 * Sem grupo, a linha da assinatura fica vazia e é removida do fim.
 */
export function fillTemplate(template: string, vars: TemplateVars): string {
  const safe: Record<'nome' | 'grupo' | 'remetente', string> = {
    nome: cleanVar(vars.nome, 'jovem'),
    grupo: cleanVar(vars.grupo, ''),
    remetente: cleanVar(vars.remetente, 'Equipe do ministério jovem'),
  };
  return template
    .replace(/\{(nome|grupo|remetente)\}/g, (_match, key: 'nome' | 'grupo' | 'remetente') => safe[key])
    .replace(/\s+$/, '');
}

/** Assunto e corpo iniciais de um modelo. `kind` 'youth' escreve para o jovem; os demais falam sobre ele. */
export function buildTemplate(id: TemplateId, kind: RecipientKind, vars: TemplateVars): { subject: string; body: string } {
  const t = TEMPLATES[id];
  return {
    subject: toSingleLine(fillTemplate(t.subject, vars)),
    body: fillTemplate(kind === 'youth' ? t.direct : t.about, vars),
  };
}
