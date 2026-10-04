import {
  chamadaRow, daysFromNow, expect, expectCounters, markAbsent, markPresent, modal, test, toDatetimeLocal,
} from './fixtures.ts';

test.describe('Encontros', () => {
  test('valida campos obrigatórios e cria um encontro com grupos', async ({ page, db, loginAs }) => {
    const coord = await db.createUser('coordinator', 'Carla Coordenadora');
    await db.createGroup('Grupo Alfa', coord.id);
    await db.createGroup('Grupo Beta', coord.id);
    await loginAs(coord);
    await page.goto('/encontros');
    await expect(page.getByText('Nenhum encontro cadastrado ainda.')).toBeVisible();

    await page.getByRole('button', { name: 'Novo encontro' }).click();
    const form = modal(page);
    await expect(form.getByRole('heading', { name: 'Novo Encontro' })).toBeVisible();
    // os grupos vêm do banco
    await expect(form.getByText('Grupo Alfa')).toBeVisible();

    await form.getByRole('button', { name: 'Criar encontro' }).click();
    await expect(form.getByText('Título é obrigatório.')).toBeVisible();

    await form.getByPlaceholder('Ex.: Encontro Mensal de Líderes').fill('Culto de Jovens');
    await form.getByRole('button', { name: 'Criar encontro' }).click();
    await expect(form.getByText('Data e hora são obrigatórias.')).toBeVisible();

    const when = daysFromNow(7);
    await form.locator('input[type="datetime-local"]').fill(toDatetimeLocal(when));
    await form.getByLabel('Grupo Alfa').check();
    await form.getByRole('button', { name: 'Criar encontro' }).click();

    await expect(page.getByRole('heading', { name: 'Novo Encontro' })).toBeHidden();
    const row = page.locator('tbody tr', { hasText: 'Culto de Jovens' });
    await expect(row).toContainText('Agendado');
    await expect(row).toContainText('Grupo Alfa');
    await expect(row).not.toContainText('Grupo Beta');
    await expect(page.getByText('1 encontro', { exact: true })).toBeVisible();

    const rows = await db.sql(
      `SELECT e.title, e.status, g.name AS grupo FROM events e
         JOIN event_groups eg ON eg.event_id = e.id JOIN groups g ON g.id = eg.group_id`);
    expect(rows).toEqual([{ title: 'Culto de Jovens', status: 'scheduled', grupo: 'Grupo Alfa' }]);
  });

  test('edita título e grupos de um encontro', async ({ page, db, loginAs }) => {
    const coord = await db.createUser('coordinator', 'Carla Coordenadora');
    const alfa = await db.createGroup('Grupo Alfa', coord.id);
    await db.createGroup('Grupo Beta', coord.id);
    await db.createEvent('Culto de Jovens', daysFromNow(3), [alfa]);
    await loginAs(coord);
    await page.goto('/encontros');

    await page.getByRole('button', { name: 'Culto de Jovens' }).first().click();
    await modal(page).getByRole('button', { name: 'Editar', exact: true }).click();
    const form = modal(page);
    await expect(form.getByRole('heading', { name: 'Editar Encontro' })).toBeVisible();
    await expect(form.getByLabel('Grupo Alfa')).toBeChecked();

    await form.getByPlaceholder('Ex.: Encontro Mensal de Líderes').fill('Culto Especial');
    await form.getByLabel('Grupo Alfa').uncheck();
    await form.getByLabel('Grupo Beta').check();
    await form.getByRole('button', { name: 'Salvar alterações' }).click();

    await expect(page.getByRole('heading', { name: 'Editar Encontro' })).toBeHidden();
    const row = page.locator('tbody tr', { hasText: 'Culto Especial' });
    await expect(row).toContainText('Grupo Beta');
    await expect(row).not.toContainText('Grupo Alfa');
  });

  test('falha ao salvar os grupos não deixa o encontro alterado nem sem grupos (atômico)', async ({ page, db, loginAs }) => {
    const coord = await db.createUser('coordinator', 'Carla Coordenadora');
    const alfa = await db.createGroup('Grupo Alfa', coord.id);
    const beta = await db.createGroup('Grupo Beta', coord.id);
    const eventId = await db.createEvent('Culto de Jovens', daysFromNow(3), [alfa]);
    await loginAs(coord);
    await page.goto('/encontros');

    await page.getByRole('button', { name: 'Culto de Jovens' }).first().click();
    await modal(page).getByRole('button', { name: 'Editar', exact: true }).click();
    const form = modal(page);
    await expect(form.getByLabel('Grupo Beta')).toBeVisible();

    // O formulário já carregou os grupos; antes de salvar, o Grupo Beta é excluído por outra pessoa.
    await db.sql(`DELETE FROM groups WHERE id = $1`, [beta]);
    await form.getByPlaceholder('Ex.: Encontro Mensal de Líderes').fill('Culto Renomeado');
    await form.getByLabel('Grupo Alfa').uncheck();
    await form.getByLabel('Grupo Beta').check();
    await form.getByRole('button', { name: 'Salvar alterações' }).click();

    // o erro é mostrado (antes era engolido) e o modal continua aberto para nova tentativa
    await expect(page.getByText('Um dos itens relacionados não existe mais ou está em uso.', { exact: false }).first()).toBeVisible();
    await expect(page.getByText(/foreign key|violates|event_groups/i)).toHaveCount(0); // sem nome de constraint/tabela
    await expect(form.getByRole('heading', { name: 'Editar Encontro' })).toBeVisible();

    // nada mudou no banco: título original e vínculo original
    const [ev] = await db.sql(`SELECT title FROM events WHERE id = $1`, [eventId]);
    expect(ev.title).toBe('Culto de Jovens');
    const links = await db.sql(`SELECT group_id FROM event_groups WHERE event_id = $1`, [eventId]);
    expect(links).toEqual([{ group_id: alfa }]);
  });

  test('falha ao criar encontro com grupo inválido não cria o encontro', async ({ page, db, loginAs }) => {
    const coord = await db.createUser('coordinator', 'Carla Coordenadora');
    const alfa = await db.createGroup('Grupo Alfa', coord.id);
    await loginAs(coord);
    await page.goto('/encontros');

    await page.getByRole('button', { name: 'Novo encontro' }).click();
    const form = modal(page);
    await expect(form.getByLabel('Grupo Alfa')).toBeVisible();
    await db.sql(`DELETE FROM groups WHERE id = $1`, [alfa]);
    await form.getByPlaceholder('Ex.: Encontro Mensal de Líderes').fill('Culto Fantasma');
    await form.locator('input[type="datetime-local"]').fill(toDatetimeLocal(daysFromNow(5)));
    await form.getByLabel('Grupo Alfa').check();
    await form.getByRole('button', { name: 'Criar encontro' }).click();

    await expect(page.getByText('Um dos itens relacionados não existe mais ou está em uso.', { exact: false }).first()).toBeVisible();
    await expect(page.getByText(/foreign key|violates|event_groups/i)).toHaveCount(0);
    expect(await db.sql(`SELECT 1 FROM events`)).toHaveLength(0);
  });

  test('filtros por status e busca', async ({ page, db, loginAs }) => {
    const coord = await db.createUser('coordinator', 'Carla Coordenadora');
    const g = await db.createGroup('Grupo Alfa', coord.id);
    await db.createEvent('Culto Agendado', daysFromNow(3), [g], 'scheduled');
    await db.createEvent('Culto Realizado', daysFromNow(-3), [g], 'completed');
    await db.createEvent('Culto Cancelado', daysFromNow(-6), [g], 'cancelled');
    await loginAs(coord);
    await page.goto('/encontros');
    await expect(page.locator('tbody tr')).toHaveCount(3);

    await page.getByRole('button', { name: 'Realizados' }).click();
    await expect(page.locator('tbody tr')).toHaveCount(1);
    await expect(page.locator('tbody tr')).toContainText('Culto Realizado');

    await page.getByRole('button', { name: 'Todos' }).click();
    await page.getByPlaceholder('Buscar por título...').fill('cancelado');
    await expect(page.locator('tbody tr')).toHaveCount(1);
    await expect(page.locator('tbody tr')).toContainText('Cancelado');
  });

  test('encontro cancelado não oferece chamada', async ({ page, db, loginAs }) => {
    const coord = await db.createUser('coordinator', 'Carla Coordenadora');
    const g = await db.createGroup('Grupo Alfa', coord.id);
    await db.createEvent('Culto Cancelado', daysFromNow(-1), [g], 'cancelled');
    await loginAs(coord);
    await page.goto('/encontros');

    await page.getByRole('button', { name: 'Culto Cancelado' }).first().click();

    await expect(modal(page).getByText('Encontro cancelado — não há chamada.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Realizar / Ver Chamada' })).toHaveCount(0);
  });

  test('coordenador exclui um encontro após confirmar', async ({ page, db, loginAs }) => {
    const coord = await db.createUser('coordinator', 'Carla Coordenadora');
    const g = await db.createGroup('Grupo Alfa', coord.id);
    await db.createEvent('Culto Descartável', daysFromNow(2), [g]);
    await loginAs(coord);
    await page.goto('/encontros');

    await page.getByRole('button', { name: 'Culto Descartável' }).first().click();
    page.once('dialog', (d) => {
      expect(d.message()).toContain('Culto Descartável');
      void d.dismiss();
    });
    await modal(page).getByRole('button', { name: 'Excluir' }).click();
    expect(await db.sql(`SELECT 1 FROM events`)).toHaveLength(1); // cancelar não exclui

    page.once('dialog', (d) => void d.accept());
    await modal(page).getByRole('button', { name: 'Excluir' }).click();
    await expect(page.getByText('Nenhum encontro cadastrado ainda.')).toBeVisible();
    expect(await db.sql(`SELECT 1 FROM events`)).toHaveLength(0);
  });
});

