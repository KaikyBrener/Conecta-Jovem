// Backend Supabase local para os testes E2E: sobe um Postgres real em memória (PGlite)
// com TODAS as migrations do projeto e expõe a mesma API HTTP que o frontend consome
// (GoTrue em /auth/v1 e PostgREST em /rest/v1). Nenhum dado real é tocado.
//
// Rodado pelo Playwright (webServer). Endpoints de controle, só para testes:
//   GET  /__test/health
//   POST /__test/reset                      limpa os dados (mantém schema e app_settings)
//   POST /__test/users {email,password,fullName,role}
//   POST /__test/sql   {sql,params}         executa como superusuário e devolve as linhas
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHmac, randomUUID } from 'node:crypto';
import { createTestDb, type Role } from '../../db/harness.ts';
import { handleRest, loadCatalog, type HttpResult } from './postgrest.ts';
import { ANON_KEY, APP_URL, CONTROL_TOKEN, FAKE_SUPABASE_PORT } from '../env.ts';

const PORT = FAKE_SUPABASE_PORT;
const JWT_SECRET = 'e2e-only-secret';
const TOKEN_TTL_SECONDS = 3600;

const { db } = await createTestDb();
await db.exec(`SET TIME ZONE 'UTC'`); // como no Supabase: timestamptz serializado em UTC
const catalog = await loadCatalog(db);

// Senhas ficam só em memória (auth.users do stub não tem coluna de senha).
const passwords = new Map<string, string>(); // email -> senha
const refreshTokens = new Map<string, string>(); // refresh_token -> user id
const recoverRequests: { email: string; redirectTo: string | null }[] = []; // pedidos de /recover (para os testes)

// PGlite tem uma única conexão: serializa tudo que toca o banco.
let queue: Promise<unknown> = Promise.resolve();
const serial = <T>(fn: () => Promise<T>): Promise<T> => {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
};

// ---------------------------------------------------------------------------
// JWT (HS256, o suficiente para o cliente ler `exp`/`sub` e o servidor validar)
// ---------------------------------------------------------------------------
const b64 = (v: object | Buffer) => Buffer.from(v instanceof Buffer ? v : JSON.stringify(v)).toString('base64url');
const sign = (data: string) => createHmac('sha256', JWT_SECRET).update(data).digest('base64url');

function issueAccessToken(user: { id: string; email: string }, ttl = TOKEN_TTL_SECONDS) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: 'HS256', typ: 'JWT' });
  const payload = b64({
    sub: user.id, email: user.email, role: 'authenticated', aud: 'authenticated',
    iat: now, exp: now + ttl,
  });
  return { token: `${head}.${payload}.${sign(`${head}.${payload}`)}`, expiresAt: now + ttl };
}

type Principal = { kind: 'anon' } | { kind: 'user'; id: string } | { kind: 'invalid'; reason: string };

function principalFrom(authorization: string | undefined): Principal {
  const token = authorization?.replace(/^Bearer\s+/i, '');
  if (!token || token === ANON_KEY) return { kind: 'anon' };
  const [h, p, s] = token.split('.');
  if (!h || !p || !s || sign(`${h}.${p}`) !== s) return { kind: 'invalid', reason: 'JWT invalid' };
  const claims = JSON.parse(Buffer.from(p, 'base64url').toString('utf8')) as { sub: string; exp: number };
  if (claims.exp < Math.floor(Date.now() / 1000)) return { kind: 'invalid', reason: 'JWT expired' };
  return { kind: 'user', id: claims.sub };
}

async function userRecord(id: string) {
  const res = await db.query<{ id: string; email: string; raw_user_meta_data: Record<string, unknown> }>(
    `SELECT id, email, raw_user_meta_data FROM auth.users WHERE id = $1`, [id]);
  const u = res.rows[0];
  if (!u) return null;
  return {
    id: u.id, aud: 'authenticated', role: 'authenticated', email: u.email,
    app_metadata: { provider: 'email', providers: ['email'] },
    user_metadata: u.raw_user_meta_data ?? {},
    created_at: new Date().toISOString(),
  };
}

async function sessionFor(user: { id: string; email: string }) {
  const { token, expiresAt } = issueAccessToken(user);
  const refresh = randomUUID();
  refreshTokens.set(refresh, user.id);
  return {
    access_token: token, token_type: 'bearer', expires_in: TOKEN_TTL_SECONDS, expires_at: expiresAt,
    refresh_token: refresh, user: await userRecord(user.id),
  };
}

