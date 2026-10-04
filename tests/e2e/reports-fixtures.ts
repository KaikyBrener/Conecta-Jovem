// Cenário com números conhecidos para os relatórios (Fase 7, bloco 7). Compartilhado por reports.spec.ts,
// reports-export.spec.ts e reports.mobile.spec.ts.
//
// Encontros (todos às 19h de São Paulo; "d-N" = N dias antes de hoje):
//   E1 d-40 Alfa            Ana P, Bia A                (só entra nos 90 dias)
//   E3 d-30 Alfa            Ana P, Bia P                (1 dia FORA dos "últimos 30 dias")
//   E2 d-29 Alfa            Ana A, Bia P                (1º dia dos "últimos 30 dias")
//   E4 d-10 Alfa+Beta       Ana A, Bia A, Caio P, Zé(inativo) P  (Zé nunca conta)
//   E7 d-5  Alfa CANCELADO  Ana A                       (cancelado nunca conta)
//   E8 d-6  Alfa realizado, SEM chamada                 ("não registrado" nunca é falta)
//   E5 d-3  Beta            Caio A
//   E6 d0   Beta            Caio P
// Últimos 30 dias: 7 registros, 3 presenças, 4 faltas = 43%; 5 encontros realizados, 1 cancelado.
// Últimos 90 dias: 11 registros, 6 presenças, 5 faltas = 55%; 7 realizados.
import type { TestDb } from './fixtures.ts';
import { spDay } from './fixtures.ts';
import { addFollowUp, seedPeople, type People } from './phase7-helpers.ts';

/** Instante às `hour`h de São Paulo, `offset` dias a partir de hoje (independe do fuso do computador). */
export const at = (offset: number, hour = 19): Date => new Date(`${spDay(offset)}T${String(hour).padStart(2, '0')}:00:00-03:00`);

export interface ReportScenario extends Omit<People, 'caio'> {
  ana: string;
  bia: string;
  caio: string;
  ze: string;
  e: Record<'e1' | 'e2' | 'e3' | 'e4' | 'e5' | 'e6' | 'e7' | 'e8', string>;
  biaAlert: string;
}

