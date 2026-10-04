// Busca global (Fase 7, bloco 8): paleta Ctrl+K sobre a RPC global_search real (migration 014, SECURITY INVOKER).
import type { Page } from '@playwright/test';
import { api, daysFromNow, expect, test, type TestDb } from './fixtures.ts';
import { seedPeople } from './phase7-helpers.ts';

async function seed(db: TestDb) {
  const p = await seedPeople(db);
  const alfaJ = await db.createGroup('Alfa Jovens', p.lia.id);
  const betaJ = await db.createGroup('Beta Jovens', p.davi.id);
  const jose = await db.createYouth('José Almeida', alfaJ);
  const jovelina = await db.createYouth('Jovelina Costa', alfaJ);
  const joana = await db.createYouth('Joana Pereira', betaJ);
  const inativo = await db.createYouth('Jovelino Inativo', alfaJ);
  await db.sql(`UPDATE youth SET is_active = false WHERE id = $1`, [inativo]);
  const culto = await db.createEvent('Culto de Jovens', daysFromNow(2), [alfaJ, betaJ]);
  const retiro = await db.createEvent('Retiro Jovens Beta', daysFromNow(9), [betaJ]);
  return { ...p, alfaJ, betaJ, jose, jovelina, joana, inativo, culto, retiro };
}

const overlay = (page: Page) => page.getByTestId('busca-global-overlay');
const input = (page: Page) => page.getByTestId('busca-global-input');
const options = (page: Page) => page.getByRole('option');

/** Ctrl+K, depois de o layout (e o atalho global) estar montado. */
async function shortcut(page: Page) {
  await expect(page.getByTestId('busca-global-abrir')).toBeVisible();
  await page.keyboard.press('Control+k');
}

test.describe('Busca global — abrir e fechar', () => {
  test('abre pelo botão e por Ctrl+K em qualquer tela, com o foco no campo', async ({ page, db, loginAs }) => {
    const s = await seed(db);
    await loginAs(s.carla);
    await page.goto('/grupos');

    await page.getByTestId('busca-global-abrir').click();
    await expect(page.getByRole('dialog', { name: 'Busca global' })).toBeVisible();
    await expect(input(page)).toBeFocused();
    await expect(page.getByTestId('busca-global-dica')).toHaveText('Digite pelo menos 2 caracteres para buscar jovens, grupos e encontros.');
    await page.keyboard.press('Escape');
    await expect(overlay(page)).toHaveCount(0);

    for (const url of ['/', '/jovens', '/relatorios']) {
      await page.goto(url);
      await shortcut(page);
      await expect(page.getByRole('dialog', { name: 'Busca global' })).toBeVisible();
      await expect(input(page)).toBeFocused();
      await page.keyboard.press('Escape');
      await expect(overlay(page)).toHaveCount(0);
    }
  });

  test('Esc, botão fechar e clique fora fecham; o foco volta para quem abriu', async ({ page, db, loginAs }) => {
    const s = await seed(db);
    await loginAs(s.carla);
    await page.goto('/');
    const opener = page.getByTestId('busca-global-abrir');

    await opener.click();
    await page.keyboard.press('Escape');
    await expect(overlay(page)).toHaveCount(0);
    await expect(opener).toBeFocused();

    await opener.click();
    await page.getByRole('button', { name: 'Fechar busca' }).click();
    await expect(overlay(page)).toHaveCount(0);

    await opener.click();
    await overlay(page).click({ position: { x: 5, y: 5 } });
    await expect(overlay(page)).toHaveCount(0);

    // o fundo não rola enquanto a busca está aberta e volta ao normal depois
    await opener.click();
    expect(await page.evaluate(() => document.body.style.overflow)).toBe('hidden');
    await page.keyboard.press('Escape');
    expect(await page.evaluate(() => document.body.style.overflow)).not.toBe('hidden');
  });

  test('o foco fica preso na paleta (Tab alterna entre campo e botão fechar)', async ({ page, db, loginAs }) => {
    const s = await seed(db);
    await loginAs(s.carla);
    await page.goto('/');
    await shortcut(page);
    await expect(input(page)).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: 'Fechar busca' })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(input(page)).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(page.getByRole('button', { name: 'Fechar busca' })).toBeFocused();
  });
});

