import type { Page } from '@playwright/test';
import { daysFromNow, expect, modal, test } from './fixtures.ts';

/** Coleta o que o app escreve no console (para verificar o formato sanitizado dos registros de erro). */
function collectConsole(page: Page) {
  const lines: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error') lines.push(m.text()); });
  return lines;
}

const json = (status: number, body: unknown) => ({ status, contentType: 'application/json', body: JSON.stringify(body) });

test.describe('Mensagens de erro amigáveis (nunca o texto técnico do servidor)', () => {
  test('violação de permissão (RLS) vira "sem permissão", sem nome de tabela/política', async ({ page, db, loginAs }) => {
    const coord = await db.createUser('coordinator', 'Carla Coordenadora');
    await db.createUser('leader', 'Lia Lider');
    await loginAs(coord);
    await page.route('**/rest/v1/groups*', (route) =>
      route.request().method() === 'POST'
        ? route.fulfill(json(403, { code: '42501', message: 'new row violates row-level security policy for table "groups"', details: null, hint: null }))
        : route.continue());
    await page.goto('/grupos');

    await page.getByRole('button', { name: 'Novo grupo' }).click();
    const form = modal(page);
    await form.getByPlaceholder('Ex.: Grupo Esperança').fill('Novo');
    await form.locator('select').selectOption({ label: 'Lia Lider' });
    await form.getByRole('button', { name: 'Criar grupo' }).click();

    await expect(page.getByText('Você não tem permissão para realizar esta ação.')).toBeVisible();
    await expect(page.getByText(/row-level|policy|"groups"/i)).toHaveCount(0);
  });

  test('registro duplicado vira mensagem clara, sem nome do índice', async ({ page, db, loginAs }) => {
    const coord = await db.createUser('coordinator', 'Carla Coordenadora');
    await loginAs(coord);
    await page.route('**/rest/v1/tasks*', (route) =>
      route.request().method() === 'POST'
        ? route.fulfill(json(409, { code: '23505', message: 'duplicate key value violates unique constraint "tasks_pkey"', details: 'Key (id)=(x) already exists.', hint: null }))
        : route.continue());
    await page.goto('/tarefas');

    await page.getByRole('button', { name: 'Nova tarefa' }).click();
    await modal(page).getByLabel('Título').fill('Qualquer');
    await modal(page).getByRole('button', { name: 'Criar tarefa' }).click();

    await expect(modal(page).getByText('Já existe um registro com esses dados.')).toBeVisible();
    await expect(page.getByText(/duplicate key|tasks_pkey|Key \(id\)/i)).toHaveCount(0);
  });

  test('sem conexão ao salvar: mensagem em pt-BR em vez de "Failed to fetch"', async ({ page, db, loginAs }) => {
    const coord = await db.createUser('coordinator', 'Carla Coordenadora');
    await db.createUser('leader', 'Lia Lider');
    await loginAs(coord);
    await page.goto('/grupos');
    await page.getByRole('button', { name: 'Novo grupo' }).click();
    await modal(page).getByPlaceholder('Ex.: Grupo Esperança').fill('Novo');
    await modal(page).locator('select').selectOption({ label: 'Lia Lider' });

    await page.route('**/rest/v1/groups*', (route) => route.abort('connectionrefused'));
    await modal(page).getByRole('button', { name: 'Criar grupo' }).click();

    await expect(page.getByText('Sem conexão com o servidor. Verifique sua internet e tente novamente.')).toBeVisible();
    await expect(page.getByText(/failed to fetch|networkerror/i)).toHaveCount(0);
  });

  test('falha de rede ao carregar uma lista mostra "sem conexão"', async ({ page, db, loginAs }) => {
    await loginAs(await db.createUser('coordinator', 'Carla Coordenadora'));
    await page.route('**/rest/v1/events*', (route) => route.abort('connectionrefused'));
    await page.goto('/encontros');

    // o supabase-js repete GETs com espera crescente antes de desistir (~7s): timeout maior que o padrão
    await expect(page.getByText('Sem conexão com o servidor.', { exact: false })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(/failed to fetch/i)).toHaveCount(0);
  });

  test('migration não aplicada (função ausente) orienta a avisar o administrador, sem detalhes', async ({ page, db, loginAs }) => {
    const coord = await db.createUser('coordinator', 'Carla Coordenadora');
    const alfa = await db.createGroup('Grupo Alfa', coord.id);
    await db.createEvent('Culto', daysFromNow(3), [alfa]);
    await loginAs(coord);
    await page.route('**/rest/v1/rpc/save_event', (route) =>
      route.fulfill(json(404, { code: 'PGRST202', message: 'Could not find the function public.save_event(...) in the schema cache', details: null, hint: null })));
    await page.goto('/encontros');

    await page.getByRole('button', { name: 'Culto' }).first().click();
    await modal(page).getByRole('button', { name: 'Editar', exact: true }).click();
    await modal(page).getByRole('button', { name: 'Salvar alterações' }).click();

    await expect(page.getByText('Este recurso ainda não está disponível no banco de dados.', { exact: false }).first()).toBeVisible();
    await expect(page.getByText(/save_event|schema cache/i)).toHaveCount(0);
  });

  test('mensagem escrita por nós no banco (pt-BR) continua aparecendo', async ({ page, db, loginAs }) => {
    const coord = await db.createUser('coordinator', 'Carla Coordenadora');
    await loginAs(coord);
    await page.goto('/settings');
    await expect(page.getByLabel('Papel de Carla Coordenadora')).toBeVisible();

    // único coordenador tentando se rebaixar: regra do banco (RAISE EXCEPTION em pt-BR)
    await page.getByLabel('Papel de Carla Coordenadora').selectOption('leader');

    await expect(page.getByText('Não é possível remover o último coordenador.')).toBeVisible();
  });
});

