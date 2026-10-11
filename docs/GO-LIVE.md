# Runbook de go-live — ConectJovem

Quem executa: o responsável pelo projeto. **Nada deste runbook é executado pelo assistente**; ele só interpreta os
resultados trazidos.

Regras: nunca cole chaves, senhas ou tokens em chat, issue ou commit (cite só o **nome** do segredo). Comandos proibidos
neste projeto: `supabase db push`, `db reset`, `db pull`, `migration up`, `config push`.

Domínio de produção do app: `https://conectjovem.com.br`. Placeholder: `DOMINIO-DE-ENVIO` é o domínio **verificado no
Resend** para enviar e-mail (pode ser `conectjovem.com.br` ou um subdomínio dedicado). Substitua só no momento de
executar e não invente valores.

Legenda:
- `[x] feito, conforme o responsável` — declarado pelo responsável; **não verificado** pelo assistente.
- `[ ]` — pendente.

---

## 0. Já feito, conforme o responsável

- [x] Chave do Resend rotacionada e a antiga revogada (`RESEND_API_KEY`), **feito, conforme o responsável**.
- [x] Cadastro aberto do Supabase Auth desligado ("Allow new users to sign up" = off), **feito, conforme o responsável**.
- [x] Ajustes de Auth, **feito, conforme o responsável**. Itens específicos ainda pendentes estão nas seções 7 e 8.

## 1. Backup (antes de qualquer mudança no banco)

- [ ] Backup restaurável do banco de hoje confirmado no painel do Supabase. **Sem backup, não siga.** No banco, a única
      forma de voltar atrás é restaurar o backup.

## 2. Verificar as migrations já aplicadas (001–019) e registrar o histórico

- [ ] Rodar a **Seção A (Q1–Q9)** de [`docs/sql/verificacao-migrations.sql`](sql/verificacao-migrations.sql) no SQL Editor,
      uma consulta por vez. Esperado: todas com `falhas: 0`.
- [ ] Trazer os resultados para análise **antes** de registrar o histórico. Se algo vier parcial, a correção é uma
      migration nova só com o que falta (nunca reaplicar a migration inteira).
- [ ] Só se Q1–Q9 derem `falhas: 0`, registrar o histórico **sem reaplicar SQL**. Primeiro teste com uma versão só:
  ```bash
  npx supabase migration list
  npx supabase migration repair --status applied 001
  npx supabase migration list
  ```
  - Se a `001` aparecer como aplicada no remoto, repita para as demais (uma por linha):
    ```bash
    npx supabase migration repair --status applied 002
    npx supabase migration repair --status applied 003
    npx supabase migration repair --status applied 004
    npx supabase migration repair --status applied 005
    npx supabase migration repair --status applied 006
    npx supabase migration repair --status applied 007
    npx supabase migration repair --status applied 008
    npx supabase migration repair --status applied 009
    npx supabase migration repair --status applied 010
    npx supabase migration repair --status applied 011
    npx supabase migration repair --status applied 012
    npx supabase migration repair --status applied 013
    npx supabase migration repair --status applied 014
    npx supabase migration repair --status applied 015
    npx supabase migration repair --status applied 016
    npx supabase migration repair --status applied 017
    npx supabase migration repair --status applied 018
    npx supabase migration repair --status applied 019
    npx supabase migration list
    ```
  - Se o CLI **recusar** o formato `001`: pare e traga o erro. **Não renomeie** arquivos de migration.

## 3. Aplicar 020, 021 e 024

Passo a passo em [`docs/sql/aplicar-migrations.md`](sql/aplicar-migrations.md).

- [ ] Aplicar `020_series_idempotency_and_event_delete_guard.sql` no SQL Editor.
- [ ] Aplicar `021_anonymize_youth.sql`.
- [ ] Aplicar `024_set_user_role_recheck_after_lock.sql`.
- [ ] Rodar `NOTIFY pgrst, 'reload schema';`.
- [ ] Rodar a **Seção B (Q10)**. Esperado: `Q10 verificados: 11 | falhas: 0`.
- [ ] Registrar o histórico:
  ```bash
  npx supabase migration repair --status applied 020
  npx supabase migration repair --status applied 021
  npx supabase migration repair --status applied 024
  npx supabase migration list
  ```
