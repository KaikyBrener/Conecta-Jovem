// Indicadores por grupo na lista de Grupos (Fase 7, bloco 6): RPC group_indicators real (migration 012).
import type { Locator, Page } from '@playwright/test';
import { daysFromNow, expect, spDay, test, type TestDb } from './fixtures.ts';

/** 8 encontros semanais, do mais antigo (70 dias atrás) ao mais recente (21 dias atrás). */
const WEEKLY = [70, 63, 56, 49, 42, 35, 28, 21];

async function meetings(db: TestDb, group: string, youth: string, by: string, days: number[], presentAt: (i: number) => boolean) {
  for (const [i, d] of days.entries()) {
    const ev = await db.createEvent(`${group} #${i + 1}`, daysFromNow(-d), [group], 'completed');
    await db.recordAttendance(ev, youth, group, presentAt(i), by);
  }
}

/**
 * Cinco grupos em ordem alfabética, cada um com um perfil diferente. Em "Em Alta" e "Em Queda" o jovem fica com 50% de
 * presença nos 8 encontros (abaixo de 70%), então o banco abre alerta de baixa frequência e ele conta como "em atenção".
 */
async function seedGroups(db: TestDb) {
  const carla = await db.createUser('coordinator', 'Carla Coordenadora');
  const leaders = [
    await db.createUser('leader', 'Lia Lider'),
    await db.createUser('leader', 'Davi Lider'),
    await db.createUser('leader', 'Eva Lider'),
    await db.createUser('leader', 'Gil Lider'),
    await db.createUser('leader', 'Ivo Lider'),
  ];
  const g = {
    alta: await db.createGroup('Grupo A Em Alta', leaders[0].id),
    queda: await db.createGroup('Grupo B Em Queda', leaders[1].id),
    estavel: await db.createGroup('Grupo C Estavel', leaders[2].id),
    poucos: await db.createGroup('Grupo D Poucos', leaders[3].id),
    vazio: await db.createGroup('Grupo E Sem Chamada', leaders[4].id),
  };
  const ana = await db.createYouth('Ana Alta', g.alta);
  const bia = await db.createYouth('Bia Queda', g.queda);
  const caio = await db.createYouth('Caio Estavel', g.estavel);
  const duda = await db.createYouth('Duda Poucos', g.poucos);
  await db.createYouth('Edu Vazio', g.vazio);
  await meetings(db, g.alta, ana, carla.id, WEEKLY, (i) => i >= 4); // faltou nos 4 mais antigos, foi nos 4 recentes
  await meetings(db, g.queda, bia, carla.id, WEEKLY, (i) => i < 4); // foi nos 4 mais antigos, faltou nos 4 recentes
  await meetings(db, g.estavel, caio, carla.id, WEEKLY, () => true);
  await meetings(db, g.poucos, duda, carla.id, [21, 14, 7], () => true);
  // duas ações atrasadas do grupo Estável (no grupo, sem jovem: não mexem na situação de ninguém)
  for (const t of ['Reservar a sala', 'Comprar material']) {
    await db.createTask(t, { createdBy: carla.id, assignedTo: carla.id, groupId: g.estavel, dueDate: spDay(-2) });
  }
  return { carla, leaders, g, ana, bia, caio, duda };
}

const row = (page: Page, name: string): Locator => page.getByTestId('grupo-linha').filter({ hasText: name });

