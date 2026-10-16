// Histórico operacional (Fase 7, bloco 9): tabela activity_log alimentada pelos triggers reais (migration 014).
// Ações são feitas com a sessão de um usuário (RPCs e tabelas exatamente como o app as chama) ou pela tela;
// ações do banco sem sessão (db.sql) não geram histórico, por desenho.
// O e-mail (communication_sent, migration 015) tem testes próprios, fora deste arquivo.
import type { Page } from '@playwright/test';
import type { Browser } from '@playwright/test';
import {
  answerConfirmation, api, brDate, daysFromNow, expect, injectSession, markAbsent, markPresent, modal, passwordSession,
  spDay, test, type TestDb, type TestUser,
} from './fixtures.ts';
import { ANON_KEY, APP_URL, SUPABASE_URL } from './env.ts';
import { bulkYouth, seedPeople } from './phase7-helpers.ts';

const SECRET = 'SEGREDO-9f3a';

const rows = (page: Page) => page.getByTestId('historico-linha');

/** Página de outro usuário (contexto separado do navegador, com sessão própria). */
async function pageAs(browser: Browser, user: TestUser) {
  const ctx = await browser.newContext({ baseURL: APP_URL, locale: 'pt-BR', timezoneId: 'America/Sao_Paulo' });
  const page = await ctx.newPage();
  await injectSession(page, await passwordSession(user));
  return { page, close: () => ctx.close() };
}

interface World {
  carla: TestUser;
  lia: TestUser;
  davi: TestUser;
  alfa: string;
  beta: string;
  ana: string;
  bia: string;
  caio: string;
  edu: string;
  culto: string;
}

async function seedWorld(db: TestDb): Promise<World> {
  const p = await seedPeople(db);
  const ana = await db.createYouth('Ana Souza', p.alfa);
  const bia = await db.createYouth('Bia Lima', p.alfa);
  const caio = await db.createYouth('Caio Alheio', p.beta);
  const edu = await db.createYouth('Edu Inativo', p.alfa);
  await db.sql(`UPDATE youth SET is_active = false WHERE id = $1`, [edu]);
  // 3 faltas seguidas da Bia e do Caio (gravadas direto no banco: sem sessão, não entram no histórico)
  for (const [i, d] of [28, 21, 14].entries()) {
    const a = await db.createEvent(`Culto Alfa ${i}`, daysFromNow(-d), [p.alfa], 'completed');
    await db.recordAttendance(a, bia, p.alfa, false, p.carla.id);
    const b = await db.createEvent(`Culto Beta ${i}`, daysFromNow(-d), [p.beta], 'completed');
    await db.recordAttendance(b, caio, p.beta, false, p.carla.id);
  }
  const culto = await db.createEvent('Culto de Hoje', daysFromNow(-1), [p.alfa], 'completed');
  return { carla: p.carla, lia: p.lia, davi: p.davi, alfa: p.alfa, beta: p.beta, ana, bia, caio, edu, culto };
}

const openAlert = async (db: TestDb, youth: string) =>
  (await db.sql<{ id: string }>(`SELECT id FROM alerts WHERE youth_id = $1 AND type = 'consecutive_absences' AND status = 'open'`, [youth]))[0].id;

