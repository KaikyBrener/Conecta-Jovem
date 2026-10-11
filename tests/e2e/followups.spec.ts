// Acompanhamento (Fase 7, blocos 2-5): registrar, editar, vincular a alerta/ação, transferir responsável,
// excluir, permissões líder x coordenador (RLS real), situação do jovem e ciclo das ações.
// Tudo roda contra o banco falso com as migrations reais (triggers, RLS e RPCs de verdade).
import type { Page } from '@playwright/test';
import {
  api, brDate, daysFromNow, expect, modal, openYouthSheet, spDay, test, type TestDb, type TestUser,
} from './fixtures.ts';
import { addFollowUp } from './phase7-helpers.ts';

const items =(page: Page) => page.getByTestId('acompanhamento-item');
const alertItems = (page: Page) => page.getByTestId('alerta-item');

/** Carla/Caio (coordenadores), Lia (líder do Grupo Alfa, onde está a Ana), Davi (líder do Grupo Beta, onde está o Zeca). */
async function seedPeople(db: TestDb) {
  const carla = await db.createUser('coordinator', 'Carla Coordenadora');
  const caio = await db.createUser('coordinator', 'Caio Coordenador');
  const lia = await db.createUser('leader', 'Lia Lider');
  const davi = await db.createUser('leader', 'Davi Lider');
  const alfa = await db.createGroup('Grupo Alfa', lia.id);
  const beta = await db.createGroup('Grupo Beta', davi.id);
  const ana = await db.createYouth('Ana Souza', alfa);
  const zeca = await db.createYouth('Zeca Alheio', beta);
  return { carla, caio, lia, davi, alfa, beta, ana, zeca };
}

/** 3 faltas consecutivas da Ana (e Bia presente) -> o banco abre o alerta de faltas. */
async function seedThreeAbsences(db: TestDb, s: Awaited<ReturnType<typeof seedPeople>>, by: TestUser) {
  const bia = await db.createYouth('Bia Lima', s.alfa);
  for (let i = 0; i < 3; i++) {
    const ev = await db.createEvent(`Culto ${i + 1}`, daysFromNow(-21 + i * 7), [s.alfa], 'completed');
    await db.recordAttendance(ev, s.ana, s.alfa, false, by.id);
    await db.recordAttendance(ev, bia, s.alfa, true, by.id);
  }
  const [alert] = await db.sql<{ id: string }>(`SELECT id FROM alerts WHERE youth_id = $1 AND type = 'consecutive_absences'`, [s.ana]);
  return { alertId: alert.id, bia };
}

