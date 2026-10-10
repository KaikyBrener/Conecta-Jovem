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
- `REPLY_TO_EMAIL` (**opcional**): endereço único (ex.: `contato@seudominio`, sem nome nem `< >`). Quando definido e válido, ele
  **sempre** vira o `reply_to` e o e-mail pessoal de quem enviou NÃO é repassado ao destinatário. Ausente ou vazio: comportamento
  anterior (`reply_to` = e-mail de quem enviou). **Definido e inválido: a função não envia** (`failed/provider_not_configured`,
  nenhuma chamada ao provedor), para um erro de digitação não expor o e-mail pessoal. A regra de formato é a mesma de
  `is_valid_email` (migration 016). AÇÃO MANUAL: `supabase secrets set REPLY_TO_EMAIL=...` (ou o painel da função) e confirmar com um
  envio de teste que o `reply_to` esperado está sendo usado.
- Provedor: conta Resend com **domínio verificado** (registros SPF e DKIM; DMARC recomendado). Sem domínio verificado o Resend só
  entrega ao dono da conta. Sem `RESEND_API_KEY`/`MAIL_FROM` a função NÃO tenta enviar: a tentativa vira `failed/provider_not_configured`.
- Limites (migration 019, por usuário, janela deslizante, no banco): **líder 10/hora e 30/dia; coordenador 20/hora e 100/dia**. Corpo até 5000 caracteres, assunto até 200; timeout do provedor 15 s; cotas do plano do provedor valem.

## Como testar com um destinatário real
1. Configure os secrets acima e o domínio. 2. Crie uma comunicação para um jovem seu com SEU e-mail como destinatário.
3. Clique em Enviar; confira a caixa de entrada (e spam) e que o histórico mostra `sent` com o id do provedor (`provider_message_id`).
4. Teste a falha: remova `RESEND_API_KEY` e envie de novo (deve aparecer `provider_not_configured`).
Os testes automatizados (`tests/functions`, `tests/db/communications-send.test.ts`) usam provedor falso; **nenhum e-mail real foi enviado**.

## Monitoramento semanal (sem webhook)
`sent` significa **aceito pelo Resend**, não "entregue": bounces e marcações como spam **não** voltam para o app. Até existir um
webhook, faça uma revisão semanal em duas frentes:

1. **Banco (AÇÃO MANUAL, SQL Editor do Supabase).** As duas consultas abaixo são somente leitura. O SQL Editor roda como
   `postgres` e enxerga todos os grupos. Nenhuma das duas mostra corpo, assunto nem destinatário.

```sql
-- Revisão semanal: falhas e envios presos em "sending" nos últimos 7 dias (somente leitura)
select left(c.id::text, 8)                                  as comunicacao,
       c.status::text                                       as status,
       coalesce(c.failure_reason, '-')                      as motivo,
       c.attempts                                           as tentativas,
       c.provider                                           as provedor,
       c.last_attempt_at at time zone 'America/Sao_Paulo'   as ultima_tentativa_brasilia,
       g.name                                               as grupo
  from public.communications c
  left join public.youth  y on y.id = c.youth_id
  left join public.groups g on g.id = y.group_id
 where c.last_attempt_at >= now() - interval '7 days'
   and (c.status = 'failed'
        or (c.status = 'sending' and c.last_attempt_at < now() - interval '10 minutes'))
 order by c.last_attempt_at desc;
```

```sql
-- Resumo dos últimos 7 dias por status e motivo (inclui os enviados, para ter a taxa de falha)
select c.status::text as status, coalesce(c.failure_reason, '-') as motivo, count(*) as total
  from public.communications c
 where c.last_attempt_at >= now() - interval '7 days'
 group by 1, 2
 order by 3 desc;
```

   **Como ler o resultado:**
   - `provider_not_configured`: falta secret (`RESEND_API_KEY`, `MAIL_FROM`) ou o `REPLY_TO_EMAIL` está inválido.
   - `provider_rejected`: o Resend recusou (domínio não verificado, remetente inválido, conta suspensa).
   - `network` / `timeout` / `unknown`: instabilidade. Se forem pontuais, reenviar resolve.
   - `sending` há mais de 10 minutos: o registro do resultado falhou. O e-mail pode ter saído; confira o id no Resend antes de reenviar.
   - Para chegar ao registro completo, filtre por `c.id::text like '<8 primeiros>%'`.

2. **Painel do Resend (AÇÃO MANUAL).** Na lista de e-mails enviados, confira os que aparecem como devolvidos (*bounced*),
   marcados como spam (*complained*) ou com entrega atrasada. Para cruzar com o app, use o id da mensagem: ele é o
   `provider_message_id` da comunicação. Na área de logs da API, veja as requisições recusadas (4xx), que viram
   `provider_rejected` no app. Os nomes dos menus podem mudar; não conferi o painel. Endereços devolvidos de forma permanente
   devem ser corrigidos na ficha do jovem antes de um novo envio.

## Segurança / abuso
- **Regra do líder (019)**: líder só envia ao e-mail cadastrado do PRÓPRIO jovem (`recipient_kind='youth'` e e-mail igual ao do jovem). Validado ao gravar o rascunho (erro pt-BR "Líderes só podem enviar ao e-mail cadastrado do próprio jovem.") e de novo no `begin` (422 `invalid_content`, `field: recipient`). Coordenador pode digitar qualquer destinatário. Jovem sem e-mail cadastrado: só o coordenador consegue enviar.
- Idempotency-Key = `id:` + SHA-256 curto de (to, subject, body): retry com o mesmo conteúdo reaproveita a chave; conteúdo editado gera chave nova.
- O log de limites (`communication_send_log`) sobrevive à exclusão da comunicação e a contagem é serializada por usuário (advisory lock).
- Anti-relay: o destinatário vem do registro validado no banco (não do request); `from` fixo no ambiente; corpo enviado como
  **texto puro**; assunto/destinatário sem CR/LF; escopo pelo RLS do usuário (+ regra de escrita dentro de `begin`); rate limit por usuário.
- `reply_to`: **sem `REPLY_TO_EMAIL`, é o e-mail do usuário que enviou, e o destinatário passa a conhecê-lo** (permite resposta direta ao
  líder/coordenador). Com `REPLY_TO_EMAIL` válido, ele o substitui sempre. Para não expor e-mails pessoais, defina o secret.
- Logs: só evento e id curto; nunca e-mail, assunto, corpo, chaves ou texto do provedor. Respostas nunca trazem texto cru do provedor.

## Riscos residuais
- Se o provedor aceitar o e-mail e o registro (`finish`) falhar 2 vezes, a linha fica `sending` apesar do e-mail ter saído; após 5 min
  ela pode ser reenviada (possível duplicata). `Idempotency-Key` = `id:attempts` não cobre tentativas diferentes.
- `sent` = aceito pelo provedor, não "lido" nem "entregue": bounces posteriores exigiriam webhook (não implementado).
- **Retenção/LGPD pendente**: `communications` (e-mail, assunto, corpo) e `activity_log` não têm prazo de retenção nem rotina de anonimização/expurgo (ver migration 016); definir prazo e rotina é decisão de produto/jurídica. `communication_send_log` é apagado após 2 dias.
