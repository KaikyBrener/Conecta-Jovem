// Alertas (Fase 7): tipos e severidade, resolver/dispensar sem apagar faltas, histórico, filtros,
// ausência de duplicidade, nova sequência de faltas e alertas por tempo (sem acompanhamento / ação atrasada).
// O banco falso aplica as migrations reais: os alertas são gerados pelos triggers, não por mocks.
import type { Page } from '@playwright/test';
import {
  daysFromNow, expect, markAbsent, markPresent, modal, spDay, test, type TestDb,
} from './fixtures.ts';

const items = (page: Page) => page.getByTestId('alerta-item');
const byType = (page: Page, tipo: string, name?: string) =>
  page.locator(`[data-testid="alerta-item"][data-tipo="${tipo}"]`, name ? { hasText: name } : undefined);

/** Ana faltou nos 2 encontros realizados (limite padrão = 3 faltas); Bia compareceu; e3 sem chamada ainda. */
async function seedAbsence(db: TestDb) {
  const coord = await db.createUser('coordinator', 'Carla Coordenadora');
  const group = await db.createGroup('Grupo Alfa', coord.id);
  const ana = await db.createYouth('Ana Souza', group);
  const bia = await db.createYouth('Bia Lima', group);
  const e1 = await db.createEvent('Culto 1', daysFromNow(-21), [group], 'completed');
  const e2 = await db.createEvent('Culto 2', daysFromNow(-14), [group], 'completed');
  const e3 = await db.createEvent('Culto 3', daysFromNow(-7), [group], 'completed');
  for (const e of [e1, e2]) {
    await db.recordAttendance(e, ana, group, false, coord.id);
    await db.recordAttendance(e, bia, group, true, coord.id);
  }
  return { coord, group, ana, bia, e1, e2, e3 };
}

/** Terceira falta da Ana (e3) direto no banco: o trigger abre o alerta de faltas. */
async function thirdAbsence(db: TestDb, s: Awaited<ReturnType<typeof seedAbsence>>) {
  await db.recordAttendance(s.e3, s.ana, s.group, false, s.coord.id);
  await db.recordAttendance(s.e3, s.bia, s.group, true, s.coord.id);
}

