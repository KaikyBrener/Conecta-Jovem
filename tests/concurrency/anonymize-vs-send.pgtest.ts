import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { concurrencyEnabled, createScratch, raceBehindHeldTransaction, settle, type Scratch, type Session } from './support';

// Cenário 6 — anonymize_youth (021) contra begin_communication_send (019): corrida entre a anonimização e um envio.
// O `PERFORM 1 ... FOR UPDATE` das comunicações do jovem (021) fecha a janela entre a checagem de 'sending' e o UPDATE.

const SIG = 'public.anonymize_youth(uuid)';
const COMM_LOCK = /PERFORM 1 FROM public\.communications WHERE youth_id = p_youth_id FOR UPDATE;/;
const ORIGINAL_SUBJECT = 'Assunto original sigiloso';

interface BeginResult { ok: boolean; error?: string; subject?: string; recipient_email?: string }

describe.skipIf(!concurrencyEnabled())('anonymize_youth × begin_communication_send: concorrência real', () => {
  let s: Scratch;
  let coord: string;
  let original: string;

  beforeAll(async () => {
    s = await createScratch();
    coord = await s.createUser('Coordenadora', 'coordinator');
  }, 180_000);
  afterAll(async () => { await s?.drop(); });

  async function youthWithDraft() {
    const youth = (await s.admin.query<{ id: string }>(
      `INSERT INTO public.youth (full_name, email, phone, address, notes, created_by)
       VALUES ('Jovem Original', 'jovem.original@exemplo.com', '27999990000', 'Rua Original', 'Obs original', $1) RETURNING id`,
      [coord])).rows[0].id;
    const comm = (await s.admin.query<{ id: string }>(
      `INSERT INTO public.communications (youth_id, recipient_email, recipient_name, recipient_kind, subject, body, created_by)
       VALUES ($1, 'jovem.original@exemplo.com', 'Jovem Original', 'youth', $2, 'Corpo original', $3) RETURNING id`,
      [youth, ORIGINAL_SUBJECT, coord])).rows[0].id;
    return { youth, comm };
  }
  const youthName = async (id: string) =>
    (await s.admin.query<{ n: string }>(`SELECT full_name AS n FROM public.youth WHERE id = $1`, [id])).rows[0].n;
  const commRow = async (id: string) =>
    (await s.admin.query<{ status: string; subject: string }>(`SELECT status::text, subject FROM public.communications WHERE id = $1`, [id])).rows[0];

  const anonymize = (who: Session, youth: string) => async () =>
    (await who.query(`SELECT public.anonymize_youth($1::uuid) AS r`, [youth])).rows[0];
  const begin = (who: Session, comm: string) => async () =>
    (await who.query<{ r: BeginResult }>(`SELECT public.begin_communication_send($1::uuid, $2::uuid) AS r`, [comm, coord])).rows[0].r;

  describe('(iii) envio confirmado ANTES da anonimização terminar', () => {
    it('com o lock: a anonimização espera, vê "sending" e é recusada; o jovem continua intacto', async () => {
      const { youth, comm } = await youthWithDraft();
      const svc = await s.session({ role: 'service_role' });
      const co = await s.session({ userId: coord });
      const r = await raceBehindHeldTransaction({
        observer: s.admin, holder: svc, holderCall: begin(svc, comm), contender: co, contenderCall: anonymize(co, youth),
      });
      expect(r.holder.ok && (r.holder.value as BeginResult).ok).toBe(true);
      expect(r.blocked).toBe(true);
      expect(r.waitEvent).toBe('transactionid');
      expect(r.contender).toMatchObject({ ok: false, code: 'P0001' });
      expect(r.contender.ok === false && r.contender.message).toMatch(/e-mail em envio/);
      expect(await youthName(youth)).toBe('Jovem Original');
      expect((await commRow(comm)).status).toBe('sending');
    });

    describe('controle negativo (SEM o FOR UPDATE das comunicações)', () => {
      beforeAll(async () => {
        original = await s.replaceFunction(SIG, (def) => def.replace(COMM_LOCK, '-- trava removida (controle negativo)'));
      });
      afterAll(async () => { await s.admin.query(original); });

      it('a anonimização CONCLUI com um envio em andamento: jovem anonimizado e e-mail "sending" (a invariante QUEBRA)', async () => {
        const { youth, comm } = await youthWithDraft();
        const svc = await s.session({ role: 'service_role' });
        const co = await s.session({ userId: coord });
        const r = await raceBehindHeldTransaction({
          observer: s.admin, holder: svc, holderCall: begin(svc, comm), contender: co, contenderCall: anonymize(co, youth),
        });
        expect(r.holder.ok && (r.holder.value as BeginResult).ok).toBe(true);
        expect(r.contender.ok).toBe(true);
        expect(await youthName(youth)).toBe('Jovem anonimizado');
        const row = await commRow(comm);
        expect(row.status).toBe('sending');
        expect(row.subject).toBe('Mensagem anonimizada');
      });
    });
  });

  describe('(ii) anonimização confirmada ANTES do envio ler o conteúdo', () => {
    it('com o lock: o begin espera e lê o conteúdo JÁ anonimizado (nunca o original)', async () => {
      const { youth, comm } = await youthWithDraft();
      const co = await s.session({ userId: coord });
      const svc = await s.session({ role: 'service_role' });
      const r = await raceBehindHeldTransaction({
        observer: s.admin, holder: co, holderCall: anonymize(co, youth), contender: svc, contenderCall: begin(svc, comm),
      });
      expect(r.holder.ok).toBe(true);
      expect(r.blocked).toBe(true);
      expect(r.contender.ok && r.contender.value).toMatchObject({
        ok: true, subject: 'Mensagem anonimizada', recipient_email: 'anonimizado@anonimizado.invalid',
      });
    });

    describe('controle SEM o FOR UPDATE (documenta que NÃO é a trava que protege este sentido)', () => {
      beforeAll(async () => {
        original = await s.replaceFunction(SIG, (def) => def.replace(COMM_LOCK, '-- trava removida (controle)'));
      });
      afterAll(async () => { await s.admin.query(original); });

      // O UPDATE de communications já serializa com o begin (trava a mesma linha): este controle NÃO quebra.
      it('o begin continua lendo o conteúdo anonimizado (protegido pelo próprio UPDATE)', async () => {
        const { youth, comm } = await youthWithDraft();
        const co = await s.session({ userId: coord });
        const svc = await s.session({ role: 'service_role' });
        const r = await raceBehindHeldTransaction({
          observer: s.admin, holder: co, holderCall: anonymize(co, youth), contender: svc, contenderCall: begin(svc, comm),
        });
        expect(r.blocked).toBe(true);
        expect(r.contender.ok && r.contender.value).toMatchObject({ ok: true, subject: 'Mensagem anonimizada' });
      });
    });
  });

  describe('(iv) estresse sem coreografia: 30 corridas simultâneas (não é prova, só busca deadlock e violação)', () => {
    it('sem deadlock (40P01) e com a invariante em todas as execuções', async () => {
      const co = await s.session({ userId: coord });
      const svc = await s.session({ role: 'service_role' });
      const tally = { anonymizedThenSend: 0, sendThenRefused: 0, other: 0 };

      for (let i = 0; i < 30; i++) {
        const { youth, comm } = await youthWithDraft();
        const [an, bg] = await Promise.all([settle(anonymize(co, youth)()), settle(begin(svc, comm)())]);

        for (const r of [an, bg]) {
          if (!r.ok) expect(['40P01', '40001'], `iteração ${i}: ${r.message}`).not.toContain(r.code);
        }
        if (an.ok) {
          expect(await youthName(youth)).toBe('Jovem anonimizado');
          expect((await commRow(comm)).subject).toBe('Mensagem anonimizada');
          if (bg.ok && bg.value.ok) expect(bg.value.subject, `iteração ${i}`).toBe('Mensagem anonimizada');
          tally.anonymizedThenSend += 1;
        } else {
          expect(an.code).toBe('P0001');
          expect(an.message).toMatch(/e-mail em envio/);
          expect(await youthName(youth)).toBe('Jovem Original');
          expect((await commRow(comm)).status).toBe('sending');
          tally.sendThenRefused += 1;
        }
      }
      console.log('[iv] desfechos:', JSON.stringify(tally));
    });
  });
});
