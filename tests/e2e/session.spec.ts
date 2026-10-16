// Sessão: troca de usuário no MESMO navegador (logout e login de outra pessoa sem recarregar a página: nada do usuário
// anterior pode aparecer) e sessão que expira durante o uso.
import type { Page } from '@playwright/test';
import { AUTH_STORAGE_KEY } from './env.ts';
import { daysFromNow, expect, loginViaForm, test, type TestDb, type TestUser } from './fixtures.ts';

const sidebar = (page: Page) => page.locator('aside');
const alertsLink = (page: Page) => page.locator('aside nav').getByRole('link', { name: /Alertas/ });
const badge = async (page: Page) => (await alertsLink(page).innerText()).replace('Alertas', '').trim();

/** Login SEM recarregar a página: usa o formulário já aberto (a SPA continua viva, com todo o estado em memória). */
async function loginInPlace(page: Page, user: TestUser) {
  await expect(page).toHaveURL(/\/login$/);
  await page.getByLabel('E-mail').fill(user.email);
  await page.getByLabel('Senha', { exact: true }).fill(user.password);
  await page.getByRole('button', { name: 'Entrar' }).click();
  await expect(page).toHaveURL('/');
}

async function logout(page: Page) {
  await page.getByRole('button', { name: 'Encerrar sessão' }).click();
  await expect(page).toHaveURL(/\/login$/);
  expect(await page.evaluate((k) => localStorage.getItem(k), AUTH_STORAGE_KEY)).toBeNull();
}

/** Carla (coordenadora), Lia (líder do Alfa, onde está a Ana) e Davi (líder do Beta, onde está o Caio); 3 faltas de cada um. */
async function seedWorld(db: TestDb) {
  const carla = await db.createUser('coordinator', 'Carla Coordenadora');
  const lia = await db.createUser('leader', 'Lia Lider');
  const davi = await db.createUser('leader', 'Davi Lider');
  const alfa = await db.createGroup('Grupo Alfa', lia.id);
  const beta = await db.createGroup('Grupo Beta', davi.id);
  await db.sql(`UPDATE app_settings SET low_attendance_threshold = 0`);
  const ana = await db.createYouth('Ana Souza', alfa);
  const caio = await db.createYouth('Caio Dias', beta);
  for (const [group, youth, prefix] of [[alfa, ana, 'Alfa'], [beta, caio, 'Beta']] as const) {
    for (let i = 0; i < 3; i++) {
      const ev = await db.createEvent(`Culto ${prefix} ${i + 1}`, daysFromNow(-21 + i * 7), [group], 'completed');
      await db.recordAttendance(ev, youth, group, false, carla.id);
    }
  }
  expect(await db.sql(`SELECT 1 FROM alerts WHERE status = 'open'`)).toHaveLength(2);
  return { carla, lia, davi, alfa, beta, ana, caio };
}