/** Percorre os fluxos reais, na ordem, com a sessão da Carla. A página precisa estar dentro do app. Textos livres levam SECRET. */
async function runFlows(page: Page, db: TestDb, w: World) {
  const ok = (r: { status: number; body: any }, what: string) => expect(r.status, `${what}: ${JSON.stringify(r.body)}`).toBeLessThan(300);

  ok(await api(page, 'POST', 'rpc/save_attendance', {
    p_event_id: w.culto, p_entries: [{ youth_id: w.ana, present: true }, { youth_id: w.bia, present: false }],
  }), 'chamada');

  const fu = await api(page, 'POST', 'follow_ups', {
    youth_id: w.ana, reason: `${SECRET} motivo`, notes: `${SECRET} observação`, next_action: `${SECRET} ação`,
    next_action_due: spDay(3), type: 'conversation', responsible_id: w.carla.id, created_by: w.carla.id,
  });
  ok(fu, 'acompanhamento');
  ok(await api(page, 'POST', 'rpc/transfer_follow_up', {
    p_follow_up_id: fu.body[0].id, p_new_responsible_id: w.lia.id, p_reason: `${SECRET} transferência`,
  }), 'transferência');

  const task = await api(page, 'POST', 'tasks', {
    title: `${SECRET} tarefa`, description: `${SECRET} descrição`, youth_id: w.ana, assigned_to: w.carla.id,
    priority: 'medium', created_by: w.carla.id,
  });
  ok(task, 'tarefa');
  ok(await api(page, 'PATCH', `tasks?id=eq.${task.body[0].id}`, { status: 'done' }), 'tarefa concluída');

  ok(await api(page, 'PATCH', `alerts?id=eq.${await openAlert(db, w.caio)}`, { status: 'dismissed', resolution_notes: `${SECRET} nota` }), 'alerta dispensado');
  ok(await api(page, 'PATCH', `alerts?id=eq.${await openAlert(db, w.bia)}`, { status: 'resolved', resolution_notes: `${SECRET} resolvido` }), 'alerta resolvido');

  ok(await api(page, 'POST', 'rpc/batch_set_youth_group', { p_youth_ids: [w.caio], p_group_id: w.alfa }), 'troca de grupo');
  ok(await api(page, 'POST', 'rpc/batch_set_youth_active', { p_youth_ids: [w.bia], p_active: false }), 'inativar');
  ok(await api(page, 'POST', 'rpc/batch_set_youth_active', { p_youth_ids: [w.edu], p_active: true }), 'reativar');
  ok(await api(page, 'POST', 'rpc/create_event_series', {
    p_name: `${SECRET} série`, p_weekday: 6, p_start_time: '19:00', p_recurrence: 'weekly',
    p_start_date: '2030-01-01', p_end_date: '2030-01-31', p_description: `${SECRET} desc`, p_group_ids: [w.alfa],
  }), 'série');
}

const EXPECTED = [
  ['event_series_created', 'Série de encontros criada', 'Série de encontros criada.'],
  ['youth_activated', 'Jovem reativado', 'Jovem reativado.'],
  ['youth_deactivated', 'Jovem inativado', 'Jovem inativado.'],
  ['youth_group_changed', 'Grupo do jovem alterado', 'Grupo do jovem alterado.'],
  ['alert_resolved', 'Alerta resolvido', 'Alerta resolvido.'],
  ['alert_dismissed', 'Alerta dispensado', 'Alerta dispensado.'],
  ['task_completed', 'Ação concluída', 'Ação concluída.'],
  ['task_created', 'Ação criada', 'Ação criada.'],
  ['follow_up_transferred', 'Acompanhamento transferido', 'Acompanhamento transferido para outro responsável.'],
  ['follow_up_created', 'Acompanhamento registrado', 'Acompanhamento registrado.'],
  ['attendance_recorded', 'Chamada registrada', 'Chamada registrada: 1 presente e 1 ausente.'],
] as const;