test.describe('Acompanhamento — registrar e editar (coordenador)', () => {
  test('registra com todos os campos, valida motivo e datas e mostra o item com o responsável atual', async ({ page, db, loginAs }) => {
    const s = await seedPeople(db);
    await loginAs(s.carla);
    const sheet = await openYouthSheet(page, 'Ana Souza');
    const section = sheet.getByTestId('secao-acompanhamento');
    await expect(section).toContainText('Nenhum acompanhamento registrado para este jovem ainda.');
    await expect(sheet.getByTestId('metrica-ultimo-acompanhamento')).toHaveText('Nenhum');

    await section.getByRole('button', { name: 'Novo acompanhamento' }).click();
    const form = modal(page);
    await expect(form.getByRole('heading', { name: 'Novo acompanhamento' })).toBeVisible();
    // padrões do formulário: hoje, sem datas futuras, tipo "Conversa"
    await expect(form.getByLabel('Data do contato')).toHaveValue(spDay(0));
    await expect(form.getByLabel('Data do contato')).toHaveAttribute('max', spDay(0));
    await expect(form.getByLabel('Tipo')).toHaveValue('conversation');
    // coordenador escolhe o responsável entre coordenadores e o líder do grupo do jovem (nunca o líder de outro grupo)
    const options = await form.getByLabel('Responsável', { exact: true }).locator('option').allTextContents();
    expect([...options].sort()).toEqual(['Caio Coordenador', 'Carla Coordenadora (eu)', 'Lia Lider']);

    // motivo é obrigatório
    await form.getByRole('button', { name: 'Registrar acompanhamento' }).click();
    await expect(form.getByText('Informe o motivo do acompanhamento.')).toBeVisible();
    expect(await db.sql(`SELECT 1 FROM follow_ups`)).toHaveLength(0);

    // data do contato não pode ser futura: o navegador barra o envio (max = hoje) antes mesmo da validação do app
    await form.getByLabel('Motivo').fill('Faltou nos últimos encontros');
    await form.getByLabel('Data do contato').fill(spDay(3));
    expect(await form.getByLabel('Data do contato').evaluate((el: HTMLInputElement) => el.validity.rangeOverflow)).toBe(true);
    await form.getByRole('button', { name: 'Registrar acompanhamento' }).click();
    await expect(page.getByText('Acompanhamento registrado.')).toHaveCount(0);
    expect(await db.sql(`SELECT 1 FROM follow_ups`)).toHaveLength(0);

    // prazo da próxima ação não pode ser anterior ao contato (min = data do contato)
    await form.getByLabel('Data do contato').fill(spDay(0));
    await form.getByLabel('Prazo da próxima ação', { exact: true }).fill(spDay(-2));
    expect(await form.getByLabel('Prazo da próxima ação', { exact: true }).evaluate((el: HTMLInputElement) => el.validity.rangeUnderflow)).toBe(true);
    await form.getByRole('button', { name: 'Registrar acompanhamento' }).click();
    await expect(page.getByText('Acompanhamento registrado.')).toHaveCount(0);
    expect(await db.sql(`SELECT 1 FROM follow_ups`)).toHaveLength(0);

    // preenche tudo e entrega o acompanhamento à líder do grupo
    await form.getByLabel('Tipo').selectOption({ label: 'Ligação' });
    await form.getByLabel('Observação').fill('Disse que está sem transporte.');
    await form.getByLabel('Próxima ação', { exact: true }).fill('Ligar na sexta');
    await form.getByLabel('Prazo da próxima ação', { exact: true }).fill(spDay(3));
    await form.getByLabel('Responsável', { exact: true }).selectOption({ label: 'Lia Lider' });
    await form.getByRole('button', { name: 'Registrar acompanhamento' }).click();
    await expect(page.getByText('Acompanhamento registrado.')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Novo acompanhamento' })).toHaveCount(0);

    const item = items(page);
    await expect(item).toHaveCount(1);
    await expect(item).toContainText(brDate(spDay(0)));
    await expect(item).toContainText('Ligação');
    await expect(item).toContainText('Faltou nos últimos encontros');
    await expect(item).toContainText('Disse que está sem transporte.');
    await expect(item).toContainText('Próxima ação: Ligar na sexta');
    await expect(item).toContainText(`prazo ${brDate(spDay(3))}`);
    await expect(item.getByTestId('responsavel-atual')).toHaveText('Lia Lider');
    await expect(item).toContainText('Responsável atual');
    await expect(section.getByRole('heading', { name: /Acompanhamento/ })).toContainText('(1)');
    await expect(sheet.getByTestId('metrica-ultimo-acompanhamento')).toHaveText(brDate(spDay(0)));

    const [row] = await db.sql(
      `SELECT reason, type, notes, next_action, next_action_due::text AS due, occurred_at::text AS occ,
              responsible_id, created_by, group_id, alert_id, task_id, completes_task FROM follow_ups`);
    expect(row).toEqual({
      reason: 'Faltou nos últimos encontros', type: 'call', notes: 'Disse que está sem transporte.',
      next_action: 'Ligar na sexta', due: spDay(3), occ: spDay(0), responsible_id: s.lia.id, created_by: s.carla.id,
      group_id: s.alfa, alert_id: null, task_id: null, completes_task: false,
    });
  });

  test('edita motivo e observação sem mexer no responsável; motivo vazio é recusado', async ({ page, db, loginAs }) => {
    const s = await seedPeople(db);
    await db.createFollowUp(s.ana, 'Primeira conversa', { responsibleId: s.carla.id });
    await loginAs(s.carla);
    const sheet = await openYouthSheet(page, 'Ana Souza');

    await items(page).getByRole('button', { name: 'Editar' }).click();
    const form = modal(page);
    await expect(form.getByRole('heading', { name: 'Editar acompanhamento' })).toBeVisible();
    await expect(form.getByLabel('Motivo')).toHaveValue('Primeira conversa');
    await expect(form.getByLabel('Responsável', { exact: true })).toHaveCount(0); // só muda pela transferência
    await expect(form.getByText(/Transferir responsável/)).toBeVisible();

    await form.getByLabel('Motivo').fill('   ');
    await form.getByRole('button', { name: 'Salvar alterações' }).click();
    await expect(form.getByText('Informe o motivo do acompanhamento.')).toBeVisible();

    await form.getByLabel('Motivo').fill('Conversa de retorno');
    await form.getByLabel('Observação').fill('Voltou animada.');
    await form.getByRole('button', { name: 'Salvar alterações' }).click();
    await expect(page.getByText('Acompanhamento atualizado.')).toBeVisible();

    await expect(items(page)).toHaveCount(1);
    await expect(items(page)).toContainText('Conversa de retorno');
    await expect(items(page)).toContainText('Voltou animada.');
    await expect(items(page)).not.toContainText('Primeira conversa');
    await expect(sheet.getByTestId('responsavel-atual')).toHaveText('Você');
    const [row] = await db.sql(`SELECT reason, notes, responsible_id FROM follow_ups`);
    expect(row).toEqual({ reason: 'Conversa de retorno', notes: 'Voltou animada.', responsible_id: s.carla.id });
  });

  test('vincula a um alerta e a uma ação; concluir a ação pelo acompanhamento marca "Por acompanhamento" e não altera a presença', async ({ page, db, loginAs }) => {
    const s = await seedPeople(db);
    const { alertId } = await seedThreeAbsences(db, s, s.carla);
    const taskId = await db.createTask('Contatar Ana Souza (3 faltas)', {
      createdBy: s.carla.id, assignedTo: s.carla.id, youthId: s.ana, groupId: s.alfa, alertId, dueDate: spDay(2),
    });
    const attendanceBefore = await db.sql(`SELECT event_id, youth_id, present FROM attendance ORDER BY event_id, youth_id`);
    await loginAs(s.carla);
    const sheet = await openYouthSheet(page, 'Ana Souza');

    // 1) só vincula alerta + ação, sem concluir: ação segue pendente e o alerta aberto
    await sheet.getByRole('button', { name: 'Novo acompanhamento' }).click();
    let form = modal(page);
    await form.getByLabel('Motivo').fill('Primeiro contato por mensagem');
    await form.getByLabel('Alerta').selectOption({ label: '3 faltas seguidas' });
    await form.getByLabel('Ação em aberto').selectOption({ label: `Contatar Ana Souza (3 faltas) (prazo ${brDate(spDay(2))})` });
    await expect(form.getByLabel('Concluir a ação ao registrar')).not.toBeChecked();
    await form.getByRole('button', { name: 'Registrar acompanhamento' }).click();
    await expect(page.getByText('Acompanhamento registrado.').last()).toBeVisible();
    await expect(items(page)).toHaveCount(1);
    await expect(items(page)).toContainText('Alerta: 3 faltas seguidas');
    await expect(items(page)).toContainText('Ação: Contatar Ana Souza (3 faltas) (Pendente)');
    await expect(items(page)).not.toContainText('Concluiu a ação');
    expect(await db.sql(`SELECT status FROM tasks`)).toEqual([{ status: 'pending' }]);
    expect(await db.sql(`SELECT status FROM alerts WHERE id = $1`, [alertId])).toEqual([{ status: 'open' }]);

    // 2) segundo acompanhamento conclui a ação
    await sheet.getByRole('button', { name: 'Novo acompanhamento' }).click();
    form = modal(page);
    await form.getByLabel('Motivo').fill('Ligação feita, vai voltar');
    await form.getByLabel('Alerta').selectOption({ label: '3 faltas seguidas' });
    await form.getByLabel('Ação em aberto').selectOption({ label: `Contatar Ana Souza (3 faltas) (prazo ${brDate(spDay(2))})` });
    await expect(form.getByText('A presença não é alterada.')).toBeVisible();
    await form.getByLabel('Concluir a ação ao registrar').check();
    await form.getByRole('button', { name: 'Registrar acompanhamento' }).click();
    await expect(page.getByText('Acompanhamento registrado.').last()).toBeVisible();

    const done = items(page).filter({ hasText: 'Ligação feita, vai voltar' });
    await expect(done).toContainText('Concluiu a ação');
    await expect(done).toContainText('Ação: Contatar Ana Souza (3 faltas) (Concluída)');
    const [fu] = await db.sql<{ id: string }>(`SELECT id FROM follow_ups WHERE reason = 'Ligação feita, vai voltar'`);
    expect(await db.sql(`SELECT status, completed_by_follow_up_id FROM tasks WHERE id = $1`, [taskId]))
      .toEqual([{ status: 'done', completed_by_follow_up_id: fu.id }]);
    // concluir a ação (vinculada ao alerta) resolve o alerta; a presença fica intacta
    expect(await db.sql(`SELECT status FROM alerts WHERE id = $1`, [alertId])).toEqual([{ status: 'resolved' }]);
    expect(await db.sql(`SELECT event_id, youth_id, present FROM attendance ORDER BY event_id, youth_id`)).toEqual(attendanceBefore);
    await expect(sheet.getByTestId('metrica-faltas')).toHaveText('3'); // as faltas continuam contadas
    await expect(sheet.getByTestId('metrica-acoes')).toHaveText('Nenhuma aberta');

    // Tarefas: concluída "Por acompanhamento"
    await page.goto('/tarefas');
    await page.getByRole('button', { name: 'Encerradas' }).click();
    const task = page.locator('main li', { hasText: 'Contatar Ana Souza (3 faltas)' });
    await expect(task).toContainText('Concluída');
    await expect(task.getByTestId('badge-concluida-acompanhamento')).toHaveText('Por acompanhamento');

    // Alertas: histórico mostra a ação concluída por acompanhamento e os dois acompanhamentos
    await page.goto('/alertas');
    await page.getByRole('button', { name: 'Resolvidos' }).click();
    const chain = alertItems(page).getByTestId('alerta-cadeia');
    await expect(chain).toContainText('Concluída por acompanhamento');
    await expect(chain).toContainText('Primeiro contato por mensagem');
    await expect(chain).toContainText('Ligação feita, vai voltar');
  });

  // Migration 016 (item 3): o histórico de transferências passou a ser imutável também contra a exclusão do
  // acompanhamento. O teste antigo ("o histórico de transferências some junto") descrevia o comportamento
  // anterior, que era justamente a falha corrigida; por isso foi dividido em dois cenários.
  test('o coordenador exclui (com confirmação) um acompanhamento SEM transferências', async ({ page, db, loginAs }) => {
    const s = await seedPeople(db);
    await db.createFollowUp(s.ana, 'Conversa antiga', { responsibleId: s.carla.id });
    await loginAs(s.carla);
    await openYouthSheet(page, 'Ana Souza');

    page.once('dialog', (d) => { expect(d.message()).toContain('Conversa antiga'); void d.dismiss(); });
    await items(page).getByRole('button', { name: 'Excluir' }).click();
    await expect(items(page)).toHaveCount(1);
    expect(await db.sql(`SELECT 1 FROM follow_ups`)).toHaveLength(1);

    page.once('dialog', (d) => void d.accept());
    await items(page).getByRole('button', { name: 'Excluir' }).click();
    await expect(page.getByText('Acompanhamento excluído.')).toBeVisible();
    await expect(page.getByText('Nenhum acompanhamento registrado para este jovem ainda.')).toBeVisible();
    expect(await db.sql(`SELECT 1 FROM follow_ups`)).toHaveLength(0);
  });

  test('acompanhamento COM transferências não pode ser excluído: sem botão "Excluir" na UI e o banco recusa a API direta', async ({ page, db, loginAs }) => {
    const s = await seedPeople(db);
    const fu = await db.createFollowUp(s.ana, 'Conversa antiga', { responsibleId: s.carla.id });
    await db.sql(
      `INSERT INTO follow_up_transfers (follow_up_id, from_responsible_id, to_responsible_id, reason, transferred_by)
       VALUES ($1, $2, $3, 'teste', $2)`, [fu, s.carla.id, s.lia.id]);
    await loginAs(s.carla);
    await openYouthSheet(page, 'Ana Souza');

    // a UI nem oferece "Excluir" quando há histórico de transferências (o banco o preserva)
    await expect(items(page)).toHaveCount(1);
    await expect(items(page).getByRole('button', { name: 'Excluir' })).toHaveCount(0);
    // o acompanhamento, a transferência e a tela continuam intactos
    await expect(items(page)).toHaveCount(1);
    await expect(items(page)).toContainText('Conversa antiga');
    await expect(items(page).getByRole('button', { name: /Transferências \(1\)/ })).toBeVisible();
    expect(await db.sql(`SELECT 1 FROM follow_ups`)).toHaveLength(1);
    expect(await db.sql(`SELECT 1 FROM follow_up_transfers`)).toHaveLength(1);

    // a mesma regra vale chamando a API direto (requisição adulterada)
    const direct = await api(page, 'DELETE', `follow_ups?id=eq.${fu}`);
    expect(direct.status).toBeGreaterThanOrEqual(400);
    expect(await db.sql(`SELECT 1 FROM follow_ups`)).toHaveLength(1);
  });
});

test.describe('Acompanhamento — transferência de responsável', () => {
  test('coordenador transfere (motivo obrigatório) duas vezes; o histórico lista "de → para · motivo · data" e não aceita adulteração', async ({ page, db, loginAs }) => {
    const s = await seedPeople(db);
    const fu = await db.createFollowUp(s.ana, 'Conversa inicial', { responsibleId: s.carla.id });
    await loginAs(s.carla);
    await openYouthSheet(page, 'Ana Souza');
    const item = items(page);
    await expect(item.getByTestId('responsavel-atual')).toHaveText('Você');
    await expect(item.getByRole('button', { name: /^Transferências/ })).toHaveCount(0); // ainda sem histórico

    await item.getByRole('button', { name: 'Transferir responsável' }).click();
    let form = modal(page);
    await expect(form.getByRole('heading', { name: 'Transferir responsável' })).toBeVisible();
    await expect(form).toContainText('Responsável atual: Você');
    // só quem pode assumir: outros coordenadores e a líder do grupo (nunca o líder de outro grupo, nem o atual)
    const opts = (await form.getByLabel('Novo responsável').locator('option').allTextContents()).filter((t) => !t.startsWith('Selecione'));
    expect([...opts].sort()).toEqual(['Caio Coordenador · Coordenador', 'Lia Lider · Líder do grupo']);
    // validações: destino e motivo obrigatórios
    await form.getByRole('button', { name: 'Transferir', exact: true }).click();
    await expect(form.getByText('Selecione o novo responsável.')).toBeVisible();
    await form.getByLabel('Novo responsável').selectOption({ label: 'Lia Lider · Líder do grupo' });
    await form.getByRole('button', { name: 'Transferir', exact: true }).click();
    await expect(form.getByText('Informe o motivo da transferência.')).toBeVisible();
    expect(await db.sql(`SELECT 1 FROM follow_up_transfers`)).toHaveLength(0);

    await form.getByLabel('Motivo da transferência').fill('A Lia é a líder do grupo');
    await form.getByRole('button', { name: 'Transferir', exact: true }).click();
    await expect(page.getByText('Responsável transferido.')).toBeVisible();
    await expect(item.getByTestId('responsavel-atual')).toHaveText('Lia Lider');

    // segunda transferência: a Lia (atual) deixa de ser opção; Carla volta a ser possível
    await item.getByRole('button', { name: 'Transferir responsável' }).click();
    form = modal(page);
    await expect(form).toContainText('Responsável atual: Lia Lider');
    const opts2 = (await form.getByLabel('Novo responsável').locator('option').allTextContents()).filter((t) => !t.startsWith('Selecione'));
    expect([...opts2].sort()).toEqual(['Caio Coordenador · Coordenador', 'Carla Coordenadora · Coordenador']);
    await form.getByLabel('Novo responsável').selectOption({ label: 'Caio Coordenador · Coordenador' });
    await form.getByLabel('Motivo da transferência').fill('Caio assume o caso');
    await form.getByRole('button', { name: 'Transferir', exact: true }).click();
    await expect(item.getByTestId('responsavel-atual')).toHaveText('Caio Coordenador');

    // histórico: "de → para · motivo · data", do mais antigo ao mais recente
    await item.getByRole('button', { name: /Transferências \(2\)/ }).click();
    const lines = item.getByTestId('historico-transferencias').locator('li');
    await expect(lines).toHaveCount(2);
    const hoje = brDate(spDay(0));
    await expect(lines.nth(0)).toHaveText(`Carla Coordenadora → Lia Lider · A Lia é a líder do grupo · ${hoje}`);
    await expect(lines.nth(1)).toHaveText(`Lia Lider → Caio Coordenador · Caio assume o caso · ${hoje}`);

    expect(await db.sql(`SELECT responsible_id FROM follow_ups WHERE id = $1`, [fu])).toEqual([{ responsible_id: s.caio.id }]);
    expect(await db.sql(`SELECT reason FROM follow_up_transfers ORDER BY transferred_at`))
      .toEqual([{ reason: 'A Lia é a líder do grupo' }, { reason: 'Caio assume o caso' }]);

    // o histórico é imutável para o cliente (sem privilégio de escrita), mesmo sendo coordenador
    const patch = await api(page, 'PATCH', 'follow_up_transfers?reason=like.*', { reason: 'adulterado' });
    expect(patch.status).toBeGreaterThanOrEqual(400);
    const del = await api(page, 'DELETE', 'follow_up_transfers?reason=like.*');
    expect(del.status).toBeGreaterThanOrEqual(400);
    // transferir para quem já é o responsável é recusado pelo banco
    const same = await api(page, 'POST', 'rpc/transfer_follow_up', { p_follow_up_id: fu, p_new_responsible_id: s.caio.id, p_reason: 'x' });
    expect(same.status).toBeGreaterThanOrEqual(400);
    expect(await db.sql(`SELECT reason FROM follow_up_transfers`)).toHaveLength(2);
    expect(await db.sql(`SELECT 1 FROM follow_up_transfers WHERE reason = 'adulterado'`)).toHaveLength(0);
  });

  test('líder responsável transfere para um coordenador e perde o controle (sem Editar/Transferir; API também recusa)', async ({ page, db, loginAs }) => {
    const s = await seedPeople(db);
    const fu = await db.createFollowUp(s.ana, 'Caso da Lia', { responsibleId: s.lia.id });
    await loginAs(s.lia);
    await openYouthSheet(page, 'Ana Souza');
    const item = items(page);
    await expect(item.getByTestId('responsavel-atual')).toHaveText('Você');
    await expect(item.getByRole('button', { name: 'Editar' })).toBeVisible();
    await expect(item.getByRole('button', { name: 'Excluir' })).toHaveCount(0); // só coordenador exclui

    await item.getByRole('button', { name: 'Transferir responsável' }).click();
    const form = modal(page);
    const opts = (await form.getByLabel('Novo responsável').locator('option').allTextContents()).filter((t) => !t.startsWith('Selecione'));
    expect([...opts].sort()).toEqual(['Caio Coordenador · Coordenador', 'Carla Coordenadora · Coordenador']);
    await form.getByLabel('Novo responsável').selectOption({ label: 'Carla Coordenadora · Coordenador' });
    await form.getByLabel('Motivo da transferência').fill('Caso complexo, vai para a coordenação');
    await form.getByRole('button', { name: 'Transferir', exact: true }).click();
    await expect(page.getByText('Responsável transferido.')).toBeVisible();

    // continua visível (jovem é do grupo dela), mas não é mais "ativo": sem botões de gestão
    await expect(item.getByTestId('responsavel-atual')).toHaveText('Carla Coordenadora');
    await expect(item.getByRole('button', { name: 'Editar' })).toHaveCount(0);
    await expect(item.getByRole('button', { name: 'Transferir responsável' })).toHaveCount(0);
    await item.getByRole('button', { name: /Transferências \(1\)/ }).click();
    await expect(item.getByTestId('historico-transferencias').locator('li')).toHaveText(
      `Lia Lider → Carla Coordenadora · Caso complexo, vai para a coordenação · ${brDate(spDay(0))}`);

    // adulteração direta pela API com a sessão da Lia
    const retake = await api(page, 'POST', 'rpc/transfer_follow_up', { p_follow_up_id: fu, p_new_responsible_id: s.lia.id, p_reason: 'quero de volta' });
    expect(retake.status).toBeGreaterThanOrEqual(400);
    const edit = await api(page, 'PATCH', `follow_ups?id=eq.${fu}`, { reason: 'adulterado' });
    expect(edit.status >= 400 || (Array.isArray(edit.body) && edit.body.length === 0)).toBe(true); // RLS: 0 linhas afetadas
    const steal = await api(page, 'PATCH', `follow_ups?id=eq.${fu}`, { responsible_id: s.lia.id });
    expect(steal.status >= 400 || (Array.isArray(steal.body) && steal.body.length === 0)).toBe(true);
    expect(await db.sql(`SELECT reason, responsible_id FROM follow_ups WHERE id = $1`, [fu]))
      .toEqual([{ reason: 'Caso da Lia', responsible_id: s.carla.id }]);
    expect(await db.sql(`SELECT 1 FROM follow_up_transfers`)).toHaveLength(1);
  });
});

test.describe('Acompanhamento — líder só nos seus jovens', () => {
  test('líder registra sob a própria responsabilidade; não enxerga nem cria acompanhamento de jovem de outro grupo', async ({ page, db, loginAs }) => {
    const s = await seedPeople(db);
    const fuZeca = await db.createFollowUp(s.zeca, 'Caso do Davi', { responsibleId: s.davi.id });
    await loginAs(s.lia);

    // lista: só a Ana
    await page.goto('/jovens');
    await expect(page.getByRole('button', { name: /Ana Souza/ }).first()).toBeVisible();
    await expect(page.getByText('Zeca Alheio')).toHaveCount(0);

    const sheet = await openYouthSheet(page, 'Ana Souza');
    await sheet.getByRole('button', { name: 'Novo acompanhamento' }).click();
    const form = modal(page);
    await expect(form.getByLabel('Responsável', { exact: true })).toHaveCount(0); // sem seletor
    await expect(form.getByText('Líderes registram acompanhamentos sob a própria responsabilidade.')).toBeVisible();
    await form.getByLabel('Motivo').fill('Visita em casa');
    await form.getByLabel('Tipo').selectOption({ label: 'Encontro presencial' });
    await form.getByRole('button', { name: 'Registrar acompanhamento' }).click();
    await expect(page.getByText('Acompanhamento registrado.')).toBeVisible();
    await expect(items(page)).toHaveCount(1);
    await expect(items(page).getByTestId('responsavel-atual')).toHaveText('Você');
    await expect(items(page).getByRole('button', { name: 'Excluir' })).toHaveCount(0);
    const [mine] = await db.sql(`SELECT responsible_id, created_by, type FROM follow_ups WHERE youth_id = $1`, [s.ana]);
    expect(mine).toEqual({ responsible_id: s.lia.id, created_by: s.lia.id, type: 'in_person' });

    // adulterações pela API com a sessão da Lia
    const read = await api(page, 'GET', `follow_ups?youth_id=eq.${s.zeca}&select=id`);
    expect(read).toEqual({ status: 200, body: [] }); // RLS esconde
    const forged = await api(page, 'POST', 'follow_ups', { youth_id: s.zeca, reason: 'invasão', responsible_id: s.lia.id, created_by: s.lia.id });
    expect(forged.status).toBeGreaterThanOrEqual(400);
    const forgedOwner = await api(page, 'POST', 'follow_ups', { youth_id: s.ana, reason: 'em nome de outro', responsible_id: s.carla.id, created_by: s.lia.id });
    expect(forgedOwner.status).toBeGreaterThanOrEqual(400);
    const del = await api(page, 'DELETE', `follow_ups?youth_id=eq.${s.ana}`);
    expect(del.body).toEqual([]); // líder não exclui
    expect((await api(page, 'POST', 'rpc/youth_situations', { p_ids: [s.zeca] })).body).toEqual([]);
    expect((await api(page, 'POST', 'rpc/assignable_responsibles', { p_youth_id: s.zeca })).body).toEqual([]);
    expect((await api(page, 'POST', 'rpc/follow_up_people', { p_follow_up_id: fuZeca })).body).toEqual([]);
    const steal = await api(page, 'POST', 'rpc/transfer_follow_up', { p_follow_up_id: fuZeca, p_new_responsible_id: s.lia.id, p_reason: 'x' });
    expect(steal.status).toBeGreaterThanOrEqual(400);

    expect(await db.sql(`SELECT reason FROM follow_ups ORDER BY reason`)).toEqual([{ reason: 'Caso do Davi' }, { reason: 'Visita em casa' }]);
    expect(await db.sql(`SELECT 1 FROM follow_up_transfers`)).toHaveLength(0);
  });
});

test.describe('Situação do jovem', () => {
  async function seedSituations(db: TestDb) {
    const carla = await db.createUser('coordinator', 'Carla Coordenadora');
    const alfa = await db.createGroup('Grupo Alfa', carla.id);
    await db.sql(`UPDATE app_settings SET low_attendance_threshold = 0`); // isola o critério das faltas/ações
    const ana = await db.createYouth('Ana Souza', alfa); // 3 faltas + ação atrasada -> Atenção
    const bia = await db.createYouth('Bia Lima', alfa); // sempre presente -> Normal
    const caio = await db.createYouth('Caio Dias', alfa); // 6 faltas -> Crítico
    const dani = await db.createYouth('Dani Rocha', alfa); // inativa
    for (let i = 0; i < 6; i++) {
      const ev = await db.createEvent(`Culto ${i + 1}`, daysFromNow(-42 + i * 7), [alfa], 'completed');
      await db.recordAttendance(ev, ana, alfa, i < 3, carla.id);
      await db.recordAttendance(ev, bia, alfa, true, carla.id);
      await db.recordAttendance(ev, caio, alfa, false, carla.id);
      await db.recordAttendance(ev, dani, alfa, true, carla.id);
    }
    await db.createTask('Ligar para Ana', { createdBy: carla.id, assignedTo: carla.id, youthId: ana, groupId: alfa, dueDate: spDay(-2) });
    await db.sql(`UPDATE youth SET is_active = false WHERE id = $1`, [dani]);
    return { carla, alfa, ana, bia, caio, dani };
  }
  const selo = (page: Page, name: string) => page.locator('tbody tr', { hasText: name }).getByTestId('situacao-selo');

  test('selo na lista e painel na ficha: normal, atenção, crítico e inativo, com motivos e métricas', async ({ page, db, loginAs }) => {
    const s = await seedSituations(db);
    await loginAs(s.carla);
    await page.goto('/jovens');
    await page.getByRole('button', { name: 'Todos', exact: true }).click();

    await expect(selo(page, 'Ana Souza')).toHaveAttribute('data-situacao', 'attention');
    await expect(selo(page, 'Ana Souza')).toHaveText('Atenção');
    await expect(selo(page, 'Bia Lima')).toHaveAttribute('data-situacao', 'normal');
    await expect(selo(page, 'Bia Lima')).toHaveText('Normal');
    await expect(selo(page, 'Caio Dias')).toHaveAttribute('data-situacao', 'critical');
    await expect(selo(page, 'Caio Dias')).toHaveText('Crítico');
    await expect(selo(page, 'Dani Rocha')).toHaveAttribute('data-situacao', 'inactive');
    await expect(selo(page, 'Dani Rocha')).toHaveText('Inativo');

    // Atenção: motivos (faltas + ação atrasada) e métricas
    let sheet = await openYouthSheet(page, 'Ana Souza', 'Todos');
    const painel = sheet.getByTestId('painel-situacao');
    await expect(painel.getByTestId('situacao-selo')).toHaveText('Atenção');
    await expect(painel.getByTestId('situacao-motivos').locator('li')).toHaveText(['3 faltas seguidas', '1 ação atrasada']);
    await expect(painel.getByTestId('metrica-faltas')).toHaveText('3');
    await expect(painel.getByTestId('metrica-frequencia')).toHaveText('50%');
    await expect(painel.getByTestId('metrica-acoes')).toHaveText('1 aberta · 1 atrasada');
    await expect(painel.getByTestId('metrica-ultimo-acompanhamento')).toHaveText('Nenhum');
    await expect(painel.getByTestId('situacao-criterio')).toContainText('Crítico = 6 ou mais faltas seguidas');
    await expect(painel.getByTestId('situacao-criterio')).toContainText('Atenção = 3 ou mais faltas seguidas');
    await sheet.getByRole('button', { name: 'Fechar', exact: true }).click();

    // Crítico
    sheet = await openYouthSheet(page, 'Caio Dias', 'Todos');
    await expect(sheet.getByTestId('painel-situacao').getByTestId('situacao-selo')).toHaveText('Crítico');
    await expect(sheet.getByTestId('situacao-motivos').locator('li')).toHaveText(['6 faltas seguidas']);
    await expect(sheet.getByTestId('metrica-frequencia')).toHaveText('0%');
    await expect(sheet.getByTestId('metrica-acoes')).toHaveText('Nenhuma aberta');
    await sheet.getByRole('button', { name: 'Fechar', exact: true }).click();

    // Normal
    sheet = await openYouthSheet(page, 'Bia Lima', 'Todos');
    await expect(sheet.getByTestId('painel-situacao').getByTestId('situacao-selo')).toHaveText('Normal');
    await expect(sheet.getByText('Nenhum sinal de atenção no momento.')).toBeVisible();
    await expect(sheet.getByTestId('situacao-motivos')).toHaveCount(0);
    await expect(sheet.getByTestId('metrica-frequencia')).toHaveText('100%');
    await sheet.getByRole('button', { name: 'Fechar', exact: true }).click();

    // Inativo: não é avaliado (não aparece como "Normal")
    sheet = await openYouthSheet(page, 'Dani Rocha', 'Todos');
    await expect(sheet.getByTestId('painel-situacao').getByTestId('situacao-selo')).toHaveText('Inativo');
    await expect(sheet.getByTestId('painel-situacao')).toContainText('Jovem inativo: a situação não é avaliada.');
    await expect(sheet.getByTestId('situacao-motivos')).toHaveCount(0);
  });

  test('desativar resolve os alertas e o selo vira "Inativo"; reativar volta a avaliar', async ({ page, db, loginAs }) => {
    const s = await seedSituations(db);
    expect(await db.sql(`SELECT 1 FROM alerts WHERE youth_id = $1 AND status = 'open'`, [s.ana])).toHaveLength(2);
    await loginAs(s.carla);
    const sheet = await openYouthSheet(page, 'Ana Souza');
    await sheet.getByRole('button', { name: 'Desativar' }).click();
    await expect(page.getByText('Jovem desativado.')).toBeVisible();

    await page.getByRole('button', { name: 'Todos', exact: true }).click();
    await expect(selo(page, 'Ana Souza')).toHaveAttribute('data-situacao', 'inactive');
    expect(await db.sql(`SELECT status FROM alerts WHERE youth_id = $1 ORDER BY type`, [s.ana]))
      .toEqual([{ status: 'resolved' }, { status: 'resolved' }]);
    expect(await db.sql(`SELECT count(*)::int AS n FROM attendance WHERE youth_id = $1`, [s.ana])).toEqual([{ n: 6 }]); // histórico intacto

    const again = await openYouthSheet(page, 'Ana Souza', 'Todos');
    await again.getByRole('button', { name: 'Reativar' }).click();
    await expect(page.getByText('Jovem reativado.')).toBeVisible();
    await expect(selo(page, 'Ana Souza')).toHaveAttribute('data-situacao', 'attention');
  });
});

test.describe('Ações (tarefas) ligadas a alertas', () => {
  test('cria a ação a partir do alerta, atribui e define prazo; atraso (selo e filtro) e conclusão sem alterar a presença', async ({ page, db, loginAs }) => {
    const s = await seedPeople(db);
    const { alertId } = await seedThreeAbsences(db, s, s.carla);
    const attendanceBefore = await db.sql(`SELECT event_id, youth_id, present FROM attendance ORDER BY event_id, youth_id`);
    await loginAs(s.carla);

    // alerta -> "Criar tarefa": formulário pré-preenchido; atribui à líder e define o prazo
    await page.goto('/alertas');
    await alertItems(page).getByRole('button', { name: 'Criar tarefa' }).click();
    const form = modal(page);
    await expect(form.getByRole('heading', { name: 'Nova tarefa' })).toBeVisible();
    await expect(form.getByLabel('Título')).toHaveValue('Contatar Ana Souza (3 faltas)');
    await expect(form.getByText('Vinculada a um alerta.', { exact: false })).toBeVisible();
    await form.getByLabel('Responsável').selectOption({ label: 'Lia Lider' });
    await form.getByLabel('Prazo').fill(spDay(5));
    await form.getByRole('button', { name: 'Criar tarefa' }).click();
    await expect(page.getByText('Tarefa criada.')).toBeVisible();

    const task = page.locator('main li', { hasText: 'Contatar Ana Souza (3 faltas)' });
    await expect(task).toContainText('Lia Lider');
    await expect(task).toContainText(brDate(spDay(5)));
    await expect(task).toContainText('Alerta aberto');
    await expect(task).toHaveAttribute('data-atrasada', 'false');
    await expect(task.getByTestId('badge-atrasada')).toHaveCount(0);
    await expect(page.getByText('1 aberta')).toBeVisible();
    expect(await db.sql(`SELECT alert_id, assigned_to, youth_id, due_date::text AS due FROM tasks`))
      .toEqual([{ alert_id: alertId, assigned_to: s.lia.id, youth_id: s.ana, due: spDay(5) }]);

    // o alerta mostra a ação na cadeia (com prazo) e passa a oferecer "Outra tarefa"
    await page.locator('aside nav').getByRole('link', { name: /Alertas/ }).click();
    const chain = alertItems(page).getByTestId('alerta-cadeia');
    await expect(chain).toContainText('Contatar Ana Souza (3 faltas) — Pendente');
    await expect(chain).toContainText(`prazo ${brDate(spDay(5))}`);
    await expect(alertItems(page).getByRole('button', { name: 'Outra tarefa' })).toBeVisible();

    // vence o prazo: selo "Atrasada", contador, filtro "Atrasadas" e alerta "ação atrasada" (editar o prazo)
    await page.locator('aside nav').getByRole('link', { name: 'Tarefas' }).click();
    await task.getByRole('button', { name: 'Editar' }).click();
    await modal(page).getByLabel('Prazo').fill(spDay(-1));
    await modal(page).getByRole('button', { name: 'Salvar alterações' }).click();
    await expect(page.getByText('Tarefa atualizada.')).toBeVisible();
    await expect(task.getByTestId('badge-atrasada')).toHaveText('Atrasada');
    await expect(task).toHaveAttribute('data-atrasada', 'true');
    await expect(page.getByText('1 atrasada')).toBeVisible();
    await page.getByRole('button', { name: 'Atrasadas (1)' }).click();
    await expect(page.getByTestId('tarefa-item')).toHaveCount(1);
    await expect(page.getByTestId('tarefa-item').getByTestId('badge-atrasada')).toBeVisible();

    await page.locator('aside nav').getByRole('link', { name: /Alertas/ }).click();
    await expect(alertItems(page)).toHaveCount(2);
    await expect(page.locator('[data-testid="alerta-item"][data-tipo="overdue_action"]').getByTestId('alerta-descricao')).toHaveText('1 ação atrasada');
    await expect(page.locator('[data-testid="alerta-item"][data-tipo="consecutive_absences"]').getByTestId('alerta-cadeia')).toContainText('Atrasada');

    // concluir: some o atraso, o alerta de faltas é resolvido pelo banco e a presença NÃO muda
    await page.locator('aside nav').getByRole('link', { name: 'Tarefas' }).click();
    await page.getByRole('button', { name: /^Abertas/ }).click();
    await task.getByRole('button', { name: 'Concluir' }).click();
    await expect(page.getByText('Tarefa concluída.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Atrasadas (0)' })).toBeVisible();
    await page.getByRole('button', { name: 'Encerradas' }).click();
    await expect(task).toContainText('Concluída');
    await expect(task.getByTestId('badge-atrasada')).toHaveCount(0); // concluída não é atrasada
    await expect(task.getByTestId('badge-concluida-acompanhamento')).toHaveCount(0); // concluída direto, não por acompanhamento
    expect(await db.sql(`SELECT type, status FROM alerts ORDER BY type`)).toEqual([
      { type: 'consecutive_absences', status: 'resolved' }, { type: 'overdue_action', status: 'resolved' },
    ]);
    expect(await db.sql(`SELECT event_id, youth_id, present FROM attendance ORDER BY event_id, youth_id`)).toEqual(attendanceBefore);
  });

  test('líder vê o selo e o filtro "Atrasadas" só das ações que o RLS permite', async ({ page, db, loginAs }) => {
    const s = await seedPeople(db);
    await db.createTask('Ação da Lia', { createdBy: s.lia.id, assignedTo: s.lia.id, youthId: s.ana, groupId: s.alfa, dueDate: spDay(-4) });
    await db.createTask('Ação do Davi', { createdBy: s.davi.id, assignedTo: s.davi.id, youthId: s.zeca, groupId: s.beta, dueDate: spDay(-4) });
    await loginAs(s.lia);
    await page.goto('/tarefas');

    await expect(page.getByText('1 atrasada')).toBeVisible();
    await expect(page.getByTestId('tarefa-item')).toHaveCount(1);
    await expect(page.getByTestId('tarefa-item')).toContainText('Ação da Lia');
    await expect(page.getByTestId('badge-atrasada')).toBeVisible();
    await expect(page.getByText('Ação do Davi')).toHaveCount(0);
    await page.getByRole('button', { name: 'Atrasadas (1)' }).click();
    await expect(page.getByTestId('tarefa-item')).toHaveCount(1);

    // o alerta "ação atrasada" também respeita o escopo
    await page.goto('/alertas');
    await expect(alertItems(page)).toHaveCount(1);
    await expect(alertItems(page)).toContainText('Ana Souza');
    await expect(page.getByText('Zeca Alheio')).toHaveCount(0);
  });
});

