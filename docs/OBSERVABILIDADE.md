# Observabilidade e tratamento de erros

> **Status: implementado** (proposta aprovada e executada nesta fase; ver a seção 5 para o que mudou).

Escopo: como o ConectJovem trata erros hoje, o que está errado e o que vamos (e **não** vamos) fazer.
Sem plataforma externa de monitoramento: o objetivo é uma base local pequena, com um único ponto de
extensão para plugar uma ferramenta no futuro.

## 1. Auditoria (estado antes desta fase)

| # | Achado | Gravidade | Onde |
|---|---|---|---|
| 1 | `errorMessage()` devolve `error.message` **cru** do PostgREST/Postgres em ~34 pontos. O usuário vê textos em inglês e **detalhes internos**: nomes de constraints/índices/tabelas (`violates foreign key constraint "event_groups_group_id_fkey"`, `new row violates row-level security policy for table "groups"`), `JSON object requested, multiple (or no) rows returned`, `Failed to fetch` | **Alta** (vazamento de detalhes internos + UX) | `lib/format.ts` e todos os hooks |
| 2 | **Nenhum ErrorBoundary.** Um erro de renderização inesperado (ex.: dado `null` onde se esperava texto) deixa a tela **toda em branco**, sem explicação nem saída | **Alta** | `main.tsx`, `Layout` |
| 3 | Nenhuma captura global (`error`, `unhandledrejection`): erros fora do React somem | Média | `main.tsx` |
| 4 | Erros **engolidos**: `.catch(() => {})` ao carregar as opções do formulário de tarefa (jovens, grupos, responsáveis), grupos do filtro de Jovens, contadores do cabeçalho; contador de alertas do menu ignora o erro. Resultado: `<select>` vazio ou "0 aberta" **sem aviso** | Média | `useTasks`, `useYouth`, `useEvents`, `useGroups`, `useAlerts` |
| 5 | `console.error` imprime o **objeto de erro do Supabase inteiro** (inclui `details`/`hint`) no navegador | Média (informação interna no console de qualquer usuário) | `AuthContext` |
| 6 | Sem feedback de **sucesso** nas mutações: salvar chamada redireciona sem confirmar; criar/editar/excluir fecha o modal em silêncio; só Configurações tem banner de sucesso | Média (UX; o usuário duvida se salvou) | páginas |
| 7 | Não há identificador para correlacionar "deu erro aqui" com o que aconteceu | Baixa | — |
| 8 | Loading e estados vazios | **OK** — listas têm `LoadingBlock`/`EmptyState`, botões mostram "Salvando…", erros aparecem em `ErrorBanner`. Nada a mudar | — |
| 9 | Erros de autenticação | **OK** desde a Fase 5 — `translateAuthError`, sem texto cru | — |

## 2. Proposta

Princípios: (a) **mensagem ao usuário ≠ registro para diagnóstico** — o usuário recebe texto curto em pt-BR;
o detalhe técnico vai (sanitizado) para o log; (b) nunca expor stack, tokens, e-mails, `details`/`hint` do banco,
nomes de constraints; (c) um ponto único de extensão, sem dependência nova.

### 2.1 `lib/logger.ts` — registro estruturado e sanitizado
- `logError(context, err, extra?)` gera um registro `{ id, at, context, code, status, message }`.
- **Sanitização**: só `code`/`status`/`message` (truncada); descarta `details`, `hint`, stack; **redige** JWTs
  (`eyJ…`), e-mails e UUIDs de usuário na mensagem.
- Sai no `console.error` em uma linha (nada de objetos crus). `id` curto (8 chars) identifica o incidente.
- **Ponto de extensão**: `setErrorReporter(fn)`. Hoje o destino padrão é o console; para adotar Sentry/Logflare/etc.
  no futuro basta chamar `setErrorReporter` uma vez em `main.tsx` — nenhum call-site muda.
- Fora de escopo agora: envio remoto, persistência, painel.

### 2.2 `errorMessage()` passa a **traduzir e proteger**
- Mapeia códigos conhecidos para pt-BR: `23505` (duplicado), `23503` (item relacionado inexistente), `23514`/`22P02`
  (valor inválido), `42501` do RLS/privilégio (sem permissão), `PGRST301/JWT` (sessão expirada), `PGRST116`
  (não encontrado/sem permissão), 5xx (erro do servidor), falha de rede (sem conexão), schema/RPC ausente
  (`PGRST200/202`, `42P01`, `42703` → "o banco precisa ser atualizado": útil quando uma migration não foi aplicada).
