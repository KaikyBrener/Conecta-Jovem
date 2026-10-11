// Anonimização pela ficha do jovem: RPC anonymize_youth REAL (migration 021) sobre o Supabase falso.
import { api, expect, modal, openYouthSheet, test, type TestDb } from './fixtures.ts';
import { seedPeople } from './phase7-helpers.ts';

const NAME = 'Maria Teste Silva';

async function seed(db: TestDb) {
  const p = await seedPeople(db);
  const youth = await db.createYouth(NAME, p.alfa);
  await db.sql(
    `UPDATE youth SET phone = '27999990000', email = 'maria.teste@exemplo.com', address = 'Rua de Teste, 1',
            notes = 'Observação de teste', birth_date = '2009-05-10', gender = 'female' WHERE id = $1`, [youth]);
  return { ...p, youth };
}

const youthRow = async (db: TestDb, id: string) =>
  (await db.sql<{ full_name: string; phone: string | null; email: string | null; address: string | null; notes: string | null;
    birth_date: string | null; is_active: boolean; group_id: string | null }>(
    `SELECT full_name, phone, email, address, notes, birth_date::text, is_active, group_id FROM youth WHERE id = $1`, [id]))[0];

test.describe('Anonimização do jovem', () => {
  test('coordenador anonimiza com o nome digitado; a ação some para o jovem já anonimizado', async ({ page, db, loginAs }) => {
    const s = await seed(db);
    await loginAs(s.carla);
    const sheet = await openYouthSheet(page, NAME);

    await sheet.getByRole('button', { name: 'Anonimizar dados' }).click();
    const dialog = modal(page);
    await expect(dialog.getByRole('heading', { name: 'Anonimizar dados' })).toBeVisible();
    await expect(dialog.getByText('IRREVERSÍVEL')).toBeVisible();

    const confirm = dialog.getByRole('button', { name: 'Anonimizar definitivamente' });
    const input = dialog.getByLabel(/Para confirmar, digite o nome do jovem/);
    await expect(confirm).toBeDisabled();
    await input.fill('Maria Teste');
    await expect(confirm).toBeDisabled();
    await input.fill('maria teste silva');
    await expect(confirm).toBeDisabled();
    await input.fill(NAME);
    await expect(confirm).toBeEnabled();
    await confirm.click();

    await expect(page.getByText('Dados do jovem anonimizados.')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Anonimizar dados' })).toHaveCount(0);

    const row = await youthRow(db, s.youth);
    expect(row).toMatchObject({
      full_name: 'Jovem anonimizado', phone: null, email: null, address: null, notes: null, birth_date: null,
      is_active: false, group_id: s.alfa,
    });

    // O jovem anonimizado fica inativo e a ficha dele não oferece mais a ação
    const again = await openYouthSheet(page, 'Jovem anonimizado', 'Inativos');
    await expect(again.getByRole('button', { name: 'Anonimizar dados' })).toHaveCount(0);
  });

  test('cancelar não altera nada', async ({ page, db, loginAs }) => {
    const s = await seed(db);
    await loginAs(s.carla);
    const sheet = await openYouthSheet(page, NAME);
    await sheet.getByRole('button', { name: 'Anonimizar dados' }).click();
    await modal(page).getByRole('button', { name: 'Cancelar' }).click();
    await expect(page.getByRole('heading', { name: 'Detalhes do Jovem' })).toBeVisible();
    expect((await youthRow(db, s.youth)).full_name).toBe(NAME);
  });

  test('e-mail em envio: o banco recusa e a mensagem dele aparece no modal; nada é apagado', async ({ page, db, loginAs }) => {
    const s = await seed(db);
    await db.sql(
      `INSERT INTO communications (youth_id, recipient_email, recipient_kind, subject, body, created_by)
       VALUES ($1, 'maria.teste@exemplo.com', 'youth', 'Assunto', 'Corpo', $2)`, [s.youth, s.carla.id]);
    await db.sql(`UPDATE communications SET status = 'sending', last_attempt_at = now() WHERE youth_id = $1`, [s.youth]);
    await loginAs(s.carla);
    const sheet = await openYouthSheet(page, NAME);
    await sheet.getByRole('button', { name: 'Anonimizar dados' }).click();
    const dialog = modal(page);
    await dialog.getByLabel(/Para confirmar, digite o nome do jovem/).fill(NAME);
    await dialog.getByRole('button', { name: 'Anonimizar definitivamente' }).click();

    await expect(dialog.getByRole('alert')).toHaveText(
      'Há um e-mail em envio para este jovem. Aguarde o envio terminar e tente novamente.');
    await expect(dialog.getByRole('button', { name: 'Anonimizar definitivamente' })).toBeEnabled();
    expect((await youthRow(db, s.youth)).full_name).toBe(NAME);
  });

  test('líder não vê a ação, e a RPC o recusa mesmo chamada direto', async ({ page, db, loginAs }) => {
    const s = await seed(db);
    await loginAs(s.lia);
    const sheet = await openYouthSheet(page, NAME);
    await expect(sheet.getByRole('button', { name: 'Editar' })).toBeVisible();
    await expect(sheet.getByRole('button', { name: 'Anonimizar dados' })).toHaveCount(0);

    const r = await api(page, 'POST', 'rpc/anonymize_youth', { p_youth_id: s.youth });
    expect(r.status).toBe(403);
    expect((await youthRow(db, s.youth)).full_name).toBe(NAME);
  });
});
