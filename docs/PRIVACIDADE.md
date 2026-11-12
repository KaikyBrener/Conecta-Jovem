# Aviso de privacidade — ConectJovem

> **RASCUNHO — validar com jurídico/responsável antes de publicar.**
> Este texto descreve o que o sistema trata e permite, a partir do código e das migrations. Ele **não** define base legal,
> prazos de guarda nem forma de consentimento, e **não** afirma conformidade com a LGPD. Tudo marcado com `[DEFINIR]`
> é decisão da organização.

## 1. Quem é o controlador

- Organização responsável: `[DEFINIR: nome da organização]`
- Encarregado (DPO) ou responsável pelo tratamento: `[DEFINIR: nome]`
- Canal de contato do titular: `[DEFINIR: e-mail ou formulário]`

## 2. Para que os dados são usados

Pelo que o sistema faz hoje:

- Cadastro e organização dos jovens em grupos.
- Registro de presença em encontros.
- Alertas de faltas e queda de frequência, para que a liderança procure o jovem.
- Acompanhamentos e tarefas de cuidado pastoral/acompanhamento.
- Relatórios agregados por grupo e período.
- Envio manual de e-mails individuais a um jovem ou contato, por clique de um líder ou coordenador.

A base legal de cada finalidade: `[DEFINIR com jurídico]`.

## 3. Quais dados são tratados

### Jovens (podem ser crianças ou adolescentes)

| Categoria | Campos no sistema |
|---|---|
| Identificação | nome, data de nascimento, gênero |
| Contato | telefone, e-mail, endereço |
| Observações livres | `youth.notes` (texto livre escrito pela liderança) |
| Participação | grupo, ativo/inativo, presença e falta por encontro |
| Acompanhamento | alertas e notas de resolução; acompanhamentos (motivo, notas, próxima ação); transferências de responsável (motivo); tarefas ligadas ao jovem (título, descrição) |
| Comunicações | e-mail e nome do destinatário, assunto, corpo, situação do envio, identificador da mensagem no provedor |

- **Dados de menores:** o cadastro aceita data de nascimento sem idade mínima, então é provável que haja menores de idade. A forma de consentimento ou autorização dos pais ou responsáveis é `[DEFINIR com jurídico]`. O sistema **não** registra hoje nenhum consentimento.
- **Textos livres:** observações, notas e corpo de e-mail podem conter informações sensíveis (por exemplo, sobre saúde ou religião) se a liderança as escrever. A orientação sobre o que pode ser escrito ali é `[DEFINIR]`.

### Equipe (coordenadores e líderes)

| Categoria | Campos no sistema |
|---|---|
| Conta | e-mail e senha (gerenciados pelo Supabase Auth; a senha não é visível ao app) |
| Perfil | nome, papel (coordenador/líder) |
| Autoria | quem registrou presença, criou tarefas e acompanhamentos, enviou e-mails; histórico de atividades com uma cópia do nome no momento da ação |
| Controle de envio | registro de tentativas de envio de e-mail (usuário e horário), apagado após cerca de 2 dias |

## 4. Com quem os dados são compartilhados (operadores)

| Operador | Uso | Observação |
|---|---|---|
| Supabase | banco de dados, autenticação e função de envio de e-mail | região do projeto: `[DEFINIR: conferir no painel]` |
| Resend | entrega dos e-mails enviados pelo app (destinatário, assunto e corpo) | **transferência internacional para os EUA** (confirmar no contrato/termos do Resend) |
| Hospedagem do site | entrega dos arquivos do app (Cloudflare Workers, arquivos estáticos; o site não grava dado pessoal) | `[DEFINIR: conferir contrato e região no painel da Cloudflare]` |

Os operadores podem manter logs técnicos e backups conforme as políticas deles. Os prazos devem ser conferidos nos contratos e no painel de cada um.

## 5. Direitos do titular e o que o sistema permite hoje

