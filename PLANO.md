# Plano Técnico: Conecta Jovem (Base)

## 1. Stack Tecnológico
- **Frontend:** React + TypeScript, build via Vite.
- **Estilização:** Tailwind CSS (mobile-first).
- **Roteamento:** React Router v6.
- **Backend/DB/Auth:** Supabase.

## 2. Estrutura de Pastas Inicial
```text
src/
 ┣ components/      # Componentes genéricos (Layout, Botões, Inputs)
 ┣ contexts/        # AuthContext para estado global do usuário
 ┣ lib/             # Cliente do Supabase e utilitários
 ┣ pages/           # Telas (Login, Dashboard)
 ┣ types/           # Tipagens do TypeScript para o DB
 ┣ App.tsx          # Configuração de rotas
 ┗ main.tsx         # Ponto de entrada
```

## 3. Configuração do Banco (Supabase) e RLS
- **Tabela `profiles`**:
  - `id` (uuid, referência a auth.users)
  - `full_name` (text)
  - `role` (enum: 'coordinator', 'leader')
  - `created_at` (timestamp)
- **RLS (Row Level Security)**:
  - Usuários só podem ver e editar o próprio profile.
  - No futuro: Regras específicas onde coordenadores vêem tudo e líderes vêem apenas seus grupos.

## 4. Etapas de Implementação (Automáticas)
1. Inicializar Vite + React + TS.
2. Instalar e configurar Tailwind CSS, React Router e Supabase JS.
3. Criar estrutura base (Layout responsivo com menu lateral/bottom tab).
4. Implementar Autenticação (Login via e-mail e logout).
5. Criar rotas protegidas (Protected Route Wrapper).
6. Gerar `.env.example` e documentação básica no `README.md`.