test.describe('Busca global — resultados', () => {
  test('mínimo de 2 caracteres e resultados agrupados em Jovens, Grupos e Encontros', async ({ page, db, loginAs }) => {
    const s = await seed(db);
    await loginAs(s.carla);
    await page.goto('/');
    let calls = 0;
    await page.route('**/rest/v1/rpc/global_search*', (route) => { calls += 1; return route.continue(); });
    await shortcut(page);

    await input(page).fill('j');
    await page.waitForTimeout(600);
    expect(calls).toBe(0); // 1 caractere: nem consulta
    await expect(page.getByTestId('busca-global-dica')).toBeVisible();
    await expect(options(page)).toHaveCount(0);

    await input(page).fill('jov');
    await expect(page.getByTestId('busca-global-dica')).toHaveCount(0);
    const groupsOf = (name: string) => page.getByRole('group', { name });
    await expect(groupsOf('Jovens').getByRole('option')).toHaveCount(2); // Jovelina e Jovelino (inativo)
    await expect(groupsOf('Grupos').getByRole('option')).toHaveCount(2);
    await expect(groupsOf('Encontros').getByRole('option')).toHaveCount(2);

    // ordem: nome começa com o termo e depois por nome
    await expect(page.getByTestId('busca-global-youth').nth(0)).toContainText('Jovelina Costa');
    await expect(page.getByTestId('busca-global-youth').nth(0)).toContainText('Alfa Jovens');
    await expect(page.getByTestId('busca-global-youth').nth(1)).toContainText('Jovelino Inativo');
    await expect(page.getByTestId('busca-global-youth').nth(1)).toContainText('Inativo');
    await expect(page.getByTestId('busca-global-group').nth(0)).toContainText('Alfa Jovens');
    await expect(page.getByTestId('busca-global-group').nth(0)).toContainText('Líder: Lia Lider');
    await expect(page.getByTestId('busca-global-group').nth(1)).toContainText('Beta Jovens');
    // encontro: título, data e situação
    const culto = page.getByTestId('busca-global-event').filter({ hasText: 'Culto de Jovens' });
    await expect(culto).toContainText('Agendado');
    await expect(culto).toContainText(/\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}/);
    expect(calls).toBeGreaterThan(0);
  });

  test('ignora acentos e maiúsculas; trata curingas e vírgulas como texto', async ({ page, db, loginAs }) => {
    const s = await seed(db);
    await loginAs(s.carla);
    await page.goto('/');
    await shortcut(page);

    await input(page).fill('jose');
    await expect(page.getByTestId('busca-global-youth')).toHaveCount(1);
    await expect(page.getByTestId('busca-global-youth')).toContainText('José Almeida');
    await input(page).fill('JOSÉ');
    await expect(page.getByTestId('busca-global-youth')).toContainText('José Almeida');
    await input(page).fill('almeida jose'); // não é substring contígua
    await expect(page.getByTestId('busca-global-vazio')).toBeVisible();
    await input(page).fill('  jo  se '); // espaços colapsados
    await expect(page.getByTestId('busca-global-vazio')).toBeVisible();
    await input(page).fill('ze almeida'); // não casa (não é parte contínua do nome)
    await expect(page.getByTestId('busca-global-vazio')).toBeVisible();
    await input(page).fill('é al');
    await expect(page.getByTestId('busca-global-youth')).toContainText('José Almeida');

    // curingas do LIKE não vazam: "%%" e "__" não casam tudo
    await input(page).fill('%%');
    await expect(page.getByTestId('busca-global-vazio')).toBeVisible();
    await input(page).fill('__');
    await expect(page.getByTestId('busca-global-vazio')).toBeVisible();
    await input(page).fill('jo,("*');
    await expect(page.getByTestId('busca-global-youth')).toHaveCount(4); // vira "jo": José, Joana, Jovelina e Jovelino
  });

  test('sem resultado mostra o vazio com o termo digitado', async ({ page, db, loginAs }) => {
    const s = await seed(db);
    await loginAs(s.carla);
    await page.goto('/');
    await shortcut(page);
    await input(page).fill('xyzzy');
    await expect(page.getByTestId('busca-global-vazio')).toHaveText('Nenhum resultado para “xyzzy”.');
    await expect(options(page)).toHaveCount(0);
  });

  test('erro da RPC mostra mensagem amigável sem texto cru', async ({ page, db, loginAs }) => {
    const s = await seed(db);
    await loginAs(s.carla);
    await page.goto('/');
    await page.route('**/rest/v1/rpc/global_search*', (route) =>
      route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ code: 'XX000', message: 'relation "youth_secreta" nao existe' }) }));
    await shortcut(page);
    await input(page).fill('jose');
    await expect(page.getByTestId('busca-global-erro')).toContainText('Não foi possível realizar a busca.');
    await expect(page.locator('body')).not.toContainText('youth_secreta');
    await expect(page.getByTestId('busca-global-vazio')).toHaveCount(0);
    // a paleta continua utilizável: Esc fecha
    await page.keyboard.press('Escape');
    await expect(overlay(page)).toHaveCount(0);
  });
});

