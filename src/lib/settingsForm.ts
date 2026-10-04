// Validação pura do formulário de parâmetros do sistema (Configurações). Os limites espelham os CHECKs do banco.

export interface SettingsFormValues {
  absence: string;
  critical: string;
  low: string;
  graceDays: string;
}

export interface SettingsPayload {
  absence_alert_threshold: number;
  critical_absence_threshold: number;
  low_attendance_threshold: number;
  followup_grace_days: number;
}

export type SettingsValidation = { ok: true; payload: SettingsPayload } | { ok: false; error: string };

function toInt(raw: string): number | null {
  if (raw.trim() === '') return null;
  const n = Number(raw);
  return Number.isInteger(n) ? n : null;
}

export function validateSettings(values: SettingsFormValues): SettingsValidation {
  const absence = toInt(values.absence);
  const critical = toInt(values.critical);
  const low = toInt(values.low);
  const grace = toInt(values.graceDays);

  if (absence === null || absence < 1 || absence > 20) {
    return { ok: false, error: 'Faltas consecutivas: informe um número inteiro entre 1 e 20.' };
  }
  if (critical === null || critical < 1 || critical > 50) {
    return { ok: false, error: 'Faltas para alerta crítico: informe um número inteiro entre 1 e 50.' };
  }
  // O banco usa GREATEST(crítico, faltas): um crítico menor seria ignorado em silêncio, então não aceitamos.
  if (critical < absence) {
    return { ok: false, error: 'Faltas para alerta crítico: o valor deve ser igual ou maior que as faltas consecutivas para gerar alerta.' };
  }
  if (low === null || low < 0 || low > 100) {
    return { ok: false, error: 'Frequência mínima: informe um número inteiro entre 0 e 100.' };
  }
  if (grace === null || grace < 1 || grace > 90) {
    return { ok: false, error: 'Prazo de carência do acompanhamento: informe um número inteiro de dias entre 1 e 90.' };
  }
  return {
    ok: true,
    payload: {
      absence_alert_threshold: absence,
      critical_absence_threshold: critical,
      low_attendance_threshold: low,
      followup_grace_days: grace,
    },
  };
}
