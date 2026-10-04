import { APP_URL } from './env.ts';
import { expect, loginViaForm, test } from './fixtures.ts';

const EXPIRED_HASH =
  '#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired';

test.describe('Recuperação de senha — pedido do link', () => {
  test('o login oferece "Esqueci minha senha" e há caminho de volta', async ({ page }) => {
    await page.goto('/login');
    await page.getByRole('link', { name: 'Esqueci minha senha' }).click();
    await expect(page).toHaveURL(/\/recuperar-senha$/);
    await expect(page.getByRole('heading', { name: 'Recuperar senha' })).toBeVisible();

    await page.getByRole('link', { name: 'Voltar ao login' }).click();
    await expect(page).toHaveURL(/\/login$/);
  });

  test('pede o link, mostra confirmação genérica e envia o redirect para /redefinir-senha', async ({ page, db }) => {
    const user = await db.createUser('leader', 'Lia Lider');
    await page.goto('/recuperar-senha');

    await page.getByLabel('E-mail').fill(user.email);
    await page.getByRole('button', { name: 'Enviar link' }).click();

    await expect(page.getByRole('heading', { name: 'Verifique seu e-mail' })).toBeVisible();
    await expect(page.getByRole('status')).toContainText('Se');
    await expect(page.getByRole('status')).toContainText('estiver cadastrado');
    const requests = await db.recoverRequests();
    expect(requests).toEqual([{ email: user.email, redirectTo: `${APP_URL}/redefinir-senha` }]);

    await page.getByRole('link', { name: 'Voltar ao login' }).click();
    await expect(page).toHaveURL(/\/login$/);
  });

  test('e-mail inexistente recebe a MESMA confirmação (não revela quem tem conta)', async ({ page }) => {
    await page.goto('/recuperar-senha');
    await page.getByLabel('E-mail').fill('ninguem@e2e.test');
    await page.getByRole('button', { name: 'Enviar link' }).click();

    await expect(page.getByRole('heading', { name: 'Verifique seu e-mail' })).toBeVisible();
    await expect(page.getByRole('status')).toContainText('estiver cadastrado');
  });

  test('e-mail vazio ou inválido é barrado antes de chamar o servidor', async ({ page, db }) => {
    await page.goto('/recuperar-senha');
    await page.getByRole('button', { name: 'Enviar link' }).click();
    expect(await page.getByLabel('E-mail').evaluate((el: HTMLInputElement) => el.validity.valueMissing)).toBe(true);

    await page.getByLabel('E-mail').fill('isso-nao-e-email');
    await page.getByRole('button', { name: 'Enviar link' }).click();
    expect(await page.getByLabel('E-mail').evaluate((el: HTMLInputElement) => el.validity.typeMismatch)).toBe(true);
    expect(await db.recoverRequests()).toHaveLength(0);
  });

  test('mostra estado de carregamento ao enviar', async ({ page, db }) => {
    const user = await db.createUser('leader', 'Lia Lider');
    await page.route('**/auth/v1/recover*', async (route) => {
      await new Promise((r) => setTimeout(r, 1000));
      await route.continue();
    });
    await page.goto('/recuperar-senha');
    await page.getByLabel('E-mail').fill(user.email);

    await page.getByRole('button', { name: 'Enviar link' }).click();

    const busy = page.getByRole('button', { name: 'Enviando...' });
    await expect(busy).toBeDisabled();
    await expect(busy).toHaveAttribute('aria-busy', 'true');
    await expect(page.getByRole('heading', { name: 'Verifique seu e-mail' })).toBeVisible();
  });

  test('limite de pedidos (429) vira mensagem em pt-BR com o tempo de espera', async ({ page, db }) => {
    const user = await db.createUser('leader', 'Lia Lider');
    await page.route('**/auth/v1/recover*', (route) =>
      route.fulfill({
        status: 429,
        contentType: 'application/json',
        body: JSON.stringify({
          code: 429, error_code: 'over_email_send_rate_limit',
          msg: 'For security purposes, you can only request this after 48 seconds.',
        }),
      }));
    await page.goto('/recuperar-senha');
    await page.getByLabel('E-mail').fill(user.email);
    await page.getByRole('button', { name: 'Enviar link' }).click();

    await expect(page.getByRole('alert')).toHaveText('Por segurança, aguarde 48 segundos antes de tentar novamente.');
    await expect(page.getByLabel('E-mail')).toHaveAttribute('aria-invalid', 'true');
    await expect(page.getByRole('button', { name: 'Enviar link' })).toBeEnabled();
  });

  test('falha de rede mostra a mensagem de rede (sem texto técnico), devolve o foco ao e-mail e permite tentar de novo', async ({ page }) => {
    await page.route('**/auth/v1/recover*', (route) => route.abort('connectionrefused'));
    await page.goto('/recuperar-senha');
    await page.getByLabel('E-mail').fill('lia@e2e.test');
    await page.getByRole('button', { name: 'Enviar link' }).click();

    // Bloco 0: rede deixou de cair na mensagem genérica de envio e passou a ter mensagem própria
    await expect(page.getByRole('alert')).toHaveText('Sem conexão com o servidor. Verifique sua internet e tente novamente.');
    await expect(page.getByText(/failed to fetch|fetch/i)).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Enviar link' })).toBeEnabled();
    await expect(page.getByLabel('E-mail')).toBeFocused();
  });

  test('429 sem tempo de espera informado vira "Muitas tentativas…" e o foco volta ao e-mail', async ({ page }) => {
    await page.route('**/auth/v1/recover*', (route) =>
      route.fulfill({
        status: 429,
        contentType: 'application/json',
        body: JSON.stringify({ code: 429, error_code: 'over_request_rate_limit', msg: 'Request rate limit reached' }),
      }));
    await page.goto('/recuperar-senha');
    await page.getByLabel('E-mail').fill('lia@e2e.test');
    await page.getByRole('button', { name: 'Enviar link' }).click();

    await expect(page.getByRole('alert')).toHaveText('Muitas tentativas. Aguarde alguns minutos e tente novamente.');
    await expect(page.getByText('Request rate limit reached')).toHaveCount(0);
    await expect(page.getByLabel('E-mail')).toBeFocused();
    await expect(page.getByRole('button', { name: 'Enviar link' })).toBeEnabled();
  });

  test('usuário já autenticado não vê a tela de recuperação', async ({ page, db, loginAs }) => {
    await loginAs(await db.createUser('leader', 'Lia Lider'));
    await page.goto('/recuperar-senha');
    await expect(page).toHaveURL('/');
  });
});