test.describe('Histórico — o que é registrado', () => {
  test('cada fluxo real gera uma entrada com texto fixo, na ordem, sem nada digitado pelos usuários', async ({ page, db, loginAs }) => {
    const w = await seedWorld(db);
    expect(await db.sql(`SELECT 1 FROM activity_log`)).toHaveLength(0); // dados do banco sem sessão não geram histórico
    await loginAs(w.carla);
    await page.goto('/historico');
    await runFlows(page, db, w);

    // banco: uma entrada por ação, tipos esperados, nenhum texto sensível em summary/meta
    const log = await db.sql<{ action: string; summary: string }>(`SELECT action, summary FROM activity_log ORDER BY occurred_at DESC, id DESC`);
    expect(log.map((l) => l.action)).toEqual(EXPECTED.map((e) => e[0]));
    expect(await db.sql(`SELECT 1 FROM activity_log WHERE activity_log::text ILIKE '%segredo%'`)).toHaveLength(0);
    // as resoluções automáticas (inativar a Bia resolveu alertas dela) NÃO entram
    expect(log.filter((l) => l.action === 'alert_resolved')).toHaveLength(1);

    await page.goto('/historico');
    await expect(page.getByRole('heading', { name: 'Histórico' })).toBeVisible();
    await expect(rows(page)).toHaveCount(11);
    for (const [i, [, label, summary]] of EXPECTED.entries()) {
      const row = rows(page).nth(i);
      await expect(row, label).toContainText(label);
      await expect(row, summary).toContainText(summary);
      await expect(row).toContainText('Carla Coordenadora');
      await expect(row).toContainText(brDate(spDay(0)));
    }
    // jovem ligado à entrada vira link para a ficha; chamada e série não têm jovem
    await expect(rows(page).nth(10).getByTestId('historico-jovem')).toHaveCount(0);
    await expect(rows(page).nth(0).getByTestId('historico-jovem')).toHaveCount(0);
    await expect(rows(page).nth(9).getByTestId('historico-jovem')).toHaveText('Ana Souza');
    await expect(rows(page).nth(9).getByTestId('historico-jovem')).toHaveAttribute('href', `/jovens?ficha=${w.ana}`);

    // nenhum texto sensível digitado (motivo, observação, nota, título) aparece na tela
    await expect(page.locator('body')).not.toContainText(SECRET);
    await expect(page.locator('body')).not.toContainText('transferência');
  });

  test('os fluxos pela tela (chamada, tarefa, lote, série) também aparecem', async ({ page, db, loginAs }) => {
    const w = await seedWorld(db);
    const t = await db.createTask('Preparar lanche', { createdBy: w.carla.id, assignedTo: w.carla.id, youthId: w.ana });
    expect(t).toBeTruthy();
    await loginAs(w.carla);

    // chamada pela tela
    await page.goto(`/chamada/${w.culto}`);
    await markPresent(page, 'Ana Souza');
    await markAbsent(page, 'Bia Lima');
    await page.getByRole('button', { name: 'Salvar Chamada' }).click();
    await expect(page.getByTestId('chamada-resumo')).toBeVisible();

    // tarefa concluída pela tela
    await page.goto('/tarefas');
    await page.locator('main li', { hasText: 'Preparar lanche' }).getByRole('button', { name: 'Concluir' }).click();
    await expect(page.locator('main li', { hasText: 'Preparar lanche' })).toHaveCount(0);

    // lote: trocar grupo e desativar
    await page.goto('/jovens');
    await page.locator('table').getByRole('checkbox', { name: 'Selecionar Caio Alheio' }).check();
    await page.getByTestId('lote-alterar-grupo').click();
    await modal(page).getByLabel('Novo grupo').selectOption({ label: 'Grupo Alfa' });
    await modal(page).getByTestId('lote-grupo-aplicar').click();
    await expect(page.getByText('1 atualizado.')).toBeVisible();
    await page.locator('table').getByRole('checkbox', { name: 'Selecionar Bia Lima' }).check();
    await page.getByTestId('lote-desativar').click();
    await answerConfirmation(page, true);
    await expect(page.getByText('1 atualizado.').last()).toBeVisible();

    // série pela tela
    await page.goto('/encontros');
    await page.getByTestId('serie-nova').click();
    const m = modal(page);
    await m.getByLabel('Nome da série').fill('Culto Semanal');
    await m.getByLabel('Dia da semana').selectOption({ label: 'Sábado' });
    await m.getByLabel('Horário').fill('19:00');
    await m.getByLabel('Data inicial').fill('2030-01-01');
    await m.getByLabel('Data final').fill('2030-01-14');
    await m.getByLabel('Grupo Alfa', { exact: true }).check();
    await m.getByTestId('serie-revisar').click();
    await m.getByTestId('serie-confirmar').click();
    await expect(page.getByText('Série criada: 2 encontros criados.')).toBeVisible();

    await page.goto('/historico');
    await expect(rows(page)).toHaveCount(5); // a tarefa semeada direto no banco (sem sessão) não gera "Ação criada"
    const text = (await rows(page).allInnerTexts()).join('\n');
    for (const s of [
      'Série de encontros criada.', 'Jovem inativado.', 'Grupo do jovem alterado.', 'Ação concluída.',
      'Chamada registrada: 1 presente e 1 ausente.',
    ]) expect(text, s).toContain(s);
    expect(text).not.toContain('Ação criada.');
  });
});

