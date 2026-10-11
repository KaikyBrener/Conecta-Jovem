import { AUTH_STORAGE_KEY } from './env.ts';
import { expect, loginViaForm, test } from './fixtures.ts';

test.describe('Login', () => {
  test('credenciais válidas levam ao dashboard autenticado', async ({ page, db }) => {
    const user = await db.createUser('coordinator', 'Carla Coordenadora');

    await loginViaForm(page, user.email, user.password);

    await expect(page).toHaveURL('/');
    await expect(page.getByRole('heading', { name: 'Visão geral' })).toBeVisible();
    const sidebar = page.locator('aside');
    await expect(sidebar.getByText('Carla Coordenadora')).toBeVisible();
    await expect(sidebar.getByText('Coordenador', { exact: true })).toBeVisible();
  });

  test('senha incorreta mostra erro contextual e permanece no login', async ({ page, db }) => {
    const user = await db.createUser('leader', 'Lia Lider');

    await loginViaForm(page, user.email, 'senha-errada');

    await expect(page.getByRole('alert')).toHaveText('E-mail ou senha incorretos.');
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByLabel('E-mail')).toHaveAttribute('aria-invalid', 'true');
    await expect(page.getByLabel('Senha', { exact: true })).toHaveAttribute('aria-invalid', 'true');
    // botão volta a ficar utilizável para nova tentativa
    await expect(page.getByRole('button', { name: 'Entrar' })).toBeEnabled();
    expect(await page.evaluate((k) => localStorage.getItem(k), AUTH_STORAGE_KEY)).toBeNull();
  });

  test('e-mail inexistente recebe a mesma mensagem (não revela se a conta existe)', async ({ page }) => {
    await loginViaForm(page, 'ninguem@e2e.test', 'qualquer-senha');
    await expect(page.getByRole('alert')).toHaveText('E-mail ou senha incorretos.');
  });

  test('campos obrigatórios: formulário vazio não dispara requisição de login', async ({ page }) => {
    const tokenRequests: string[] = [];
    page.on('request', (r) => {
      if (r.url().includes('/auth/v1/token')) tokenRequests.push(r.url());
    });
    await page.goto('/login');

    await page.getByRole('button', { name: 'Entrar' }).click();

    const email = page.getByLabel('E-mail');
    expect(await email.evaluate((el: HTMLInputElement) => el.validity.valueMissing)).toBe(true);
    await expect(page).toHaveURL(/\/login$/);
    expect(tokenRequests).toHaveLength(0);
  });

  test('e-mail com formato inválido é barrado pelo navegador', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel('E-mail').fill('isso-nao-e-email');
    await page.getByLabel('Senha', { exact: true }).fill('abc');
    await page.getByRole('button', { name: 'Entrar' }).click();

    expect(await page.getByLabel('E-mail').evaluate((el: HTMLInputElement) => el.validity.typeMismatch)).toBe(true);
    await expect(page).toHaveURL(/\/login$/);
  });

  test('mostra estado de carregamento enquanto autentica', async ({ page, db }) => {
    const user = await db.createUser('coordinator', 'Carla Coordenadora');
    // segura a resposta do login para dar tempo de observar o loading
    await page.route('**/auth/v1/token*', async (route) => {
      await new Promise((r) => setTimeout(r, 1200));
      await route.continue();
    });
    await page.goto('/login');
    await page.getByLabel('E-mail').fill(user.email);
    await page.getByLabel('Senha', { exact: true }).fill(user.password);

    await page.getByRole('button', { name: 'Entrar' }).click();

    const busy = page.getByRole('button', { name: 'Entrando...' });
    await expect(busy).toBeDisabled();
    await expect(busy).toHaveAttribute('aria-busy', 'true');
    await expect(page.getByLabel('E-mail')).toHaveAttribute('readonly', '');
    await expect(page).toHaveURL('/');
  });

  test('falha de rede mostra mensagem de REDE (não de credencial), libera o botão e devolve o foco à senha', async ({ page, db }) => {
    const user = await db.createUser('leader', 'Lia Lider');
    await page.route('**/auth/v1/token*', (route) => route.abort('connectionrefused'));

    await loginViaForm(page, user.email, user.password);

    const alert = page.getByRole('alert');
    await expect(alert).toHaveText('Sem conexão com o servidor. Verifique sua internet e tente novamente.');
    // rede não é senha errada: nem a mensagem de credencial nem texto técnico do navegador
    await expect(alert).not.toContainText('E-mail ou senha incorretos');
    await expect(page.getByText(/failed to fetch|ERR_|AuthRetryableFetchError/i)).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Entrar' })).toBeEnabled();
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByLabel('Senha', { exact: true })).toBeFocused();
  });

  test('429 do servidor mostra "Muitas tentativas…" (não "senha inválida") e não vaza o texto cru', async ({ page, db }) => {
    const user = await db.createUser('leader', 'Lia Lider');
    await page.route('**/auth/v1/token*', (route) =>
      route.fulfill({
        status: 429,
        contentType: 'application/json',
        body: JSON.stringify({ code: 429, error_code: 'over_request_rate_limit', msg: 'Request rate limit reached' }),
      }));

    await loginViaForm(page, user.email, user.password);

    const alert = page.getByRole('alert');
    await expect(alert).toHaveText('Muitas tentativas. Aguarde alguns minutos e tente novamente.');
    await expect(alert).not.toContainText('E-mail ou senha incorretos');
    await expect(page.getByText('Request rate limit reached')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Entrar' })).toBeEnabled();
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByLabel('Senha', { exact: true })).toBeFocused();
  });

  test('429 identificado só pelo error_code (over_*_rate_limit), sem status 429, também vira "Muitas tentativas…"', async ({ page, db }) => {
    const user = await db.createUser('leader', 'Lia Lider');
    await page.route('**/auth/v1/token*', (route) =>
      route.fulfill({
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify({ code: 400, error_code: 'over_email_send_rate_limit', msg: 'algo interno' }),
      }));

    await loginViaForm(page, user.email, user.password);

    await expect(page.getByRole('alert')).toHaveText('Muitas tentativas. Aguarde alguns minutos e tente novamente.');
    await expect(page.getByText('algo interno')).toHaveCount(0);
  });

  test('credencial inválida: o foco vai para o campo de senha, com o texto selecionado para redigitar', async ({ page, db }) => {
    const user = await db.createUser('leader', 'Lia Lider');

    await loginViaForm(page, user.email, 'senha-errada');

    await expect(page.getByRole('alert')).toHaveText('E-mail ou senha incorretos.');
    const password = page.getByLabel('Senha', { exact: true });
    await expect(password).toBeFocused();
    // texto selecionado: digitar substitui a senha errada em vez de acrescentar a ela
    expect(await password.evaluate((el: HTMLInputElement) => [el.selectionStart, el.selectionEnd])).toEqual([0, 'senha-errada'.length]);
    await page.keyboard.type(user.password);
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL('/');
  });

  test('botão mostrar/ocultar senha alterna o tipo do campo', async ({ page }) => {
    await page.goto('/login');
    const password = page.getByLabel('Senha', { exact: true });
    await password.fill('segredo');
    await expect(password).toHaveAttribute('type', 'password');

    await page.getByRole('button', { name: 'Mostrar senha' }).click();
    await expect(password).toHaveAttribute('type', 'text');
    await expect(password).toHaveValue('segredo');

    await page.getByRole('button', { name: 'Ocultar senha' }).click();
    await expect(password).toHaveAttribute('type', 'password');
  });

  test('é possível autenticar só pelo teclado (Tab + Enter)', async ({ page, db }) => {
    const user = await db.createUser('leader', 'Lia Lider');
    await page.goto('/login');

    await page.getByLabel('E-mail').focus();
    await page.keyboard.type(user.email);
    await page.keyboard.press('Tab');
    await page.keyboard.type(user.password);
    await page.keyboard.press('Enter');

    await expect(page).toHaveURL('/');
  });
});