| Direito | O que o sistema permite hoje |
|---|---|
| Confirmação e acesso | o coordenador vê a ficha e o relatório individual do jovem (com exportação). Não há área de acesso direto para o próprio jovem. |
| Correção | coordenador e líder do grupo editam a ficha |
| Anonimização ou eliminação | a RPC `anonymize_youth` (migration 021, só coordenador, **irreversível**) apaga os dados pessoais do jovem e o texto residual em presença, alertas, tarefas, acompanhamentos e e-mails, mantendo id, grupo e estatísticas. É feita **pela tela do coordenador**: ficha do jovem → "Anonimizar dados", com aviso de irreversível e confirmação digitando o nome do jovem; líderes não veem a ação. Só funciona se a migration 021 estiver **aplicada no banco real** (conferir com a consulta Q10 de `docs/sql/verificacao-migrations.sql`); sem ela, só existe a desativação. Limites na seção 6. |
| Portabilidade | só pela exportação do relatório individual (CSV/PDF). Formato e suficiência: `[DEFINIR]` |
| Informação sobre compartilhamento | seção 4 deste aviso |
| Revogação de consentimento | sem registro de consentimento no sistema. Ver seção 3. |

- **Pedidos:** o titular ou responsável deve usar o canal `[DEFINIR]`.
- **Prazo de resposta:** `[DEFINIR]`.

## 6. Limitações conhecidas e decisões de produto pendentes

Sobre a anonimização (`anonymize_youth`). Os itens 2 e 3 foram tratados na migration 025; o que resta em cada linha é ponto a decidir.

| # | Limitação | Situação |
|---|---|---|
| 1 | **Texto que cita o jovem fora das tabelas ligadas a ele não é alcançado.** A função limpa tudo que está ligado ao jovem por id (ficha, presença, alertas, tarefas, acompanhamentos, e-mails). Mas um nome digitado em título/descrição de encontro, descrição de grupo ou anotação de **outro** jovem não tem ligação por id e permanece. | Limite técnico inevitável. Orientar a equipe a não escrever dados pessoais de um jovem em registros de outros: `[DEFINIR]` |
| 2 | **Marca de "anonimizado" e registro do ato.** A migration 025 grava no cadastro quando e por quem o jovem foi anonimizado (`anonymized_at`/`anonymized_by`, que nem o coordenador altera pela API) e gera uma linha "Dados anonimizados" no histórico de atividades, com autor e horário. A ficha mostra a data e, para o coordenador, o responsável. Jovens anonimizados **antes** da 025 ficam sem marca (o banco não tinha esse registro). | **Implementado** (exige a 025 aplicada no banco real: consulta Q13). O prazo de guarda desse registro segue a decisão de retenção: `[DEFINIR]` |
| 3 | **Rascunhos e envios com falha do jovem anonimizado.** Com a 025, a anonimização os cancela: não podem mais ser enviados, reabertos nem editados (o servidor recusa). E-mails já enviados continuam como enviados, com o conteúdo substituído. Ao ser aplicada, a 025 cancela também os rascunhos e falhas de quem foi anonimizado antes dela. Criar um e-mail **novo** para um jovem já anonimizado continua possível para o coordenador. | **Implementado** o cancelamento (exige a 025). Bloquear e-mails novos para jovem anonimizado: decisão de produto pendente, **não implementado** |
| 4 | **Cópias fora do banco:** backups do Supabase até expirarem, e-mails já entregues e o painel do Resend. | Fora do alcance do sistema. Prazos: `[DEFINIR]` |

Cada item acima depende da organização e do jurídico; este documento não define prazo, base legal nem consentimento.

## 7. Retenção

Não há rotina automática de expurgo, exceto a limpeza do registro de tentativas de envio (cerca de 2 dias). A proposta está em `docs/RETENCAO.md` e depende de decisão da organização.

## 8. Segurança (resumo factual)

- **Acesso aos dados:** controlado no banco por papel (RLS). O líder só vê os jovens dos próprios grupos.
- **Envio de e-mail:** feito no servidor. Nenhuma chave fica no navegador.
- **Cadastro de contas:** feito só pelo painel; o cadastro aberto deve estar desligado (ação manual).

---
*Última revisão deste rascunho:* `[DEFINIR data]`