- Mensagens **escritas por nós** (`RAISE EXCEPTION` em pt-BR com `P0001`/`P0002`, ou `42501` customizado, como
  "Não é possível remover o último coordenador.") continuam passando — são seguras e úteis.
- Qualquer outra coisa → o `fallback` do ponto de chamada ("Erro ao carregar grupos."). **Nunca** o texto cru.
- Cada chamada também registra o erro via `logError` (contexto = o `fallback`, que já descreve a operação).

### 2.3 Rede de segurança global
- `ErrorBoundary` na raiz (tela cheia: "Algo deu errado", recarregar) e **dentro do Layout** (a navegação
  continua funcionando; trocar de página limpa o erro). Mostra só o **código do incidente**, nunca mensagem/stack.
- `window.error` e `unhandledrejection` → `logError`.

### 2.4 Sem erro silencioso
- Falhas de carga de opções/contadores passam a aparecer (banner na página) e a ser registradas.

### 2.5 Feedback de sucesso
- `ToastProvider` pequeno (sem lib): `toast.success(...)`/`toast.error(...)`, `aria-live`, some sozinho, fica acima
  da barra inferior no mobile. Usado em: chamada salva, criar/editar/excluir (jovem, grupo, encontro, tarefa),
  mudança de status de tarefa/alerta, papel alterado.

### 2.6 Testes
- Unitários: sanitização do logger, mapeamento de `errorMessage`, redação de tokens/e-mails.
- E2E: mensagens amigáveis para 500/rede/RLS/duplicado/FK (sem texto técnico na tela), ErrorBoundary com dado
  corrompido, falha de carga de opções visível, toasts nos fluxos principais.

## 3. O que NÃO vamos fazer (e por quê)
- **Sentry/Datadog/LogRocket etc.**: custo, privacidade (dados de menores/igreja), dependência e configuração sem
  necessidade comprovada. O `setErrorReporter` deixa a porta aberta.
- **Tabela de logs no banco / Edge Function de ingestão**: exigiria migration, RLS e backend novos; sem demanda.
- **Telemetria de uso/analytics**: fora do escopo (observabilidade de erros, não de produto).
- **Retry automático de mutações**: risco de duplicar escrita; o usuário decide tentar de novo.

## 4. Convenção para quem desenvolve
- Em todo `catch`/`{ error }` use `errorMessage(err, 'Erro ao <fazer X>.')` para o que vai à tela — **nunca**
  `error.message`.
- Não escreva `.catch(() => {})`: mostre ao usuário (`setError`) ou, no mínimo, `logError`.
- Sucesso de mutação → `toast.success(...)`.
- Erros fatais de renderização são tratados pelo `ErrorBoundary`; não use `try/catch` em render.

## 5. O que foi implementado

| Proposta | Onde |
|---|---|
| Logger sanitizado + `setErrorReporter` | `src/lib/logger.ts` (testes: `src/lib/errors.test.ts`) |
| Tradução segura de erros | `src/lib/errors.ts`; `errorMessage()` em `src/lib/format.ts` |
| ErrorBoundary (raiz e Layout) + captura global | `src/components/ErrorBoundary.tsx`, `src/lib/globalErrors.ts`, `main.tsx`, `Layout.tsx` |
| Fim dos erros engolidos | `useTasks`, `useYouth` (aviso na tela); `useEvents`, `useGroups`, `useAlerts` (registro) |
| `console.error` cru do AuthContext | trocado por `logError` |
| Toasts de sucesso | `src/contexts/ToastContext.tsx` + páginas |
| Testes E2E | `tests/e2e/observability.spec.ts` |

Mudança de comportamento deliberada: o teste unitário que afirmava `errorMessage({message:'falhou'}) === 'falhou'`
codificava o vazamento e foi invertido; testes E2E que esperavam o texto cru do servidor passaram a esperar a mensagem amigável.

Pendências conhecidas (fora de escopo): destino remoto dos registros (só console), `flowType: 'pkce'` no Auth, CSP.
