import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { concurrencyEnabled, createScratch, raceBehindHeldTransaction, type Scratch, type Session } from './support';

// Cenário 5 — create_event_series (migration 020: advisory lock por parâmetros + checagem de série ativa idêntica).
// Duas conexões criando a MESMA série: só uma pode existir. Séries diferentes não devem se bloquear.

const SIG = 'public.create_event_series(text, integer, time, text, date, date, text, uuid[])';
const ADVISORY = /PERFORM pg_advisory_xact_lock\([\s\S]*?\);/;

describe.skipIf(!concurrencyEnabled())('create_event_series: concorrência real', () => {
  let s: Scratch;
  let coord: string;
  let original: string;
  let seq = 0;

  beforeAll(async () => {
    s = await createScratch();
    coord = await s.createUser('Coordenadora', 'coordinator');
  }, 180_000);
  afterAll(async () => { await s?.drop(); });

  const create = (who: Session, name: string) => async () =>
    (await who.query<{ r: { series_id: string; created: number } }>(
      `SELECT public.create_event_series($1, 0, '19:00'::time, 'weekly', '2031-03-02'::date, '2031-03-30'::date, NULL, '{}'::uuid[]) AS r`,
      [name])).rows[0].r;
  const seriesCount = async (name: string) =>
    (await s.admin.query<{ n: number }>(`SELECT count(*)::int AS n FROM public.event_series WHERE name = $1`, [name])).rows[0].n;
  const uniqueName = () => { seq += 1; return `Culto ${seq}`; };

  it('com o lock: o segundo espera e é recusado ("Já existe uma série ativa"); existe 1 série', async () => {
    const name = uniqueName();
    const sa = await s.session({ userId: coord });
    const sb = await s.session({ userId: coord });
    const r = await raceBehindHeldTransaction({
      observer: s.admin, holder: sa, holderCall: create(sa, name), contender: sb, contenderCall: create(sb, name),
    });
    expect(r.blocked).toBe(true);
    expect(r.waitEvent).toBe('advisory');
    expect(r.holder.ok).toBe(true);
    expect(r.contender).toMatchObject({ ok: false, code: 'P0001' });
    expect(r.contender.ok === false && r.contender.message).toMatch(/Já existe uma série ativa/);
    expect(await seriesCount(name)).toBe(1);
  });

  it('séries com nomes diferentes NÃO se bloqueiam (lock por parâmetros): ambas são criadas', async () => {
    const [n1, n2] = [uniqueName(), uniqueName()];
    const sa = await s.session({ userId: coord });
    const sb = await s.session({ userId: coord });
    const r = await raceBehindHeldTransaction({
      observer: s.admin, holder: sa, holderCall: create(sa, n1), contender: sb, contenderCall: create(sb, n2),
    });
    expect(r.blocked).toBe(false);
    expect(r.contender.ok).toBe(true);
    expect(await seriesCount(n1)).toBe(1);
    expect(await seriesCount(n2)).toBe(1);
  });

  describe('controle negativo (SEM o lock)', () => {
    beforeAll(async () => {
      original = await s.replaceFunction(SIG, (def) => def.replace(ADVISORY, '-- lock removido (controle negativo)'));
    });
    afterAll(async () => { await s.admin.query(original); });

    it('as duas chamadas criam a série: ficam 2 séries idênticas (a invariante QUEBRA)', async () => {
      const name = uniqueName();
      const sa = await s.session({ userId: coord });
      const sb = await s.session({ userId: coord });
      const r = await raceBehindHeldTransaction({
        observer: s.admin, holder: sa, holderCall: create(sa, name), contender: sb, contenderCall: create(sb, name),
      });
      expect(r.blocked).toBe(false);
      expect(r.contender.ok).toBe(true);
      expect(await seriesCount(name)).toBe(2);
    });
  });
});
