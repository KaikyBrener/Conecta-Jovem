import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { concurrencyEnabled, createScratch, raceBehindHeldTransaction, type Scratch, type Session } from './support';

// Cenários 2 e 3 — begin_communication_send (migration 019). Postgres real, duas conexões como service_role.
// 2) Mesmo usuário, duas comunicações diferentes, no limite: o lock por usuário impede estourar o limite por hora.
// 3) Mesma comunicação por duas conexões: só um begin pode vencer (sem envio duplicado).

const SIG = 'public.begin_communication_send(uuid, uuid)';
const ADVISORY = /PERFORM pg_advisory_xact_lock\([\s\S]*?\);/;
const ROW_LOCK = /(SELECT \* INTO c FROM public\.communications WHERE id = p_id) FOR UPDATE;/;
const STATUS_PREDICATE = /AND \(status::text IN \('draft', 'failed'\)[\s\S]*?now\(\) - v_stale\)\)\)/;

interface BeginResult {
  ok: boolean; error?: string; reason?: string; window?: string; attempts?: number; id?: string;
}

describe.skipIf(!concurrencyEnabled())('begin_communication_send: concorrência real', () => {
  let s: Scratch;
  let coord: string;
  let youth: string;
  let original: string;

  beforeAll(async () => {
    s = await createScratch();
    coord = await s.createUser('Coordenadora', 'coordinator');
    youth = (await s.admin.query<{ id: string }>(
      `INSERT INTO public.youth (full_name, email, created_by) VALUES ('Jovem Envio', 'jovem@exemplo.com', $1) RETURNING id`,
      [coord])).rows[0].id;
  }, 180_000);
  afterAll(async () => { await s?.drop(); });

  const draft = async () =>
    (await s.admin.query<{ id: string }>(
      `INSERT INTO public.communications (youth_id, recipient_email, recipient_name, recipient_kind, subject, body, created_by)
       VALUES ($1, 'jovem@exemplo.com', 'Dest', 'youth', 'Assunto', 'Corpo', $2) RETURNING id`, [youth, coord])).rows[0].id;
  const logCount = async () =>
    (await s.admin.query<{ n: number }>(`SELECT count(*)::int AS n FROM public.communication_send_log WHERE user_id = $1`, [coord])).rows[0].n;
  const attemptsOf = async (id: string) =>
    (await s.admin.query<{ attempts: number }>(`SELECT attempts FROM public.communications WHERE id = $1`, [id])).rows[0].attempts;
  const svc = () => s.session({ role: 'service_role' });
  const begin = (who: Session, id: string) => async () =>
    (await who.query<{ r: BeginResult }>(`SELECT public.begin_communication_send($1::uuid, $2::uuid) AS r`, [id, coord])).rows[0].r;

  /** Coordenador: 20/hora. Deixa o usuário com 19 envios na última hora (1 vaga). */
  async function oneSlotLeft() {
    await s.admin.query(`DELETE FROM public.communication_send_log`);
    await s.admin.query(
      `INSERT INTO public.communication_send_log (user_id, started_at)
       SELECT $1, now() - interval '10 minutes' FROM generate_series(1, 19)`, [coord]);
  }

  describe('cenário 2 — limite por hora (usuário no limite, 2 rascunhos)', () => {
    it('com o lock: o segundo begin espera, vê 20 envios e recebe rate_limited; o log termina com 20', async () => {
      await oneSlotLeft();
      const [d1, d2] = [await draft(), await draft()];
      const sa = await svc();
      const sb = await svc();
      const r = await raceBehindHeldTransaction({
        observer: s.admin, holder: sa, holderCall: begin(sa, d1), contender: sb, contenderCall: begin(sb, d2),
      });
      expect(r.blocked).toBe(true);
      expect(r.waitEvent).toBe('advisory');
      expect(r.holder.ok && r.holder.value.ok).toBe(true);
      expect(r.contender.ok && r.contender.value).toMatchObject({ ok: false, error: 'rate_limited', window: 'hour' });
      expect(await logCount()).toBe(20);
    });

    describe('controle negativo (SEM o lock por usuário)', () => {
      beforeAll(async () => {
        original = await s.replaceFunction(SIG, (def) => def.replace(ADVISORY, '-- lock removido (controle negativo)'));
      });
      afterAll(async () => { await s.admin.query(original); });

      it('os dois begins passam e o log vai a 21 (o limite de 20/h É ultrapassado)', async () => {
        await oneSlotLeft();
        const [d1, d2] = [await draft(), await draft()];
        const sa = await svc();
        const sb = await svc();
        const r = await raceBehindHeldTransaction({
          observer: s.admin, holder: sa, holderCall: begin(sa, d1), contender: sb, contenderCall: begin(sb, d2),
        });
        expect(r.blocked).toBe(false);
        expect(r.contender.ok && r.contender.value.ok).toBe(true);
        expect(await logCount()).toBe(21);
      });
    });
  });

  describe('cenário 3 — mesma comunicação, duas conexões', () => {
    it('com todas as proteções: um vence (attempts = 1) e o outro recebe conflict/in_progress', async () => {
      await s.admin.query(`DELETE FROM public.communication_send_log`);
      const d = await draft();
      const sa = await svc();
      const sb = await svc();
      const r = await raceBehindHeldTransaction({
        observer: s.admin, holder: sa, holderCall: begin(sa, d), contender: sb, contenderCall: begin(sb, d),
      });
      expect(r.blocked).toBe(true);
      expect(r.waitEvent).toBe('advisory');
      expect(r.holder.ok && r.holder.value.ok).toBe(true);
      expect(r.contender.ok && r.contender.value).toMatchObject({ ok: false, error: 'conflict', reason: 'in_progress' });
      expect(await attemptsOf(d)).toBe(1);
      expect(await logCount()).toBe(1);
    });

    describe('controle A: SÓ o advisory lock removido', () => {
      beforeAll(async () => {
        original = await s.replaceFunction(SIG, (def) => def.replace(ADVISORY, '-- lock removido (controle A)'));
      });
      afterAll(async () => { await s.admin.query(original); });

      // RESULTADO ESPERADO E RELEVANTE: este controle NÃO quebra a invariante. O advisory lock não é a única defesa:
      // o SELECT ... FOR UPDATE e o UPDATE condicional por status também serializam a MESMA comunicação.
      // (O advisory lock continua indispensável no cenário 2, onde as linhas são diferentes.)
      it('a invariante continua valendo (defesa em profundidade): attempts = 1 e o segundo begin é recusado', async () => {
        await s.admin.query(`DELETE FROM public.communication_send_log`);
        const d = await draft();
        const sa = await svc();
        const sb = await svc();
        const r = await raceBehindHeldTransaction({
          observer: s.admin, holder: sa, holderCall: begin(sa, d), contender: sb, contenderCall: begin(sb, d),
        });
        expect(r.blocked).toBe(true);
        expect(r.waitEvent).toBe('transactionid');
        expect(r.contender.ok && r.contender.value).toMatchObject({ ok: false, error: 'conflict' });
        expect(await attemptsOf(d)).toBe(1);
      });
    });

    describe('controle B: advisory lock + FOR UPDATE + predicado de status removidos', () => {
      beforeAll(async () => {
        original = await s.replaceFunction(SIG, (def) =>
          def.replace(ADVISORY, '-- lock removido (controle B)')
            .replace(ROW_LOCK, '$1;')
            .replace(STATUS_PREDICATE, 'AND true'));
      });
      afterAll(async () => { await s.admin.query(original); });

      it('os dois begins vencem e attempts = 2 (envio DUPLICADO: a invariante QUEBRA)', async () => {
        await s.admin.query(`DELETE FROM public.communication_send_log`);
        const d = await draft();
        const sa = await svc();
        const sb = await svc();
        const r = await raceBehindHeldTransaction({
          observer: s.admin, holder: sa, holderCall: begin(sa, d), contender: sb, contenderCall: begin(sb, d),
        });
        expect(r.contender.ok && r.contender.value.ok).toBe(true);
        expect(await attemptsOf(d)).toBe(2);
      });
    });
  });
});