test.describe('Histórico — filtros', () => {
  test('tipo de ação, jovem e combinações', async ({ page, db, loginAs }) => {
    const w = await seedWorld(db);
    await loginAs(w.carla);
    await page.goto('/historico');
    await runFlows(page, db, w);
    await page.goto('/historico');
    await expect(rows(page)).toHaveCount(11);

    const type = page.getByLabel('Filtrar por tipo de ação');
    const labels = await type.locator('option').allTextContents();
    expect(labels[0]).toBe('Todas as ações');
    for (const [, label] of EXPECTED) expect(labels).toContain(label);

    await type.selectOption({ label: 'Alerta dispensado' });
    await expect(rows(page)).toHaveCount(1);
    await expect(rows(page).first()).toContainText('Caio Alheio');
    await type.selectOption({ label: 'Chamada registrada' });
    await expect(rows(page)).toHaveCount(1);
    await type.selectOption('all');
    await expect(rows(page)).toHaveCount(11);

    // por jovem (nome): sem acento/maiúsculas não importa, só o trecho
    await page.getByLabel('Buscar por jovem').fill('ana');
    await expect(rows(page)).toHaveCount(4); // acompanhamento, transferência, ação criada e concluída
    for (const r of await rows(page).all()) await expect(r.getByTestId('historico-jovem')).toHaveText('Ana Souza');
    await type.selectOption({ label: 'Ação concluída' });
    await expect(rows(page)).toHaveCount(1);
    await type.selectOption('all');
    await page.getByLabel('Buscar por jovem').fill('zzzz');
    await expect(page.getByText('Nenhuma atividade encontrada para os filtros escolhidos.')).toBeVisible();
    await page.getByLabel('Buscar por jovem').fill('');
    await expect(rows(page)).toHaveCount(11);
  });

  test('período: pronto, personalizado (limites e validações) e "Todo o período"', async ({ page, db, loginAs }) => {
    const w = await seedWorld(db);
    await loginAs(w.carla);
    await page.goto('/historico');
    await runFlows(page, db, w);
    // recua 2 entradas no tempo (o banco permite a manutenção; clientes não): 45 dias e 100 dias atrás
    await db.sql(`UPDATE activity_log SET occurred_at = now() - interval '45 days' WHERE action = 'follow_up_created'`);
    await db.sql(`UPDATE activity_log SET occurred_at = now() - interval '100 days' WHERE action = 'task_created'`);

    await page.goto('/historico');
    const chip = (name: string) => page.getByRole('button', { name, exact: true });
    await expect(chip('Últimos 30 dias')).toHaveAttribute('aria-pressed', 'true');
    await expect(rows(page)).toHaveCount(9);

    await chip('Últimos 90 dias').click();
    await expect(rows(page)).toHaveCount(10); // + acompanhamento (45 dias)
    await chip('Todo o período').click();
    await expect(rows(page)).toHaveCount(11);
    await chip('Hoje').click();
    await expect(rows(page)).toHaveCount(9);
    await chip('Semana').click();
    await expect(rows(page).first()).toBeVisible();
    await chip('Mês').click();
    await expect(rows(page).first()).toBeVisible();

    // personalizado: validações
    await chip('Personalizado').click();
    await page.locator('#historico-de').fill(spDay(-1));
    await page.locator('#historico-ate').fill(spDay(-5));
    await expect(page.getByRole('alert')).toHaveText('A data inicial não pode ser posterior à data final.');
    // (observação: a lista anterior continua na tela enquanto o período está inválido; o importante é não consultar)
    let queries = 0;
    await page.route('**/rest/v1/activity_log*', (route) => { queries += 1; return route.continue(); });
    await page.locator('#historico-de').fill(spDay(-500));
    await page.locator('#historico-ate').fill(spDay(0));
    await expect(page.getByRole('alert')).toHaveText('O período pode ter no máximo 400 dias.');
    await page.waitForTimeout(500);
    const settled = queries;
    await page.locator('#historico-de').fill('');
    await expect(page.getByRole('alert')).toHaveText('Informe a data inicial e a data final.');
    await page.waitForTimeout(500);
    expect(queries).toBe(settled); // período inválido não consulta o servidor
    await page.unroute('**/rest/v1/activity_log*');

    // limites inclusivos nas duas pontas: do dia -50 ao dia -40 só o acompanhamento de 45 dias atrás
    await page.locator('#historico-de').fill(spDay(-50));
    await page.locator('#historico-ate').fill(spDay(-40));
    await expect(rows(page)).toHaveCount(1);
    await expect(rows(page).first()).toContainText('Acompanhamento registrado');
    // só o dia de hoje (ponta inclusiva) traz as 9 de hoje
    await page.locator('#historico-de').fill(spDay(0));
    await page.locator('#historico-ate').fill(spDay(0));
    await expect(rows(page)).toHaveCount(9);
    // período sem nada
    await page.locator('#historico-de').fill(spDay(-30));
    await page.locator('#historico-ate').fill(spDay(-10));
    await expect(page.getByText('Nenhuma atividade encontrada para os filtros escolhidos.')).toBeVisible();
  });

  // A busca por nome usa o embed `youth:youth_id!inner` filtrado no servidor. A versão antiga resolvia os ids dos jovens
  // antes e truncava em 200: com mais de 200 jovens casando com a busca, parte do histórico sumia.
  test('busca por nome de jovem com mais de 200 jovens que casam: o total é exato e todas as páginas existem', async ({ page, db, loginAs }) => {
    const w = await seedWorld(db);
    const marta = await bulkYouth(db, 'Marta', 260, w.alfa); // todos contêm "a"
    const bento = await bulkYouth(db, 'Bento', 3, w.alfa); // nenhum contém "a"
    await loginAs(w.carla);
    await page.goto('/historico');
    for (const ids of [marta.slice(0, 130), marta.slice(130), bento]) {
      const mv = await api(page, 'POST', 'rpc/batch_set_youth_group', { p_youth_ids: ids, p_group_id: w.beta });
      expect(mv.status, JSON.stringify(mv.body)).toBe(200);
    }
    expect(await db.sql(`SELECT 1 FROM activity_log WHERE action = 'youth_group_changed'`)).toHaveLength(263);

    await page.goto('/historico');
    await expect(page.getByText('Mostrando 1–25 de 263 registros')).toBeVisible();

    await page.getByLabel('Buscar por jovem').fill('a');
    await expect(page.getByText('Mostrando 1–25 de 260 registros')).toBeVisible(); // 260, não 200
    await expect(page.getByText('Página 1 de 11')).toBeVisible();
    await expect(page.locator('body')).not.toContainText('Bento');
    await expect(rows(page)).toHaveCount(25);

    // a última página existe e traz as 10 restantes (as linhas 251-260)
    for (let i = 0; i < 10; i++) await page.getByRole('button', { name: 'Próxima' }).click();
    await expect(page.getByText('Página 11 de 11')).toBeVisible();
    await expect(page.getByText('Mostrando 251–260 de 260 registros')).toBeVisible();
    await expect(rows(page)).toHaveCount(10);
    for (const r of await rows(page).all()) await expect(r.getByTestId('historico-jovem')).toContainText('Marta');

    // refinar a busca estreita no servidor, e a combinação com o tipo de ação continua exata
    await page.getByLabel('Buscar por jovem').fill('marta 25');
    await expect(rows(page)).toHaveCount(10); // Marta 250..259 ("marta 25" + 1 dígito); cabe em 1 página: sem paginação
    await expect(page.getByRole('navigation', { name: 'Paginação' })).toHaveCount(0);
    await page.getByLabel('Filtrar por tipo de ação').selectOption({ label: 'Grupo do jovem alterado' });
    await expect(rows(page)).toHaveCount(10);
    await page.getByLabel('Filtrar por tipo de ação').selectOption({ label: 'Chamada registrada' });
    await expect(page.getByText('Nenhuma atividade encontrada para os filtros escolhidos.')).toBeVisible();
  });

  test('paginação no servidor: 25 por página, ordem do mais recente e total correto', async ({ page, db, loginAs }) => {
    const w = await seedWorld(db);
    const many = await bulkYouth(db, 'Lote', 30, w.alfa);
    await loginAs(w.carla);
    await page.goto('/historico');
    const mv = await api(page, 'POST', 'rpc/batch_set_youth_group', { p_youth_ids: many, p_group_id: w.beta });
    expect(mv.status).toBe(200);

    await page.goto('/historico');
    await expect(rows(page)).toHaveCount(25);
    await expect(page.getByText('Mostrando 1–25 de 30 registros')).toBeVisible();
    await page.getByRole('button', { name: 'Próxima' }).click();
    await expect(page.getByText('Página 2 de 2')).toBeVisible();
    await expect(rows(page)).toHaveCount(5);
    await page.getByRole('button', { name: 'Anterior' }).click();
    await expect(rows(page)).toHaveCount(25);

    // mudar o filtro volta à página 1
    await page.getByRole('button', { name: 'Próxima' }).click();
    await page.getByLabel('Filtrar por tipo de ação').selectOption({ label: 'Grupo do jovem alterado' });
    await expect(page.getByText('Página 1 de 2')).toBeVisible();
  });
});

