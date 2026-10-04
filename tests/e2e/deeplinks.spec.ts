// Links profundos (Fase 7): /jovens?ficha=, /encontros?evento=, /grupos?busca=, /tarefas?filtro=, /historico?jovem=.
import { expect, spDay, test } from './fixtures.ts';
import { overdueTask, pageAs, seedPeople } from './phase7-helpers.ts';

const GHOST = '00000000-0000-4000-8000-000000000000';

test.describe('Links profundos', () => {
  test('/jovens?ficha=<id> abre a ficha mesmo fora da página atual e limpa o parâmetro ao fechar', async ({ page, db, loginAs }) => {
    const p = await seedPeople(db);
    for (let i = 0; i < 30; i++) await db.createYouth(`Jovem ${String(i).padStart(2, '0')}`, p.alfa);
    const ze = await db.createYouth('Zélia Última', p.alfa); // cai na 2ª página
    await loginAs(p.carla);

    await page.goto(`/jovens?ficha=${ze}`);
    await expect(page.getByRole('heading', { name: 'Detalhes do Jovem' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Zélia Última' })).toBeVisible();
    await page.getByRole('button', { name: 'Fechar', exact: true }).first().click();
    await expect(page.getByRole('heading', { name: 'Detalhes do Jovem' })).toHaveCount(0);
    await expect(page).toHaveURL(/\/jovens$/);
  });

  test('ficha inexistente, inválida ou de outro grupo (líder) mostra aviso e não abre nada', async ({ page, browser, db, loginAs }) => {
    const p = await seedPeople(db);
    const caio = await db.createYouth('Caio Alheio', p.beta);
    const notice = 'Jovem não encontrado ou sem permissão para ver a ficha.';
    await loginAs(p.carla);
    await page.goto(`/jovens?ficha=${GHOST}`);
    await expect(page.getByText(notice)).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Detalhes do Jovem' })).toHaveCount(0);
    await expect(page).toHaveURL(/\/jovens$/);

    await page.goto('/jovens?ficha=nao-e-um-id');
    // (no dev server, o StrictMode pode repetir o aviso para id inválido: basta o primeiro)
    await expect(page.getByText(notice).first()).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Detalhes do Jovem' })).toHaveCount(0);

    // líder: o RLS esconde o jovem do outro grupo
    const { page: leader, close } = await pageAs(browser, p.lia);
    await leader.goto(`/jovens?ficha=${caio}`);
    await expect(leader.getByText(notice)).toBeVisible();
    await expect(leader.getByRole('heading', { name: 'Detalhes do Jovem' })).toHaveCount(0);
    await expect(leader.locator('body')).not.toContainText('Caio Alheio');
    await close();
  });

  test('/encontros?evento=<id> abre o detalhe; id inexistente avisa', async ({ page, db, loginAs }) => {
    const p = await seedPeople(db);
    let first = '';
    for (let i = 0; i < 30; i++) {
      const id = await db.createEvent(`Encontro ${String(i).padStart(2, '0')}`, new Date(Date.now() + (i + 1) * 86_400_000), [p.alfa]);
      if (i === 0) first = id;
    }
    await loginAs(p.carla);
    await page.goto(`/encontros?evento=${first}`);
    await expect(page.getByRole('heading', { name: 'Detalhes do Encontro' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Encontro 00' })).toBeVisible();

    await page.goto(`/encontros?evento=${GHOST}`);
    await expect(page.getByText('Encontro não encontrado ou sem permissão para vê-lo.')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Detalhes do Encontro' })).toHaveCount(0);
  });

  test('/grupos?busca= preenche a busca, filtra no servidor e sai da URL', async ({ page, db, loginAs }) => {
    const p = await seedPeople(db);
    await loginAs(p.carla);
    await page.goto('/grupos?busca=Beta');
    await expect(page.getByPlaceholder('Buscar por grupo ou líder...')).toHaveValue('Beta');
    await expect(page.getByTestId('grupo-linha')).toHaveCount(1);
    await expect(page.getByTestId('grupo-linha')).toContainText('Grupo Beta');
    await expect(page).toHaveURL(/\/grupos$/);
    // limpar o campo mostra todos de novo (o link não "briga" com a digitação)
    await page.getByPlaceholder('Buscar por grupo ou líder...').fill('');
    await expect(page.getByTestId('grupo-linha')).toHaveCount(2);
  });

  test('/tarefas?filtro=atrasadas abre filtrado; valores desconhecidos usam o padrão', async ({ page, db, loginAs }) => {
    const p = await seedPeople(db);
    const ana = await db.createYouth('Ana Souza', p.alfa);
    await overdueTask(db, 'Tarefa atrasada', ana, p.carla);
    await db.createTask('Tarefa no prazo', { createdBy: p.carla.id, assignedTo: p.carla.id, youthId: ana, dueDate: spDay(5) });
    await loginAs(p.carla);

    await page.goto('/tarefas?filtro=atrasadas');
    await expect(page.getByText('Tarefa atrasada')).toBeVisible();
    await expect(page.getByText('Tarefa no prazo')).toHaveCount(0);

    await page.goto('/tarefas?filtro=qualquer');
    await expect(page.getByText('Tarefa atrasada')).toBeVisible();
    await expect(page.getByText('Tarefa no prazo')).toBeVisible();
  });
});
