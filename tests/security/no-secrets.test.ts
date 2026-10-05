import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

// Guarda estática: o front-end só pode conhecer a URL e a chave PUBLICÁVEL do Supabase. Nada de service_role,
// senha de banco ou arquivo de segredos no código que vai para o navegador (src/ e index.html) e os arquivos de
// segredo precisam estar no .gitignore. (Não lê Senha_BD.txt nem .env: só confere que estão ignorados.)

const ROOT = process.cwd();

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|css|html|json)$/.test(name)) out.push(full);
  }
  return out;
}

const clientFiles = [...walk(join(ROOT, 'src')), join(ROOT, 'index.html')];
// os próprios testes citam os padrões proibidos: ficam de fora (só olhamos o código do navegador)
const sources = clientFiles
  .filter((f) => !/\.test\.tsx?$/.test(f))
  .map((f) => ({ file: relative(ROOT, f).replace(/\\/g, '/'), text: readFileSync(f, 'utf8') }));

describe('segredos não vão para o código do navegador', () => {
  it('há arquivos para varrer (a varredura não está vazia)', () => {
    expect(sources.length).toBeGreaterThan(50);
  });

  it.each([
    ['service_role', /service[_-]?role/i],
    ['chave secreta do Supabase (sb_secret_)', /sb_secret_/],
    ['senha/arquivo de credencial do banco', /Senha_BD/i],
    ['string de conexão do Postgres', /postgres(ql)?:\/\/[^\s'"`]*:[^\s'"`]*@/i],
    ['JWT embutido (eyJ…)', /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
    ['variável de ambiente que não é VITE_', /process\.env\./],
    // envio de e-mail é server-side (Edge Function): nada do provedor/SMTP no navegador
    ['chave/variável do provedor de e-mail (RESEND)', /RESEND/],
    ['remetente fixo do servidor (MAIL_FROM)', /MAIL_FROM/],
    ['API do provedor de e-mail', /api\.resend\.com/i],
    ['SMTP', /smtp/i],
  ])('nenhum arquivo de src/ contém %s', (_name, pattern) => {
    const hits = sources.filter((s) => pattern.test(s.text)).map((s) => s.file);
    expect(hits).toEqual([]);
  });

  it('só lê as duas variáveis públicas do Vite (URL e chave publicável)', () => {
    const used = new Set<string>();
    for (const s of sources) {
      for (const m of s.text.matchAll(/import\.meta\.env\.([A-Z0-9_]+)/g)) used.add(m[1]);
    }
    const allowed = new Set(['VITE_SUPABASE_URL', 'VITE_SUPABASE_PUBLISHABLE_KEY', 'DEV', 'PROD', 'MODE', 'BASE_URL', 'SSR']);
    expect([...used].filter((v) => !allowed.has(v))).toEqual([]);
    expect(used.has('VITE_SUPABASE_URL')).toBe(true);
    expect(used.has('VITE_SUPABASE_PUBLISHABLE_KEY')).toBe(true);
  });

  it('.env, .env.* e Senha_BD.txt estão no .gitignore (e .env.example continua versionável)', () => {
    const lines = readFileSync(join(ROOT, '.gitignore'), 'utf8').split(/\r?\n/).map((l) => l.trim());
    expect(lines).toContain('.env');
    expect(lines).toContain('.env.*');
    expect(lines).toContain('Senha_BD.txt');
    expect(lines).toContain('!.env.example');
  });
});

// O bundle gerado por `npm run build` (dist/) é o que de fato chega ao navegador. Só roda quando o build existe
// (o `npm run build` do fluxo de qualidade vem antes de `npm test` no CI; sem dist/ é ignorado).
function walkDist(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walkDist(full, out);
    else if (/\.(js|css|html|json|map|svg)$/.test(name)) out.push(full);
  }
  return out;
}

describe.skipIf(!existsSync(join(ROOT, 'dist')))('segredos de e-mail não vão para o bundle (dist/)', () => {
  const files = existsSync(join(ROOT, 'dist')) ? walkDist(join(ROOT, 'dist')) : [];
  const dist = files.map((f) => ({ file: relative(ROOT, f).replaceAll('\\', '/'), text: readFileSync(f, 'utf8') }));

  it('há arquivos para varrer', () => {
    expect(dist.length).toBeGreaterThan(0);
  });

  it.each([
    ['RESEND', /RESEND/],
    ['MAIL_FROM', /MAIL_FROM/],
    ['service_role', /service[_-]?role/i],
    ['api.resend.com', /api\.resend\.com/i],
    ['smtp', /smtp/i],
    // (sb_secret_ fica de fora: o próprio supabase-js cita o prefixo ao RECUSAR chaves secretas no navegador)
  ])('nenhum arquivo de dist/ contém %s', (_name, pattern) => {
    expect(dist.filter((d) => pattern.test(d.text)).map((d) => d.file)).toEqual([]);
  });
});