// ---------------------------------------------------------------------------
// GoTrue
// ---------------------------------------------------------------------------
const authError = (status: number, errorCode: string, msg: string): HttpResult =>
  ({ status, body: { code: status, error_code: errorCode, msg } });

async function handleAuth(req: IncomingMessage, url: URL, body: any): Promise<HttpResult> {
  const path = url.pathname.replace('/auth/v1', '');
  if (path === '/token' && req.method === 'POST') {
    const grant = url.searchParams.get('grant_type');
    if (grant === 'password') {
      const email = String(body.email ?? '').trim().toLowerCase();
      const found = await db.query<{ id: string }>(`SELECT id FROM auth.users WHERE lower(email) = $1`, [email]);
      if (!found.rows[0] || passwords.get(email) !== body.password) {
        return authError(400, 'invalid_credentials', 'Invalid login credentials');
      }
      return { status: 200, body: await sessionFor({ id: found.rows[0].id, email }) };
    }
    if (grant === 'refresh_token') {
      const uid = refreshTokens.get(body.refresh_token);
      if (!uid) return authError(400, 'refresh_token_not_found', 'Invalid Refresh Token: Refresh Token Not Found');
      refreshTokens.delete(body.refresh_token);
      const user = await userRecord(uid);
      return { status: 200, body: await sessionFor({ id: uid, email: user!.email }) };
    }
  }
  if (path === '/logout' && req.method === 'POST') return { status: 204 };
  if (path === '/recover' && req.method === 'POST') {
    // Como o GoTrue real: responde 200 exista ou não o e-mail (não revela quem tem conta)
    recoverRequests.push({ email: String(body?.email ?? ''), redirectTo: url.searchParams.get('redirect_to') });
    return { status: 200, body: {} };
  }
  if (path === '/user') {
    const who = principalFrom(req.headers.authorization);
    if (who.kind !== 'user') return authError(401, 'bad_jwt', 'invalid claim: missing sub claim');
    if (req.method === 'GET') return { status: 200, body: await userRecord(who.id) };
    if (req.method === 'PUT') {
      const user = await userRecord(who.id);
      if (body.password) {
        // Política padrão do Supabase: mínimo de 6 caracteres e diferente da senha atual
        if (String(body.password).length < 6) {
          return authError(422, 'weak_password', 'Password should be at least 6 characters.');
        }
        if (passwords.get(user!.email.toLowerCase()) === body.password) {
          return authError(422, 'same_password', 'New password should be different from the old password.');
        }
        passwords.set(user!.email.toLowerCase(), body.password);
      }
      return { status: 200, body: user };
    }
  }
  return authError(404, 'not_found', `rota GoTrue não suportada: ${req.method} ${path}`);
}

