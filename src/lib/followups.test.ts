import { describe, expect, it } from 'vitest';
import {
  canManageFollowUp,
  followUpPayload,
  isNextActionLate,
  isNextActionOverdue,
  personName,
  sortTransfers,
  transferLine,
  validateFollowUpForm,
  type FollowUpFormValues,
} from './followups';

const base: FollowUpFormValues = {
  occurred_at: '2026-10-01',
  type: 'call',
  reason: 'Faltou três vezes',
  notes: '',
  next_action: '',
  next_action_due: '',
  responsible_id: 'u1',
  task_id: '',
  completes_task: false,
  alert_id: '',
};
const TODAY = '2026-10-03';

describe('validateFollowUpForm', () => {
  it('aceita um formulário válido', () => {
    expect(validateFollowUpForm(base, TODAY)).toBeNull();
    expect(validateFollowUpForm({ ...base, occurred_at: TODAY }, TODAY)).toBeNull();
  });

  it('exige motivo (espaços não contam)', () => {
    expect(validateFollowUpForm({ ...base, reason: '   ' }, TODAY)).toBe('Informe o motivo do acompanhamento.');
  });

  it('não aceita data futura nem ausente', () => {
    expect(validateFollowUpForm({ ...base, occurred_at: '2026-10-04' }, TODAY)).toBe('A data do contato não pode estar no futuro.');
    expect(validateFollowUpForm({ ...base, occurred_at: '' }, TODAY)).toBe('Informe a data do contato.');
  });

  it('prazo da próxima ação não pode ser anterior ao contato', () => {
    expect(validateFollowUpForm({ ...base, next_action_due: '2026-09-30' }, TODAY)).toMatch(/anterior/);
    expect(validateFollowUpForm({ ...base, next_action_due: '2026-10-01' }, TODAY)).toBeNull();
  });

  it('concluir a ação exige escolher a ação', () => {
    expect(validateFollowUpForm({ ...base, completes_task: true }, TODAY)).toBe('Selecione a ação que será concluída.');
    expect(validateFollowUpForm({ ...base, completes_task: true, task_id: 't1' }, TODAY)).toBeNull();
  });
});

describe('followUpPayload', () => {
  it('transforma textos vazios em null e apara o motivo', () => {
    expect(followUpPayload({ ...base, reason: '  Conversa  ', notes: '  ', next_action: ' Ligar ' })).toMatchObject({
      reason: 'Conversa', notes: null, next_action: 'Ligar', next_action_due: null, alert_id: null, task_id: null,
    });
  });

  it('completes_task só vale com ação vinculada', () => {
    expect(followUpPayload({ ...base, completes_task: true, task_id: '' }).completes_task).toBe(false);
    expect(followUpPayload({ ...base, completes_task: true, task_id: 't1' }).completes_task).toBe(true);
  });
});

describe('nomes e histórico de transferências', () => {
  const names = new Map([['u1', 'Fulano'], ['u2', 'Beltrano']]);

  it('personName', () => {
    expect(personName('u1', names)).toBe('Fulano');
    expect(personName('u1', names, 'u1')).toBe('Você');
    expect(personName('zzz', names)).toBe('Outro usuário');
    expect(personName(null, names)).toBe('Sem responsável');
  });

  it('transferLine: "Fulano → Beltrano · motivo · data"', () => {
    const line = transferLine(
      { from_responsible_id: 'u1', to_responsible_id: 'u2', reason: 'O jovem mudou de grupo', transferred_at: '2026-09-12T15:00:00Z' },
      names,
    );
    expect(line).toBe('Fulano → Beltrano · O jovem mudou de grupo · 12/09/2026');
  });

  it('sortTransfers ordena do mais antigo ao mais recente sem alterar a entrada', () => {
    const list = [{ transferred_at: '2026-09-02T00:00:00Z' }, { transferred_at: '2026-09-01T00:00:00Z' }];
    expect(sortTransfers(list).map((t) => t.transferred_at)).toEqual(['2026-09-01T00:00:00Z', '2026-09-02T00:00:00Z']);
    expect(list[0].transferred_at).toBe('2026-09-02T00:00:00Z');
  });
});

describe('canManageFollowUp', () => {
  it('coordenador sempre; líder só se for o responsável atual (ou criador sem responsável)', () => {
    expect(canManageFollowUp({ responsible_id: 'a', created_by: 'b' }, 'x', true)).toBe(true);
    expect(canManageFollowUp({ responsible_id: 'x', created_by: 'b' }, 'x', false)).toBe(true);
    expect(canManageFollowUp({ responsible_id: 'a', created_by: 'x' }, 'x', false)).toBe(false); // transferido: perdeu o acesso
    expect(canManageFollowUp({ responsible_id: null, created_by: 'x' }, 'x', false)).toBe(true);
    expect(canManageFollowUp({ responsible_id: 'x', created_by: 'x' }, null, false)).toBe(false);
  });
});

describe('isNextActionLate', () => {
  it('vencida só se o prazo é anterior a hoje', () => {
    expect(isNextActionLate('2026-10-02', TODAY)).toBe(true);
    expect(isNextActionLate('2026-10-03', TODAY)).toBe(false);
    expect(isNextActionLate(null, TODAY)).toBe(false);
  });
});

describe('isNextActionOverdue (regra do banco: report_pending_followups)', () => {
  const overdue = { next_action_due: '2026-10-02', completes_task: false, task: null };

  it('vencido no acompanhamento mais recente com prazo anterior a hoje', () => {
    expect(isNextActionOverdue(overdue, TODAY, true)).toBe(true);
  });
  it('acompanhamento superado por um mais novo do mesmo jovem nunca está vencido', () => {
    expect(isNextActionOverdue(overdue, TODAY, false)).toBe(false);
  });
  it('sem prazo ou com prazo de hoje em diante não está vencido', () => {
    expect(isNextActionOverdue({ ...overdue, next_action_due: null }, TODAY, true)).toBe(false);
    expect(isNextActionOverdue({ ...overdue, next_action_due: TODAY }, TODAY, true)).toBe(false);
  });
  it('ação vinculada concluída ou cancelada tira o vencimento; aberta mantém', () => {
    expect(isNextActionOverdue({ ...overdue, task: { status: 'done' } }, TODAY, true)).toBe(false);
    expect(isNextActionOverdue({ ...overdue, task: { status: 'cancelled' } }, TODAY, true)).toBe(false);
    expect(isNextActionOverdue({ ...overdue, task: { status: 'pending' } }, TODAY, true)).toBe(true);
    expect(isNextActionOverdue({ ...overdue, task: { status: 'in_progress' } }, TODAY, true)).toBe(true);
  });
  it('acompanhamento que conclui a ação não fica vencido', () => {
    expect(isNextActionOverdue({ ...overdue, completes_task: true, task: { status: 'pending' } }, TODAY, true)).toBe(false);
  });
});
