# Contribuindo com o ConectJovem

Este guia vale para quem mexe no código, inclusive o próprio autor.

## Fluxo de trabalho

1. Crie uma branch a partir da `main` com um nome que diga o que muda: `fix/encontros-chip-serie`, `feat/relatorio-grupos`, `docs/readme`.
2. Faça mudanças pequenas e incrementais. Preserve o que já funciona.
3. Rode as verificações abaixo antes de abrir o PR.
4. Abra o PR para a `main` usando o modelo, em português, dizendo o problema, a causa e a correção.
5. Depois do merge, apague a branch.

## Verificações antes do PR

```bash
npm run lint
npm run build
npm test
npm run test:e2e   # quando a mudança afeta telas ou fluxos
```

Só diga que algo foi testado se o teste realmente rodou.

O GitHub Actions (`.github/workflows/ci.yml`) roda lint, build, `npm test`, os testes de concorrência e o E2E em cada PR e
em cada push na `main`. Ele não substitui rodar as verificações antes de abrir o PR.

## Convenções

- **Idioma**: interface, mensagens, commits e PRs em português (pt-BR).
- **Commits**: mensagem curta no imperativo, com o tipo na frente (`fix`, `feat`, `docs`, `chore`, `refactor`, `test`) e o corpo explicando o motivo.
- **Banco de dados**: mudanças de schema só por **nova migration** numerada em `supabase/migrations/`. Nunca edite uma migration já aplicada. Toda tabela nova em `public` precisa de RLS ligado e políticas por papel. Nunca afrouxe o RLS para facilitar uma tela. Detalhes em [docs/OPERACAO.md](docs/OPERACAO.md).
- **Dados**: sem dados mockados nas telas; trate os estados vazio, carregando e erro.
- **Erros**: mostre sempre pela função `errorMessage()`, nunca o texto cru do servidor.
- **Confirmações**: ações irreversíveis usam `useConfirm()`, nunca `window.confirm`.
- **Visual**: use os componentes de `src/components/ui` e as classes semânticas do design system (ver [docs/REDESIGN.md](docs/REDESIGN.md)). O modo escuro precisa funcionar.
- **Testes**: mudanças de banco ganham teste em `tests/db`; mudanças de fluxo ganham ou ajustam o E2E. Não remova `data-testid`.
- **Segurança**: nunca commite `.env`, chaves, dumps de banco, logs ou qualquer dado pessoal de jovens.

## Reportando bugs e sugestões

Use os modelos de issue. Para falhas de segurança, siga o [SECURITY.md](SECURITY.md) e não abra issue pública.