test.describe('Link de recuperação — definir nova senha', () => {
  test('define a nova senha, entra no sistema e consegue logar de novo só com a nova', async ({ page, db }) => {
    const user = await db.createUser('coordinator', 'Carla Coordenadora');
    const hash = await db.authLink(user.email, 'recovery');

    await page.goto(`/redefinir-senha${hash}`);

    await expect(page.getByRole('heading', { name: 'Redefinir senha' })).toBeVisible();
    // o token não fica na barra de endereço / histórico
    expect(await page.evaluate(() => location.hash)).toBe('');

    await page.getByLabel('Nova senha').fill('NovaSenha#2026');
    await page.getByLabel('Confirmar senha').fill('NovaSenha#2026');
    await page.getByRole('button', { name: 'Salvar nova senha' }).click();

    await expect(page).toHaveURL('/');
    await expect(page.locator('aside').getByText('Carla Coordenadora')).toBeVisible();

    await page.getByRole('button', { name: 'Encerrar sessão' }).click();
    await expect(page).toHaveURL(/\/login$/);
    await loginViaForm(page, user.email, user.password); // senha antiga
    await expect(page.getByRole('alert')).toHaveText('E-mail ou senha inválidos.');
    await page.getByLabel('Senha', { exact: true }).fill('NovaSenha#2026');
    await page.getByRole('button', { name: 'Entrar' }).click();
    await expect(page).toHaveURL('/');
  });

  test('valida: senhas diferentes, senha curta e senha igual à atual', async ({ page, db }) => {
    const user = await db.createUser('leader', 'Lia Lider');
    await page.goto(`/redefinir-senha${await db.authLink(user.email)}`);
    const pw = page.getByLabel('Nova senha');
    const confirm = page.getByLabel('Confirmar senha');
    const save = page.getByRole('button', { name: 'Salvar nova senha' });

    await pw.fill('abcdef');
    await confirm.fill('abcdeg');
    await save.click();
    await expect(page.getByRole('alert')).toHaveText('As senhas não conferem.');
    await expect(pw).toHaveAttribute('aria-invalid', 'true');

    await pw.fill('abc');
    await confirm.fill('abc');
    await save.click();
    await expect(page.getByRole('alert')).toHaveText('A senha deve ter pelo menos 6 caracteres.');

    // regra do servidor, traduzida
    await pw.fill(user.password);
    await confirm.fill(user.password);
    await save.click();
    await expect(page.getByRole('alert')).toHaveText('A nova senha deve ser diferente da senha atual.');
    await expect(page).toHaveURL(/\/redefinir-senha#?$/);
  });

  test('após cada erro de validação o foco vai ao campo com problema; 429 e rede têm mensagem própria e devolvem o foco', async ({ page, db }) => {
    const user = await db.createUser('leader', 'Lia Lider');
    await page.goto(`/redefinir-senha${await db.authLink(user.email)}`);
    const pw = page.getByLabel('Nova senha');
    const confirm = page.getByLabel('Confirmar senha');
    const save = page.getByRole('button', { name: 'Salvar nova senha' });

    await pw.fill('abc');
    await confirm.fill('abc');
    await save.click();
    await expect(page.getByRole('alert')).toHaveText('A senha deve ter pelo menos 6 caracteres.');
    await expect(pw).toBeFocused();

    await pw.fill('abcdef');
    await confirm.fill('abcdeg');
    await save.click();
    await expect(page.getByRole('alert')).toHaveText('As senhas não conferem.');
    await expect(confirm).toBeFocused();

    // erros do servidor (a requisição só ocorre com os campos válidos)
    await confirm.fill('abcdef');
    await page.route('**/auth/v1/user', (route) =>
      route.request().method() === 'PUT'
        ? route.fulfill({
            status: 429, contentType: 'application/json',
            body: JSON.stringify({ code: 429, error_code: 'over_request_rate_limit', msg: 'Request rate limit reached' }),
          })
        : route.continue());
    await save.click();
    await expect(page.getByRole('alert')).toHaveText('Muitas tentativas. Aguarde alguns minutos e tente novamente.');
    await expect(pw).toBeFocused();

    await page.unroute('**/auth/v1/user');
    await page.route('**/auth/v1/user', (route) =>
      route.request().method() === 'PUT' ? route.abort('connectionrefused') : route.continue());
    await confirm.focus();
    await save.click();
    await expect(page.getByRole('alert')).toHaveText('Sem conexão com o servidor. Verifique sua internet e tente novamente.');
    await expect(pw).toBeFocused();
  });

  test('mostra "Salvando..." e erro inesperado do servidor sem vazar texto técnico', async ({ page, db }) => {
    const user = await db.createUser('leader', 'Lia Lider');
    await page.goto(`/redefinir-senha${await db.authLink(user.email)}`);
    await page.route('**/auth/v1/user', async (route) => {
      if (route.request().method() !== 'PUT') return route.continue();
      await new Promise((r) => setTimeout(r, 700));
      await route.fulfill({
        status: 500, contentType: 'application/json',
        body: JSON.stringify({ code: 500, error_code: 'unexpected_failure', msg: 'pq: relation auth.secret_table does not exist' }),
      });
    });

    await page.getByLabel('Nova senha').fill('NovaSenha#2026');
    await page.getByLabel('Confirmar senha').fill('NovaSenha#2026');
    await page.getByRole('button', { name: 'Salvar nova senha' }).click();

    await expect(page.getByRole('button', { name: 'Salvando...' })).toBeDisabled();
    // Bloco 0: erro 5xx do GoTrue é traduzido para a mensagem de servidor (nunca o texto cru)
    await expect(page.getByRole('alert')).toHaveText('O servidor encontrou um problema. Tente novamente em instantes.');
    await expect(page.getByText('secret_table')).toHaveCount(0);
  });

  test('enquanto a senha não é definida, outras rotas voltam para a tela de redefinição', async ({ page, db }) => {
    const user = await db.createUser('leader', 'Lia Lider');
    await page.goto(`/redefinir-senha${await db.authLink(user.email)}`);
    await expect(page.getByRole('heading', { name: 'Redefinir senha' })).toBeVisible();

    // navegação interna do app (um page.goto recarregaria a página e descartaria o estado em memória)
    await page.evaluate(() => {
      window.history.pushState({}, '', '/jovens');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    await expect(page).toHaveURL(/\/redefinir-senha#?$/);
    await expect(page.getByRole('heading', { name: 'Redefinir senha' })).toBeVisible();
  });

  test('recarregar depois de entrar pelo link (sem o fragmento) leva a Configurações, onde a senha pode ser trocada', async ({ page, db }) => {
    const user = await db.createUser('leader', 'Lia Lider');
    await page.goto(`/redefinir-senha${await db.authLink(user.email)}`);
    await expect(page.getByRole('heading', { name: 'Redefinir senha' })).toBeVisible();

    await page.reload();

    // sessão do link foi guardada (usuário autenticado) e o fragmento já não existe:
    // usuário autenticado sem link vai para Configurações, onde pode trocar a senha
    await expect(page).toHaveURL(/\/settings$/);
  });
});

test.describe('Convite — definição inicial de senha', () => {
  test('link de convite no endereço raiz leva a "Defina sua senha" e depois ao sistema', async ({ page, db }) => {
    const user = await db.createUser('leader', 'Lia Lider');
    const hash = await db.authLink(user.email, 'invite');

    await page.goto(`/${hash}`);

    await expect(page).toHaveURL(/\/redefinir-senha$/);
    await expect(page.getByRole('heading', { name: 'Defina sua senha' })).toBeVisible();
    await expect(page.getByText('Bem-vindo ao Conecta Jovem!')).toBeVisible();

    await page.getByLabel('Nova senha').fill('MinhaSenha#1');
    await page.getByLabel('Confirmar senha').fill('MinhaSenha#1');
    await page.getByRole('button', { name: 'Definir senha e entrar' }).click();

    await expect(page).toHaveURL('/');
    await expect(page.locator('aside').getByText('Lia Lider')).toBeVisible();

    // e na próxima vez entra com a senha escolhida
    await page.getByRole('button', { name: 'Encerrar sessão' }).click();
    await loginViaForm(page, user.email, 'MinhaSenha#1');
    await expect(page).toHaveURL('/');
  });
});

test.describe('Link inválido ou expirado', () => {
  test('link expirado explica e oferece pedir outro', async ({ page }) => {
    await page.goto(`/redefinir-senha${EXPIRED_HASH}`);

    await expect(page.getByRole('heading', { name: 'Link inválido ou expirado' })).toBeVisible();
    await expect(page.getByRole('alert')).toContainText('só podem ser usados uma vez');
    await page.getByRole('link', { name: 'Pedir um novo link' }).click();
    await expect(page).toHaveURL(/\/recuperar-senha$/);
    await expect(page.getByRole('heading', { name: 'Recuperar senha' })).toBeVisible();
  });

  test('convite expirado que cai no endereço raiz também mostra a explicação', async ({ page }) => {
    await page.goto(`/${EXPIRED_HASH}`);
    await expect(page).toHaveURL(/\/redefinir-senha$/);
    await expect(page.getByRole('heading', { name: 'Link inválido ou expirado' })).toBeVisible();
    // não fica preso: pode voltar ao login
    await page.getByRole('link', { name: 'Voltar ao login' }).click();
    await expect(page).toHaveURL(/\/login$/);
    await page.goto('/jovens');
    await expect(page).toHaveURL(/\/login$/);
  });

  test('abrir /redefinir-senha sem link nem sessão mostra a mesma tela', async ({ page }) => {
    await page.goto('/redefinir-senha');
    await expect(page.getByRole('heading', { name: 'Link inválido ou expirado' })).toBeVisible();
  });

  test('usuário autenticado normal em /redefinir-senha é levado a Configurações', async ({ page, db, loginAs }) => {
    await loginAs(await db.createUser('leader', 'Lia Lider'));
    await page.goto('/redefinir-senha');
    await expect(page).toHaveURL(/\/settings$/);
  });
});

test.describe('Sessão encerrada e perfil não carregado', () => {
  test('sessão encerrada em outra aba: volta ao login explicando o motivo', async ({ page, db, context }) => {
    const user = await db.createUser('leader', 'Lia Lider');
    await loginViaForm(page, user.email, user.password);
    await expect(page).toHaveURL('/');

    // outra aba do mesmo navegador sai da conta (o Supabase avisa as demais abas)
    const other = await context.newPage();
    await other.goto('/');
    await other.getByRole('button', { name: 'Encerrar sessão' }).click();
    await expect(other).toHaveURL(/\/login$/);

    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByRole('status')).toHaveText('Sua sessão foi encerrada. Entre novamente para continuar.');
  });

  test('sair pelo botão NÃO mostra o aviso de sessão encerrada', async ({ page, db, loginAs }) => {
    await loginAs(await db.createUser('leader', 'Lia Lider'));
    await page.goto('/');
    await page.getByRole('button', { name: 'Encerrar sessão' }).click();

    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByRole('status')).toHaveCount(0);
  });

  test('autenticado sem papel carregado: tela de erro (não abre o app) e "Tentar novamente" recupera', async ({ page, db, loginAs }) => {
    const user = await db.createUser('coordinator', 'Carla Coordenadora');
    await loginAs(user);
    await db.sql(`DELETE FROM user_roles WHERE user_id = $1`, [user.id]);

    await page.goto('/');

    await expect(page.getByRole('heading', { name: 'Não foi possível carregar sua conta' })).toBeVisible();
    await expect(page.locator('aside')).toHaveCount(0); // app não abriu "pela metade"
    await page.goto('/grupos');
    await expect(page.getByRole('heading', { name: 'Não foi possível carregar sua conta' })).toBeVisible(); // fail-closed em toda rota

    await db.sql(`INSERT INTO user_roles (user_id, role) VALUES ($1, 'coordinator')`, [user.id]);
    await page.getByRole('button', { name: 'Tentar novamente' }).click();

    await expect(page.getByRole('heading', { name: 'Grupos' })).toBeVisible();
    await expect(page.locator('aside').getByText('Coordenador', { exact: true })).toBeVisible();
  });

  test('falha de rede ao carregar o perfil: erro sem detalhes técnicos e "Sair" volta ao login', async ({ page, db, loginAs }) => {
    await loginAs(await db.createUser('leader', 'Lia Lider'));
    await page.route('**/rest/v1/user_roles*', (route) =>
      route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ message: 'pq: connection to host db-internal-7 failed' }) }));

    await page.goto('/');

    await expect(page.getByRole('heading', { name: 'Não foi possível carregar sua conta' })).toBeVisible();
    await expect(page.getByText('db-internal-7')).toHaveCount(0);
    await page.getByRole('button', { name: 'Sair' }).click();
    await expect(page).toHaveURL(/\/login$/);
  });
});