// ---------------------------------------------------------------------------
// Controle de testes
// ---------------------------------------------------------------------------
async function resetData() {
  // app_settings e time_alerts_sync_state (migration 016) são tabelas de linha única criada pela migration:
  // truncá-las apagaria a linha (o UPDATE do throttle de sync_time_alerts passaria a não achar nada e o
  // throttle de 60 s nunca valeria nos testes). Elas são restauradas abaixo em vez de truncadas.
  const tables = await db.query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename NOT IN ('app_settings', 'time_alerts_sync_state')`);
  await db.exec('RESET ROLE');
  await db.exec(`TRUNCATE ${tables.rows.map((t) => `public."${t.tablename}"`).join(', ')} CASCADE`);
  await db.exec(`DELETE FROM auth.users`);
  await db.exec(`UPDATE public.app_settings SET absence_alert_threshold = 3, low_attendance_threshold = 70, critical_absence_threshold = 6, followup_grace_days = 7`);
  await db.exec(`UPDATE public.time_alerts_sync_state SET last_run = '-infinity'`);
  passwords.clear();
  refreshTokens.clear();
  recoverRequests.length = 0;
}

async function createUser(email: string, password: string, fullName: string, role: Role) {
  const id = randomUUID();
  await db.query(
    `INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES ($1, $2, jsonb_build_object('full_name', $3::text))`,
    [id, email.toLowerCase(), fullName]);
  await db.query(`UPDATE public.user_roles SET role = $2 WHERE user_id = $1`, [id, role]);
  passwords.set(email.toLowerCase(), password);
  return id;
}

async function handleControl(url: URL, method: string, body: any): Promise<HttpResult> {
  switch (url.pathname) {
    case '/__test/health': return { status: 200, body: { ok: true } };
    case '/__test/reset': await resetData(); return { status: 200, body: { ok: true } };
    case '/__test/users': {
      const id = await createUser(body.email, body.password, body.fullName, body.role);
      return { status: 200, body: { id } };
    }
    case '/__test/auth-link': {
      // Gera o fragmento de URL de um e-mail de recuperação/convite: "#access_token=…&type=recovery"
      const found = await db.query<{ id: string; email: string }>(
        `SELECT id, email FROM auth.users WHERE lower(email) = $1`, [String(body.email).toLowerCase()]);
      if (!found.rows[0]) return { status: 404, body: { error: 'usuário não encontrado' } };
      const session = await sessionFor(found.rows[0]);
      const hash = new URLSearchParams({
        access_token: session.access_token, expires_in: String(session.expires_in), expires_at: String(session.expires_at),
        refresh_token: session.refresh_token, token_type: 'bearer', type: body.type ?? 'recovery',
      }).toString();
      return { status: 200, body: { hash: `#${hash}` } };
    }
    case '/__test/recover-requests': return { status: 200, body: recoverRequests };
    case '/__test/sql': {
      await db.exec('RESET ROLE');
      const res = await db.query(String(body.sql), body.params ?? []);
      return { status: 200, body: res.rows };
    }
  }
  return { status: 404, body: { error: `${method} ${url.pathname}` } };
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------
const CORS: Record<string, string> = {
  // só o app de teste (nada de '*'): uma página qualquer aberta durante o E2E não alcança o servidor
  'access-control-allow-origin': APP_URL,
  'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS',
  'access-control-expose-headers': 'Content-Range, Content-Type',
  'access-control-max-age': '600',
};

function send(res: ServerResponse, result: HttpResult, requestedHeaders?: string) {
  const headers: Record<string, string> = { ...CORS, ...(result.headers ?? {}) };
  headers['access-control-allow-headers'] = requestedHeaders ?? 'authorization, apikey, content-type';
  if (result.body !== undefined) headers['content-type'] = 'application/json; charset=utf-8';
  res.writeHead(result.status, headers);
  res.end(result.body === undefined ? undefined : JSON.stringify(result.body));
}

async function readBody(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : undefined;
}

createServer(async (req, res) => {
  const requested = req.headers['access-control-request-headers'] as string | undefined;
  try {
    if (req.method === 'OPTIONS') return send(res, { status: 204 }, requested);
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    const body = await readBody(req);
    let result: HttpResult;

    if (url.pathname.startsWith('/__test/')) {
      if (req.headers['x-e2e-token'] !== CONTROL_TOKEN) {
        return send(res, { status: 403, body: { error: 'token de controle ausente ou inválido' } }, requested);
      }
      result = await serial(() => handleControl(url, req.method ?? 'GET', body));
    } else if (url.pathname.startsWith('/auth/v1/')) {
      result = await serial(() => handleAuth(req, url, body));
    } else if (url.pathname.startsWith('/rest/v1/')) {
      const who = principalFrom(req.headers.authorization);
      if (who.kind === 'invalid') {
        result = { status: 401, body: { code: 'PGRST301', message: who.reason, details: null, hint: null } };
      } else {
        const headers = Object.fromEntries(
          Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(',') : v]));
        result = await serial(() => handleRest(db, catalog, {
          method: req.method ?? 'GET',
          table: decodeURIComponent(url.pathname.slice('/rest/v1/'.length)),
          search: url.searchParams,
          headers,
          body,
          userId: who.kind === 'user' ? who.id : null,
        }));
      }
    } else {
      result = { status: 404, body: { error: 'not found' } };
    }
    send(res, result, requested);
  } catch (err) {
    console.error('[fake-supabase]', err);
    send(res, { status: 500, body: { message: (err as Error).message } }, requested);
  }
}).listen(PORT, '127.0.0.1', () => {
  console.log(`[fake-supabase] ouvindo em http://127.0.0.1:${PORT}`);
});