- [ ] (Opcional, depois) A `023` (pg_cron): só após habilitar `pg_cron` no painel (Database → Extensions). Conferir com
      Q11/Q12 e registrar com `npx supabase migration repair --status applied 023`.

Se qualquer migration falhar no meio: **pare, não reexecute**, traga o erro (ver `aplicar-migrations.md`).

## 4. Domínio de envio no Resend

- [ ] Adicionar o domínio de envio no painel do Resend (ex.: `conectjovem.com.br` ou um subdomínio dedicado a e-mail).
- [ ] Publicar no DNS os registros **SPF** e **DKIM** que o Resend mostrar, copiados do painel, sem alterar.
- [ ] Publicar **DMARC** inicial em modo observação: registro TXT `_dmarc.DOMINIO-DE-ENVIO` com `v=DMARC1; p=none`
      (o endereço de relatórios `rua=mailto:...` é opcional e fica a critério do responsável).
- [ ] Esperar o domínio aparecer como **verificado** no Resend. Sem isso, o Resend só entrega para o dono da conta.

## 5. Secrets da Edge Function `send-communication`

Definir com o CLI ou no painel (Edge Functions → Secrets), **sem colar valores em chat**:

```bash
npx supabase secrets set MAIL_FROM="ConectJovem <no-reply@DOMINIO-DE-ENVIO>" ALLOWED_ORIGIN=https://conectjovem.com.br MAIL_PROVIDER=resend
npx supabase secrets set REPLY_TO_EMAIL=contato@DOMINIO-DE-ENVIO
```

- [x] `RESEND_API_KEY`: chave nova, **feito, conforme o responsável**.
- [ ] `MAIL_FROM`: remetente **no domínio verificado** do item 4.
- [ ] `ALLOWED_ORIGIN`: a URL **exata** do app, **sem barra final** (`https://conectjovem.com.br`). A função normaliza barra e
      caminho, mas mantenha o valor limpo. Errada ou ausente = o navegador bloqueia o envio (CORS).
- [ ] `MAIL_PROVIDER=resend`.
- [ ] `REPLY_TO_EMAIL` (opcional, recomendado): endereço único da organização. Esconde o e-mail pessoal de quem envia.
      **Inválido = a função não envia** (`provider_not_configured`).

Detalhes: [`docs/EMAIL.md`](EMAIL.md).

## 6. Deploy da função

- [ ] Na raiz do repositório, nesta branch, rodar `npx supabase functions deploy send-communication`.
      `verify_jwt` fica no padrão (ligado). O deploy leva o import fixado em `supabase-js 2.117.2`, `ALLOWED_ORIGIN`
      normalizada e `REPLY_TO_EMAIL`.

## 7. Host e DNS do app

Hospedagem: **Cloudflare Workers (arquivos estáticos)**, configurada em `wrangler.jsonc` na raiz do repositório:
publica o `dist/` e usa `not_found_handling: "single-page-application"` como fallback de SPA (qualquer rota do app
devolve o `index.html`). O `public/_headers` vai para o `dist/` e define os headers de segurança.

- [ ] Worker `conecta-jovem` ligado a este repositório e à branch de produção. **Não mude o `"name"` do
      `wrangler.jsonc`**: o domínio está ligado a esse Worker, e outro nome criaria um Worker novo.
- [ ] Comando de build: `npm run build`.
- [ ] Pasta publicada: `dist` (já definida em `wrangler.jsonc`).
- [ ] Variáveis de ambiente definidas **antes** do primeiro build:
      `VITE_SUPABASE_URL` e `VITE_SUPABASE_PUBLISHABLE_KEY`, só a chave **publicável**, nunca a `service_role`.
      Sem `VITE_SUPABASE_URL` o build **falha** de propósito (a CSP precisa dela).
- [ ] Versão do Node no host: a mesma versão principal usada no desenvolvimento (hoje, Node 24).
- [ ] Domínio `conectjovem.com.br` ligado ao Worker (Workers & Pages → o Worker → Settings → Domains & Routes).
- [ ] HTTPS ativo no domínio.
- [ ] HSTS: `public/_headers` envia `includeSubDomains`. Confirme antes que **todos** os subdomínios têm HTTPS.

### Logs e monitoramento

- **Worker:** o `wrangler.jsonc` liga `observability`. O Worker só entrega arquivos estáticos (não roda código do app),
  então os logs do Workers mostram pouco: servem para ver se o site está respondendo, não o que o usuário fez.