test.describe('Configurações — troca de senha com mensagens em pt-BR', () => {
  test('senha igual à atual (regra do servidor) aparece traduzida', async ({ page, db, loginAs }) => {
    const user = await db.createUser('leader', 'Lia Lider');
    await loginAs(user);
    await page.goto('/settings');

    await page.getByLabel('Nova senha').fill(user.password);
    await page.getByLabel('Confirmar senha').fill(user.password);
    await page.getByRole('button', { name: 'Alterar senha' }).click();

    await expect(page.getByText('A nova senha deve ser diferente da senha atual.')).toBeVisible();
    await expect(page.getByText(/should be different/i)).toHaveCount(0);
  });

  test('troca a senha com sucesso e a nova passa a valer no login', async ({ page, db, loginAs }) => {
    const user = await db.createUser('leader', 'Lia Lider');
    await loginAs(user);
    await page.goto('/settings');

    await page.getByLabel('Nova senha').fill('OutraSenha#77');
    await page.getByLabel('Confirmar senha').fill('OutraSenha#77');
    await page.getByRole('button', { name: 'Alterar senha' }).click();
    await expect(page.getByText('Senha alterada.')).toBeVisible();

    await page.getByRole('button', { name: 'Encerrar sessão' }).click();
    await loginViaForm(page, user.email, 'OutraSenha#77');
    await expect(page).toHaveURL('/');
  });
});