test.describe('Alertas — tipos, severidade e filtros', () => {
  test('mostra tipo, descrição e severidade de cada alerta (faltas, frequência baixa, queda) e filtra por tipo e severidade', async ({ page, db, loginAs }) => {
    const coord = await db.createUser('coordinator', 'Carla Coordenadora');
    const group = await db.createGroup('Grupo Alfa', coord.id);
    // limite de "frequência baixa" em 10%: só quem faltou sempre dispara; deixa os cenários previsíveis
    await db.sql(`UPDATE app_settings SET low_attendance_threshold = 10`);
    const ana = await db.createYouth('Ana Souza', group); // 8 faltas
    const bia = await db.createYouth('Bia Lima', group); // presente nos 4 mais antigos, ausente nos 4 últimos
    const dani = await db.createYouth('Dani Rocha', group); // só 3 faltas (3 registros)
    for (let i = 0; i < 8; i++) {
      const ev = await db.createEvent(`Culto ${i + 1}`, daysFromNow(-70 + i * 7), [group], 'completed');
      await db.recordAttendance(ev, ana, group, false, coord.id);
      await db.recordAttendance(ev, bia, group, i < 4, coord.id);
      if (i >= 5) await db.recordAttendance(ev, dani, group, false, coord.id);
    }
    expect((await db.sql(`SELECT type, severity FROM alerts ORDER BY type, severity`)).length).toBe(5);

    await loginAs(coord);
    await page.goto('/alertas');
    await expect(items(page)).toHaveCount(5);
    await expect(page.getByRole('button', { name: 'Abertos (5)' })).toBeVisible();
    await expect(page.locator('aside nav').getByRole('link', { name: /Alertas/ })).toContainText('5');

    // faltas seguidas: 8 faltas é crítico (limite crítico padrão = 6); 4 e 3 são atenção
    const anaFaltas = byType(page, 'consecutive_absences', 'Ana Souza');
    await expect(anaFaltas).toHaveAttribute('data-severidade', 'critical');
    await expect(anaFaltas.getByTestId('alerta-descricao')).toHaveText('8 faltas seguidas');
    await expect(anaFaltas).toContainText('Crítico');
    const biaFaltas = byType(page, 'consecutive_absences', 'Bia Lima');
    await expect(biaFaltas).toHaveAttribute('data-severidade', 'attention');
    await expect(biaFaltas.getByTestId('alerta-descricao')).toHaveText('4 faltas seguidas');
    await expect(biaFaltas).toContainText('Atenção');
    await expect(byType(page, 'consecutive_absences', 'Dani Rocha').getByTestId('alerta-descricao')).toHaveText('3 faltas seguidas');

    // frequência baixa e queda de frequência trazem os números calculados pelo banco
    const low = byType(page, 'low_attendance');
    await expect(low).toHaveCount(1);
    await expect(low).toContainText('Ana Souza');
    await expect(low.getByTestId('alerta-descricao')).toHaveText('Frequência 0% nos últimos 8 encontros');
    await expect(low).toContainText('Frequência baixa');
    const drop = byType(page, 'attendance_drop');
    await expect(drop).toHaveCount(1);
    await expect(drop).toContainText('Bia Lima');
    await expect(drop.getByTestId('alerta-descricao')).toHaveText('Frequência caiu de 100% para 0% (últimos 4 encontros)');

    // filtros por tipo e por severidade (combináveis)
    await page.getByLabel('Filtrar por tipo').selectOption({ label: 'Frequência baixa' });
    await expect(items(page)).toHaveCount(1);
    await page.getByLabel('Filtrar por tipo').selectOption({ label: 'Faltas seguidas' });
    await expect(items(page)).toHaveCount(3);
    await page.getByLabel('Filtrar por severidade').selectOption({ label: 'Crítico' });
    await expect(items(page)).toHaveCount(1);
    await expect(items(page)).toContainText('Ana Souza');
    await page.getByLabel('Filtrar por severidade').selectOption({ label: 'Atenção' });
    await expect(items(page)).toHaveCount(2);
    await page.getByLabel('Filtrar por tipo').selectOption({ label: 'Ação atrasada' });
    await expect(items(page)).toHaveCount(0);
    await expect(page.getByText('Nenhum alerta encontrado.')).toBeVisible();
    await page.getByLabel('Filtrar por tipo').selectOption({ label: 'Todos os tipos' });
    await page.getByLabel('Filtrar por severidade').selectOption({ label: 'Qualquer severidade' });
    await expect(items(page)).toHaveCount(5);
  });
});

