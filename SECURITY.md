# Política de segurança

O ConectJovem trata dados pessoais de jovens, inclusive menores de idade. Levamos a segurança a sério.

## Como reportar uma vulnerabilidade

**Não abra uma issue pública** para falhas de segurança.

Use o relato privado do GitHub: na aba **Security** do repositório, clique em **Report a vulnerability**.

Inclua, se possível:
- o que foi encontrado e onde (tela, rota ou função);
- como reproduzir, em passos curtos;
- o impacto que você enxerga (por exemplo, acesso a dados de outro grupo).

**Nunca inclua dados pessoais reais** no relato (nomes, telefones, e-mails de jovens). Use dados fictícios ou descreva o caso sem eles.

## O que acontece depois

- Você recebe a confirmação de que o relato foi lido.
- A falha é avaliada, corrigida e publicada em produção antes de qualquer divulgação.
- Se você quiser, o seu nome pode ser citado como quem encontrou a falha.

## Escopo

Dentro do escopo: o aplicativo em `conectjovem.com.br`, as regras de acesso do banco (RLS e RPCs) e a Edge Function de envio de e-mail.

Fora do escopo: ataques de negação de serviço, engenharia social, falhas em serviços de terceiros (Supabase, Cloudflare, Resend) sem relação com a nossa configuração, e testes que acessem dados reais de pessoas.

## Boas práticas do projeto

- Nenhum segredo vai para o repositório; o frontend usa só a chave *publishable* do Supabase.
- Toda tabela tem Row Level Security com políticas explícitas por papel.
- O envio de e-mail acontece só no servidor, com limites por usuário.