test.describe('Acompanhamento — próxima ação "vencida" só vale para o acompanhamento mais recente', () => {
  const tab = (page: Page) => page.getByTestId('rel-aba-followups');

  test('um prazo vencido de contato antigo deixa de ser pendência quando há contato mais novo (ficha e relatório concordam)', async ({ page, db, loginAs }) => {
    const s = await seedPeople(db);
    const bia = await db.createYouth('Bia Lima', s.alfa);
    // Ana: contato antigo com prazo vencido, MAS já existe um contato mais novo com prazo futuro
    await addFollowUp(db, s.ana, 'Primeira conversa', { responsibleId: s.carla.id, occurredDaysAgo: 10, nextAction: 'Ligar para os pais', dueInDays: -3 });
    await addFollowUp(db, s.ana, 'Segunda conversa', { responsibleId: s.carla.id, occurredDaysAgo: 2, nextAction: 'Visitar a família', dueInDays: 4 });
    // Bia: o único (logo, o mais recente) acompanhamento está vencido
    await addFollowUp(db, bia, 'Visita combinada', { responsibleId: s.carla.id, occurredDaysAgo: 6, nextAction: 'Levar o material', dueInDays: -2 });
    await loginAs(s.carla);

    // ficha da Ana: nenhum dos dois é "vencido" (o antigo foi substituído pelo mais novo)
    await openYouthSheet(page, 'Ana Souza');
    await expect(items(page)).toHaveCount(2);
    const antigo = items(page).filter({ hasText: 'Primeira conversa' });
    const novo = items(page).filter({ hasText: 'Segunda conversa' });
    await expect(antigo).toContainText(`prazo ${brDate(spDay(-3))}`); // o prazo continua visível, só não é cobrado
    await expect(antigo).not.toContainText('(vencido)');
    await expect(novo).toContainText(`prazo ${brDate(spDay(4))}`);
    await expect(novo).not.toContainText('(vencido)');

    // ficha da Bia: o mais recente vencido é destacado
    await page.keyboard.press('Escape');
    await openYouthSheet(page, 'Bia Lima');
    await expect(items(page)).toHaveCount(1);
    await expect(items(page)).toContainText(`prazo ${brDate(spDay(-2))} (vencido)`);

    // relatório: 2 pendentes (Ana nova + Bia), só 1 vencida (Bia); a antiga da Ana não conta
    await page.goto('/relatorios');
    await tab(page).click();
    const root = page.getByTestId('relatorio-acompanhamento');
    await expect(root).toContainText('Próximas ações pendentes2');
    await expect(root).toContainText('Próximas ações vencidas1');
    const next = page.getByTestId('tabela-proximas-acoes').locator('tbody tr');
    await expect(next).toHaveCount(2);
    await expect(next.filter({ hasText: 'Bia Lima' }).locator('[data-vencida="true"]')).toBeVisible();
    await expect(next.filter({ hasText: 'Ana Souza' }).locator('[data-vencida="false"]')).toBeVisible();
    await expect(next.filter({ hasText: 'Ana Souza' })).toContainText('Visitar a família');
    await expect(page.getByTestId('tabela-proximas-acoes')).not.toContainText('Ligar para os pais');

    // um contato novo da Bia (sem próxima ação) substitui o vencido: some da ficha e do relatório
    await db.createFollowUp(bia, 'Retorno', { responsibleId: s.carla.id });
    await page.reload();
    await tab(page).click();
    await expect(root).toContainText('Próximas ações pendentes1');
    await expect(root).toContainText('Próximas ações vencidas0');
    await openYouthSheet(page, 'Bia Lima');
    await expect(items(page)).toHaveCount(2);
    await expect(items(page).filter({ hasText: 'Visita combinada' })).not.toContainText('(vencido)');
  });
});
