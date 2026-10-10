# Retenção de dados — PROPOSTA (nada implementado)

> Somente proposta. **Nenhuma migration foi criada.** Prazos, gatilhos e aprovações são decisões da organização e do
> jurídico. Este documento não afirma conformidade com a LGPD: descreve opções e o que cada uma faria no sistema.

## Situação atual (fatos do código)

| Dado | O que acontece hoje |
|---|---|
| `communications` | Guardado para sempre. O coordenador só pode excluir `draft` e `cancelled` (policy `coordinator_delete_communications`). `sent`/`failed` ficam com e-mail e nome do destinatário, assunto e corpo. |
| `communication_send_log` | Linhas com mais de 2 dias são apagadas **dentro** de `begin_communication_send` (019, linha 150). Ou seja, a limpeza só acontece quando alguém envia um e-mail; sem envios, linhas antigas ficam. Conteúdo: usuário, horário e id da comunicação. |
| `activity_log` | Guardado para sempre. O trigger `activity_log_immutable` bloqueia UPDATE/DELETE só para `anon`/`authenticated`; uma função do banco (dono `postgres`) consegue apagar. Guarda `actor_name` (cópia do nome do líder ou coordenador), `youth_id`, `group_id`, um resumo curto e `meta`. |
| Jovens inativos | Desativação lógica (`is_active = false`). Todos os dados pessoais permanecem. A anonimização manual é a RPC `anonymize_youth` (migration 021, **escrita mas ainda não aplicada** no banco real e **sem botão na interface**). |
| Backups do Supabase | Mantidos conforme o plano do projeto. Um expurgo no banco **não** apaga cópias em backup até que expirem. Confirmar o prazo no painel. |

## Opções por tabela

### 1. `communications` (e-mails)

| Opção | Como | Prós | Contras |
|---|---|---|---|
| A. Expurgo total | `DELETE` de `sent`/`failed`/`cancelled` com mais de **N meses** | Simples; remove todo o conteúdo pessoal | Perde o histórico de que houve contato; `activity_log` fica com `entity_id` órfão (não há FK) |
| B. Anonimizar o conteúdo | Após **N meses**: zerar `subject`, `body`, `recipient_name`; trocar `recipient_email` por um endereço fixo de marcação; manter `status`, datas, `youth_id`, `provider_message_id` | Mantém a estatística "quantos contatos e quando" | `recipient_email` é `NOT NULL` com `CHECK is_valid_email`: exige um endereço reservado ou uma mudança de constraint na migration. O guard `communications_guard` bloqueia edição de `sent`, então a rotina precisa de uma exceção controlada. |
| C. Apenas rascunhos | Apagar `draft`/`cancelled` com mais de **N meses** | Baixo risco | Não resolve o conteúdo dos enviados |

**Nunca** tocar em `sending`, que é envio em andamento.

### 2. `communication_send_log`

| Opção | Prós | Contras |
|---|---|---|
| A. Manter como está (limpa a cada envio) | Zero trabalho | Linhas antigas ficam se não houver envios |
| B. Limpeza agendada diária (> 2 dias) | Prazo garantido | Depende de agendamento (`pg_cron`, disponibilidade a confirmar) ou de chamada manual |

### 3. `activity_log`

| Opção | Como | Prós | Contras |
|---|---|---|---|
| A. Expurgo | `DELETE` com mais de **N meses** | Simples | Perde a auditoria antiga ("quem fez o quê") |
| B. Pseudonimizar | Após **N meses**: `actor_name = NULL`, `youth_id = NULL`, `meta = '{}'`, mantendo ação, data e grupo | Mantém contagens por grupo e período | A auditoria individual se perde; exige UPDATE por função do banco |
| C. Seguir o jovem | Quando o jovem for anonimizado, aplicar B só nas linhas dele | Coerente com a ficha anonimizada | Depende da 021 e da revisão do que ela já faz |

### 4. Jovens inativos

| Opção | Como | Prós | Contras |
|---|---|---|---|
| A. Só manual | O coordenador anonimiza caso a caso (RPC da 021) | Decisão humana em cada caso | Esquecimento; nada acontece sozinho |
| B. Lista de revisão | Tela ou relatório "inativos há mais de **N meses**" para o coordenador decidir | Equilíbrio entre controle e lembrete | Ainda depende de alguém agir |
| C. Automático | Anonimizar inativos há mais de **N meses** via agendamento | Prazo garantido | Irreversível sem revisão; risco de anonimizar quem iria voltar |

**Impacto nas estatísticas** (vale para A, B e C, se a 021 mantiver presença e grupo):
- **Mantidas:** frequência por grupo e por período.
- **Perdidas:** o relatório individual e os textos de acompanhamento, alertas, tarefas e e-mails desse jovem.

## Execução: como rodaria

- **Agendado:** `pg_cron` diário, com a extensão a confirmar no projeto, ou uma Edge Function agendada.
- **Manual:** RPC só para coordenador ("executar retenção agora").
- **Em qualquer caso:**
  - função `SECURITY DEFINER` com `search_path` fixo, sem EXECUTE para `anon`;
  - registro de quantas linhas foram afetadas;
  - testes no PGlite antes de aplicar.

## Perguntas para implementar a migration 022

1. **Prazo de `communications`:** quantos meses para enviados/falhos? E para rascunhos/cancelados?
2. **Modo de `communications`:** expurgo total (A) ou anonimização do conteúdo (B)? Se B, qual endereço de marcação usar em `recipient_email`, ou podemos permitir `NULL` após anonimização?
3. **Prazo de `activity_log`:** quantos meses de auditoria? Expurgar (A) ou pseudonimizar (B)?
4. **Jovens inativos:** manual (A), lista de revisão (B) ou automático (C)? Se B ou C, inativo há quantos meses?
5. **Aprovação:** quem aprova uma anonimização ou expurgo? Basta o coordenador ou precisa de um segundo responsável?
6. **Gatilho:** agendamento automático (`pg_cron` disponível no projeto?) ou execução manual por coordenador?
7. **Comprovação:** a organização precisa de um registro de que a retenção rodou (data e quantidade)? Onde guardar sem reter o dado apagado?
8. **Backups:** o prazo de backup do plano Supabase é aceitável, dado que dados expurgados continuam nele até expirar?
9. **Contas da equipe:** líder que sai da organização — desativar no Auth, e o que fazer com o nome dele em `activity_log`?
10. **Anonimização (021):** ela já limpa os textos de tarefas, acompanhamentos, alertas e e-mails do jovem (revisão feita: sem coluna de texto ligada por id ficando de fora). A 022 deve também registrar o ato (marca "anonimizado" e linha no histórico) e tratar os rascunhos anonimizados? Ver `docs/PRIVACIDADE.md`, seção 6.