test.describe('Sessão, redirects e acesso', () => {
  test('rota protegida sem sessão redireciona para /login', async ({ page }) => {
    for (const path of ['/', '/grupos', '/encontros', '/alertas', '/tarefas', '/settings']) {
      await page.goto(path);
      await expect(page).toHaveURL(/\/login$/);
    }
  });

  test('rota desconhecida cai no login (sem sessão) ou no início (com sessão)', async ({ page, db, loginAs }) => {
    await page.goto('/pagina-que-nao-existe');
    await expect(page).toHaveURL(/\/login$/);

    const user = await db.createUser('leader', 'Lia Lider');
    await loginAs(user);
    await page.goto('/pagina-que-nao-existe');
    await expect(page).toHaveURL('/');
  });

  test('usuário autenticado que abre /login é levado ao início', async ({ page, db, loginAs }) => {
    await loginAs(await db.createUser('coordinator', 'Carla Coordenadora'));
    await page.goto('/login');
    await expect(page).toHaveURL('/');
  });

  test('refresh mantém a autenticação e a rota atual', async ({ page, db }) => {
    const user = await db.createUser('coordinator', 'Carla Coordenadora');
    await loginViaForm(page, user.email, user.password);
    await expect(page).toHaveURL('/');

    await page.getByRole('link', { name: 'Grupos' }).click();
    await expect(page.getByRole('heading', { name: 'Grupos' })).toBeVisible();

    await page.reload();

    await expect(page).toHaveURL(/\/grupos$/);
    await expect(page.getByRole('heading', { name: 'Grupos' })).toBeVisible();
    await expect(page.locator('aside').getByText('Carla Coordenadora')).toBeVisible();
  });

  test('encerrar sessão volta ao login e bloqueia rotas protegidas', async ({ page, db, loginAs }) => {
    await loginAs(await db.createUser('coordinator', 'Carla Coordenadora'));
    await page.goto('/grupos');
    await expect(page.getByRole('heading', { name: 'Grupos' })).toBeVisible();

    await page.getByRole('button', { name: 'Encerrar sessão' }).click();

    await expect(page).toHaveURL(/\/login$/);
    expect(await page.evaluate((k) => localStorage.getItem(k), AUTH_STORAGE_KEY)).toBeNull();

    await page.goto('/grupos');
    await expect(page).toHaveURL(/\/login$/);
  });

  test('o aviso de sessão encerrada aparece uma vez e NÃO reaparece após recarregar a página', async ({ page, db, context }) => {
    const user = await db.createUser('leader', 'Lia Lider');
    await loginViaForm(page, user.email, user.password);
    await expect(page).toHaveURL('/');
    // outra aba encerra a sessão
    const other = await context.newPage();
    await other.goto('/');
    await other.getByRole('button', { name: 'Encerrar sessão' }).click();
    await expect(other).toHaveURL(/\/login$/);
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByRole('status')).toHaveText('Sua sessão foi encerrada. Entre novamente para continuar.');
    // o motivo foi lido uma vez e removido do history.state (react-router guarda o state em history.state.usr)
    await expect.poll(() => page.evaluate(() => (window.history.state as { usr?: unknown } | null)?.usr ?? null)).toBeNull();

    await page.reload();

    await expect(page.getByRole('button', { name: 'Entrar' })).toBeVisible();
    await expect(page.getByRole('status')).toHaveCount(0);
  });
});
