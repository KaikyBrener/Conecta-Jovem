import { daysFromNow, expect, markAbsent, markPresent, modal, test, type TestDb, type TestUser } from './fixtures.ts';

/**
 * Cenário: Ana faltou nos 2 últimos encontros realizados (limite padrão = 3 faltas
 * consecutivas); Bia compareceu. Um 3º encontro está agendado e ainda sem chamada.
 */
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

/**
 * Salva a chamada do 3º encontro com a Bia presente e a Ana AUSENTE (marcada explicitamente:
 * "não registrado" não é falta) → Ana chega a 3 faltas.
 */
async function saveThirdAttendance(page: import('@playwright/test').Page, eventId: string) {
  await page.goto(`/chamada/${eventId}`);
  await markPresent(page, 'Bia Lima');
  await markAbsent(page, 'Ana Souza');
  await page.getByRole('button', { name: 'Salvar Chamada' }).click();
  // o painel de resumo aparece (sem navegação automática) já listando o alerta recém-criado
  await expect(page.getByTestId('chamada-resumo')).toBeVisible();
  await expect(page.getByTestId('chamada-novos-alertas')).toContainText('Ana Souza');
  // não há mais navegação automática: o usuário volta pelo botão (mesmo estado final de antes: /encontros)
  await page.getByTestId('chamada-resumo').getByRole('button', { name: 'Voltar aos encontros' }).click();
  await expect(page).toHaveURL(/\/encontros$/);
}

test.describe('Alertas de faltas', () => {
  test('salvar a chamada que completa o limite abre um alerta visível em /alertas e no menu', async ({ page, db, loginAs }) => {
    const { coord, e3 } = await seedAbsenceScenario(db);
    await loginAs(coord);

    // antes da 3ª falta não há alerta
    await page.goto('/alertas');
    await expect(page.getByText('Nenhum alerta aberto. Tudo em dia!')).toBeVisible();
    expect(await db.sql(`SELECT 1 FROM alerts`)).toHaveLength(0);

    await saveThirdAttendance(page, e3);

    // o contador do menu reflete o novo alerta
    const alertsLink = page.locator('aside nav').getByRole('link', { name: /Alertas/ });
    await expect(alertsLink).toContainText('1');

    await alertsLink.click();
    const card = page.locator('main li', { hasText: 'Ana Souza' });
    await expect(card).toBeVisible();
    await expect(card).toContainText('Grupo Alfa');
    await expect(card).toContainText('3 faltas seguidas');
    await expect(card).toContainText('Aberto');
    await expect(card).toContainText('Última falta: Culto 3');
    // quem compareceu não gera alerta
    await expect(page.getByText('Bia Lima')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Abertos \(1\)/ })).toBeVisible();

    const alerts = await db.sql(`SELECT consecutive_absences, status FROM alerts`);
    expect(alerts).toEqual([{ consecutive_absences: 3, status: 'open' }]);
  });

  test('dispensar com observações move o alerta para "Dispensados" e permite reabrir', async ({ page, db, loginAs }) => {
    const { coord, e3 } = await seedAbsenceScenario(db);
    await loginAs(coord);
    await saveThirdAttendance(page, e3);
    await page.goto('/alertas');

    await page.getByRole('button', { name: 'Dispensar' }).click();
    const form = modal(page);
    await expect(form.getByRole('heading', { name: 'Dispensar alerta' })).toBeVisible();
    await form.getByLabel('Observações').fill('Está viajando neste mês.');
    await form.getByRole('button', { name: 'Confirmar' }).click();

    await expect(page.getByText('Nenhum alerta aberto. Tudo em dia!')).toBeVisible();
    await page.getByRole('button', { name: 'Dispensados' }).click();
    const card = page.locator('main li', { hasText: 'Ana Souza' });
    await expect(card).toContainText('Dispensado');
    await expect(card).toContainText('Está viajando neste mês.');

    // reabrir
    await card.getByRole('button', { name: 'Reabrir' }).click();
    await page.getByRole('button', { name: /Abertos/ }).click();
    await expect(page.locator('main li', { hasText: 'Ana Souza' })).toContainText('Aberto');
  });
});

