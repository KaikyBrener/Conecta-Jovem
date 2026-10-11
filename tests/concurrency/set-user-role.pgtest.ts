import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { concurrencyEnabled, createScratch, raceBehindHeldTransaction, type Scratch, type Session } from './support';

// Cenário 1 — set_user_role (008: pg_advisory_xact_lock; 024: checagem de papel refeita após o lock). Postgres real.
// 1a) A rebaixa B enquanto B rebaixa A: nunca pode sobrar 0 coordenadores (controle: sem o lock).
// 1b) 3 coordenadores; A rebaixa B enquanto B (ainda coordenador no seu snapshot) rebaixa C. Em execução serial a
//     chamada de B falha (42501: B já não é coordenador) (controle: sem o recheck da 024, ou seja, a função da 008).

const SIG = 'public.set_user_role(uuid, user_role)';
const LOCK_LINE = /PERFORM pg_advisory_xact_lock\([\s\S]*?\);/;

describe.skipIf(!concurrencyEnabled())('set_user_role: concorrência real', () => {
  let s: Scratch;
  let original: string;

  beforeAll(async () => { s = await createScratch(); }, 180_000);
  afterAll(async () => { await s?.drop(); });

  const coordinators = async () =>
    (await s.admin.query<{ n: number }>(`SELECT count(*)::int AS n FROM public.user_roles WHERE role = 'coordinator'`)).rows[0].n;
  const reset = async () => { await s.admin.query(`UPDATE public.user_roles SET role = 'leader'`); };
  const roleOf = async (id: string) =>
    (await s.admin.query<{ role: string }>(`SELECT role FROM public.user_roles WHERE user_id = $1`, [id])).rows[0].role;
  const demote = (who: Session, target: string) => () =>
    who.query(`SELECT public.set_user_role($1::uuid, 'leader'::user_role)`, [target]);

  async function twoCoordinators() {
    await reset();
    const a = await s.createUser('Coord A', 'coordinator');
    const b = await s.createUser('Coord B', 'coordinator');
    return { a, b, sa: await s.session({ userId: a }), sb: await s.session({ userId: b }) };
  }

  describe('com o lock (função original)', () => {
    it('1a) rebaixamento cruzado A↔B: B espera no lock e é negado (já não é coordenador); sobra 1 coordenador', async () => {
      const { a, b, sa, sb } = await twoCoordinators();
      const r = await raceBehindHeldTransaction({
        observer: s.admin, holder: sa, holderCall: demote(sa, b), contender: sb, contenderCall: demote(sb, a),
      });
      expect(r.blocked).toBe(true);
      expect(r.waitEvent).toBe('advisory');
      expect(r.holder.ok).toBe(true);
      // Com o recheck da 024 a chamada de B falha por papel (42501), antes mesmo da guarda "último coordenador".
      expect(r.contender).toMatchObject({ ok: false, code: '42501' });
      expect(await roleOf(a)).toBe('coordinator');
      expect(await coordinators()).toBe(1);
    });

    // Regressão da migration 024: antes dela a checagem get_my_role() rodava ANTES do pg_advisory_xact_lock e não era
    // refeita, e B (já rebaixado por A) conseguia rebaixar C. Em execução serial a chamada de B falha com 42501.
    it('1b) com 3 coordenadores, quem acabou de ser rebaixado não consegue rebaixar outro (42501)', async () => {
      await reset();
      const a = await s.createUser('Coord A', 'coordinator');
      const b = await s.createUser('Coord B', 'coordinator');
      const c = await s.createUser('Coord C', 'coordinator');
      const sa = await s.session({ userId: a });
      const sb = await s.session({ userId: b });
      const r = await raceBehindHeldTransaction({
        observer: s.admin, holder: sa, holderCall: demote(sa, b), contender: sb, contenderCall: demote(sb, c),
      });
      expect(r.blocked).toBe(true);
      // Equivalente ao serial A→B depois B→C: a chamada de B é negada e C continua coordenador.
      expect(r.contender).toMatchObject({ ok: false, code: '42501' });
      expect(await roleOf(c)).toBe('coordinator');
      expect(await coordinators()).toBe(2);
    });
  });

  describe('controle negativo 1b (SEM o recheck após o lock = função da 008)', () => {
    beforeAll(async () => {
      original = await s.replaceFunction(SIG, (def) =>
        def.replace(/(PERFORM pg_advisory_xact_lock\([\s\S]*?\);)\s*-- Refaz a checagem[\s\S]*?END IF;/, '$1'));
    });
    afterAll(async () => { await s.admin.query(original); });

    it('B (já rebaixado) rebaixa C: a equivalência com a execução serial QUEBRA', async () => {
      await reset();
      const a = await s.createUser('Coord A', 'coordinator');
      const b = await s.createUser('Coord B', 'coordinator');
      const c = await s.createUser('Coord C', 'coordinator');
      const sa = await s.session({ userId: a });
      const sb = await s.session({ userId: b });
      const r = await raceBehindHeldTransaction({
        observer: s.admin, holder: sa, holderCall: demote(sa, b), contender: sb, contenderCall: demote(sb, c),
      });
      expect(r.blocked).toBe(true);
      expect(r.contender.ok).toBe(true);
      expect(await roleOf(c)).toBe('leader');
      expect(await coordinators()).toBe(1);
    });
  });

  describe('controle negativo 1a (cópia da função SEM o lock)', () => {
    beforeAll(async () => {
      original = await s.replaceFunction(SIG, (def) => def.replace(LOCK_LINE, '-- lock removido (controle negativo)'));
    });
    afterAll(async () => { await s.admin.query(original); });

    it('1a) sem o lock os dois rebaixamentos passam e restam 0 coordenadores (a invariante QUEBRA)', async () => {
      const { a, b, sa, sb } = await twoCoordinators();
      const r = await raceBehindHeldTransaction({
        observer: s.admin, holder: sa, holderCall: demote(sa, b), contender: sb, contenderCall: demote(sb, a),
      });
      expect(r.blocked).toBe(false);
      expect(r.contender.ok).toBe(true);
      expect(await coordinators()).toBe(0);
    });
  });
});
