# Autenticação e e-mails do Auth — configuração manual

Este checklist é feito **à mão**, pelo responsável, nos painéis do Supabase, do Resend e da Cloudflare. Nada aqui é
automatizável pelo repositório (`supabase config push` é proibido neste projeto) e nada é executado pelo assistente.

**Nunca cole chaves, senhas ou tokens** em chat, issue, commit ou neste arquivo. Cite só o **nome** do segredo.

Escopo: os e-mails do **Supabase Auth** (redefinição de senha, convite, avisos de segurança). Os e-mails de
comunicação com os jovens saem por outro caminho, a Edge Function `send-communication`: ver [`EMAIL.md`](EMAIL.md).

Os nomes de menus do painel do Supabase mudam com o tempo; se um item não estiver onde este arquivo diz, procure pelo
nome dentro de **Authentication**.

---

## 1. URLs (Authentication → URL Configuration)

- [ ] **Site URL** = `https://conectjovem.com.br`
- [ ] **Redirect URLs** (uma por linha):
  - `https://conectjovem.com.br/**`
  - `http://localhost:5173/**` (desenvolvimento)

O app pede a redefinição com `redirectTo = <origem atual>/redefinir-senha` (`window.location.origin`, sem URL fixa).
Se a origem não estiver nas Redirect URLs, o Supabase ignora o `redirectTo` e manda o link para a **Site URL**.

## 2. Domínio de envio no Resend

- [ ] Domínio `conectjovem.com.br` adicionado no Resend e com status **Verified**.
- [ ] Registros **SPF** e **DKIM** publicados no DNS (Cloudflare), copiados do painel do Resend sem alterar.
- [ ] **DMARC** publicado (`_dmarc.conectjovem.com.br`), no mínimo `v=DMARC1; p=none`.

Sem domínio verificado, o Resend só entrega para o dono da conta e o Auth devolve erro 500 ao pedir a redefinição.

## 3. SMTP personalizado (Authentication → Emails → SMTP Settings)

- [ ] **Enable custom SMTP**: ligado.

| Campo | Valor |
|---|---|
| Sender email | `avisos@conectjovem.com.br` |
| Sender name | `ConectJovem` |
| Host | `smtp.resend.com` |
| Port | `465` |
| Username | `resend` |
| Password | a chave de API do Resend (**não escreva aqui**; é o mesmo tipo de valor do secret `RESEND_API_KEY`) |
| Minimum interval between emails | `60` segundos |

- [ ] Recomendado: uma chave do Resend **só para o SMTP do Auth**, com permissão apenas de envio. Assim ela pode ser
      trocada sem afetar a Edge Function.
- [ ] Depois de salvar, conferir em Authentication → Rate Limits o limite de e-mails por hora (com SMTP próprio ele
      deixa de ser o limite baixo do envio padrão do Supabase).

## 4. Templates em português (Authentication → Emails)

Aba **Templates** (e-mails de autenticação):

| Template | Usar? | Observação |
|---|---|---|
| Reset password | **Sim** | traduzir; é o e-mail do "Esqueci minha senha" |
| Invite user | **Sim** | traduzir; é como os usuários são criados (convite pelo painel) |
| Confirm sign up | Não se aplica | o cadastro aberto está desligado; pode ficar no padrão |
| Magic link | Não se aplica | o app só usa e-mail + senha |
| Change email address | Traduzir | só é enviado se alguém trocar o e-mail pelo painel |
| Reauthentication | Não se aplica | o app não pede reautenticação por código |

Avisos de segurança (aba de notificações de segurança, quando existir no painel):

| Aviso | Ativar? |
|---|---|
| Password changed | **Sim** |
| Email address changed | **Sim** |
| MFA (fator adicionado/removido) | **Só se o MFA for ativado** |
| Demais (telefone, identidade vinculada) | Não se aplica |

Em todos os templates: manter as variáveis do Supabase como estão (por exemplo `{{ .ConfirmationURL }}`); mudar só o
texto. O nome do sistema é **ConectJovem**.