test.describe('Grupos — indicadores', () => {
  test('frequência, tendência, jovens em atenção e ações atrasadas de cada grupo', async ({ page, db, loginAs }) => {
    const s = await seedGroups(db);
    await loginAs(s.carla);
    await page.goto('/grupos');
    await expect(page.getByTestId('grupo-linha')).toHaveCount(5);
    await expect(row(page, 'Grupo A Em Alta').getByTestId('grupo-rate')).toHaveText('50%');

    // ordenação continua por nome (nunca por desempenho)
    const names = await page.getByTestId('grupo-linha').locator('td:first-child span.font-medium').allInnerTexts();
    expect(names.map((n) => n.trim())).toEqual([
      'Grupo A Em Alta', 'Grupo B Em Queda', 'Grupo C Estavel', 'Grupo D Poucos', 'Grupo E Sem Chamada',
    ]);

    // tendência em alta: 4 recentes (100%) contra 4 anteriores (0%)
    const alta = row(page, 'Grupo A Em Alta');
    await expect(alta.getByTestId('grupo-trend')).toHaveAttribute('data-tendencia', 'up');
    await expect(alta.getByTestId('grupo-trend')).toContainText('em alta');
    await expect(alta.getByTestId('grupo-trend')).toContainText('(+100 pp)');
    await expect(alta.getByTestId('grupo-attention')).toHaveText('1');
    await expect(alta.getByTestId('grupo-overdue')).toHaveText('0');

    // tendência em queda
    const queda = row(page, 'Grupo B Em Queda');
    await expect(queda.getByTestId('grupo-rate')).toHaveText('50%');
    await expect(queda.getByTestId('grupo-trend')).toHaveAttribute('data-tendencia', 'down');
    await expect(queda.getByTestId('grupo-trend')).toContainText('em queda');
    await expect(queda.getByTestId('grupo-trend')).toContainText('(-100 pp)');
    await expect(queda.getByTestId('grupo-attention')).toHaveText('1');

    // estável: 100% sempre, 2 ações atrasadas do grupo, ninguém em atenção
    const estavel = row(page, 'Grupo C Estavel');
    await expect(estavel.getByTestId('grupo-rate')).toHaveText('100%');
    await expect(estavel.getByTestId('grupo-trend')).toHaveAttribute('data-tendencia', 'stable');
    await expect(estavel.getByTestId('grupo-trend')).toContainText('estável');
    await expect(estavel.getByTestId('grupo-trend')).toContainText('(0 pp)');
    await expect(estavel.getByTestId('grupo-attention')).toHaveText('0');
    await expect(estavel.getByTestId('grupo-overdue')).toHaveText('2');

    // só 3 encontros com chamada: taxa existe, mas a tendência exige 8
    const poucos = row(page, 'Grupo D Poucos');
    await expect(poucos.getByTestId('grupo-rate')).toHaveText('100%');
    await expect(poucos.getByTestId('grupo-trend')).toHaveAttribute('data-tendencia', 'insufficient');
    await expect(poucos.getByTestId('grupo-trend')).toHaveText('dados insuficientes');

    // sem nenhuma chamada
    const vazio = row(page, 'Grupo E Sem Chamada');
    await expect(vazio.getByTestId('grupo-rate')).toHaveText('sem chamadas');
    await expect(vazio.getByTestId('grupo-trend')).toHaveText('dados insuficientes');
    await expect(vazio.getByTestId('grupo-attention')).toHaveText('0');
    await expect(vazio.getByTestId('grupo-overdue')).toHaveText('0');

    // integrantes e líder continuam na linha
    await expect(alta).toContainText('Lia Lider');
    await expect(page.getByTestId('grupos-indicadores-indisponiveis')).toHaveCount(0);
  });

  test('os indicadores seguem a página/busca: filtrar por líder mostra só o grupo dele', async ({ page, db, loginAs }) => {
    const s = await seedGroups(db);
    await loginAs(s.carla);
    await page.goto('/grupos');
    await expect(page.getByTestId('grupo-linha')).toHaveCount(5);
    await page.getByPlaceholder('Buscar por grupo ou líder...').fill('Davi');
    await expect(page.getByTestId('grupo-linha')).toHaveCount(1);
    await expect(page.getByTestId('grupo-linha').getByTestId('grupo-trend')).toHaveAttribute('data-tendencia', 'down');
  });

  test('falha da RPC group_indicators não quebra a lista: aviso discreto e "—" nos indicadores', async ({ page, db, loginAs }) => {
    const s = await seedGroups(db);
    await loginAs(s.carla);
    await page.route('**/rest/v1/rpc/group_indicators*', (route) =>
      route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ message: 'quebrou o indicador' }) }));
    await page.goto('/grupos');

    await expect(page.getByTestId('grupo-linha')).toHaveCount(5);
    await expect(page.getByTestId('grupos-indicadores-indisponiveis')).toHaveText(
      'Não foi possível carregar os indicadores dos grupos agora. A lista continua disponível.');
    await expect(row(page, 'Grupo A Em Alta').getByTestId('grupo-rate')).toHaveText('—');
    await expect(row(page, 'Grupo A Em Alta')).toContainText('Lia Lider');
    await expect(page.locator('body')).not.toContainText('quebrou o indicador');
    // criar/abrir integrantes continuam funcionando
    await row(page, 'Grupo A Em Alta').getByRole('button', { name: /Grupo A Em Alta/ }).click();
    await expect(page.getByRole('heading', { name: 'Integrantes — Grupo A Em Alta' })).toBeVisible();
    await expect(page.getByText('Ana Alta')).toBeVisible();
  });

  test('líder vê os indicadores só do próprio grupo', async ({ page, db, loginAs }) => {
    const s = await seedGroups(db);
    await loginAs(s.leaders[1]); // Davi: Grupo B Em Queda
    await page.goto('/grupos');
    await expect(page.getByTestId('grupo-linha')).toHaveCount(1);
    const queda = row(page, 'Grupo B Em Queda');
    await expect(queda.getByTestId('grupo-rate')).toHaveText('50%');
    await expect(queda.getByTestId('grupo-trend')).toHaveAttribute('data-tendencia', 'down');
    await expect(page.locator('main')).not.toContainText('Grupo A Em Alta');
  });

  test('líder desassocia um jovem do próprio grupo pelo fluxo normal (corrigido na migration 014)', async ({ page, db, loginAs }) => {
    const s = await seedGroups(db);
    await loginAs(s.leaders[0]); // Lia: Grupo A Em Alta (Ana)
    await page.goto('/grupos');
    await row(page, 'Grupo A Em Alta').getByRole('button', { name: /Grupo A Em Alta/ }).click();
    await expect(page.getByRole('heading', { name: 'Integrantes — Grupo A Em Alta' })).toBeVisible();
    await expect(page.getByText('Ana Alta')).toBeVisible();

    const removeBtn = page.getByTitle('Remover do grupo').first();
    await removeBtn.click();

    await expect.poll(async () => (await db.sql<{ group_id: string | null }>(`SELECT group_id FROM youth WHERE id = $1`, [s.ana]))[0].group_id).toBeNull();
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(page.locator('body')).not.toContainText('row-level security');
    await expect(page.getByText('Ana Alta')).toHaveCount(0);
  });
});
