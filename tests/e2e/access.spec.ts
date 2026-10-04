import { ANON_KEY, SUPABASE_URL } from './env.ts';
import { expect, injectSession, passwordSession, test, type TestUser } from './fixtures.ts';

/** Chamada direta à API do Supabase (PostgREST), como um cliente malicioso faria. */
async function api(path: string, init: { method?: string; token?: string; body?: unknown } = {}) {
  const res = await fetch(`${SUPABASE_URL}${path}`, {
    method: init.method ?? 'GET',
    headers: {
      'content-type': 'application/json',
      apikey: ANON_KEY,
      authorization: `Bearer ${init.token ?? ANON_KEY}`,
      prefer: 'return=representation',
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

const tokenOf = async (u: TestUser) => (await passwordSession(u)).access_token as string;

test.describe('Configurações por papel', () => {
  test('coordenador vê perfil, parâmetros do sistema e gestão de papéis', async ({ page, db, loginAs }) => {
    const coord = await db.createUser('coordinator', 'Carla Coordenadora');
    await db.createUser('leader', 'Lia Lider');
    await loginAs(coord);

    await page.goto('/settings');

    await expect(page.getByRole('heading', { name: 'Meu perfil' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Parâmetros de acompanhamento' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Usuários e papéis' })).toBeVisible();
    await expect(page.getByLabel('Papel de Lia Lider')).toHaveValue('leader');
  });

  test('líder vê só o próprio perfil (sem parâmetros do sistema nem papéis)', async ({ page, db, loginAs }) => {
    await db.createUser('coordinator', 'Carla Coordenadora');
    await loginAs(await db.createUser('leader', 'Lia Lider'));

    await page.goto('/settings');

    await expect(page.getByRole('heading', { name: 'Meu perfil' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Parâmetros de acompanhamento' })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Usuários e papéis' })).toHaveCount(0);
    await expect(page.getByLabel(/^Papel de/)).toHaveCount(0);
  });

  test('coordenador valida e altera o limite de faltas; o valor persiste', async ({ page, db, loginAs }) => {
    await loginAs(await db.createUser('coordinator', 'Carla Coordenadora'));
    await page.goto('/settings');
    const field = page.getByLabel('Faltas consecutivas para gerar alerta');
    await expect(field).toHaveValue('3');

    // fora do intervalo (max=20): o navegador barra o envio e nada é gravado
    await field.fill('50');
    await page.getByRole('button', { name: 'Salvar', exact: true }).click();
    expect(await field.evaluate((el: HTMLInputElement) => el.validity.rangeOverflow)).toBe(true);
    expect((await db.sql(`SELECT absence_alert_threshold AS n FROM app_settings`))[0].n).toBe(3);

    await field.fill('5');
    await page.getByRole('button', { name: 'Salvar', exact: true }).click();
    await expect.poll(async () => (await db.sql(`SELECT absence_alert_threshold AS n FROM app_settings`))[0].n).toBe(5);

    await page.reload();
    await expect(page.getByLabel('Faltas consecutivas para gerar alerta')).toHaveValue('5');
  });

  // Regressão: <SettingsForm key={settings.updated_at}> era remontado ao salvar (updated_at muda)
  // e perdia o estado `ok`, então a confirmação nunca aparecia.
  test('salvar parâmetros mostra a confirmação "Configurações salvas."', async ({ page, db, loginAs }) => {
    await loginAs(await db.createUser('coordinator', 'Carla Coordenadora'));
    await page.goto('/settings');

    await page.getByLabel('Faltas consecutivas para gerar alerta').fill('5');
    await page.getByRole('button', { name: 'Salvar', exact: true }).click();

    await expect(page.getByText('Configurações salvas.', { exact: false })).toBeVisible({ timeout: 3_000 });
  });
});

test.describe('Autorização no banco (RLS) — chamadas diretas à API', () => {
  test('anônimo não lê nenhum dado', async ({ db }) => {
    const coord = await db.createUser('coordinator', 'Carla Coordenadora');
    await db.createGroup('Grupo Alfa', coord.id);

    for (const table of ['groups', 'youth', 'events', 'attendance', 'alerts', 'tasks', 'profiles', 'user_roles']) {
      const res = await api(`/rest/v1/${table}?select=*`);
      // sem privilégio (401/403) ou sem linhas visíveis: nunca dados
      expect(res.status === 200 ? res.json : []).toEqual([]);
    }
  });

  test('líder não consegue criar grupo nem alterar grupo de outro líder', async ({ db }) => {
    const lia = await db.createUser('leader', 'Lia Lider');
    const davi = await db.createUser('leader', 'Davi Lider');
    const gDavi = await db.createGroup('Grupo do Davi', davi.id);
    const token = await tokenOf(lia);

    const create = await api('/rest/v1/groups', { method: 'POST', token, body: { name: 'Invasor', leader_id: lia.id } });
    expect(create.status).toBeGreaterThanOrEqual(400);

    const rename = await api(`/rest/v1/groups?id=eq.${gDavi}`, { method: 'PATCH', token, body: { name: 'Hackeado' } });
    expect(rename.json).toEqual([]); // 0 linhas afetadas

    expect(await db.sql(`SELECT name FROM groups`)).toEqual([{ name: 'Grupo do Davi' }]);
  });

  test('líder não consegue se promover a coordenador (RPC nem update direto)', async ({ db }) => {
    const lia = await db.createUser('leader', 'Lia Lider');
    await db.createUser('coordinator', 'Carla Coordenadora');
    const token = await tokenOf(lia);

    const rpc = await api('/rest/v1/rpc/set_user_role', { method: 'POST', token, body: { p_user_id: lia.id, p_role: 'coordinator' } });
    expect(rpc.status).toBeGreaterThanOrEqual(400);
    const direct = await api(`/rest/v1/user_roles?user_id=eq.${lia.id}`, { method: 'PATCH', token, body: { role: 'coordinator' } });
    expect(direct.status >= 400 || direct.json?.length === 0).toBe(true);

    const [role] = await db.sql(`SELECT role FROM user_roles WHERE user_id = $1`, [lia.id]);
    expect(role.role).toBe('leader');
  });

  test('líder não registra presença em encontro de outro grupo nem em nome de outra pessoa', async ({ db }) => {
    const lia = await db.createUser('leader', 'Lia Lider');
    const davi = await db.createUser('leader', 'Davi Lider');
    await db.createGroup('Grupo da Lia', lia.id);
    const gDavi = await db.createGroup('Grupo do Davi', davi.id);
    const zeca = await db.createYouth('Zeca do Davi', gDavi);
    const ev = await db.createEvent('Culto do Davi', new Date(), [gDavi]);
    const token = await tokenOf(lia);

    const res = await api('/rest/v1/attendance', {
      method: 'POST', token,
      body: { event_id: ev, youth_id: zeca, group_id: gDavi, present: true, recorded_by: lia.id },
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await db.sql(`SELECT 1 FROM attendance`)).toHaveLength(0);
  });
});

test.describe('Ciclo de vida da sessão', () => {
  test('token de acesso expirado é renovado com o refresh token, sem pedir login', async ({ page, db }) => {
    const user = await db.createUser('coordinator', 'Carla Coordenadora');
    const session = await passwordSession(user);
    // simula uma aba aberta há muito tempo: access token vencido, refresh token válido
    await injectSession(page, { ...session, expires_at: Math.floor(Date.now() / 1000) - 60 });
    const refreshCalls: string[] = [];
    page.on('request', (r) => {
      if (r.url().includes('grant_type=refresh_token')) refreshCalls.push(r.url());
    });

    await page.goto('/grupos');

    await expect(page.getByRole('heading', { name: 'Grupos' })).toBeVisible();
    await expect(page).toHaveURL(/\/grupos$/);
    expect(refreshCalls.length).toBeGreaterThan(0);
  });

  test('refresh token inválido derruba a sessão e leva ao login', async ({ page, db }) => {
    const user = await db.createUser('coordinator', 'Carla Coordenadora');
    const session = await passwordSession(user);
    await injectSession(page, { ...session, refresh_token: 'token-invalido', expires_at: Math.floor(Date.now() / 1000) - 60 });

    await page.goto('/grupos');

    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByRole('button', { name: 'Entrar' })).toBeVisible();
  });
});