test.describe('Troca de usuário no mesmo navegador', () => {
  test('coordenadora sai e a líder entra (sem recarregar): papel, menu, dados e contador são os da líder', async ({ page, db }) => {
    const w = await seedWorld(db);

    // --- Carla: vê tudo
    await loginViaForm(page, w.carla.email, w.carla.password);
    await expect(page).toHaveURL('/');
    await expect(sidebar(page).getByText('Carla Coordenadora')).toBeVisible();
    await expect(sidebar(page).getByText('Coordenador', { exact: true })).toBeVisible();
    await expect.poll(() => badge(page)).toBe('2');
    await alertsLink(page).click();
    await expect(page.getByTestId('alerta-item')).toHaveCount(2);
    await page.locator('aside nav').getByRole('link', { name: 'Jovens' }).click();
    await expect(page.getByRole('button', { name: 'Novo jovem' })).toBeVisible();
    await expect(page.locator('tbody tr', { hasText: 'Caio Dias' })).toBeVisible();
    await page.locator('aside nav').getByRole('link', { name: 'Configurações' }).click();
    await expect(page.getByRole('heading', { name: 'Parâmetros de acompanhamento' })).toBeVisible();

    // --- sai: a sessão some e as rotas protegidas fecham
    await logout(page);
    await expect(page.getByRole('status')).toHaveCount(0); // saída voluntária: sem aviso de "sessão encerrada"
    await expect(page.locator('body')).not.toContainText('Carla Coordenadora');
    await expect(page.locator('body')).not.toContainText('Caio Dias');

    // --- Lia entra pelo MESMO formulário, sem recarregar a página
    await loginInPlace(page, w.lia);
    await expect(sidebar(page).getByText('Lia Lider')).toBeVisible();
    await expect(sidebar(page).getByText('Líder', { exact: true })).toBeVisible();
    await expect(sidebar(page).getByText('Carla Coordenadora')).toHaveCount(0);
    await expect(sidebar(page).getByText('Coordenador', { exact: true })).toHaveCount(0);
    await expect.poll(() => badge(page), 'o selo é o da líder (1), não o da coordenadora (2)').toBe('1');

    await alertsLink(page).click();
    await expect(page.getByTestId('alerta-item')).toHaveCount(1);
    await expect(page.getByTestId('alerta-item')).toContainText('Ana Souza');
    await expect(page.getByText('Caio Dias')).toHaveCount(0);

    await page.locator('aside nav').getByRole('link', { name: 'Jovens' }).click();
    await expect(page.locator('tbody tr', { hasText: 'Ana Souza' })).toBeVisible();
    await expect(page.getByText('Caio Dias')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Novo jovem' })).toHaveCount(0); // papel de líder, não o da Carla

    await page.locator('aside nav').getByRole('link', { name: 'Configurações' }).click();
    await expect(page.getByRole('heading', { name: 'Meu perfil' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Parâmetros de acompanhamento' })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Usuários e papéis' })).toHaveCount(0);
    await expect(page.getByLabel('Nome')).toHaveValue('Lia Lider');
    await expect(page.locator('body')).not.toContainText('carla.coordenadora@e2e.test');

    await page.locator('aside nav').getByRole('link', { name: 'Relatórios' }).click();
    await expect(page.locator('#rel-grupo option')).toHaveText(['Todos os seus grupos', 'Grupo Alfa']);
  });

  test('o caminho inverso (líder sai, coordenadora entra) também não herda papel nem dados', async ({ page, db }) => {
    const w = await seedWorld(db);

    await loginViaForm(page, w.lia.email, w.lia.password);
    await expect(sidebar(page).getByText('Líder', { exact: true })).toBeVisible();
    await expect.poll(() => badge(page)).toBe('1');
    await page.locator('aside nav').getByRole('link', { name: 'Jovens' }).click();
    await expect(page.getByText('Caio Dias')).toHaveCount(0);
    await logout(page);

    await loginInPlace(page, w.carla);
    await expect(sidebar(page).getByText('Carla Coordenadora')).toBeVisible();
    await expect(sidebar(page).getByText('Coordenador', { exact: true })).toBeVisible();
    await expect(sidebar(page).getByText('Lia Lider')).toHaveCount(0);
    await expect.poll(() => badge(page)).toBe('2');
    await page.locator('aside nav').getByRole('link', { name: 'Jovens' }).click();
    await expect(page.locator('tbody tr', { hasText: 'Caio Dias' })).toBeVisible();
    await expect(page.locator('tbody tr', { hasText: 'Ana Souza' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Novo jovem' })).toBeVisible();
    await page.locator('aside nav').getByRole('link', { name: 'Configurações' }).click();
    await expect(page.getByRole('heading', { name: 'Parâmetros de acompanhamento' })).toBeVisible();
  });

  test('voltar (botão do navegador) depois de sair não mostra as telas do usuário anterior', async ({ page, db }) => {
    const w = await seedWorld(db);
    await loginViaForm(page, w.carla.email, w.carla.password);
    await page.locator('aside nav').getByRole('link', { name: 'Jovens' }).click();
    await expect(page.locator('tbody tr', { hasText: 'Caio Dias' })).toBeVisible();
    await logout(page);

    await page.goBack();
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.locator('body')).not.toContainText('Caio Dias');
    await expect(page.getByRole('button', { name: 'Entrar' })).toBeVisible();
  });

  test('credencial errada logo depois de sair não restaura a sessão anterior', async ({ page, db }) => {
    const w = await seedWorld(db);
    await loginViaForm(page, w.carla.email, w.carla.password);
    await expect(page).toHaveURL('/');
    await logout(page);

    await page.getByLabel('E-mail').fill(w.lia.email);
    await page.getByLabel('Senha', { exact: true }).fill('senha-errada');
    await page.getByRole('button', { name: 'Entrar' }).click();
    await expect(page.getByRole('alert')).toHaveText('E-mail ou senha incorretos.');
    await expect(page).toHaveURL(/\/login$/);
    expect(await page.evaluate((k) => localStorage.getItem(k), AUTH_STORAGE_KEY)).toBeNull();
    await page.goto('/alertas');
    await expect(page).toHaveURL(/\/login$/);
  });
});

test.describe('Sessão expirada durante o uso', () => {
  test('a renovação é recusada pelo servidor ao voltar para a aba: volta ao login com o aviso e sem dados', async ({ page, db, loginAs }) => {
    const w = await seedWorld(db);
    await loginAs(w.carla);
    await page.goto('/jovens');
    await expect(page.locator('tbody tr', { hasText: 'Caio Dias' })).toBeVisible();

    // o servidor deixa de aceitar o refresh token (revogado/expirado) e o access token local vence
    await page.route('**/auth/v1/token*', (route) =>
      route.fulfill({
        status: 400, contentType: 'application/json',
        body: JSON.stringify({ code: 400, error_code: 'refresh_token_not_found', msg: 'Invalid Refresh Token: Refresh Token Not Found' }),
      }));
    await page.evaluate((key) => {
      const session = JSON.parse(localStorage.getItem(key)!);
      session.expires_at = Math.floor(Date.now() / 1000) - 120;
      localStorage.setItem(key, JSON.stringify(session));
    }, AUTH_STORAGE_KEY);
    // o usuário volta para a aba: o cliente tenta renovar a sessão
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange', { bubbles: true })));

    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByRole('status')).toHaveText('Sua sessão foi encerrada. Entre novamente para continuar.');
    await expect(page.locator('body')).not.toContainText('Caio Dias');
    await expect(page.locator('body')).not.toContainText('Carla Coordenadora');
    expect(await page.evaluate((k) => localStorage.getItem(k), AUTH_STORAGE_KEY)).toBeNull();

    // rotas protegidas continuam fechadas e o login volta a funcionar normalmente
    await page.unroute('**/auth/v1/token*');
    await page.goto('/alertas');
    await expect(page).toHaveURL(/\/login$/);
    await loginViaForm(page, w.lia.email, w.lia.password);
    await expect(page).toHaveURL('/');
    await expect(sidebar(page).getByText('Lia Lider')).toBeVisible();
  });

  test('falha de REDE ao renovar não derruba a sessão (diferente de token inválido)', async ({ page, db, loginAs }) => {
    const w = await seedWorld(db);
    await loginAs(w.carla);
    await page.goto('/jovens');
    await expect(page.locator('tbody tr', { hasText: 'Caio Dias' })).toBeVisible();

    await page.route('**/auth/v1/token*', (route) => route.abort('connectionrefused'));
    await page.evaluate((key) => {
      const session = JSON.parse(localStorage.getItem(key)!);
      session.expires_at = Math.floor(Date.now() / 1000) - 120;
      localStorage.setItem(key, JSON.stringify(session));
    }, AUTH_STORAGE_KEY);
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange', { bubbles: true })));
    await page.waitForTimeout(800);

    // sem internet não é sessão inválida: o usuário continua na tela e a sessão local é mantida
    await expect(page).toHaveURL(/\/jovens$/);
    await expect(page.locator('tbody tr', { hasText: 'Caio Dias' })).toBeVisible();
    expect(await page.evaluate((k) => localStorage.getItem(k), AUTH_STORAGE_KEY)).not.toBeNull();
  });

  test('token vencido com refresh válido renova sozinho ao voltar para a aba (sem aviso e sem login)', async ({ page, db, loginAs }) => {
    const w = await seedWorld(db);
    await loginAs(w.carla);
    await page.goto('/jovens');
    await expect(page.locator('tbody tr', { hasText: 'Caio Dias' })).toBeVisible();

    const refreshes: string[] = [];
    page.on('request', (r) => { if (r.url().includes('grant_type=refresh_token')) refreshes.push(r.url()); });
    await page.evaluate((key) => {
      const session = JSON.parse(localStorage.getItem(key)!);
      session.expires_at = Math.floor(Date.now() / 1000) - 120;
      localStorage.setItem(key, JSON.stringify(session));
    }, AUTH_STORAGE_KEY);
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange', { bubbles: true })));

    await expect.poll(() => refreshes.length).toBeGreaterThan(0);
    await expect(page).toHaveURL(/\/jovens$/);
    await expect(page.getByRole('status')).toHaveCount(0);
    await expect.poll(async () => {
      const session = await page.evaluate((k) => JSON.parse(localStorage.getItem(k)!), AUTH_STORAGE_KEY);
      return session.expires_at > Math.floor(Date.now() / 1000);
    }).toBe(true);
  });
});