test.describe('Histórico — estados e links', () => {
  test('sem nenhuma atividade mostra o vazio; erro do servidor vira banner amigável', async ({ page, db, loginAs }) => {
    await loginAs(await db.createUser('coordinator', 'Carla Coordenadora'));
    await page.goto('/historico');
    await expect(page.getByText('Nenhuma atividade registrada ainda.')).toBeVisible();

    await page.route('**/rest/v1/activity_log*', (route) =>
      route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ code: 'XX000', message: 'relation "activity_log" corrompida' }) }));
    await page.reload();
    await expect(page.getByRole('alert')).toHaveText('Erro ao carregar o histórico.');
    await expect(page.locator('body')).not.toContainText('corrompida');
    await expect(page.getByRole('heading', { name: 'Histórico' })).toBeVisible();
  });

  test('/historico?jovem=<id> filtra o jovem, mostra o histórico inteiro e dá para remover o filtro', async ({ page, db, loginAs }) => {
    const w = await seedWorld(db);
    await loginAs(w.carla);
    await page.goto('/historico');
    await runFlows(page, db, w);
    await db.sql(`UPDATE activity_log SET occurred_at = now() - interval '60 days' WHERE action = 'task_created'`);

    await page.goto(`/historico?jovem=${w.ana}`);
    await expect(page.getByTestId('historico-filtro-jovem')).toContainText('Ana Souza');
    await expect(page.getByRole('button', { name: 'Todo o período' })).toHaveAttribute('aria-pressed', 'true'); // vindo da ficha: tudo
    await expect(rows(page)).toHaveCount(4);
    for (const r of await rows(page).all()) await expect(r.getByTestId('historico-jovem')).toHaveText('Ana Souza');

    await page.getByRole('button', { name: 'Remover filtro de jovem' }).click();
    await expect(page.getByTestId('historico-filtro-jovem')).toHaveCount(0);
    await expect(page).toHaveURL(/\/historico$/);
    await expect(rows(page).first()).toBeVisible();

    // id inválido é ignorado (sem erro)
    await page.goto('/historico?jovem=nao-e-um-id');
    await expect(page.getByTestId('historico-filtro-jovem')).toHaveCount(0);
    await expect(page.getByRole('alert')).toHaveCount(0);
  });

  test('"Histórico recente" na ficha do jovem e atalho "Ver tudo"', async ({ page, db, loginAs }) => {
    const w = await seedWorld(db);
    await loginAs(w.carla);
    await page.goto('/historico');
    await runFlows(page, db, w);

    await page.goto(`/jovens?ficha=${w.ana}`);
    const recent = page.getByTestId('historico-recente');
    await expect(recent.getByRole('heading', { name: 'Histórico recente' })).toBeVisible();
    await expect(recent.locator('li')).toHaveCount(4);
    await expect(recent).toContainText('Acompanhamento registrado.');
    await expect(recent).toContainText('Ação concluída.');
    await expect(recent).toContainText('por Carla Coordenadora');
    await expect(recent).not.toContainText(SECRET);
    await recent.getByRole('link', { name: 'Ver tudo' }).click();
    await expect(page).toHaveURL(new RegExp(`/historico\\?jovem=${w.ana}`));
    await expect(rows(page)).toHaveCount(4);
  });
});

