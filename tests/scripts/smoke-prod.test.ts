import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { runSmoke } from '../../scripts/smoke-prod.mjs';

// Servidor HTTP LOCAL (127.0.0.1, porta aleatória) que imita o host; nada sai da máquina.
const APP_HTML = `<!doctype html><html><head><meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; connect-src 'self' https://x.supabase.co" />
</head><body><div id="root"></div></body></html>`;

const SECURITY_HEADERS = {
  'strict-transport-security': 'max-age=31536000; includeSubDomains',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'content-security-policy': "frame-ancestors 'none'",
};

let server: Server | null = null;
const seen: { method: string; headers: IncomingHttpHeaders }[] = [];

async function serve(handler: (path: string) => { status: number; headers?: Record<string, string>; body: string }) {
  server = createServer((req, res) => {
    seen.push({ method: req.method ?? '', headers: req.headers });
    const r = handler(req.url ?? '/');
    res.writeHead(r.status, { 'content-type': 'text/html; charset=utf-8', ...r.headers });
    res.end(r.body);
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  return `http://127.0.0.1:${port}`;
}

afterEach(async () => {
  seen.length = 0;
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = null;
});

const byItem = (rs: { item: string; ok: boolean }[]) => Object.fromEntries(rs.map((r) => [r.item, r.ok]));

describe('scripts/smoke-prod.mjs', () => {
  it('host bem configurado: todos os itens OK (exceto HTTPS, porque o servidor de teste é http local)', async () => {
    const url = await serve(() => ({ status: 200, headers: SECURITY_HEADERS, body: APP_HTML }));
    const rs = await runSmoke(url);
    const failed = rs.filter((r) => !r.ok).map((r) => r.item);
    expect(failed).toEqual(['URL usa HTTPS']);
    expect(rs).toHaveLength(9);
  });

  it('host mal configurado: aponta cada problema (sem headers, sem fallback de SPA, sem meta CSP, localhost no HTML)', async () => {
    const url = await serve((path) => path === '/'
      ? { status: 200, body: '<html><body><div id="root"></div><script src="http://localhost:54321/x.js"></script></body></html>' }
      : { status: 404, body: 'Not Found' });
    const ok = byItem(await runSmoke(url));
    expect(ok['GET / responde 200 com o app']).toBe(true);
    expect(ok['GET /jovens responde 200 com o app (fallback de SPA)']).toBe(false);
    expect(ok['Header Strict-Transport-Security']).toBe(false);
    expect(ok['Header X-Content-Type-Options: nosniff']).toBe(false);
    expect(ok['Header Referrer-Policy']).toBe(false);
    expect(ok['Proteção contra iframe (frame-ancestors ou X-Frame-Options)']).toBe(false);
    expect(ok['Meta Content-Security-Policy no HTML']).toBe(false);
    expect(ok['HTML sem "localhost" nem "127.0.0.1"']).toBe(false);
  });

  it('X-Frame-Options sozinho também conta como proteção contra iframe', async () => {
    const url = await serve(() => ({ status: 200, headers: { 'x-frame-options': 'DENY' }, body: APP_HTML }));
    expect(byItem(await runSmoke(url))['Proteção contra iframe (frame-ancestors ou X-Frame-Options)']).toBe(true);
  });

  it('só faz GET e não envia credenciais (sem Authorization, Cookie nem apikey)', async () => {
    const url = await serve(() => ({ status: 200, headers: SECURITY_HEADERS, body: APP_HTML }));
    await runSmoke(url);
    expect(seen.length).toBeGreaterThanOrEqual(2);
    for (const r of seen) {
      expect(r.method).toBe('GET');
      expect(r.headers.authorization).toBeUndefined();
      expect(r.headers.cookie).toBeUndefined();
      expect(r.headers.apikey).toBeUndefined();
    }
  });

  it('servidor fora do ar: FALHA clara, sem exceção', async () => {
    const url = await serve(() => ({ status: 200, body: APP_HTML }));
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
    const rs = await runSmoke(url);
    expect(rs.at(-1)).toMatchObject({ item: 'GET / responde', ok: false });
  });
});