test.describe('Alerta → tarefa → conclusão', () => {
  test('criar tarefa a partir do alerta e concluí-la resolve o alerta automaticamente', async ({ page, db, loginAs }) => {
    const { coord, e3 } = await seedAbsenceScenario(db);
    await loginAs(coord);
    await saveThirdAttendance(page, e3);
    await page.goto('/alertas');

    // 1) alerta → "Criar tarefa" abre o formulário pré-preenchido
    await page.getByRole('button', { name: 'Criar tarefa' }).click();
    await expect(page).toHaveURL(/\/tarefas/);
    const form = modal(page);
    await expect(form.getByRole('heading', { name: 'Nova tarefa' })).toBeVisible();
    await expect(form.getByLabel('Título')).toHaveValue('Contatar Ana Souza (3 faltas)');
    await expect(form.getByLabel('Prioridade')).toHaveValue('high');
    await expect(form.getByLabel('Jovem')).not.toHaveValue('');
    await expect(form.getByText('Vinculada a um alerta.', { exact: false })).toBeVisible();
    await form.getByRole('button', { name: 'Criar tarefa' }).click();

    // 2) tarefa aparece vinculada a um alerta aberto
    const task = page.locator('main li', { hasText: 'Contatar Ana Souza (3 faltas)' });
    await expect(task).toContainText('Pendente');
    await expect(task).toContainText('Alerta aberto');
    await expect(task).toContainText('Eu');

    // 3) o alerta mostra a tarefa vinculada
    await page.locator('aside nav').getByRole('link', { name: /Alertas/ }).click();
    await expect(page.locator('main li', { hasText: 'Ana Souza' })).toContainText('Contatar Ana Souza (3 faltas) — Pendente');

    // 4) concluir a tarefa resolve o alerta (trigger no banco)
    await page.locator('aside nav').getByRole('link', { name: 'Tarefas' }).click();
    await page.locator('main li', { hasText: 'Contatar Ana Souza' }).getByRole('button', { name: 'Concluir' }).click();
    await expect(page.getByText('Nenhuma tarefa encontrada para este filtro.')).toBeVisible(); // saiu de "Abertas"
    await page.getByRole('button', { name: 'Encerradas' }).click();
    const done = page.locator('main li', { hasText: 'Contatar Ana Souza' });
    await expect(done).toContainText('Concluída');
    await expect(done).toContainText('Alerta encerrado');

    await page.locator('aside nav').getByRole('link', { name: /Alertas/ }).click();
    await expect(page.getByText('Nenhum alerta aberto. Tudo em dia!')).toBeVisible();
    await page.getByRole('button', { name: 'Resolvidos' }).click();
    await expect(page.locator('main li', { hasText: 'Ana Souza' })).toContainText('Resolvido');

    const [alert] = await db.sql(`SELECT status, resolved_by FROM alerts`);
    expect(alert).toEqual({ status: 'resolved', resolved_by: coord.id });
  });
});

