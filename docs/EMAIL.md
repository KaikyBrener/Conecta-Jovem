# E-mail: envio pelo servidor

Fluxo: Alerta/Acompanhamento -> Compor (rascunho) -> Revisar -> **Enviar** (1 clique) -> resultado REAL do provedor -> Histórico.
Só e-mail. Nada é automático: nenhum alerta dispara envio. "Enviada" só existe se o provedor respondeu 2xx.

## Peças
- Migration `018_communications_server_send.sql`: estados `draft, sending, sent, failed, cancelled`; RPCs `begin_communication_send` /
  `finish_communication_send` (EXECUTE só para `service_role`); rate limit (20 envios iniciados/h por usuário).
  Clientes **não** conseguem definir `sending`/`sent`/`failed` (nem por UPDATE, nem por `mark_communication`, que só aceita `draft`/`cancelled`).
- Edge Function `supabase/functions/send-communication` (`handler.ts` puro e testado; `provider.ts`; `index.ts` liga o Deno).

## Contrato HTTP
`POST /functions/v1/send-communication`, `Authorization: Bearer <JWT do usuário>`, body `{"communication_id":"<uuid>"}`.
- `200 {status:"sent", communication_id, sent_at}` ou `200 {status:"failed", communication_id, failure_reason}`
  (`provider_not_configured | provider_rejected | invalid_address | network | timeout | unknown`).
- Erros `{error}`: 400 `invalid_request`, 401 `unauthorized`, 404 `not_found` (inexistente ou fora do escopo), 405,
  409 `already_sent|in_progress|not_sendable`, 422 `invalid_content` (+`field`), 429 `rate_limited` (+`Retry-After`), 500 `internal_error`.

## Configuração (NADA disso está configurado por este repositório)
```
supabase functions deploy send-communication
supabase secrets set RESEND_API_KEY=... MAIL_FROM="Conecta Jovem <no-reply@seudominio>" \
  ALLOWED_ORIGIN=https://seu-app MAIL_PROVIDER=resend
```
- Aplicar a migration 018 no SQL Editor (após a 017).
- `verify_jwt` fica no padrão (true); não há `supabase/config.toml`. `SUPABASE_URL/ANON_KEY/SERVICE_ROLE_KEY` são injetadas pela plataforma.
- `ALLOWED_ORIGIN`: origem exata do app. Sem ela, nenhuma origem recebe CORS (restrito por padrão).
- Provedor: conta Resend com **domínio verificado** (registros SPF e DKIM; DMARC recomendado). Sem domínio verificado o Resend só
  entrega ao dono da conta. Sem `RESEND_API_KEY`/`MAIL_FROM` a função NÃO tenta enviar: a tentativa vira `failed/provider_not_configured`.
- Limites (migration 019, por usuário, janela deslizante, no banco): **líder 10/hora e 30/dia; coordenador 20/hora e 100/dia**. Corpo até 5000 caracteres, assunto até 200; timeout do provedor 15 s; cotas do plano do provedor valem.

## Como testar com um destinatário real
1. Configure os secrets acima e o domínio. 2. Crie uma comunicação para um jovem seu com SEU e-mail como destinatário.
3. Clique em Enviar; confira a caixa de entrada (e spam) e que o histórico mostra `sent` com o id do provedor (`provider_message_id`).
4. Teste a falha: remova `RESEND_API_KEY` e envie de novo (deve aparecer `provider_not_configured`).
Os testes automatizados (`tests/functions`, `tests/db/communications-send.test.ts`) usam provedor falso; **nenhum e-mail real foi enviado**.

## Segurança / abuso
- **Regra do líder (019)**: líder só envia ao e-mail cadastrado do PRÓPRIO jovem (`recipient_kind='youth'` e e-mail igual ao do jovem). Validado ao gravar o rascunho (erro pt-BR "Líderes só podem enviar ao e-mail cadastrado do próprio jovem.") e de novo no `begin` (422 `invalid_content`, `field: recipient`). Coordenador pode digitar qualquer destinatário. Jovem sem e-mail cadastrado: só o coordenador consegue enviar.
- Idempotency-Key = `id:` + SHA-256 curto de (to, subject, body): retry com o mesmo conteúdo reaproveita a chave; conteúdo editado gera chave nova.
- O log de limites (`communication_send_log`) sobrevive à exclusão da comunicação e a contagem é serializada por usuário (advisory lock).
- Anti-relay: o destinatário vem do registro validado no banco (não do request); `from` fixo no ambiente; corpo enviado como
  **texto puro**; assunto/destinatário sem CR/LF; escopo pelo RLS do usuário (+ regra de escrita dentro de `begin`); rate limit por usuário.
- `reply_to` = e-mail do usuário que enviou: **o destinatário passa a conhecer o e-mail de quem enviou**. Decisão registrada: mantido (permite resposta direta ao líder/coordenador).
- Logs: só evento e id curto; nunca e-mail, assunto, corpo, chaves ou texto do provedor. Respostas nunca trazem texto cru do provedor.

## Riscos residuais
- Se o provedor aceitar o e-mail e o registro (`finish`) falhar 2 vezes, a linha fica `sending` apesar do e-mail ter saído; após 5 min
  ela pode ser reenviada (possível duplicata). `Idempotency-Key` = `id:attempts` não cobre tentativas diferentes.
- `sent` = aceito pelo provedor, não "lido" nem "entregue": bounces posteriores exigiriam webhook (não implementado).
- **Retenção/LGPD pendente**: `communications` (e-mail, assunto, corpo) e `activity_log` não têm prazo de retenção nem rotina de anonimização/expurgo (ver migration 016); definir prazo e rotina é decisão de produto/jurídica. `communication_send_log` é apagado após 2 dias.
