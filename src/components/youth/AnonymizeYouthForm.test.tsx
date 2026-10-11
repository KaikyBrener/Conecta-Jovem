import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { AnonymizeYouthForm } from './AnonymizeYouthForm';

// Renderização no servidor (sem DOM): textos, estado inicial do botão e erro. A digitação é coberta no E2E.
const render = (over: Partial<Parameters<typeof AnonymizeYouthForm>[0]> = {}) =>
  renderToStaticMarkup(
    <AnonymizeYouthForm youthName="Maria Silva" loading={false} error={null} onConfirm={() => {}} onCancel={() => {}} {...over} />,
  );

const confirmButton = (html: string) => /<button type="submit"[^>]*>/.exec(html)![0];

describe('AnonymizeYouthForm', () => {
  it('avisa que é irreversível e lista o que é apagado e o que é mantido', () => {
    const html = render();
    expect(html).toContain('IRREVERSÍVEL');
    expect(html).toContain('Maria Silva');
    expect(html).toContain('Será apagado:');
    for (const t of ['data de nascimento', 'gênero', 'telefone', 'e-mail', 'endereço', 'observações',
      'presença, tarefas, acompanhamentos, alertas e e-mails']) expect(html, t).toContain(t);
    expect(html).toContain('Será mantido:');
    expect(html).toContain('o grupo e os registros de presença e falta, para as estatísticas');
  });

  it('pede para digitar o nome e começa com o botão de confirmar DESABILITADO', () => {
    const html = render();
    expect(html).toContain('Para confirmar, digite o nome do jovem');
    expect(confirmButton(html)).toContain('disabled');
    expect(html).toContain('Anonimizar definitivamente');
  });

  it('durante a chamada: botões desabilitados e texto "Anonimizando..."', () => {
    const html = render({ loading: true });
    expect(html).toContain('Anonimizando...');
    expect(confirmButton(html)).toContain('disabled');
    expect(html).toContain('aria-busy="true"');
  });

  it('mostra o erro do banco em um alerta', () => {
    const html = render({ error: 'Há um e-mail em envio para este jovem. Aguarde o envio terminar e tente novamente.' });
    expect(html).toContain('role="alert"');
    expect(html).toContain('Há um e-mail em envio para este jovem');
  });
});