test.describe('Registro de erros (logger) — sanitizado e com código de incidente', () => {
  test('o console recebe UMA linha por erro, sem objeto cru, sem e-mail nem token', async ({ page, db, loginAs }) => {
    const coord = await db.createUser('coordinator', 'Carla Coordenadora');
    await loginAs(coord);
    const logs = collectConsole(page);
    await page.route('**/rest/v1/groups*', (route) =>
      route.fulfill(json(500, {
        code: 'XX000', message: `erro interno para ${coord.email} token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghij_klm`,
        details: 'DETALHE-SECRETO-DO-BANCO', hint: 'DICA-INTERNA',
      })));

    await page.goto('/grupos');
    await expect(page.getByText('Erro ao carregar grupos.')).toBeVisible();

    const app = logs.filter((l) => l.startsWith('[conectjovem]'));
    expect(app.length).toBeGreaterThan(0);
    const all = app.join('\n');
    expect(all).toContain('Erro ao carregar grupos.');
    expect(all).toMatch(/\[conectjovem\] [0-9a-f]{8} /);
    expect(all).not.toContain(coord.email);
    expect(all).not.toMatch(/eyJ[\w-]{8,}\./);
    expect(all).not.toContain('DETALHE-SECRETO');
    expect(all).not.toContain('DICA-INTERNA');
    expect(all).not.toMatch(/\n\s+at /); // sem stack
  });

  test('erro fora do React (promessa rejeitada) é capturado e registrado', async ({ page, db, loginAs }) => {
    await loginAs(await db.createUser('leader', 'Lia Lider'));
    const logs = collectConsole(page);
    await page.goto('/');
    await expect(page.locator('aside')).toBeVisible();

    await page.evaluate(() => { void Promise.reject(new Error('rejeição de teste')); });

    await expect.poll(() => logs.filter((l) => l.includes('Promessa rejeitada sem tratamento')).length).toBeGreaterThan(0);
    // o app segue funcionando
    await expect(page.locator('aside')).toBeVisible();
  });
});

test.describe('ErrorBoundary — erro de renderização não derruba o app', () => {
  test('dado corrompido em uma página mostra "Algo deu errado" com código, mantém o menu e permite continuar', async ({ page, db, loginAs }) => {
    const coord = await db.createUser('coordinator', 'Carla Coordenadora');
    await loginAs(coord);
    const logs = collectConsole(page);
    // grupo sem nome: a tela de Grupos faz name.charAt(0) e quebra na renderização
    await page.route('**/rest/v1/groups*', (route) =>
      route.request().method() === 'GET' && !route.request().url().includes('head')
        ? route.fulfill({
            status: 200, contentType: 'application/json', headers: { 'content-range': '0-0/1' },
            body: JSON.stringify([{ id: 'g1', name: null, leader_id: coord.id, description: null, profiles: { full_name: 'X' }, youth: [{ count: 0 }] }]),
          })
        : route.continue());

    await page.goto('/grupos');

    const alert = page.getByRole('alert').filter({ hasText: 'Algo deu errado' });
    await expect(alert).toBeVisible();
    await expect(alert).toContainText('Código do incidente:');
    // sem mensagem técnica nem stack na tela
    await expect(page.getByText(/TypeError|charAt|undefined|null/)).toHaveCount(0);
    // o menu lateral continua funcionando
    await expect(page.locator('aside')).toBeVisible();

    const code = (await alert.locator('span.font-mono').textContent())!.trim();
    expect(code).toMatch(/^[0-9a-f]{8}$/);
    expect(logs.join('\n')).toContain(code); // o código mostrado é o mesmo do registro

    // trocar de página limpa o erro
    await page.locator('aside nav').getByRole('link', { name: 'Jovens' }).click();
    await expect(page.getByRole('heading', { name: 'Jovens' })).toBeVisible();
    await expect(page.getByText('Algo deu errado')).toHaveCount(0);
  });

  test('"Tentar novamente" remonta a tela e busca os dados de novo (que agora vêm corretos)', async ({ page, db, loginAs }) => {
    const coord = await db.createUser('coordinator', 'Carla Coordenadora');
    await db.createGroup('Grupo Alfa', coord.id);
    await loginAs(coord);
    let broken = true;
    await page.route('**/rest/v1/groups*', (route) =>
      broken && route.request().method() === 'GET' && !route.request().url().includes('head')
        ? route.fulfill({
            status: 200, contentType: 'application/json', headers: { 'content-range': '0-0/1' },
            body: JSON.stringify([{ id: 'g1', name: null, leader_id: coord.id, description: null, profiles: null, youth: [] }]),
          })
        : route.continue());
    await page.goto('/grupos');
    await expect(page.getByText('Algo deu errado')).toBeVisible();

    broken = false;
    await page.getByRole('button', { name: 'Tentar novamente' }).click();

    await expect(page.locator('tbody tr', { hasText: 'Grupo Alfa' })).toBeVisible();
    await expect(page.getByText('Algo deu errado')).toHaveCount(0);
  });
});

