// Anonimização de jovem (RPC anonymize_youth, migrations 021 e 025). Regras puras da tela; a regra real está no banco.

/** Nome que a 021 grava no lugar do nome real. */
export const ANONYMIZED_YOUTH_NAME = 'Jovem anonimizado';

export const isAnonymizedYouth = (fullName: string | null | undefined) => fullName === ANONYMIZED_YOUTH_NAME;

const normalize = (s: string) => s.trim().replace(/\s+/g, ' ');

/** A confirmação exige o nome atual do jovem: espaços extras são ignorados; maiúsculas e acentos importam. */
export function anonymizeConfirmationMatches(typed: string, fullName: string): boolean {
  const expected = normalize(fullName);
  return expected !== '' && normalize(typed) === expected;
}

/** Retorno da RPC: quantos registros de texto ligados ao jovem foram limpos. */
export interface AnonymizeResult {
  youth_id: string;
  tasks: number;
  follow_ups: number;
  communications: number;
  /** Rascunhos e envios com falha que foram cancelados (migration 025; ausente antes dela). */
  communications_cancelled?: number;
  /** Data registrada da anonimização (migration 025; ausente antes dela). */
  anonymized_at?: string;
}