test.describe('Tarefas', () => {
  test('valida título obrigatório, cria e edita uma tarefa', async ({ page, db, loginAs }) => {
    const coord = await db.createUser('coordinator', 'Carla Coordenadora');
    await loginAs(coord);
    await page.goto('/tarefas');
    await expect(page.getByText('Nenhuma tarefa encontrada para este filtro.')).toBeVisible();
    await expect(page.getByText('0 abertas')).toBeVisible();

    await page.getByRole('button', { name: 'Nova tarefa' }).click();
    const form = modal(page);
    await form.getByRole('button', { name: 'Criar tarefa' }).click();
    await expect(form.getByText('Título é obrigatório.')).toBeVisible();

    await form.getByLabel('Título').fill('Ligar para as famílias');
    await form.getByLabel('Descrição').fill('Confirmar presença no retiro');
    await form.getByLabel('Prioridade').selectOption('high');
    await form.getByLabel('Prazo').fill('2031-05-20');
    await form.getByRole('button', { name: 'Criar tarefa' }).click();

    const task = page.locator('main li', { hasText: 'Ligar para as famílias' });
    await expect(task).toContainText('Pendente');
    await expect(task).toContainText('Alta');
    await expect(task).toContainText('Confirmar presença no retiro');
    await expect(task).toContainText('Eu');
    await expect(page.getByText('1 aberta')).toBeVisible();

    // editar
    await task.getByRole('button', { name: 'Editar' }).click();
    const edit = modal(page);
    await expect(edit.getByRole('heading', { name: 'Editar tarefa' })).toBeVisible();
    await expect(edit.getByLabel('Título')).toHaveValue('Ligar para as famílias');
    await edit.getByLabel('Título').fill('Ligar para os responsáveis');
    await edit.getByRole('button', { name: 'Salvar alterações' }).click();
    await expect(page.locator('main li', { hasText: 'Ligar para os responsáveis' })).toBeVisible();
    await expect(page.getByText('Ligar para as famílias')).toHaveCount(0);

    const rows = await db.sql(`SELECT title, priority, due_date::text AS due, created_by, assigned_to FROM tasks`);
    expect(rows).toEqual([{ title: 'Ligar para os responsáveis', priority: 'high', due: '2031-05-20', created_by: coord.id, assigned_to: coord.id }]);
  });

  test('iniciar e concluir uma tarefa atualiza status e filtros', async ({ page, db, loginAs }) => {
    const coord = await db.createUser('coordinator', 'Carla Coordenadora');
    await db.sql(`INSERT INTO tasks (title, created_by, assigned_to) VALUES ('Preparar lanche', $1, $1)`, [coord.id]);
    await loginAs(coord);
    await page.goto('/tarefas');

    const task = page.locator('main li', { hasText: 'Preparar lanche' });
    await task.getByRole('button', { name: 'Iniciar' }).click();
    await expect(task).toContainText('Em andamento');
    await expect(task.getByRole('button', { name: 'Iniciar' })).toHaveCount(0);

    await task.getByRole('button', { name: 'Concluir' }).click();
    await expect(page.getByText('Nenhuma tarefa encontrada para este filtro.')).toBeVisible();
    await page.getByRole('button', { name: 'Encerradas' }).click();
    await expect(page.locator('main li', { hasText: 'Preparar lanche' })).toContainText('Concluída');
    await page.getByRole('button', { name: 'Todas' }).click();
    await expect(page.locator('main li')).toHaveCount(1);

    const [row] = await db.sql(`SELECT status FROM tasks`);
    expect(row.status).toBe('done');
  });

  test('tarefa com prazo vencido aparece como atrasada', async ({ page, db, loginAs }) => {
    const coord = await db.createUser('coordinator', 'Carla Coordenadora');
    await db.sql(
      `INSERT INTO tasks (title, created_by, assigned_to, due_date) VALUES ('Enviar relatório', $1, $1, '2020-01-10')`, [coord.id]);
    await loginAs(coord);
    await page.goto('/tarefas');

    const task = page.locator('main li', { hasText: 'Enviar relatório' });
    await expect(task.getByTestId('badge-atrasada')).toHaveText('Atrasada');
    await expect(task).toHaveAttribute('data-atrasada', 'true');
    await expect(page.getByText('1 atrasada')).toBeVisible();
  });

  test('exclui uma tarefa somente após confirmar', async ({ page, db, loginAs }) => {
    const coord = await db.createUser('coordinator', 'Carla Coordenadora');
    await db.sql(`INSERT INTO tasks (title, created_by, assigned_to) VALUES ('Tarefa descartável', $1, $1)`, [coord.id]);
    await loginAs(coord);
    await page.goto('/tarefas');
    const task = page.locator('main li', { hasText: 'Tarefa descartável' });

    page.once('dialog', (d) => void d.dismiss());
    await task.getByRole('button', { name: 'Excluir' }).click();
    await expect(task).toBeVisible();
    expect(await db.sql(`SELECT 1 FROM tasks`)).toHaveLength(1);

    page.once('dialog', (d) => {
      expect(d.message()).toContain('Tarefa descartável');
      void d.accept();
    });
    await task.getByRole('button', { name: 'Excluir' }).click();
    await expect(page.getByText('Nenhuma tarefa encontrada para este filtro.')).toBeVisible();
    expect(await db.sql(`SELECT 1 FROM tasks`)).toHaveLength(0);
  });

  test('busca e filtro "Só as minhas"', async ({ page, db, loginAs }) => {
    const coord = await db.createUser('coordinator', 'Carla Coordenadora');
    const lia = await db.createUser('leader', 'Lia Lider');
    await db.sql(`INSERT INTO tasks (title, created_by, assigned_to) VALUES ('Minha tarefa', $1, $1)`, [coord.id]);
    await db.sql(`INSERT INTO tasks (title, created_by, assigned_to) VALUES ('Tarefa da Lia', $1, $2)`, [coord.id, lia.id]);
    await loginAs(coord);
    await page.goto('/tarefas');
    await expect(page.locator('main li')).toHaveCount(2);
    await expect(page.locator('main li', { hasText: 'Tarefa da Lia' })).toContainText('Lia Lider');

    await page.getByLabel('Só as minhas').check();
    await expect(page.locator('main li')).toHaveCount(1);
    await expect(page.locator('main li')).toContainText('Minha tarefa');

    await page.getByLabel('Só as minhas').uncheck();
    await page.getByPlaceholder('Buscar por título ou jovem...').fill('lia');
    await expect(page.locator('main li')).toHaveCount(1);
    await page.getByPlaceholder('Buscar por título ou jovem...').fill('xyz');
    await expect(page.getByText('Nenhuma tarefa encontrada para "xyz".')).toBeVisible();
  });

  test('link /tarefas?novo=1&jovem=<id> abre o formulário pré-preenchido', async ({ page, db, loginAs }) => {
    const coord = await db.createUser('coordinator', 'Carla Coordenadora');
    const group = await db.createGroup('Grupo Alfa', coord.id);
    const youth = await db.createYouth('Ana Souza', group);
    await loginAs(coord);

    await page.goto(`/tarefas?novo=1&jovem=${youth}`);

    const form = modal(page);
    await expect(form.getByLabel('Título')).toHaveValue('Acompanhar Ana Souza');
    await expect(form.getByLabel('Grupo')).not.toHaveValue('');
    await expect(page).toHaveURL(/\/tarefas$/); // parâmetros são consumidos
  });

  test('erro ao criar tarefa é exibido no formulário', async ({ page, db, loginAs }) => {
    await loginAs(await db.createUser('coordinator', 'Carla Coordenadora'));
    await page.route('**/rest/v1/tasks*', (route) =>
      route.request().method() === 'POST'
        ? route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ message: 'falha ao gravar' }) })
        : route.continue());
    await page.goto('/tarefas');

    await page.getByRole('button', { name: 'Nova tarefa' }).click();
    await modal(page).getByLabel('Título').fill('Tarefa com erro');
    await modal(page).getByRole('button', { name: 'Criar tarefa' }).click();

    // mensagem amigável da operação; o texto cru do servidor nunca aparece
    await expect(modal(page).getByText('Erro ao criar tarefa.')).toBeVisible();
    await expect(page.getByText('falha ao gravar')).toHaveCount(0);
    await expect(modal(page).getByRole('heading', { name: 'Nova tarefa' })).toBeVisible();
  });
});

