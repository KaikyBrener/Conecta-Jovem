// Chamada com 3 estados (Fase 7): não registrado (sem linha no banco, NÃO é falta) / presente / ausente,
// salva só quem foi marcado via RPC save_attendance e mostra um resumo (sem navegar sozinha).
import { AUTH_STORAGE_KEY, SUPABASE_URL, ANON_KEY } from './env.ts';
import {
  chamadaRow, daysFromNow, expect, expectCounters, markAbsent, markPresent, test, type TestDb,
} from './fixtures.ts';

const SAVE = 'Salvar Chamada';
const BATCH = 'Marcar não registrados (visíveis) como presentes';

async function seedMeeting(db: TestDb) {
  const coord = await db.createUser('coordinator', 'Carla Coordenadora');
  const group = await db.createGroup('Grupo Alfa', coord.id);
  const ana = await db.createYouth('Ana Souza', group);
  const bruno = await db.createYouth('Bruno Lima', group);
  const carlos = await db.createYouth('Carlos Dias', group);
  const eventId = await db.createEvent('Culto de Jovens', daysFromNow(-1), [group]);
  return { coord, group, ana, bruno, carlos, eventId };
}

/** Ana faltou nos 2 últimos encontros realizados (limite padrão = 3); Bia compareceu. e3 ainda sem chamada. */
async function seedAbsenceScenario(db: TestDb) {
  const coord = await db.createUser('coordinator', 'Carla Coordenadora');
  const group = await db.createGroup('Grupo Alfa', coord.id);
  const ana = await db.createYouth('Ana Souza', group);
  const bia = await db.createYouth('Bia Lima', group);
  const e1 = await db.createEvent('Culto 1', daysFromNow(-21), [group], 'completed');
  const e2 = await db.createEvent('Culto 2', daysFromNow(-14), [group], 'completed');
  const e3 = await db.createEvent('Culto 3', daysFromNow(-7), [group], 'scheduled');
  for (const e of [e1, e2]) {
    await db.recordAttendance(e, ana, group, false, coord.id);
    await db.recordAttendance(e, bia, group, true, coord.id);
  }
  return { coord, group, ana, bia, e3 };
}

test.describe('Chamada — 3 estados', () => {
  test('todo jovem começa "não registrado"; Presente/Ausente alternam e tocar no estado ativo (não salvo) desfaz', async ({ page, db, loginAs }) => {
    const { coord, eventId } = await seedMeeting(db);
    await loginAs(coord);
    await page.goto(`/chamada/${eventId}`);
    const ana = chamadaRow(page, 'Ana Souza');
    const save = page.getByRole('button', { name: SAVE });

    await expect(ana).toHaveAttribute('data-state', 'unregistered');
    await expect(ana.getByTestId('estado-texto')).toHaveText('Não registrado');
    await expect(page.getByRole('button', { name: 'Presente: Ana Souza' })).toHaveAttribute('aria-pressed', 'false');
    await expect(page.getByRole('button', { name: 'Ausente: Ana Souza' })).toHaveAttribute('aria-pressed', 'false');
    await expectCounters(page, { total: 3, presentes: 0, ausentes: 0, naoRegistrados: 3, percentual: '—' });
    await expect(save).toBeDisabled(); // nada marcado: não há o que salvar

    await markPresent(page, 'Ana Souza');
    await expect(ana).toHaveAttribute('data-state', 'present');
    await expect(ana.getByTestId('estado-texto')).toHaveText('Presente');
    await expect(page.getByRole('button', { name: 'Presente: Ana Souza' })).toHaveAttribute('aria-pressed', 'true');
    await expectCounters(page, { total: 3, presentes: 1, ausentes: 0, naoRegistrados: 2, percentual: '100%' });
    await expect(save).toBeEnabled();

    await markAbsent(page, 'Ana Souza'); // troca direta presente -> ausente
    await expect(ana).toHaveAttribute('data-state', 'absent');
    await expect(ana.getByTestId('estado-texto')).toHaveText('Ausente');
    await expectCounters(page, { total: 3, presentes: 0, ausentes: 1, naoRegistrados: 2, percentual: '0%' });

    await markAbsent(page, 'Ana Souza'); // tocar no ativo, linha ainda não salva: volta a "não registrado"
    await expect(ana).toHaveAttribute('data-state', 'unregistered');
    await expectCounters(page, { total: 3, presentes: 0, ausentes: 0, naoRegistrados: 3, percentual: '—' });
    await expect(save).toBeDisabled();
  });

  test('"não registrado" NÃO é falta: salvar sem marcar a Ana não cria linha nem alerta', async ({ page, db, loginAs }) => {
    const { coord, ana, e3 } = await seedAbsenceScenario(db);
    await loginAs(coord);
    await page.goto(`/chamada/${e3}`);

    await markPresent(page, 'Bia Lima'); // Ana fica sem estado
    await expect(page.getByTestId('aviso-sem-registro')).toHaveText('1 jovem ficará sem registro');
    await page.getByRole('button', { name: SAVE }).click();

    await expect(page.getByTestId('chamada-resumo')).toBeVisible();
    await expect(page.getByText('Nenhum novo alerta.')).toBeVisible();
    expect(await db.sql(`SELECT 1 FROM attendance WHERE event_id = $1 AND youth_id = $2`, [e3, ana])).toHaveLength(0);
    expect(await db.sql(`SELECT 1 FROM alerts`)).toHaveLength(0);
    await page.goto('/alertas');
    await expect(page.getByText('Nenhum alerta aberto. Tudo em dia!')).toBeVisible();

    // a mesma Ana, agora marcada AUSENTE de propósito, completa 3 faltas e gera o alerta (contraste)
    await page.goBack();
    await markAbsent(page, 'Ana Souza');
    await page.getByRole('button', { name: SAVE }).click();
    await expect(page.getByTestId('chamada-novos-alertas')).toContainText('Ana Souza');
    expect(await db.sql(`SELECT consecutive_absences, status FROM alerts`)).toEqual([{ consecutive_absences: 3, status: 'open' }]);
  });
});