export async function seedReportScenario(db: TestDb): Promise<ReportScenario> {
  const p = await seedPeople(db);
  const ana = await db.createYouth('Ana Souza', p.alfa);
  const bia = await db.createYouth('Bia Lima', p.alfa);
  const caio = await db.createYouth('Caio Alheio', p.beta);
  const ze = await db.createYouth('Zé Inativo', p.alfa);
  const by = p.carla.id;
  const ev = (title: string, off: number, groups: string[], status = 'completed') => db.createEvent(title, at(off), groups, status);

  const e1 = await ev('Culto E1', -40, [p.alfa]);
  const e3 = await ev('Culto E3', -30, [p.alfa]);
  const e2 = await ev('Culto E2', -29, [p.alfa]);
  const e4 = await ev('Culto E4', -10, [p.alfa, p.beta]);
  const e7 = await ev('Culto E7 Cancelado', -5, [p.alfa], 'cancelled');
  const e8 = await ev('Culto E8 Sem Chamada', -6, [p.alfa]);
  const e5 = await ev('Culto E5', -3, [p.beta]);
  const e6 = await ev('Culto E6', 0, [p.beta]);

  await db.recordAttendance(e1, ana, p.alfa, true, by);
  await db.recordAttendance(e1, bia, p.alfa, false, by);
  await db.recordAttendance(e3, ana, p.alfa, true, by);
  await db.recordAttendance(e3, bia, p.alfa, true, by);
  await db.recordAttendance(e2, ana, p.alfa, false, by);
  await db.recordAttendance(e2, bia, p.alfa, true, by);
  await db.recordAttendance(e4, ana, p.alfa, false, by);
  await db.recordAttendance(e4, bia, p.alfa, false, by);
  await db.recordAttendance(e4, caio, p.beta, true, by);
  await db.recordAttendance(e5, caio, p.beta, false, by);
  await db.recordAttendance(e6, caio, p.beta, true, by);
  await db.recordAttendance(e7, ana, p.alfa, false, by);
  // Zé só fica inativo depois da chamada (como no mundo real): a presença dele não entra nos relatórios
  await db.recordAttendance(e4, ze, p.alfa, true, by);
  await db.sql(`UPDATE youth SET is_active = false WHERE id = $1`, [ze]);

  // Acompanhamentos (F0 fora dos 30 dias; F1 e F2 com próxima ação pendente; F1 vencida)
  await addFollowUp(db, ana, 'Conversa antiga', { responsibleId: p.lia.id, occurredDaysAgo: 40 });
  await addFollowUp(db, ana, 'Faltas recentes', { responsibleId: p.lia.id, occurredDaysAgo: 5, nextAction: 'Ligar para os pais', dueInDays: -1 });
  const f2 = await addFollowUp(db, bia, 'Visita combinada', { responsibleId: p.carla.id, occurredDaysAgo: 2, nextAction: 'Visitar a família', dueInDays: 5 });
  await db.sql(`UPDATE follow_ups SET type = 'call' WHERE id = $1`, [f2]);
  await addFollowUp(db, caio, 'Retorno ao grupo', { responsibleId: p.davi.id, occurredDaysAgo: 1 });

  // Alertas: Ana e Bia ficam com 50% em 4 registros (abaixo de 70%) => 2 alertas de baixa frequência criados hoje.
  // O da Bia é dispensado (1 aberto, 1 dispensado).
  const [bAlert] = await db.sql<{ id: string }>(`SELECT id FROM alerts WHERE youth_id = $1 AND status = 'open'`, [bia]);
  await db.sql(`UPDATE alerts SET status = 'dismissed', resolved_at = now() WHERE id = $1`, [bAlert.id]);

  // uma ação atrasada da Ana
  await db.createTask('Ligar para os pais da Ana', { createdBy: by, assignedTo: by, youthId: ana, dueDate: spDay(-1) });

  return { ...p, ana, bia, caio, ze, e: { e1, e2, e3, e4, e5, e6, e7, e8 }, biaAlert: bAlert.id };
}

/** Frequência esperada calculada direto na tabela (independente das RPCs de relatório). */
export async function expectedFrequency(db: TestDb, from: string, to: string, groupId: string | null = null) {
  const [r] = await db.sql<{ p: number; n: number }>(
    `SELECT (count(*) FILTER (WHERE a.present))::int AS p, count(*)::int AS n
       FROM attendance a
       JOIN events e ON e.id = a.event_id
       JOIN youth y ON y.id = a.youth_id
      WHERE y.is_active AND e.status <> 'cancelled'
        AND (e.event_date AT TIME ZONE 'America/Sao_Paulo')::date BETWEEN $1::date AND $2::date
        AND ($3::uuid IS NULL OR (y.group_id = $3::uuid
             AND EXISTS (SELECT 1 FROM event_groups eg WHERE eg.event_id = e.id AND eg.group_id = $3::uuid)))`,
    [from, to, groupId]);
  return { present: r.p, registered: r.n, text: r.n === 0 ? '—' : `${Math.round((100 * r.p) / r.n)}%` };
}

/** "dd/mm/aaaa" -> mesmo formato da tela a partir de YYYY-MM-DD */
export const br = (day: string) => day.split('-').reverse().join('/');

const iso = (d: Date) => d.toISOString().slice(0, 10);
const utcDate = (day: string) => new Date(`${day}T00:00:00Z`);

/** Semana atual (segunda a domingo), calculada de forma independente do app. */
export function weekRange(today: string): { from: string; to: string } {
  const d = utcDate(today);
  const monday = new Date(d.getTime() - ((d.getUTCDay() + 6) % 7) * 86_400_000);
  return { from: iso(monday), to: iso(new Date(monday.getTime() + 6 * 86_400_000)) };
}

/** Mês atual, do dia 1 ao último dia. */
export function monthRange(today: string): { from: string; to: string } {
  const d = utcDate(today);
  return { from: iso(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1))), to: iso(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0))) };
}
