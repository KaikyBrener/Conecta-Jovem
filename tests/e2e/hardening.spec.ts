// Hardening da migration 016 vista pelo navegador/API: throttle de sync_time_alerts(), relatórios do líder sem dados
// de encontro de outro grupo, anon sem nenhum privilégio e tabela de estado do throttle fechada para clientes.
// (Exclusão de acompanhamento com transferências: followups.spec.ts; e-mail com '%': communications.spec.ts.)
import type { Page } from '@playwright/test';
import { api, daysFromNow, expect, spDay, test, type TestDb } from './fixtures.ts';
import { ANON_KEY, SUPABASE_URL } from './env.ts';
import { seedReportScenario } from './reports-fixtures.ts';

const items = (page: Page) => page.getByTestId('alerta-item');
const byType = (page: Page, tipo: string, name?: string) =>
  page.locator(`[data-testid="alerta-item"][data-tipo="${tipo}"]`, name ? { hasText: name } : undefined);
const tab = (page: Page, key: string) => page.getByTestId(`rel-aba-${key}`);

/** Ana com 3 faltas seguidas (alerta de faltas aberto); "frequência baixa" desligada para isolar o foco. */
async function seedOpenAbsenceAlert(db: TestDb) {
  const coord = await db.createUser('coordinator', 'Carla Coordenadora');
  const group = await db.createGroup('Grupo Alfa', coord.id);
  await db.sql(`UPDATE app_settings SET low_attendance_threshold = 0`);
  const ana = await db.createYouth('Ana Souza', group);
  const bia = await db.createYouth('Bia Lima', group);
  for (const [i, d] of [-21, -14, -7].entries()) {
    const ev = await db.createEvent(`Culto ${i + 1}`, daysFromNow(d), [group], 'completed');
    await db.recordAttendance(ev, ana, group, false, coord.id);
    await db.recordAttendance(ev, bia, group, true, coord.id);
  }
  return { coord, group, ana, bia };
}

const noFollowupCount = async (db: TestDb) =>
  (await db.sql(`SELECT 1 FROM alerts WHERE type = 'no_followup'`)).length;