test.describe('Chamada — busca, filtros e ação em lote', () => {
  async function seedFiltering(db: TestDb) {
    const coord = await db.createUser('coordinator', 'Carla Coordenadora');
    const alfa = await db.createGroup('Grupo Alfa', coord.id);
    const beta = await db.createGroup('Grupo Beta', coord.id);
    await db.createYouth('Ana Souza', alfa);
    await db.createYouth('Bruno Lima', alfa);
    await db.createYouth('Carlos Dias', alfa);
    await db.createYouth('José Álvares', alfa);
    await db.createYouth('Daniela Dias', beta);
    const eventId = await db.createEvent('Culto de Jovens', daysFromNow(-1), [alfa, beta]);
    return { coord, eventId };
  }
  const chip = (page: import('@playwright/test').Page, label: string) => page.getByRole('button', { name: label, exact: true });

  test('busca (sem acento/caixa) e filtros por estado e por grupo, com contagens coerentes', async ({ page, db, loginAs }) => {
    const { coord, eventId } = await seedFiltering(db);
    await loginAs(coord);
    await page.goto(`/chamada/${eventId}`);
    const names = () => page.getByTestId('chamada-jovem');

    await markPresent(page, 'Ana Souza');
    await markAbsent(page, 'Bruno Lima');
    await markAbsent(page, 'José Álvares');

    await expect(chip(page, 'Todos (5)')).toHaveAttribute('aria-pressed', 'true');
    await expect(chip(page, 'Não registrados (2)')).toBeVisible();
    await expect(chip(page, 'Presentes (1)')).toBeVisible();
    await expect(chip(page, 'Ausentes (2)')).toBeVisible();

    await chip(page, 'Não registrados (2)').click();
    await expect(names()).toHaveText([/Carlos Dias/, /Daniela Dias/]);
    await chip(page, 'Presentes (1)').click();
    await expect(names()).toHaveText([/Ana Souza/]);
    await chip(page, 'Ausentes (2)').click();
    await expect(names()).toHaveText([/Bruno Lima/, /José Álvares/]);
    await chip(page, 'Todos (5)').click();
    await expect(names()).toHaveCount(5);

    // busca sem acento nem caixa; as contagens dos chips acompanham a busca, os contadores do topo não
    await page.getByLabel('Buscar jovem').fill('JOSE');
    await expect(names()).toHaveText([/José Álvares/]);
    await expect(chip(page, 'Todos (1)')).toBeVisible();
    await expect(chip(page, 'Não registrados (0)')).toBeVisible();
    await expect(chip(page, 'Ausentes (1)')).toBeVisible();
    await expectCounters(page, { total: 5, presentes: 1, ausentes: 2, naoRegistrados: 2 });

    await page.getByLabel('Buscar jovem').fill('dias');
    await expect(names()).toHaveText([/Carlos Dias/, /Daniela Dias/]);
    await expect(chip(page, 'Todos (2)')).toBeVisible();
    await expect(chip(page, 'Não registrados (2)')).toBeVisible();

    await page.getByLabel('Buscar jovem').fill('');
    await page.getByLabel('Filtrar por grupo').selectOption({ label: 'Grupo Beta' });
    await expect(names()).toHaveText([/Daniela Dias/]);
    await expect(chip(page, 'Todos (1)')).toBeVisible();
    await expect(chip(page, 'Não registrados (1)')).toBeVisible();
    await expect(chip(page, 'Presentes (0)')).toBeVisible();

    await page.getByLabel('Buscar jovem').fill('zzz');
    await expect(page.getByText('Nenhum jovem encontrado com os filtros atuais.')).toBeVisible();
    await expect(names()).toHaveCount(0);
  });

  test('ação em lote só afeta quem está "não registrado" e visível; nunca sobrescreve Ausente/Presente', async ({ page, db, loginAs }) => {
    const { coord, eventId } = await seedFiltering(db);
    await loginAs(coord);
    await page.goto(`/chamada/${eventId}`);
    const batch = page.getByRole('button', { name: BATCH });

    await markAbsent(page, 'Bruno Lima');
    await markPresent(page, 'Ana Souza');

    // com o chip "Ausentes" ativo não há nenhum não registrado visível: botão desabilitado
    await page.getByRole('button', { name: /^Ausentes \(/ }).click();
    await expect(batch).toBeDisabled();
    await page.getByRole('button', { name: /^Todos \(/ }).click();

    // escopo = busca "daniela": só ela está visível e sem estado
    await page.getByLabel('Buscar jovem').fill('daniela');
    await batch.click();
    await expect(chamadaRow(page, 'Daniela Dias')).toHaveAttribute('data-state', 'present');
    await expect(batch).toBeDisabled(); // não sobrou ninguém sem estado dentro do escopo
    await page.getByLabel('Buscar jovem').fill('');
    // fora do escopo: nada mudou
    await expect(chamadaRow(page, 'Carlos Dias')).toHaveAttribute('data-state', 'unregistered');
    await expect(chamadaRow(page, 'José Álvares')).toHaveAttribute('data-state', 'unregistered');
    await expect(chamadaRow(page, 'Bruno Lima')).toHaveAttribute('data-state', 'absent');
    await expectCounters(page, { total: 5, presentes: 2, ausentes: 1, naoRegistrados: 2 });

    // sem filtro: marca os 2 que restam como presentes, o ausente explícito permanece ausente
    await batch.click();
    await expect(chamadaRow(page, 'Carlos Dias')).toHaveAttribute('data-state', 'present');
    await expect(chamadaRow(page, 'José Álvares')).toHaveAttribute('data-state', 'present');
    await expect(chamadaRow(page, 'Bruno Lima')).toHaveAttribute('data-state', 'absent');
    await expectCounters(page, { total: 5, presentes: 4, ausentes: 1, naoRegistrados: 0, percentual: '80%' });
    await expect(page.getByTestId('aviso-sem-registro')).toHaveCount(0);
    await expect(batch).toBeDisabled();
  });
});

test.describe('Chamada — salvar e resumo', () => {
  test('salva só quem foi marcado (sem linhas para não registrados) e mostra o resumo com números e "Nenhum novo alerta."', async ({ page, db, loginAs }) => {
    const { coord, ana, bruno, carlos, eventId } = await seedMeeting(db);
    await loginAs(coord);
    await page.goto(`/chamada/${eventId}`);

    await markPresent(page, 'Ana Souza');
    await markAbsent(page, 'Bruno Lima'); // Carlos fica sem estado
    await expect(page.getByTestId('aviso-sem-registro')).toHaveText('1 jovem ficará sem registro');
    await page.getByRole('button', { name: SAVE }).click();

    const summary = page.getByTestId('chamada-resumo');
    await expect(summary.getByRole('heading', { name: 'Chamada registrada.' })).toBeVisible();
    await expect(page.getByTestId('chamada-resumo-numeros')).toHaveText('2 registrados · 1 presente · 1 ausente · 50% · de 3 jovens');
    await expect(summary.getByText('Nenhum novo alerta.')).toBeVisible();
    await expect(page.getByTestId('chamada-novos-alertas')).toHaveCount(0);
    // sem navegação automática
    await expect(page).toHaveURL(new RegExp(`/chamada/${eventId}$`));
    await page.waitForTimeout(500);
    await expect(page).toHaveURL(new RegExp(`/chamada/${eventId}$`));
    await expect(summary).toBeVisible();

    const rows = await db.sql<{ youth_id: string; present: boolean }>(`SELECT youth_id, present FROM attendance WHERE event_id = $1`, [eventId]);
    expect(Object.fromEntries(rows.map((r) => [r.youth_id, r.present]))).toEqual({ [ana]: true, [bruno]: false });
    expect(rows.map((r) => r.youth_id)).not.toContain(carlos); // não registrado = sem linha
    const [ev] = await db.sql(`SELECT status FROM events WHERE id = $1`, [eventId]);
    expect(ev.status).toBe('completed'); // coordenador: "marcar como realizado" vem marcado
    expect(await db.sql(`SELECT 1 FROM alerts`)).toHaveLength(0);

    // "Continuar editando" volta à lista, com Carlos ainda sem estado
    await summary.getByRole('button', { name: 'Continuar editando' }).click();
    await expect(chamadaRow(page, 'Carlos Dias')).toHaveAttribute('data-state', 'unregistered');
    await expect(page.getByText('Chamada já registrada — você está editando.')).toBeVisible();
  });

  test('desmarcar "Marcar encontro como realizado" mantém o encontro agendado', async ({ page, db, loginAs }) => {
    const { coord, eventId } = await seedMeeting(db);
    await loginAs(coord);
    await page.goto(`/chamada/${eventId}`);

    await page.getByLabel('Marcar encontro como realizado').uncheck();
    await markPresent(page, 'Ana Souza');
    await page.getByRole('button', { name: SAVE }).click();

    await expect(page.getByTestId('chamada-resumo')).toBeVisible();
    const [ev] = await db.sql(`SELECT status FROM events WHERE id = $1`, [eventId]);
    expect(ev.status).toBe('scheduled');
  });

  test('a falta que completa o limite lista o NOVO alerta (atenção) no painel e leva a /alertas', async ({ page, db, loginAs }) => {
    const { coord, e3 } = await seedAbsenceScenario(db);
    await loginAs(coord);
    await page.goto(`/chamada/${e3}`);

    await markPresent(page, 'Bia Lima');
    await markAbsent(page, 'Ana Souza');
    await page.getByRole('button', { name: SAVE }).click();

    const novos = page.getByTestId('chamada-novos-alertas');
    await expect(novos).toBeVisible();
    await expect(novos).toContainText('Novas situações que pedem atenção');
    await expect(novos.locator('li')).toHaveCount(1);
    await expect(novos.locator('li')).toContainText('Ana Souza');
    await expect(novos.locator('li')).toContainText('3 faltas seguidas');
    await expect(novos.locator('li')).not.toContainText('Crítico');
    await expect(page.getByText('Nenhum novo alerta.')).toHaveCount(0);

    await novos.getByRole('link', { name: 'Ver alertas' }).click();
    await expect(page).toHaveURL(/\/alertas$/);
    await expect(page.locator('main li', { hasText: 'Ana Souza' })).toBeVisible();
  });

  test('nova falta CRÍTICA aparece no painel com o selo "Crítico"', async ({ page, db, loginAs }) => {
    const { coord, e3 } = await seedAbsenceScenario(db);
    // limite crítico = limite de alerta (3): o alerta já nasce crítico ao completar 3 faltas
    await db.sql(`UPDATE app_settings SET critical_absence_threshold = 3`);
    await loginAs(coord);
    await page.goto(`/chamada/${e3}`);

    await markAbsent(page, 'Ana Souza');
    await markPresent(page, 'Bia Lima');
    await page.getByRole('button', { name: SAVE }).click();

    const novos = page.getByTestId('chamada-novos-alertas');
    await expect(novos.locator('li')).toHaveCount(1);
    await expect(novos.locator('li')).toContainText('Ana Souza');
    await expect(novos.locator('li')).toContainText('3 faltas seguidas · Crítico');
    expect(await db.sql(`SELECT severity FROM alerts`)).toEqual([{ severity: 'critical' }]);
  });

  test('linha já salva não volta a "não registrado": tocar no estado ativo não apaga o registro', async ({ page, db, loginAs }) => {
    const { coord, group, ana, bruno, eventId } = await seedMeeting(db);
    await db.recordAttendance(eventId, ana, group, true, coord.id);
    await db.recordAttendance(eventId, bruno, group, false, coord.id);
    await loginAs(coord);
    await page.goto(`/chamada/${eventId}`);

    // salva no banco (carregada): tocar no ativo não muda nada
    await markPresent(page, 'Ana Souza');
    await markAbsent(page, 'Bruno Lima');
    await expect(chamadaRow(page, 'Ana Souza')).toHaveAttribute('data-state', 'present');
    await expect(chamadaRow(page, 'Bruno Lima')).toHaveAttribute('data-state', 'absent');
    await expectCounters(page, { total: 3, presentes: 1, ausentes: 1, naoRegistrados: 1 });

    // salva nesta sessão (Carlos): depois de salvar, também não "desmarca"
    await markPresent(page, 'Carlos Dias');
    await page.getByRole('button', { name: SAVE }).click();
    await page.getByTestId('chamada-resumo').getByRole('button', { name: 'Continuar editando' }).click();
    await markPresent(page, 'Carlos Dias');
    await expect(chamadaRow(page, 'Carlos Dias')).toHaveAttribute('data-state', 'present');
    await expectCounters(page, { total: 3, presentes: 2, ausentes: 1, naoRegistrados: 0 });

    // mudar para o outro estado continua permitido
    await markAbsent(page, 'Carlos Dias');
    await expect(chamadaRow(page, 'Carlos Dias')).toHaveAttribute('data-state', 'absent');

    const rows = await db.sql<{ present: boolean }>(`SELECT present FROM attendance WHERE event_id = $1`, [eventId]);
    expect(rows).toHaveLength(3);
  });
});

test.describe('Chamada — permissões e erros', () => {
  test('líder só vê e salva jovens dos seus grupos; a RPC rejeita jovem de outro grupo', async ({ page, db, loginAs }) => {
    const lia = await db.createUser('leader', 'Lia Lider');
    const davi = await db.createUser('leader', 'Davi Lider');
    const gLia = await db.createGroup('Grupo da Lia', lia.id);
    const gDavi = await db.createGroup('Grupo do Davi', davi.id);
    const ana = await db.createYouth('Ana Souza', gLia);
    const bia = await db.createYouth('Bia Lima', gLia);
    const zeca = await db.createYouth('Zeca Alheio', gDavi);
    const eventId = await db.createEvent('Culto Geral', daysFromNow(-1), [gLia, gDavi]);
    await loginAs(lia);
    await page.goto(`/chamada/${eventId}`);

    await expect(page.getByTestId('chamada-jovem')).toHaveText([/Ana Souza/, /Bia Lima/]);
    await expect(page.getByText('Zeca Alheio')).toHaveCount(0);
    await expect(page.getByText('Grupo do Davi')).toHaveCount(0);
    await expect(page.getByLabel('Filtrar por grupo')).toHaveCount(0); // só um grupo visível
    await expectCounters(page, { total: 2, presentes: 0, ausentes: 0, naoRegistrados: 2 });

    await markPresent(page, 'Ana Souza');
    await markAbsent(page, 'Bia Lima');
    await page.getByRole('button', { name: SAVE }).click();
    await expect(page.getByTestId('chamada-resumo-numeros')).toHaveText('2 registrados · 1 presente · 1 ausente · 50%');
    await expect(page.getByTestId('chamada-resumo-de-total')).toHaveCount(0); // todos os jovens visíveis foram registrados

    const rows = await db.sql<{ youth_id: string; present: boolean; recorded_by: string }>(`SELECT youth_id, present, recorded_by FROM attendance`);
    expect(Object.fromEntries(rows.map((r) => [r.youth_id, r.present]))).toEqual({ [ana]: true, [bia]: false });
    expect(new Set(rows.map((r) => r.recorded_by))).toEqual(new Set([lia.id]));

    // adulteração: chamar a RPC direto com um jovem do grupo do Davi
    const status = await page.evaluate(
      async ([key, url, anon, ev, youthId]) => {
        const session = JSON.parse(localStorage.getItem(key)!);
        const res = await fetch(`${url}/rest/v1/rpc/save_attendance`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', apikey: anon, authorization: `Bearer ${session.access_token}` },
          body: JSON.stringify({ p_event_id: ev, p_entries: [{ youth_id: youthId, present: false }] }),
        });
        return res.status;
      },
      [AUTH_STORAGE_KEY, SUPABASE_URL, ANON_KEY, eventId, zeca] as const,
    );
    expect(status).toBeGreaterThanOrEqual(400);
    expect(await db.sql(`SELECT 1 FROM attendance WHERE youth_id = $1`, [zeca])).toHaveLength(0);
  });

  test('encontro cancelado é somente leitura: sem marcar, sem lote, sem salvar', async ({ page, db, loginAs }) => {
    const coord = await db.createUser('coordinator', 'Carla Coordenadora');
    const group = await db.createGroup('Grupo Alfa', coord.id);
    const ana = await db.createYouth('Ana Souza', group);
    await db.createYouth('Bruno Lima', group);
    const eventId = await db.createEvent('Culto Cancelado', daysFromNow(-1), [group], 'cancelled');
    await db.recordAttendance(eventId, ana, group, true, coord.id);
    await loginAs(coord);
    await page.goto(`/chamada/${eventId}`);

    await expect(page.getByText('Este encontro foi cancelado. A chamada não pode ser alterada e não conta na frequência.')).toBeVisible();
    await expect(chamadaRow(page, 'Ana Souza')).toHaveAttribute('data-state', 'present');
    await expect(chamadaRow(page, 'Bruno Lima')).toHaveAttribute('data-state', 'unregistered');
    for (const name of ['Presente: Ana Souza', 'Ausente: Ana Souza', 'Presente: Bruno Lima', 'Ausente: Bruno Lima']) {
      await expect(page.getByRole('button', { name })).toBeDisabled();
    }
    await expect(page.getByRole('button', { name: BATCH })).toBeDisabled();
    await expect(page.getByRole('button', { name: SAVE })).toBeDisabled();
    await expect(page.getByLabel('Marcar encontro como realizado')).toHaveCount(0);

    // o estado continua intacto, inclusive depois de recarregar
    await page.reload();
    await expect(chamadaRow(page, 'Ana Souza')).toHaveAttribute('data-state', 'present');
    expect(await db.sql(`SELECT 1 FROM attendance WHERE event_id = $1`, [eventId])).toHaveLength(1);
  });

  test('erro do servidor (500) mostra mensagem amigável sem texto cru, mantém as marcações e permite tentar de novo', async ({ page, db, loginAs }) => {
    const { coord, ana, eventId } = await seedMeeting(db);
    await loginAs(coord);
    await page.route('**/rest/v1/rpc/save_attendance*', (route) =>
      route.fulfill({
        status: 500, contentType: 'application/json',
        body: JSON.stringify({ code: 'XX000', message: 'relation "attendance_secret" violates constraint pg_internal_7', details: 'stack', hint: 'x' }),
      }), { times: 1 });
    await page.goto(`/chamada/${eventId}`);
    await markPresent(page, 'Ana Souza');
    await markAbsent(page, 'Bruno Lima');

    await page.getByRole('button', { name: SAVE }).click();

    await expect(page.getByText('Erro ao salvar chamada.')).toBeVisible();
    await expect(page.getByText(/attendance_secret|pg_internal|violates|constraint/i)).toHaveCount(0);
    await expect(page.getByTestId('chamada-resumo')).toHaveCount(0);
    await expect(chamadaRow(page, 'Ana Souza')).toHaveAttribute('data-state', 'present');
    await expect(chamadaRow(page, 'Bruno Lima')).toHaveAttribute('data-state', 'absent');
    expect(await db.sql(`SELECT 1 FROM attendance`)).toHaveLength(0);

    // segunda tentativa (sem o erro simulado) funciona e limpa a mensagem
    await expect(page.getByRole('button', { name: SAVE })).toBeEnabled();
    await page.getByRole('button', { name: SAVE }).click();
    await expect(page.getByTestId('chamada-resumo')).toBeVisible();
    expect(await db.sql(`SELECT youth_id FROM attendance WHERE present`)).toEqual([{ youth_id: ana }]);
  });

  test('encontro cancelado por outra pessoa durante a edição: mostra a regra do banco e não grava nada', async ({ page, db, loginAs }) => {
    const { coord, eventId } = await seedMeeting(db);
    await loginAs(coord);
    await page.goto(`/chamada/${eventId}`);
    await markPresent(page, 'Ana Souza');

    await db.sql(`UPDATE events SET status = 'cancelled' WHERE id = $1`, [eventId]);
    await page.getByRole('button', { name: SAVE }).click();

    await expect(page.getByText('Encontro cancelado: não é possível registrar chamada.')).toBeVisible();
    await expect(page.getByTestId('chamada-resumo')).toHaveCount(0);
    expect(await db.sql(`SELECT 1 FROM attendance`)).toHaveLength(0);
  });
});
