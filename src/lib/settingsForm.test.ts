import { describe, expect, it } from 'vitest';
import { validateSettings } from './settingsForm';

const ok = { absence: '3', critical: '6', low: '70', graceDays: '7' };

describe('validateSettings', () => {
  it('valores padrão geram o payload completo', () => {
    expect(validateSettings(ok)).toEqual({
      ok: true,
      payload: {
        absence_alert_threshold: 3,
        critical_absence_threshold: 6,
        low_attendance_threshold: 70,
        followup_grace_days: 7,
      },
    });
  });

  it('crítico igual ao limite de alerta é aceito; menor é recusado', () => {
    expect(validateSettings({ ...ok, absence: '5', critical: '5' }).ok).toBe(true);
    const r = validateSettings({ ...ok, absence: '8', critical: '6' });
    expect(r).toMatchObject({ ok: false });
    expect(r.ok === false && r.error).toMatch(/igual ou maior/);
  });

  it('crítico fica entre 1 e 50 (CHECK do banco)', () => {
    expect(validateSettings({ ...ok, critical: '0' }).ok).toBe(false);
    expect(validateSettings({ ...ok, critical: '51' }).ok).toBe(false);
    expect(validateSettings({ ...ok, critical: '50' }).ok).toBe(true);
  });

  it('carência é inteiro entre 1 e 90', () => {
    for (const bad of ['0', '91', '1.5', '', 'abc']) {
      expect(validateSettings({ ...ok, graceDays: bad }).ok).toBe(false);
    }
    expect(validateSettings({ ...ok, graceDays: '1' }).ok).toBe(true);
    expect(validateSettings({ ...ok, graceDays: '90' }).ok).toBe(true);
  });

  it('faltas (1..20) e frequência (0..100) continuam validadas; vazio não vira zero', () => {
    expect(validateSettings({ ...ok, absence: '21' }).ok).toBe(false);
    expect(validateSettings({ ...ok, absence: '' }).ok).toBe(false);
    expect(validateSettings({ ...ok, low: '101' }).ok).toBe(false);
    expect(validateSettings({ ...ok, low: '' }).ok).toBe(false);
    expect(validateSettings({ ...ok, low: '0' }).ok).toBe(true);
  });
});
