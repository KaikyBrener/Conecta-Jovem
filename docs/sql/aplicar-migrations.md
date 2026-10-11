# Aplicar as migrations pendentes no SQL Editor do Supabase

Quem executa: o responsável pelo projeto, no **SQL Editor** do painel. Nenhuma destas etapas é feita pelo CLI
(`db push`, `migration up` etc. são proibidos neste projeto).

## Antes de começar (obrigatório)

1. **Backup confirmado.** Sem um backup restaurável de hoje, **não aplique nada**. No banco, a única forma de voltar
   atrás é restaurar o backup.
2. **Verificação do estado atual.** Rode a **Seção A (Q1–Q9)** de [`verificacao-migrations.sql`](verificacao-migrations.sql).
   Todas precisam dar `falhas: 0`. Se alguma acusar problema, **pare**: aplicar 020/021/024 sobre um banco parcial pode
   piorar a situação. Traga o resultado.
3. Tenha o repositório na versão desta branch e abra cada arquivo de `supabase/migrations/` **inteiro**.

## Ordem de aplicação

| Ordem | Arquivo | O que faz | Observação |
|---|---|---|---|
| 1 | `020_series_idempotency_and_event_delete_guard.sql` | série idêntica é recusada; encontro com chamada não pode ser excluído | — |
| 2 | `021_anonymize_youth.sql` | RPC `anonymize_youth` (só coordenador, irreversível) | depende da 020 aplicada |
| 3 | `024_set_user_role_recheck_after_lock.sql` | `set_user_role` refaz a checagem depois do lock | depois da 021 |
| — | `023_cron_time_alerts.sql` | varredura diária por `pg_cron` (**opcional**) | **só depois** de habilitar `pg_cron` no painel (Database → Extensions). Sem a extensão, a função é criada e o agendamento é pulado com um aviso. |
| — | `022` | (retenção) | **ainda não existe**; nada a aplicar |

## Como aplicar cada uma

1. Cole o arquivo **inteiro** no SQL Editor (do cabeçalho até a última linha) e execute **uma única vez**.
2. Confira que terminou sem erro.
3. Só então passe para a próxima.

Depois das três (020, 021, 024), rode no SQL Editor:

```sql
NOTIFY pgrst, 'reload schema';
```

Isso faz o PostgREST enxergar a nova RPC `anonymize_youth` imediatamente. Não altera dados.

Em seguida rode a **Seção B (Q10)** de `verificacao-migrations.sql`. Esperado: `Q10 verificados: 11 | falhas: 0`.

Se você rodar a Q10 no meio do caminho, é normal ela acusar o que ainda não foi aplicado:

| Aplicado até | A Q10 deve acusar apenas |
|---|---|
| nada | itens de 020, 021 e 024 |
| 020 | itens de 021 e 024 |
| 021 | o marcador "Refaz a checagem" de `set_user_role` (024) |
| 024 | nada (`falhas: 0`) |

A 023, se e quando for aplicada, é conferida pelas **Q11 e Q12** (Seção C).

## Se uma migration falhar no meio

1. **Pare.** Não aplique a próxima.
2. **Não reexecute** o arquivo e não tente "consertar" rodando só um trecho.
3. Copie a **mensagem de erro inteira** (código e texto) e o nome do arquivo.
4. Rode a Seção A (Q1–Q9) e a Seção B (Q10) e guarde os resultados.
5. Traga tudo. A correção, se necessária, será uma **migration nova** só com o que falta.

**Por que não reexecutar:** as migrations do projeto não são idempotentes em geral (por exemplo, reaplicar a 004 ou a
005 regride policies). Lendo o SQL, a 020, a 021 e a 024 usam apenas `CREATE OR REPLACE FUNCTION`,
`DROP TRIGGER IF EXISTS`/`CREATE TRIGGER` e `REVOKE`/`GRANT`. Em tese seriam reexecutáveis, mas isso **não foi testado
no banco real**, e um erro no meio pode ter deixado o banco num estado que só a análise do erro esclarece.

## Depois de aplicar

- **Histórico do CLI:** registrar as versões aplicadas (`supabase migration repair --status applied ...`), seguindo
  [`../GO-LIVE.md`](../GO-LIVE.md). Isso só grava o histórico; não reaplica SQL.
- **Supabase falso do E2E:** não precisa de nada; ele já aplica todas as migrations do repositório.