test.describe('Histórico — líder e imutabilidade', () => {
  test('líder só vê o histórico dos jovens e grupos dele', async ({ page, browser, db, loginAs }) => {
    const w = await seedWorld(db);
    await loginAs(w.carla);
    await page.goto('/historico');
    // Carla: tarefa para a Ana (Alfa) e para o Caio (Beta); chamada do Culto Alfa e de um Culto Beta
    await api(page, 'POST', 'tasks', { title: 'T Ana', youth_id: w.ana, assigned_to: w.carla.id, priority: 'low', created_by: w.carla.id });
    await api(page, 'POST', 'tasks', { title: 'T Caio', youth_id: w.caio, assigned_to: w.carla.id, priority: 'low', created_by: w.carla.id });
    await api(page, 'POST', 'rpc/save_attendance', { p_event_id: w.culto, p_entries: [{ youth_id: w.ana, present: true }] });
    const [{ id: cultoBeta }] = await db.sql<{ id: string }>(`SELECT id FROM events WHERE title = 'Culto Beta 0'`);
    await api(page, 'POST', 'rpc/save_attendance', { p_event_id: cultoBeta, p_entries: [{ youth_id: w.caio, present: true }] });

    const { page: leader, close } = await pageAs(browser, w.lia);
    await leader.goto('/historico');

    // Lia vê: a ação criada da Ana e a chamada do grupo dela; nada do Caio nem do Culto Beta
    await expect(rows(leader)).toHaveCount(2);
    const texts = (await rows(leader).allInnerTexts()).join('\n');
    expect(texts).toContain('Ação criada.');
    expect(texts).toContain('Ana Souza');
    expect(texts).toContain('Chamada registrada: 1 presente e 0 ausentes.');
    expect(texts).not.toContain('Caio');
    const total = await api(leader, 'GET', 'activity_log?select=id');
    expect(total.body).toHaveLength(2);

    // mudança de grupo: líder do grupo novo vê, e o do antigo vê a saída (group_id = antigo)
    const lia = await api(page, 'POST', 'rpc/batch_set_youth_group', { p_youth_ids: [w.caio], p_group_id: w.alfa });
    expect(lia.status).toBe(200);
    await leader.reload();
    await expect(leader.locator('body')).toContainText('Grupo do jovem alterado.');
    await close();
  });

  test('o histórico é imutável: inserir, alterar e apagar via API adulterada falha', async ({ page, db, loginAs }) => {
    const w = await seedWorld(db);
    await loginAs(w.carla);
    await page.goto('/historico');
    await runFlows(page, db, w);
    const before = await db.sql(`SELECT id, summary, occurred_at::text AS at FROM activity_log ORDER BY id`);
    expect(before).toHaveLength(11);

    const del = await api(page, 'DELETE', 'activity_log?id=not.is.null');
    expect(del.status).toBe(403);
    const upd = await api(page, 'PATCH', 'activity_log?id=not.is.null', { summary: 'adulterado' });
    expect(upd.status).toBe(403);
    const ins = await api(page, 'POST', 'activity_log', { action: 'task_created', entity_type: 'task', summary: 'forjado', meta: {} });
    expect(ins.status).toBe(403);
    // nem o escritor interno é chamável
    const rpc = await api(page, 'POST', 'rpc/activity_write', {
      p_action: 'task_created', p_entity_type: 'task', p_entity_id: null, p_youth_id: null, p_group_id: null, p_summary: 'forjado',
    });
    expect(rpc.status).toBeGreaterThanOrEqual(400);

    const after = await db.sql(`SELECT id, summary, occurred_at::text AS at FROM activity_log ORDER BY id`);
    expect(after).toEqual(before);
    expect(await db.sql(`SELECT 1 FROM activity_log WHERE summary IN ('adulterado', 'forjado')`)).toHaveLength(0);
  });

  test('líder também não consegue alterar, apagar nem forjar entradas', async ({ page, browser, db, loginAs }) => {
    const w = await seedWorld(db);
    await loginAs(w.carla);
    await page.goto('/historico');
    await api(page, 'POST', 'tasks', { title: 'T Ana', youth_id: w.ana, assigned_to: w.carla.id, priority: 'low', created_by: w.carla.id });
    const { page: leader, close } = await pageAs(browser, w.lia);
    await leader.goto('/historico');
    await expect(rows(leader)).toHaveCount(1);

    expect((await api(leader, 'DELETE', 'activity_log?id=not.is.null')).status).toBe(403);
    expect((await api(leader, 'PATCH', 'activity_log?id=not.is.null', { summary: 'adulterado' })).status).toBe(403);
    expect((await api(leader, 'POST', 'activity_log', { action: 'task_created', entity_type: 'task', summary: 'forjado', meta: {} })).status).toBe(403);
    const rows1 = await db.sql<{ summary: string }>(`SELECT summary FROM activity_log`);
    expect(rows1).toEqual([{ summary: 'Ação criada.' }]);

    // anônimo não lê nada
    const anon = await page.evaluate(async ([url, key]) => {
      const res = await fetch(`${url}/rest/v1/activity_log?select=id`, { headers: { apikey: key, authorization: `Bearer ${key}` } });
      return { status: res.status };
    }, [SUPABASE_URL, ANON_KEY] as const);
    expect([401, 403]).toContain(anon.status);
    await close();
  });
});