test.describe('Chamada (presença)', () => {
  async function seedMeeting(db: import('./fixtures.ts').TestDb) {
    const coord = await db.createUser('coordinator', 'Carla Coordenadora');
    const group = await db.createGroup('Grupo Alfa', coord.id);
    const ana = await db.createYouth('Ana Souza', group);
    const bruno = await db.createYouth('Bruno Lima', group);
    const carla = await db.createYouth('Carlos Dias', group);
    const eventId = await db.createEvent('Culto de Jovens', daysFromNow(-1), [group]);
    return { coord, group, ana, bruno, carla, eventId };
  }

  test('abre a chamada a partir do encontro, marca presenças e ausências e salva', async ({ page, db, loginAs }) => {
    const { coord, ana, bruno, carla, eventId } = await seedMeeting(db);
    await loginAs(coord);
    await page.goto('/encontros');

    await page.getByRole('button', { name: 'Culto de Jovens' }).first().click();
    await modal(page).getByRole('button', { name: 'Realizar / Ver Chamada' }).click();

    await expect(page).toHaveURL(new RegExp(`/chamada/${eventId}$`));
    await expect(page.getByRole('heading', { name: 'Chamada' })).toBeVisible();
    // jovens do banco, em ordem alfabética, todos "não registrados" (sem estado) por padrão
    await expect(page.getByTestId('chamada-jovem')).toHaveText([/Ana Souza/, /Bruno Lima/, /Carlos Dias/]);
    for (const row of await page.getByTestId('chamada-jovem').all()) await expect(row).toHaveAttribute('data-state', 'unregistered');
    await expectCounters(page, { total: 3, presentes: 0, ausentes: 0, naoRegistrados: 3 });

    await markPresent(page, 'Ana Souza');
    await markAbsent(page, 'Bruno Lima');
    await markPresent(page, 'Carlos Dias');
    await expectCounters(page, { total: 3, presentes: 2, ausentes: 1, naoRegistrados: 0, percentual: '67%' });

    await page.getByRole('button', { name: 'Salvar Chamada' }).click();

    // não navega sozinho: mostra o resumo e deixa o usuário decidir
    const summary = page.getByTestId('chamada-resumo');
    await expect(summary.getByRole('heading', { name: 'Chamada registrada.' })).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/chamada/${eventId}$`));
    await summary.getByRole('button', { name: 'Voltar aos encontros' }).click();
    await expect(page).toHaveURL(/\/encontros$/);
    await expect(page.locator('tbody tr', { hasText: 'Culto de Jovens' })).toContainText('Realizado');

    const saved = await db.sql<{ youth_id: string; present: boolean; recorded_by: string }>(
      `SELECT youth_id, present, recorded_by FROM attendance WHERE event_id = $1`, [eventId]);
    expect(saved).toHaveLength(3);
    const presence = Object.fromEntries(saved.map((r) => [r.youth_id, r.present]));
    expect(presence).toEqual({ [ana]: true, [bruno]: false, [carla]: true });
    expect(new Set(saved.map((r) => r.recorded_by))).toEqual(new Set([coord.id]));
  });

  test('reabrir a chamada mostra o que foi salvo e permite corrigir', async ({ page, db, loginAs }) => {
    const { coord, group, ana, bruno, carla, eventId } = await seedMeeting(db);
    await db.recordAttendance(eventId, ana, group, true, coord.id);
    await db.recordAttendance(eventId, bruno, group, false, coord.id);
    await db.recordAttendance(eventId, carla, group, false, coord.id);
    await loginAs(coord);

    await page.goto(`/chamada/${eventId}`);

    await expect(page.getByText('Chamada já registrada — você está editando.')).toBeVisible();
    await expectCounters(page, { total: 3, presentes: 1, ausentes: 2, naoRegistrados: 0 });
    await expect(chamadaRow(page, 'Ana Souza')).toHaveAttribute('data-state', 'present');
    await expect(chamadaRow(page, 'Bruno Lima')).toHaveAttribute('data-state', 'absent');

    await markPresent(page, 'Bruno Lima');
    await expectCounters(page, { total: 3, presentes: 2, ausentes: 1, naoRegistrados: 0 });
    await page.getByRole('button', { name: 'Salvar Chamada' }).click();
    await expect(page.getByTestId('chamada-resumo-numeros')).toHaveText('3 registrados · 2 presentes · 1 ausente · 67%');

    const rows = await db.sql<{ present: boolean }>(
      `SELECT present FROM attendance WHERE event_id = $1 AND youth_id = $2`, [eventId, bruno]);
    expect(rows).toEqual([{ present: true }]);
    // upsert: continua com 1 registro por jovem (sem duplicar)
    expect(await db.sql(`SELECT 1 FROM attendance WHERE event_id = $1`, [eventId])).toHaveLength(3);
  });

  test('ação em lote com filtro ativo: salvar grava os marcados ocultos e não inventa registro para os demais', async ({ page, db, loginAs }) => {
    const { coord, ana, bruno, eventId } = await seedMeeting(db);
    await loginAs(coord);
    await page.goto(`/chamada/${eventId}`);

    await markAbsent(page, 'Bruno Lima');
    await page.getByPlaceholder('Buscar jovem...').fill('ana');
    await expect(page.getByTestId('chamada-jovem')).toHaveCount(1);
    await page.getByRole('button', { name: 'Marcar não registrados (visíveis) como presentes' }).click();
    // o contador considera todos os jovens do encontro, não só os filtrados
    await expectCounters(page, { total: 3, presentes: 1, ausentes: 1, naoRegistrados: 1 });
    await expect(page.getByTestId('aviso-sem-registro')).toHaveText('1 jovem ficará sem registro');

    // salva COM o filtro ainda ativo: Bruno (oculto, ausente) também precisa ser gravado
    await page.getByRole('button', { name: 'Salvar Chamada' }).click();
    await expect(page.getByTestId('chamada-resumo')).toBeVisible();
    const rows = await db.sql<{ youth_id: string; present: boolean }>(`SELECT youth_id, present FROM attendance WHERE event_id = $1`, [eventId]);
    expect(Object.fromEntries(rows.map((r) => [r.youth_id, r.present]))).toEqual({ [ana]: true, [bruno]: false });
  });

  test('mostra "Salvando..." e desabilita o botão durante o envio', async ({ page, db, loginAs }) => {
    const { coord, eventId } = await seedMeeting(db);
    await loginAs(coord);
    await page.route('**/rest/v1/rpc/save_attendance*', async (route) => {
      await new Promise((r) => setTimeout(r, 1000));
      await route.continue();
    });
    await page.goto(`/chamada/${eventId}`);
    await markPresent(page, 'Ana Souza');

    await page.getByRole('button', { name: 'Salvar Chamada' }).click();

    const saving = page.getByRole('button', { name: /Salvando/ });
    await expect(saving).toBeDisabled();
    await expect(page.getByTestId('chamada-resumo')).toBeVisible();
  });

  test('erro ao salvar mantém o usuário na chamada, preserva as marcações e exibe a mensagem', async ({ page, db, loginAs }) => {
    const { coord, eventId } = await seedMeeting(db);
    await loginAs(coord);
    await page.route('**/rest/v1/rpc/save_attendance*', (route) =>
      route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ message: 'banco indisponível' }) }));
    await page.goto(`/chamada/${eventId}`);
    await markPresent(page, 'Ana Souza');

    await page.getByRole('button', { name: 'Salvar Chamada' }).click();

    await expect(page.getByText('Erro ao salvar chamada.')).toBeVisible();
    await expect(page.getByText('banco indisponível')).toHaveCount(0);
    await expect(page).toHaveURL(new RegExp(`/chamada/${eventId}$`));
    await expect(chamadaRow(page, 'Ana Souza')).toHaveAttribute('data-state', 'present');
    await expect(page.getByRole('button', { name: 'Salvar Chamada' })).toBeEnabled();
    expect(await db.sql(`SELECT 1 FROM attendance`)).toHaveLength(0);
  });

  test('encontro inexistente mostra mensagem e permite voltar', async ({ page, db, loginAs }) => {
    await loginAs(await db.createUser('coordinator', 'Carla Coordenadora'));
    await page.goto('/chamada/00000000-0000-4000-8000-000000000000');

    // erro de carga: mensagem amigável (nunca o texto cru do servidor) + "Tentar novamente"
    await expect(page.getByText('Registro não encontrado ou sem permissão.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Tentar novamente' })).toBeVisible();
    await page.getByRole('button', { name: 'Voltar' }).click();
    await expect(page).toHaveURL(/\/encontros$/);
  });

  test('encontro sem grupos avisa que não há jovens para a chamada', async ({ page, db, loginAs }) => {
    const coord = await db.createUser('coordinator', 'Carla Coordenadora');
    const eventId = await db.createEvent('Culto Solto', daysFromNow(-1), []);
    await loginAs(coord);
    await page.goto(`/chamada/${eventId}`);

    await expect(page.getByText('Nenhum grupo vinculado a este encontro.', { exact: false })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Salvar Chamada' })).toBeDisabled();
  });
});

test.describe('Chamada — líder (restrições de acesso)', () => {
  test('líder só enxerga encontros e jovens dos seus grupos e salva a chamada', async ({ page, db, loginAs }) => {
    const lia = await db.createUser('leader', 'Lia Lider');
    const davi = await db.createUser('leader', 'Davi Lider');
    const gLia = await db.createGroup('Grupo da Lia', lia.id);
    const gDavi = await db.createGroup('Grupo do Davi', davi.id);
    const ana = await db.createYouth('Ana Souza', gLia);
    await db.createYouth('Zeca Alheio', gDavi);
    const mine = await db.createEvent('Culto da Lia', daysFromNow(-1), [gLia]);
    const theirs = await db.createEvent('Culto do Davi', daysFromNow(-1), [gDavi]);
    await loginAs(lia);

    await page.goto('/encontros');
    await expect(page.locator('tbody tr')).toHaveCount(1);
    await expect(page.getByText('Culto do Davi')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Novo encontro' })).toHaveCount(0);

    // URL direta para encontro de outro grupo: bloqueada pelo RLS
    await page.goto(`/chamada/${theirs}`);
    await expect(page.getByText('Registro não encontrado ou sem permissão.')).toBeVisible();
    await expect(page.getByTestId('chamada-jovem')).toHaveCount(0);

    await page.goto(`/chamada/${mine}`);
    await expect(page.getByTestId('chamada-jovem')).toHaveText([/Ana Souza/]);
    await expect(page.getByText('Zeca Alheio')).toHaveCount(0);
    // líder não vê a opção de marcar o encontro como realizado
    await expect(page.getByLabel('Marcar encontro como realizado')).toHaveCount(0);

    await markPresent(page, 'Ana Souza');
    await page.getByRole('button', { name: 'Salvar Chamada' }).click();
    await expect(page.getByTestId('chamada-resumo')).toBeVisible();

    const rows = await db.sql<{ youth_id: string; present: boolean; recorded_by: string }>(
      `SELECT youth_id, present, recorded_by FROM attendance`);
    expect(rows).toEqual([{ youth_id: ana, present: true, recorded_by: lia.id }]);
    // evento segue "agendado": só coordenador conclui
    const [ev] = await db.sql(`SELECT status FROM events WHERE id = $1`, [mine]);
    expect(ev.status).toBe('scheduled');
  });
});