test.describe('Alertas — resolver, dispensar e histórico', () => {
  test('resolver avisa que não apaga as faltas e mantém presença, histórico e métricas do jovem', async ({ page, db, loginAs }) => {
    const s = await seedAbsence(db);
    await thirdAbsence(db, s);
    const attendanceBefore = await db.sql(`SELECT event_id, youth_id, present FROM attendance ORDER BY event_id, youth_id`);
    expect(attendanceBefore).toHaveLength(6);
    await loginAs(s.coord);
    await page.goto('/alertas');

    const card = byType(page, 'consecutive_absences', 'Ana Souza');
    await card.getByRole('button', { name: 'Resolver' }).click();
    const form = modal(page);
    await expect(form.getByRole('heading', { name: 'Resolver alerta' })).toBeVisible();
    await expect(form.getByTestId('aviso-historico')).toContainText('Resolver não apaga as faltas; elas continuam no histórico.');
    // o aviso é o mesmo para Resolver e Dispensar (mudança intencional): explica quando o alerta pode voltar
    await expect(form.getByTestId('aviso-historico')).toContainText('Ele só volta se uma presença quebrar a sequência.');
    await form.getByLabel('Observações').fill('Conversamos por telefone.');
    await form.getByRole('button', { name: 'Confirmar' }).click();

    await expect(page.getByText('Alerta resolvido.')).toBeVisible();
    await expect(page.getByText('Nenhum alerta aberto. Tudo em dia!')).toBeVisible();

    // o banco não tocou na presença
    expect(await db.sql(`SELECT event_id, youth_id, present FROM attendance ORDER BY event_id, youth_id`)).toEqual(attendanceBefore);
    const [alert] = await db.sql(`SELECT status, resolution_notes, resolved_by FROM alerts`);
    expect(alert).toEqual({ status: 'resolved', resolution_notes: 'Conversamos por telefone.', resolved_by: s.coord.id });

    // ficha: faltas e histórico intactos; a situação ainda enxerga as 3 faltas
    await page.goto('/jovens');
    await page.getByRole('button', { name: /Ana Souza/ }).first().click();
    const sheet = page.locator('div.fixed.inset-0').first();
    await expect(sheet.getByTestId('metrica-faltas')).toHaveText('3');
    await expect(sheet.getByText('Histórico de Presença').locator('..')).toContainText(/Faltas3/);
    for (const title of ['Culto 1', 'Culto 2', 'Culto 3']) await expect(sheet.getByText(title, { exact: true })).toBeVisible();
    await expect(sheet.getByTestId('alertas-abertos-jovem')).toHaveCount(0); // sem alerta aberto
  });

  test('dispensar explica que o alerta não é recriado e a 4ª falta da mesma sequência não o reabre', async ({ page, db, loginAs }) => {
    const s = await seedAbsence(db);
    await db.sql(`UPDATE app_settings SET low_attendance_threshold = 0`); // desliga "frequência baixa": o foco aqui são as faltas
    await thirdAbsence(db, s);
    await loginAs(s.coord);
    await page.goto('/alertas');

    await byType(page, 'consecutive_absences', 'Ana Souza').getByRole('button', { name: 'Dispensar' }).click();
    const form = modal(page);
    await expect(form.getByRole('heading', { name: 'Dispensar alerta' })).toBeVisible();
    await expect(form.getByTestId('aviso-historico')).toContainText('Dispensar não apaga as faltas');
    await expect(form.getByTestId('aviso-historico')).toContainText('O alerta não é recriado enquanto a situação continuar a mesma.');
    await form.getByRole('button', { name: 'Cancelar' }).click();
    expect(await db.sql(`SELECT status FROM alerts`)).toEqual([{ status: 'open' }]); // cancelar não muda nada

    await byType(page, 'consecutive_absences', 'Ana Souza').getByRole('button', { name: 'Dispensar' }).click();
    await modal(page).getByLabel('Observações').fill('Está viajando.');
    await modal(page).getByRole('button', { name: 'Confirmar' }).click();
    await expect(page.getByText('Alerta dispensado.')).toBeVisible();

    // mais uma falta na MESMA sequência: o alerta dispensado não volta
    const e4 = await db.createEvent('Culto 4', daysFromNow(-1), [s.group], 'completed');
    await db.recordAttendance(e4, s.ana, s.group, false, s.coord.id);
    await page.reload();
    await expect(page.getByText('Nenhum alerta aberto. Tudo em dia!')).toBeVisible();
    expect(await db.sql(`SELECT status FROM alerts WHERE type = 'consecutive_absences'`)).toEqual([{ status: 'dismissed' }]);
  });

  test('Resolvidos e Dispensados formam o histórico; "Todos" lista tudo; reabrir devolve o alerta a "Abertos"', async ({ page, db, loginAs }) => {
    const s = await seedAbsence(db);
    // Bia também com 3 faltas
    for (const e of [s.e1, s.e2, s.e3]) {
      await db.sql(`DELETE FROM attendance WHERE event_id = $1 AND youth_id = $2`, [e, s.bia]);
      await db.recordAttendance(e, s.bia, s.group, false, s.coord.id);
    }
    await db.recordAttendance(s.e3, s.ana, s.group, false, s.coord.id);
    expect(await db.sql(`SELECT 1 FROM alerts WHERE status = 'open'`)).toHaveLength(2);
    await loginAs(s.coord);
    await page.goto('/alertas');

    await byType(page, 'consecutive_absences', 'Ana Souza').getByRole('button', { name: 'Resolver' }).click();
    await modal(page).getByLabel('Observações').fill('Voltou a participar do grupo.');
    await modal(page).getByRole('button', { name: 'Confirmar' }).click();
    await byType(page, 'consecutive_absences', 'Bia Lima').getByRole('button', { name: 'Dispensar' }).click();
    await modal(page).getByLabel('Observações').fill('Mudou de cidade.');
    await modal(page).getByRole('button', { name: 'Confirmar' }).click();
    await expect(page.getByText('Nenhum alerta aberto. Tudo em dia!')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Abertos (0)' })).toBeVisible();

    await page.getByRole('button', { name: 'Resolvidos' }).click();
    await expect(items(page)).toHaveCount(1);
    await expect(items(page)).toContainText('Ana Souza');
    await expect(items(page)).toContainText('Resolvido');
    await expect(items(page)).toContainText('Voltou a participar do grupo.');
    await expect(items(page)).toContainText('Encerrado em');
    await page.getByRole('button', { name: 'Dispensados' }).click();
    await expect(items(page)).toHaveCount(1);
    await expect(items(page)).toContainText('Bia Lima');
    await expect(items(page)).toContainText('Dispensado');
    await expect(items(page)).toContainText('Mudou de cidade.');
    await page.getByRole('button', { name: 'Todos', exact: true }).click();
    await expect(items(page)).toHaveCount(2);

    // o histórico persiste depois de recarregar a página
    await page.reload();
    await page.getByRole('button', { name: 'Todos', exact: true }).click();
    await expect(items(page)).toHaveCount(2);

    // reabrir: volta para "Abertos"
    await page.getByRole('button', { name: 'Dispensados' }).click();
    await items(page).getByRole('button', { name: 'Reabrir' }).click();
    await expect(page.getByText('Alerta reaberto.')).toBeVisible();
    await expect(page.getByText('Nenhum alerta encontrado.')).toBeVisible();
    await page.getByRole('button', { name: /^Abertos \(1\)/ }).click();
    await expect(items(page)).toHaveCount(1);
    await expect(items(page)).toContainText('Bia Lima');
    expect(await db.sql(`SELECT status FROM alerts ORDER BY status`)).toEqual([{ status: 'open' }, { status: 'resolved' }]);
  });

  test('não duplica: recarregar e novas faltas atualizam o MESMO alerta aberto', async ({ page, db, loginAs }) => {
    const s = await seedAbsence(db);
    await db.sql(`UPDATE app_settings SET low_attendance_threshold = 0`); // desliga "frequência baixa": o foco aqui são as faltas
    await thirdAbsence(db, s);
    await loginAs(s.coord);
    for (let i = 0; i < 2; i++) {
      await db.resetSyncThrottle(); // sem isso a 2ª abertura (< 60 s) nem varreria
      await page.goto('/alertas'); // cada abertura roda sync_time_alerts (idempotente)
      await expect(items(page)).toHaveCount(1);
    }
    const [before] = await db.sql<{ id: string }>(`SELECT id FROM alerts`);

    const e4 = await db.createEvent('Culto 4', daysFromNow(-1), [s.group], 'completed');
    await db.recordAttendance(e4, s.ana, s.group, false, s.coord.id);
    await page.reload();
    await expect(items(page)).toHaveCount(1);
    await expect(byType(page, 'consecutive_absences').getByTestId('alerta-descricao')).toHaveText('4 faltas seguidas');
    const rows = await db.sql<{ id: string; consecutive_absences: number }>(
      `SELECT id, consecutive_absences FROM alerts WHERE type = 'consecutive_absences'`);
    expect(rows).toEqual([{ id: before.id, consecutive_absences: 4 }]);
  });

  test('nova sequência (presença + novas faltas) gera um NOVO alerta; o antigo continua no histórico', async ({ page, db, loginAs }) => {
    const s = await seedAbsence(db);
    await thirdAbsence(db, s);
    await loginAs(s.coord);
    await page.goto('/alertas');
    await byType(page, 'consecutive_absences', 'Ana Souza').getByRole('button', { name: 'Resolver' }).click();
    await modal(page).getByLabel('Observações').fill('Primeira sequência tratada.');
    await modal(page).getByRole('button', { name: 'Confirmar' }).click();
    await expect(page.getByText('Alerta resolvido.')).toBeVisible();

    // Ana volta (presença) e depois falta de novo, 2 vezes direto no banco e a 3ª pela tela de chamada
    const e4 = await db.createEvent('Culto 4', daysFromNow(-6), [s.group], 'completed');
    const e5 = await db.createEvent('Culto 5', daysFromNow(-5), [s.group], 'completed');
    const e6 = await db.createEvent('Culto 6', daysFromNow(-4), [s.group], 'completed');
    const e7 = await db.createEvent('Culto 7', daysFromNow(-1), [s.group], 'scheduled');
    await db.recordAttendance(e4, s.ana, s.group, true, s.coord.id);
    await db.recordAttendance(e5, s.ana, s.group, false, s.coord.id);
    await db.recordAttendance(e6, s.ana, s.group, false, s.coord.id);
    expect(await db.sql(`SELECT 1 FROM alerts WHERE type = 'consecutive_absences' AND status = 'open'`)).toHaveLength(0); // só 2 faltas

    await page.goto(`/chamada/${e7}`);
    await markAbsent(page, 'Ana Souza');
    await markPresent(page, 'Bia Lima');
    await page.getByRole('button', { name: 'Salvar Chamada' }).click();
    const novos = page.getByTestId('chamada-novos-alertas');
    await expect(novos).toContainText('Ana Souza');
    await expect(novos).toContainText('3 faltas seguidas');

    await page.goto('/alertas');
    await page.getByLabel('Filtrar por tipo').selectOption({ label: 'Faltas seguidas' });
    await page.getByRole('button', { name: 'Todos', exact: true }).click();
    await expect(items(page)).toHaveCount(2);
    const aberto = items(page).filter({ hasText: 'Aberto' }).filter({ hasNotText: 'Resolvido' });
    await expect(aberto).toHaveCount(1);
    await expect(aberto.getByTestId('alerta-descricao')).toHaveText('3 faltas seguidas');
    await expect(aberto).toContainText('Última falta: Culto 7');
    const antigo = items(page).filter({ hasText: 'Resolvido' });
    await expect(antigo).toHaveCount(1);
    await expect(antigo).toContainText('Primeira sequência tratada.');
    await expect(antigo).toContainText('Última falta: Culto 3');

    const rows = await db.sql<{ status: string; last: string }>(
      `SELECT a.status, e.title AS last FROM alerts a JOIN events e ON e.id = a.last_event_id
        WHERE a.type = 'consecutive_absences' ORDER BY e.title`);
    expect(rows).toEqual([{ status: 'resolved', last: 'Culto 3' }, { status: 'open', last: 'Culto 7' }]);
  });
});

test.describe('Alertas por tempo', () => {
  test('"sem acompanhamento" aparece após os dias de tolerância e some ao registrar um acompanhamento', async ({ page, db, loginAs }) => {
    const s = await seedAbsence(db);
    await thirdAbsence(db, s);
    await loginAs(s.coord);

    // alerta de faltas recém-criado: ainda dentro da tolerância (7 dias)
    await page.goto('/alertas');
    await expect(items(page)).toHaveCount(1);
    await expect(byType(page, 'no_followup')).toHaveCount(0);

    // envelhece o alerta de faltas: ao abrir /alertas, sync_time_alerts cria o "sem acompanhamento"
    // (a varredura é limitada a 1 por minuto no banco, migration 016: zera o throttle para a nova abertura varrer)
    await db.ageAlerts('consecutive_absences', 9);
    await db.resetSyncThrottle();
    await page.reload();
    await expect(items(page)).toHaveCount(2);
    const semAcomp = byType(page, 'no_followup', 'Ana Souza');
    await expect(semAcomp.getByTestId('alerta-descricao')).toHaveText('Sem acompanhamento há 9 dias');
    await expect(semAcomp).toContainText('Sem acompanhamento');
    await expect(semAcomp).toHaveAttribute('data-severidade', 'attention');
    await page.getByLabel('Filtrar por tipo').selectOption({ label: 'Sem acompanhamento' });
    await expect(items(page)).toHaveCount(1);
    await page.getByLabel('Filtrar por tipo').selectOption({ label: 'Todos os tipos' });

    // recarregar de novo (com nova varredura de fato) não duplica
    await db.resetSyncThrottle();
    await page.reload();
    await expect(items(page)).toHaveCount(2);

    // registrar acompanhamento a partir do alerta de faltas resolve o "sem acompanhamento"
    await byType(page, 'consecutive_absences', 'Ana Souza').getByRole('button', { name: 'Registrar acompanhamento' }).click();
    const form = modal(page);
    await expect(form.getByRole('heading', { name: 'Novo acompanhamento' })).toBeVisible();
    await expect(form.getByLabel('Alerta')).not.toHaveValue(''); // já vinculado ao alerta de origem
    await form.getByLabel('Motivo').fill('Conversa após as faltas');
    await form.getByRole('button', { name: 'Registrar acompanhamento' }).click();
    await expect(page.getByText('Acompanhamento registrado.')).toBeVisible();

    await expect(items(page)).toHaveCount(1); // só o alerta de faltas segue aberto
    await expect(byType(page, 'no_followup')).toHaveCount(0);
    const faltas = byType(page, 'consecutive_absences', 'Ana Souza');
    await expect(faltas.getByTestId('alerta-cadeia')).toContainText('Conversa após as faltas');
    await expect(faltas.getByTestId('alerta-cadeia')).toContainText('Conversa'); // tipo do acompanhamento
    await page.getByRole('button', { name: 'Resolvidos' }).click();
    await expect(byType(page, 'no_followup')).toHaveCount(1);
    await expect(byType(page, 'no_followup')).toContainText('Resolvido automaticamente: acompanhamento registrado.');
    expect(await db.sql(`SELECT status FROM alerts WHERE type = 'no_followup'`)).toEqual([{ status: 'resolved' }]);
  });

  test('"ação atrasada" nasce com a ação vencida e some ao concluí-la; concluir não altera a presença', async ({ page, db, loginAs }) => {
    const s = await seedAbsence(db);
    await db.createTask('Ligar para Ana', { createdBy: s.coord.id, assignedTo: s.coord.id, youthId: s.ana, groupId: s.group, dueDate: spDay(-3) });
    expect(await db.sql(`SELECT 1 FROM alerts WHERE type = 'overdue_action'`)).toHaveLength(1);
    const attendanceBefore = await db.sql(`SELECT event_id, youth_id, present FROM attendance ORDER BY event_id, youth_id`);
    await loginAs(s.coord);

    await page.goto('/alertas');
    const atrasada = byType(page, 'overdue_action', 'Ana Souza');
    await expect(atrasada.getByTestId('alerta-descricao')).toHaveText('1 ação atrasada');
    await expect(atrasada).toContainText('Ação atrasada');

    await page.locator('aside nav').getByRole('link', { name: 'Tarefas' }).click();
    const task = page.locator('main li', { hasText: 'Ligar para Ana' });
    await expect(task.getByTestId('badge-atrasada')).toBeVisible();
    await task.getByRole('button', { name: 'Concluir' }).click();
    await expect(page.getByText('Tarefa concluída.')).toBeVisible();

    await page.locator('aside nav').getByRole('link', { name: /Alertas/ }).click();
    await expect(page.getByText('Nenhum alerta aberto. Tudo em dia!')).toBeVisible();
    await page.getByRole('button', { name: 'Resolvidos' }).click();
    await expect(byType(page, 'overdue_action')).toContainText('Resolvido automaticamente: nenhuma ação atrasada.');
    expect(await db.sql(`SELECT event_id, youth_id, present FROM attendance ORDER BY event_id, youth_id`)).toEqual(attendanceBefore);
  });
});