## 5. Proteções recomendadas

- [ ] **Cadastro aberto desligado** (Authentication → Sign In / Providers → "Allow new users to sign up" = off).
- [ ] **Senha mínima 10** (o app valida 10 na tela; ver `src/lib/passwordPolicy.ts`).
- [ ] **Limites de tentativas** (Authentication → Rate Limits): revisar os limites de login, de e-mails enviados e de
      verificação de token. Não aumentar sem necessidade.
- [ ] **CAPTCHA (Cloudflare Turnstile)** em Authentication → Attack Protection. **Não ligar ainda:** o app não envia
      o token do CAPTCHA. Ligar no painel sem a mudança no app **quebra o login e a redefinição**. Exige uma tarefa
      própria (widget no front-end e ajuste da CSP).
- [ ] **MFA para coordenadores**: também exige telas novas no app. Decidir antes de ativar no painel.

## 6. Como testar

1. Abrir `https://conectjovem.com.br/login` → **Esqueci minha senha** → informar o e-mail de um usuário de teste.
2. A tela mostra "Se o e-mail estiver cadastrado, você receberá um link em instantes." (a mesma resposta para e-mail
   inexistente, de propósito).
3. O e-mail chega (conferir o spam), com remetente `ConectJovem <avisos@conectjovem.com.br>` e texto em português.
4. O link abre `https://conectjovem.com.br/redefinir-senha` (no domínio de produção, não em `localhost` nem no domínio
   `*.workers.dev`).
5. Definir uma senha de 10+ caracteres → o app entra.
6. Abrir o **mesmo** link de novo → tela "Link inválido ou expirado" com o botão **Pedir novo link**.
7. Conferir os registros:
   - **Resend → Logs / Emails**: o envio aparece como entregue (`delivered`).
   - **Supabase → Logs → Auth**: o pedido em `/recover` aparece com status 200.

## 7. Sintoma → causa provável

| Sintoma | Causa provável | Onde olhar |
|---|---|---|
| Tela mostra "Não foi possível enviar o e-mail agora. Aguarde um minuto e tente novamente." | o Auth respondeu 500 em `/recover`: SMTP errado (host, porta, usuário, chave revogada) ou remetente em domínio não verificado | Supabase → Logs → Auth; Resend → Logs |
| Tela mostra "Muitas tentativas. Aguarde um pouco." ou "aguarde N segundos" | limite de envio (intervalo mínimo de 60 s por usuário ou limite por hora) | Authentication → Rate Limits |
| A tela confirma, mas o e-mail não chega | o e-mail não está cadastrado (a resposta é neutra de propósito); ou caiu no spam; ou domínio sem SPF/DKIM | Authentication → Users; Resend → Logs; DNS |
| O link abre `localhost` ou outro domínio | Site URL errada, ou a origem não está nas Redirect URLs | Authentication → URL Configuration |
| O link abre "Link inválido ou expirado" na primeira vez | o link já foi aberto antes (alguns leitores de e-mail e antivírus abrem o link sozinhos), ou expirou | pedir novo link; Supabase → Logs → Auth |
| E-mail chega em inglês | template não traduzido | Authentication → Emails → Templates |
| Remetente aparece como `noreply@mail.app.supabase.io` | SMTP personalizado desligado | Authentication → Emails → SMTP Settings |
| Login mostra "E-mail ou senha incorretos." para um usuário que existe | senha errada, ou o usuário nunca definiu senha (convite não concluído) | Authentication → Users |
| Login e redefinição falham logo após ligar o CAPTCHA | o app não envia o token do CAPTCHA | desligar o CAPTCHA no painel (seção 5) |

## 8. O que o app já faz (sem configuração)

- `redirectTo` da redefinição usa a origem atual do navegador.
- A resposta do pedido de redefinição é a mesma exista ou não a conta.
- "E-mail ou senha incorretos." é a mesma mensagem para e-mail inexistente e para senha errada.
- Erros do Auth nunca aparecem crus na tela; o registro no console é sanitizado (sem e-mail, token ou id).
