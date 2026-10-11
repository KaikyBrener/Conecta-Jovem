#!/usr/bin/env node
// Smoke test do site publicado: `npm run smoke -- https://SEU-DOMINIO`
// Só faz requisições GET, sem cookies, tokens ou credenciais, e sem dependências (fetch do Node).
// Verifica: 200 em / e numa rota profunda (/jovens, fallback de SPA), headers de segurança do host,
// meta Content-Security-Policy no HTML e ausência de "localhost"/"127.0.0.1" no HTML.
import { pathToFileURL } from 'node:url';

const TIMEOUT_MS = 15_000;
const DEEP_ROUTE = '/jovens';

async function get(url) {
  const res = await fetch(url, {
    method: 'GET',
    redirect: 'follow',
    headers: { accept: 'text/html', 'user-agent': 'conecta-jovem-smoke/1' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  return { status: res.status, headers: res.headers, body: await res.text(), url: res.url };
}

const isAppHtml = (html) => /<div[^>]+id=["']root["']/i.test(html);

/** @returns {Promise<{ item: string; ok: boolean; detail: string }[]>} */
export async function runSmoke(baseUrl) {
  const origin = new URL(baseUrl).origin;
  const results = [];
  const add = (item, ok, detail) => results.push({ item, ok, detail });

  add('URL usa HTTPS', origin.startsWith('https://'), origin);

  let root;
  try {
    root = await get(`${origin}/`);
  } catch (err) {
    add('GET / responde', false, `sem resposta: ${err?.name ?? 'erro'} ${err?.message ?? ''}`.trim());
    return results;
  }
  add('GET / responde 200 com o app', root.status === 200 && isAppHtml(root.body), `status ${root.status}`);

  try {
    const deep = await get(`${origin}${DEEP_ROUTE}`);
    add(`GET ${DEEP_ROUTE} responde 200 com o app (fallback de SPA)`, deep.status === 200 && isAppHtml(deep.body),
      `status ${deep.status}${deep.status === 200 && !isAppHtml(deep.body) ? ', mas o HTML não é o do app' : ''}`);
  } catch (err) {
    add(`GET ${DEEP_ROUTE} responde (fallback de SPA)`, false, `sem resposta: ${err?.message ?? 'erro'}`);
  }

  const h = root.headers;
  const hsts = h.get('strict-transport-security') ?? '';
  add('Header Strict-Transport-Security', /max-age=\d+/i.test(hsts), hsts || 'ausente');

  const nosniff = h.get('x-content-type-options') ?? '';
  add('Header X-Content-Type-Options: nosniff', nosniff.trim().toLowerCase() === 'nosniff', nosniff || 'ausente');

  const referrer = h.get('referrer-policy') ?? '';
  add('Header Referrer-Policy', referrer.trim() !== '', referrer || 'ausente');

  const cspHeader = h.get('content-security-policy') ?? '';
  const xfo = h.get('x-frame-options') ?? '';
  add('Proteção contra iframe (frame-ancestors ou X-Frame-Options)', /frame-ancestors/i.test(cspHeader) || xfo.trim() !== '',
    [cspHeader && `CSP: ${cspHeader}`, xfo && `X-Frame-Options: ${xfo}`].filter(Boolean).join(' | ') || 'ausente');

  add('Meta Content-Security-Policy no HTML',
    /<meta[^>]+http-equiv=["']Content-Security-Policy["'][^>]*>/i.test(root.body),
    'injetada pelo build (vite.config.ts)');

  const local = /localhost|127\.0\.0\.1/i.exec(root.body);
  add('HTML sem "localhost" nem "127.0.0.1"', !local, local ? `encontrado: ${local[0]}` : 'ok');

  return results;
}

async function main() {
  const arg = process.argv[2];
  let url;
  try {
    url = new URL(arg ?? '');
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('protocolo');
  } catch {
    console.error('Uso: npm run smoke -- https://SEU-DOMINIO');
    process.exitCode = 2;
    return;
  }
  console.log(`Smoke test (só GET, sem credenciais): ${url.origin}\n`);
  const results = await runSmoke(url.href);
  for (const r of results) console.log(`${r.ok ? 'OK   ' : 'FALHA'}  ${r.item} — ${r.detail}`);
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} OK${failed ? `, ${failed} FALHA(S)` : ''}`);
  // exitCode (e não process.exit): no Windows, sair à força com conexões do fetch fechando aborta o Node.
  process.exitCode = failed ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