- **Visitas:** ligar o **Cloudflare Web Analytics** no painel (Analytics & Logs → Web Analytics → `conectjovem.com.br`).
  Não exige alterar o app.
- **Erros do navegador:** hoje ficam só no console de quem usa (ver `docs/OBSERVABILIDADE.md`). Para recebê-los seria
  preciso um monitor de erros, como o Sentry. **Não está instalado.**
- **Edge Function:** Supabase → Edge Functions → `send-communication` → Logs.
- **E-mails (entregue, devolvido, reclamação):** painel do Resend.

## 8. Supabase Auth

- [ ] Em Authentication → URL Configuration, **Site URL** = `https://conectjovem.com.br`.
- [ ] **Redirect URLs** incluindo `https://conectjovem.com.br/redefinir-senha`.
- [ ] Senha mínima **10** no Auth (o app já valida 10 na tela). Se fizer parte dos "ajustes de Auth" já declarados, só confira.
- [ ] **SMTP próprio** no Auth (Project Settings → Auth → SMTP). O envio padrão do Supabase tem limite baixo de e-mails
      por hora, o que afeta convites e recuperação de senha.
- [ ] Revisar os textos de "Invite user" e "Reset password" (Email Templates).

## 9. Usuários e papéis

- [ ] Criar os usuários pelo painel (Authentication → Users → Invite user). O cadastro aberto continua desligado.
- [ ] Garantir **pelo menos um coordenador**. O primeiro é promovido no SQL Editor (único `UPDATE` deste runbook, feito
      pelo responsável):
  ```sql
  UPDATE public.user_roles SET role = 'coordinator'
  WHERE user_id = (SELECT id FROM auth.users WHERE email = 'EMAIL-DO-COORDENADOR');
  ```
  Os demais papéis são definidos em **Configurações** pelo coordenador. Recomendado: **dois** coordenadores, para não
  depender de uma pessoa só.

## 10. Teste final em produção

- [ ] Login de um coordenador e de um líder.
- [ ] **Recuperação de senha**: o e-mail chega, o link abre `/redefinir-senha` e uma senha de 10+ caracteres é aceita.
- [ ] **Envio real** de uma comunicação para **outro destinatário** (não o dono da conta Resend). A mensagem chega
      (confira o spam), e a comunicação fica `sent` com `provider_message_id` preenchido. Consulta somente-leitura para
      conferir, por id curto, sem corpo nem destinatário:
  ```sql
  select left(id::text, 8) as comunicacao, status::text, failure_reason, provider_message_id is not null as tem_id_provedor
    from public.communications order by last_attempt_at desc nulls last limit 5;
  ```
- [ ] `npm run smoke -- https://conectjovem.com.br`: todos os itens `OK`.
- [ ] **Líder sem acesso a grupo alheio**: logado como líder, ele vê só os próprios grupos, jovens e encontros. Abrir a URL
      de um encontro ou jovem de outro grupo não mostra os dados.
- [ ] (Opcional) **Anonimização**: testar com um jovem de **TESTE**, criado só para isso (**nunca com dado real**: é
      irreversível). Como coordenador: ficha do jovem → "Anonimizar dados" → digitar o nome → confirmar. O jovem deve
      virar "Jovem anonimizado", inativo, no mesmo grupo. Como líder, a ação não deve aparecer. Exige a 021 aplicada.

## 11. Pós-lançamento

- [ ] Toda semana, rodar a consulta de falhas de envio ([`docs/EMAIL.md`](EMAIL.md), "Monitoramento semanal") e conferir
      bounces e reclamações no painel do Resend.
- [ ] (Opcional) Aplicar a `023` para manter os alertas temporais atualizados diariamente (seção 3).

## 12. Como voltar atrás

- **Frontend:** no painel da Cloudflare, voltar para a versão anterior do Worker (Workers & Pages → o Worker →
  Deployments → Rollback). Não exige mexer no banco.
- **Edge Function:** fazer o deploy de novo a partir da versão anterior do código (por exemplo, a partir da `main`),
  com `npx supabase functions deploy send-communication`.
- **Banco:** **só pelo backup** do item 1. As migrations não têm "desfazer". A exceção é o agendamento da `023`, que
  se remove com `cron.unschedule` (ver o cabeçalho da 023).
- **Secrets:** voltar o valor anterior com `npx supabase secrets set ...`, sem colar valores em chat.