test.describe('Busca global — teclado e navegação', () => {
  test('setas movem a opção ativa (circular) e Enter abre a ficha do jovem', async ({ page, db, loginAs }) => {
    const s = await seed(db);
    await loginAs(s.carla);
    await page.goto('/grupos');
    await shortcut(page);
    await input(page).fill('jov');
    await expect(options(page)).toHaveCount(6);

    const active = () => page.locator('[role="option"][aria-selected="true"]');
    await expect(active()).toHaveCount(1);
    await expect(active()).toContainText('Jovelina Costa'); // primeira opção já vem ativa
    await page.keyboard.press('ArrowDown');
    await expect(active()).toContainText('Jovelino Inativo');
    await page.keyboard.press('ArrowDown');
    await expect(active()).toContainText('Alfa Jovens'); // passa para a seção Grupos
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('ArrowUp');
    await expect(active()).toContainText('Jovelina Costa');
    await page.keyboard.press('ArrowUp'); // volta ao fim da lista (circular)
    await expect(active()).toContainText('Retiro Jovens Beta');
    await page.keyboard.press('ArrowDown');
    await expect(active()).toContainText('Jovelina Costa');
    await expect(input(page)).toHaveAttribute('aria-activedescendant', /.+/);

    await page.keyboard.press('Enter');
    await expect(overlay(page)).toHaveCount(0);
    await expect(page).toHaveURL(new RegExp(`/jovens\\?ficha=${s.jovelina}`));
    await expect(page.getByRole('heading', { name: 'Detalhes do Jovem' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Jovelina Costa' })).toBeVisible();
  });

  test('Enter em um grupo abre Grupos já buscando por ele', async ({ page, db, loginAs }) => {
    const s = await seed(db);
    await loginAs(s.carla);
    await page.goto('/');
    await shortcut(page);
    await input(page).fill('beta jov');
    await expect(page.getByTestId('busca-global-group')).toHaveCount(1);
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/grupos/);
    await expect(page.getByPlaceholder('Buscar por grupo ou líder...')).toHaveValue('Beta Jovens');
    await expect(page.getByTestId('grupo-linha')).toHaveCount(1);
    await expect(page.getByTestId('grupo-linha')).toContainText('Beta Jovens');
  });

  test('clicar em um encontro abre o detalhe dele em Encontros', async ({ page, db, loginAs }) => {
    const s = await seed(db);
    await loginAs(s.carla);
    await page.goto('/');
    await shortcut(page);
    await input(page).fill('retiro');
    await page.getByTestId('busca-global-event').click();
    await expect(page).toHaveURL(new RegExp(`/encontros\\?evento=${s.retiro}`));
    await expect(page.getByRole('heading', { name: 'Detalhes do Encontro' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Retiro Jovens Beta' })).toBeVisible();
  });

  test('Enter sem resultados não navega', async ({ page, db, loginAs }) => {
    const s = await seed(db);
    await loginAs(s.carla);
    await page.goto('/jovens');
    await shortcut(page);
    await input(page).fill('xyzzy');
    await expect(page.getByTestId('busca-global-vazio')).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(overlay(page)).toBeVisible();
    await expect(page).toHaveURL(/\/jovens$/);
  });
});

test.describe('Busca global — líder', () => {
  test('líder só encontra jovens, grupos e encontros dos próprios grupos', async ({ page, db, loginAs }) => {
    const s = await seed(db);
    await loginAs(s.lia);
    await page.goto('/');
    await shortcut(page);
    await input(page).fill('jov');

    await expect(page.getByTestId('busca-global-youth')).toHaveCount(2); // Jovelina e Jovelino (do Alfa Jovens)
    await expect(page.getByTestId('busca-global-group')).toHaveCount(1);
    await expect(page.getByTestId('busca-global-group')).toContainText('Alfa Jovens');
    await expect(page.getByTestId('busca-global-event')).toHaveCount(1);
    await expect(page.getByTestId('busca-global-event')).toContainText('Culto de Jovens');
    await expect(overlay(page)).not.toContainText('Beta Jovens');
    await expect(overlay(page)).not.toContainText('Retiro Jovens Beta');

    await input(page).fill('joana');
    await expect(page.getByTestId('busca-global-vazio')).toBeVisible();
    await input(page).fill('retiro');
    await expect(page.getByTestId('busca-global-vazio')).toBeVisible();

    // chamada direta à API também respeita o escopo
    const res = await api(page, 'POST', 'rpc/global_search', { p_query: 'jov', p_limit: 20 });
    expect(res.status).toBe(200);
    expect(res.body.youth.map((y: { full_name: string }) => y.full_name).sort()).toEqual(['Jovelina Costa', 'Jovelino Inativo']);
    expect(res.body.groups.map((g: { name: string }) => g.name)).toEqual(['Alfa Jovens']);
    expect(res.body.events.map((e: { title: string }) => e.title)).toEqual(['Culto de Jovens']);
  });
});
