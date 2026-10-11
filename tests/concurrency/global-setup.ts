import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    /** URL de superusuário do servidor descartável ('' quando desabilitado). */
    pgAdminUrl: string;
    pgSource: 'embedded' | 'external' | 'disabled';
  }
}

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
  });

export default async function setup(project: TestProject) {
  const external = process.env.CONCURRENCY_DATABASE_URL?.trim();
  if (external) {
    project.provide('pgSource', 'external');
    project.provide('pgAdminUrl', external);
    return;
  }

  if (process.env.CONCURRENCY_TESTS !== '1') {
    project.provide('pgSource', 'disabled');
    project.provide('pgAdminUrl', '');
    console.warn(
      '\n[test:concurrency] PULADO: defina CONCURRENCY_TESTS=1 (Postgres descartável via embedded-postgres) ' +
        'ou CONCURRENCY_DATABASE_URL (superusuário de um Postgres descartável). Nunca use o Supabase real.\n',
    );
    return;
  }

  const dir = mkdtempSync(join(tmpdir(), 'conecta-pgtest-'));
  const port = await freePort();
  const password = randomBytes(12).toString('hex');
  const pg = new EmbeddedPostgres({
    databaseDir: dir,
    port,
    user: 'postgres',
    password,
    persistent: false,
    // O padrão do initdb no Windows é WIN1252; as migrations têm acentos e símbolos UTF-8.
    initdbFlags: ['--encoding=UTF8', '--locale=C'],
    onLog: () => {},
    onError: () => {},
  });
  await pg.initialise();
  await pg.start();

  project.provide('pgSource', 'embedded');
  project.provide('pgAdminUrl', `postgres://postgres:${password}@127.0.0.1:${port}/postgres`);

  return async () => {
    try {
      await pg.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}