test.describe('Falhas de carga auxiliares não ficam em silêncio', () => {
  test('opções do formulário de tarefa que não carregam geram aviso na tela', async ({ page, db, loginAs }) => {
    const coord = await db.createUser('coordinator', 'Carla Coordenadora');
    await db.createYouth('Ana Souza', null);
    await loginAs(coord);
    await page.route('**/rest/v1/youth*', (route) => route.fulfill(json(500, { message: 'falha' })));

    await page.goto('/tarefas');

    await expect(page.getByText('Não foi possível carregar jovens, grupos e responsáveis para o formulário.')).toBeVisible();
  });

  test('lista de grupos do filtro de Jovens que não carrega gera aviso', async ({ page, db, loginAs }) => {
    await loginAs(await db.createUser('coordinator', 'Carla Coordenadora'));
    await page.route('**/rest/v1/groups*', (route) => route.fulfill(json(500, { message: 'falha' })));

    await page.goto('/jovens');

    await expect(page.getByText('Não foi possível carregar a lista de grupos.')).toBeVisible();
  });
});

test.describe('Feedback de sucesso (toasts)', () => {
  // Atualizado para o modelo de 3 estados (Fase 7, bloco 1): "Salvar Chamada" só habilita com alguma marcação, o
  // salvamento não navega (mostra o resumo na própria tela) e o aviso passou a dizer "Chamada registrada.".
  // A intenção é a mesma: salvar a chamada dá confirmação visível por toast (role=status).
  test('salvar a chamada confirma "Chamada registrada." (toast) e mostra o resumo na própria tela', async ({ page, db, loginAs }) => {
    const coord = await db.createUser('coordinator', 'Carla Coordenadora');
    const group = await db.createGroup('Grupo Alfa', coord.id);
    await db.createYouth('Ana Souza', group);
    const eventId = await db.createEvent('Culto', daysFromNow(-1), [group]);
    await loginAs(coord);
    await page.goto(`/chamada/${eventId}`);

    // sem nenhuma marcação não há o que salvar
    await expect(page.getByRole('button', { name: 'Salvar Chamada' })).toBeDisabled();
    await page.getByRole('button', { name: 'Presente: Ana Souza' }).click();
    await page.getByRole('button', { name: 'Salvar Chamada' }).click();

    await expect(page.getByRole('status').filter({ hasText: 'Chamada registrada.' })).toBeVisible();
    await expect(page.getByTestId('chamada-resumo')).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/chamada/${eventId}$`));
  });

  test('criar grupo, criar e concluir tarefa mostram confirmação; o aviso pode ser fechado', async ({ page, db, loginAs }) => {
    const coord = await db.createUser('coordinator', 'Carla Coordenadora');
    await db.createUser('leader', 'Lia Lider');
    await loginAs(coord);

    await page.goto('/grupos');
    await page.getByRole('button', { name: 'Novo grupo' }).click();
    await modal(page).getByPlaceholder('Ex.: Grupo Esperança').fill('Grupo Esperança');
    await modal(page).locator('select').selectOption({ label: 'Lia Lider' });
    await modal(page).getByRole('button', { name: 'Criar grupo' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Grupo criado.' })).toBeVisible();

    await page.goto('/tarefas');
    await page.getByRole('button', { name: 'Nova tarefa' }).click();
    await modal(page).getByLabel('Título').fill('Ligar para as famílias');
    await modal(page).getByRole('button', { name: 'Criar tarefa' }).click();
    const created = page.getByRole('status').filter({ hasText: 'Tarefa criada.' });
    await expect(created).toBeVisible();

    await page.locator('main li', { hasText: 'Ligar para as famílias' }).getByRole('button', { name: 'Concluir' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Tarefa concluída.' })).toBeVisible();

    // o aviso pode ser fechado
    await created.getByRole('button', { name: 'Fechar aviso' }).click();
    await expect(created).toHaveCount(0);
  });

  test('o aviso desaparece sozinho depois de alguns segundos', async ({ page, db, loginAs }) => {
    await loginAs(await db.createUser('coordinator', 'Carla Coordenadora'));
    await page.goto('/tarefas');
    await page.getByRole('button', { name: 'Nova tarefa' }).click();
    await modal(page).getByLabel('Título').fill('Tarefa rápida');
    await modal(page).getByRole('button', { name: 'Criar tarefa' }).click();

    const toast = page.getByRole('status').filter({ hasText: 'Tarefa criada.' });
    await expect(toast).toBeVisible();
    await expect(toast).toHaveCount(0, { timeout: 8000 });
  });
});