test.describe('Tarefas e alertas — líder (restrições de acesso)', () => {
  async function seedLeaders(db: TestDb): Promise<{ lia: TestUser; davi: TestUser; ana: string }> {
    const lia = await db.createUser('leader', 'Lia Lider');
    const davi = await db.createUser('leader', 'Davi Lider');
    const gLia = await db.createGroup('Grupo da Lia', lia.id);
    const gDavi = await db.createGroup('Grupo do Davi', davi.id);
    const ana = await db.createYouth('Ana da Lia', gLia);
    const zeca = await db.createYouth('Zeca do Davi', gDavi);
    // 3 faltas consecutivas para cada um
    for (const [i, title] of ['A', 'B', 'C'].entries()) {
      const ev = await db.createEvent(`Culto ${title}`, daysFromNow(-30 + i * 7), [gLia, gDavi], 'completed');
      await db.recordAttendance(ev, ana, gLia, false, lia.id);
      await db.recordAttendance(ev, zeca, gDavi, false, davi.id);
    }
    return { lia, davi, ana };
  }

  test('líder só vê alertas de jovens dos seus grupos', async ({ page, db, loginAs }) => {
    const { lia } = await seedLeaders(db);
    expect(await db.sql(`SELECT 1 FROM alerts`)).toHaveLength(2); // o banco gerou os dois
    await loginAs(lia);

    await page.goto('/alertas');

    await expect(page.locator('main li')).toHaveCount(1);
    await expect(page.locator('main li')).toContainText('Ana da Lia');
    await expect(page.getByText('Zeca do Davi')).toHaveCount(0);
    await expect(page.locator('aside nav').getByRole('link', { name: /Alertas/ })).toContainText('1');
  });

  test('líder só atribui tarefas a si mesmo e não vê tarefas de terceiros', async ({ page, db, loginAs }) => {
    const { lia, davi } = await seedLeaders(db);
    await db.sql(`INSERT INTO tasks (title, created_by, assigned_to) VALUES ('Tarefa do Davi', $1, $1)`, [davi.id]);
    await loginAs(lia);
    await page.goto('/tarefas');

    await expect(page.getByText('Tarefa do Davi')).toHaveCount(0);

    await page.getByRole('button', { name: 'Nova tarefa' }).click();
    const form = modal(page);
    await expect(form.getByText('Líderes atribuem tarefas apenas a si.')).toBeVisible();
    const assignees = await form.getByLabel('Responsável').locator('option').allTextContents();
    expect(assignees).toEqual(['Sem responsável', 'Lia Lider (eu)']);
    const youth = await form.getByLabel('Jovem').locator('option').allTextContents();
    expect(youth).toEqual(['Nenhum', 'Ana da Lia']); // sem jovens do grupo do Davi
  });
});
