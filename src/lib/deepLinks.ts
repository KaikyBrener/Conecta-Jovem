import type { TaskListFilter } from '../hooks/useTasks';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `/jovens?ficha=<id>`: devolve o id normalizado ou null se ausente/inválido
 * (evita enviar lixo ao Postgres, que responderia 22P02).
 */
export function parseYouthSheetParam(value: string | null | undefined): string | null {
  const v = value?.trim();
  return v && UUID_RE.test(v) ? v.toLowerCase() : null;
}

/** `/encontros?evento=<id>`: id normalizado ou null (mesmo critério da ficha do jovem). */
export function parseEventParam(value: string | null | undefined): string | null {
  return parseYouthSheetParam(value);
}

/** `/historico?jovem=<id>`: id normalizado ou null. */
export function parseHistoryYouthParam(value: string | null | undefined): string | null {
  return parseYouthSheetParam(value);
}

const MAX_SEARCH_PARAM = 80;

/**
 * `/grupos?busca=<texto>` e `/encontros?busca=<texto>`: texto para preencher o campo de busca.
 * Remove caracteres de controle, colapsa espaços e limita o tamanho. Ausente/vazio → ''.
 * (O texto continua passando por searchPattern() antes de ir ao servidor.)
 */
export function parseSearchParam(value: string | null | undefined): string {
  const noControl = Array.from(value ?? '', (ch) => (ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127 ? ' ' : ch)).join('');
  const clean = noControl.replace(/\s+/g, ' ').trim();
  return clean.slice(0, MAX_SEARCH_PARAM).trim();
}

/** `/tarefas?filtro=atrasadas` → filtro interno. Valor desconhecido/ausente → null (mantém o padrão). */
export function parseTaskFilterParam(value: string | null | undefined): TaskListFilter | null {
  switch (value?.trim().toLowerCase()) {
    case 'atrasadas':
      return 'overdue';
    case 'abertas':
      return 'open';
    case 'encerradas':
      return 'done';
    case 'todas':
      return 'all';
    default:
      return null;
  }
}