test.describe('sync_time_alerts: throttle de 60 s no banco (migration 016)', () => {
  test('2ª varredura em < 60 s não cria o alerta envelhecido; zerando last_run a varredura cria', async ({ page, db, loginAs }) => {
    const s = await seedOpenAbsenceAlert(db);
    expect(await db.lastSyncRun(), 'banco limpo: nunca varreu').toBeNull();
    await loginAs(s.coord);

    // 1ª abertura: varre e marca last_run
    await page.goto('/alertas');
    await expect(items(page)).toHaveCount(1);
    await expect.poll(() => db.lastSyncRun()).not.toBeNull();
    const firstRun = await db.lastSyncRun();

    // o alerta de faltas "envelhece" (9 dias > 7 de carência): uma nova varredura criaria o "sem acompanhamento"
    await db.ageAlerts('consecutive_absences', 9);

    // reabrir em < 60 s: o cliente chama a RPC, mas o banco a ignora
    await page.reload();
    await expect(items(page)).toHaveCount(1);
    await expect(byType(page, 'no_followup')).toHaveCount(0);
    expect(await noFollowupCount(db)).toBe(0);
    expect(await db.lastSyncRun(), 'varredura ignorada não mexe em last_run').toBe(firstRun);

    // a RPC chamada direto pela API também é ignorada (e não dá erro)
    const direct = await api(page, 'POST', 'rpc/sync_time_alerts', {});
    expect(direct.status, JSON.stringify(direct.body)).toBeLessThan(300);
    expect(await noFollowupCount(db)).toBe(0);
    expect(await db.lastSyncRun()).toBe(firstRun);

    // passado o intervalo (last_run zerado): a varredura acontece e o alerta aparece
    await db.resetSyncThrottle();
    await page.reload();
    await expect(items(page)).toHaveCount(2);
    const semAcomp = byType(page, 'no_followup', 'Ana Souza');
    await expect(semAcomp.getByTestId('alerta-descricao')).toHaveText('Sem acompanhamento há 9 dias');
    expect(await noFollowupCount(db)).toBe(1);
    const secondRun = await db.lastSyncRun();
    expect(secondRun).not.toBeNull();
    expect(secondRun).not.toBe(firstRun);

    // e logo em seguida volta a valer o intervalo: nada novo e last_run intocado
    expect((await api(page, 'POST', 'rpc/sync_time_alerts', {})).status).toBeLessThan(300);
    expect(await db.lastSyncRun()).toBe(secondRun);
    expect(await noFollowupCount(db)).toBe(1);
  });

  test('o estado do throttle é fechado para clientes e a RPC exige login', async ({ page, db, loginAs }) => {
    const lia = await db.createUser('leader', 'Lia Lider');
    await db.createUser('coordinator', 'Carla Coordenadora');
    await loginAs(lia);
    await page.goto('/');

    // leitura e escrita direta da tabela de estado: negadas, mesmo logado
    const read = await api(page, 'GET', 'time_alerts_sync_state?select=*');
    expect([401, 403]).toContain(read.status);
    const write = await api(page, 'PATCH', 'time_alerts_sync_state?id=eq.true', { last_run: '2000-01-01T00:00:00Z' });
    expect([401, 403]).toContain(write.status);
    expect(await db.lastSyncRun()).toBeNull();

    // anônimo não executa a varredura
    const anon = await page.evaluate(async ([url, key]) => {
      const res = await fetch(`${url}/rest/v1/rpc/sync_time_alerts`, {
        method: 'POST',
        headers: { apikey: key, authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: '{}',
      });
      return res.status;
    }, [SUPABASE_URL, ANON_KEY] as const);
    expect([401, 403]).toContain(anon);
    expect(await db.lastSyncRun()).toBeNull();
  });
});

test.describe('anon sem nenhum privilégio nas tabelas públicas (migration 016)', () => {
  test('anônimo recebe 401/403 em TODAS as tabelas de public (não só "0 linhas"); o login continua funcionando', async ({ page, db }) => {
    const coord = await db.createUser('coordinator', 'Carla Coordenadora');
    await db.createGroup('Grupo Alfa', coord.id);
    const tables = (await db.sql<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`)).map((t) => t.tablename);
    // o conjunto cobre as tabelas das fases anteriores e as novas (garante que a consulta acima não veio vazia)
    for (const expected of ['alerts', 'attendance', 'follow_ups', 'communications', 'activity_log', 'time_alerts_sync_state']) {
      expect(tables).toContain(expected);
    }

    await page.goto('/login');
    const results = await page.evaluate(async ([url, key, names]) => {
      const out: Record<string, number> = {};
      for (const t of names) {
        const res = await fetch(`${url}/rest/v1/${t}?select=*`, { headers: { apikey: key, authorization: `Bearer ${key}` } });
        out[t] = res.status;
      }
      return out;
    }, [SUPABASE_URL, ANON_KEY, tables] as const);
    for (const t of tables) expect([401, 403], `anon em ${t}`).toContain(results[t]);

    // o fluxo de login/redirect não depende de nenhuma tabela pública para anon
    await page.getByLabel('E-mail').fill(coord.email);
    await page.getByLabel('Senha', { exact: true }).fill(coord.password);
    await page.getByRole('button', { name: 'Entrar' }).click();
    await expect(page).toHaveURL('/');
    await expect(page.getByRole('heading', { name: 'Visão geral' })).toBeVisible();
  });
});

test.describe('Relatórios do líder: encontro de outro grupo após o jovem trocar de grupo (migration 016)', () => {
  /** Caio (Grupo Beta) passa para o Grupo Alfa depois de ter presenças em E4 (Alfa+Beta), E5 e E6 (só Beta). */
  async function moveCaioToAlfa(db: TestDb, s: Awaited<ReturnType<typeof seedReportScenario>>) {
    await db.sql(`UPDATE youth SET group_id = $1 WHERE id = $2`, [s.alfa, s.caio]);
  }

  test('Frequência > Por encontro: a líder do novo grupo vê data/estado, mas "Encontro de outro grupo" e nenhum título/id real', async ({ page, db, loginAs }) => {
    const s = await seedReportScenario(db);
    await moveCaioToAlfa(db, s);
    await loginAs(s.lia);
    await page.goto('/relatorios');
    await tab(page, 'attendance').click();

    const byEvent = page.getByTestId('tabela-encontros');
    await expect(byEvent).toBeVisible();
    // E5 e E6 (só Beta) viram o título genérico; E4 (também do Alfa) segue com o título real
    await expect(byEvent.locator('tbody tr', { hasText: 'Encontro de outro grupo' })).toHaveCount(2);
    await expect(byEvent.getByRole('row', { name: /Culto E4/ })).toBeVisible();
    await expect(page.locator('body')).not.toContainText('Culto E5');
    await expect(page.locator('body')).not.toContainText('Culto E6');
    // o estado do Caio nesses encontros continua nas contagens (a Lia vê 1 falta e 1 presença do outro grupo)
    // (a contagem é ancorada: sem isso "1/1" casaria dentro de datas como "01/10/2026", dependente do dia do teste)
    await expect(byEvent.getByRole('row', { name: /Encontro de outro grupo.*(?<![\d/])0\/1(?![\d/])/ })).toBeVisible(); // E5: Caio ausente
    await expect(byEvent.getByRole('row', { name: /Encontro de outro grupo.*(?<![\d/])1\/1(?![\d/])/ })).toBeVisible(); // E6: Caio presente

    // a mesma resposta pela API: event_id NULL e nada do título/id originais em lugar nenhum do JSON
    const range = { p_from: spDay(-29), p_to: spDay(0), p_group_id: null, p_min_absences: 3 };
    const res = await api(page, 'POST', 'rpc/report_attendance', range);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const masked = res.body.by_event.filter((e: any) => e.title === 'Encontro de outro grupo');
    expect(masked).toHaveLength(2);
    for (const e of masked) {
      expect(e.event_id).toBeNull();
      expect(e.event_date).toBeTruthy();
      expect(e.status).toBe('completed');
    }
    const raw = JSON.stringify(res.body);
    for (const secret of ['Culto E5', 'Culto E6', s.e.e5, s.e.e6]) expect(raw).not.toContain(secret);
    expect(res.body.by_event.find((e: any) => e.title === 'Culto E4').event_id).toBe(s.e.e4); // do grupo dela: normal
  });

  test('Individual: a ficha do jovem que mudou de grupo mostra "Encontro de outro grupo" com o estado, sem o título', async ({ page, db, loginAs }) => {
    const s = await seedReportScenario(db);
    await moveCaioToAlfa(db, s);
    await loginAs(s.lia);
    await page.goto('/relatorios');
    await tab(page, 'youth').click();
    await page.getByLabel('Buscar jovem por nome').fill('caio');
    await page.getByTestId('rel-jovem-resultado').click();

    const presence = page.getByTestId('relatorio-individual').getByRole('table', { name: 'Presença nos encontros' });
    await expect(presence.getByRole('row', { name: /Culto E4/ })).toBeVisible();
    await expect(presence.getByRole('row', { name: /Encontro de outro grupo.*Falta/ })).toBeVisible(); // E5
    await expect(presence.getByRole('row', { name: /Encontro de outro grupo.*Presen/ })).toBeVisible(); // E6
    await expect(page.locator('body')).not.toContainText('Culto E5');
    await expect(page.locator('body')).not.toContainText('Culto E6');

    const res = await api(page, 'POST', 'rpc/report_youth', { p_youth_id: s.caio, p_from: spDay(-29), p_to: spDay(0) });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const foreign = res.body.attendance.events.filter((e: any) => e.event_id === null);
    expect(foreign.map((e: any) => [e.title, e.state]).sort()).toEqual([
      ['Encontro de outro grupo', 'absent'], ['Encontro de outro grupo', 'present'],
    ]);
    const raw = JSON.stringify(res.body);
    for (const secret of ['Culto E5', 'Culto E6', s.e.e5, s.e.e6]) expect(raw).not.toContain(secret);
  });

  test('coordenador continua vendo título e id reais dos mesmos encontros', async ({ page, db, loginAs }) => {
    const s = await seedReportScenario(db);
    await moveCaioToAlfa(db, s);
    await loginAs(s.carla);
    await page.goto('/relatorios');
    await tab(page, 'attendance').click();

    const byEvent = page.getByTestId('tabela-encontros');
    await expect(byEvent.getByRole('row', { name: /Culto E5/ })).toBeVisible();
    await expect(byEvent.getByRole('row', { name: /Culto E6/ })).toBeVisible();
    await expect(page.locator('body')).not.toContainText('Encontro de outro grupo');

    const res = await api(page, 'POST', 'rpc/report_attendance', { p_from: spDay(-29), p_to: spDay(0), p_group_id: null, p_min_absences: 3 });
    expect(res.status).toBe(200);
    expect(res.body.by_event.find((e: any) => e.title === 'Culto E5').event_id).toBe(s.e.e5);
    expect(res.body.by_event.some((e: any) => e.event_id === null)).toBe(false);
  });
});
