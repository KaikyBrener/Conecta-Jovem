import { defineConfig } from 'vitest/config';

// Testes de concorrência em Postgres REAL (não PGlite): `npm run test:concurrency`.
// Fora do `npm test`: o include padrão do projeto é *.test.ts; estes são *.pgtest.ts e só rodam por esta config.
// Habilitar: CONCURRENCY_TESTS=1 (sobe um Postgres descartável via embedded-postgres)
//        ou CONCURRENCY_DATABASE_URL=postgres://... (superusuário de um Postgres DESCARTÁVEL, ex.: Docker no CI).
// Sem nenhuma das duas, tudo é pulado com uma mensagem. NUNCA aponte para o Supabase real.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/concurrency/**/*.pgtest.ts'],
    globalSetup: ['tests/concurrency/global-setup.ts'],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 180_000,
  },
});
