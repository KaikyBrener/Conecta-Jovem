import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'tests/**/*.test.ts'],
    testTimeout: 30_000,
    // Cada worker que roda os testes de banco (PGlite) chega a ~1 GB. Com um worker por thread da CPU, a RAM
    // acaba e o sistema derruba workers ("Worker exited unexpectedly"), o que aparece como testes que somem do
    // total sem nenhum FAIL. Quatro workers cabem em máquinas de 8 GB+ e não ficam mais lentos que seis.
    // Para forçar outro valor: `npx vitest run --maxWorkers=N`.
    maxWorkers: 4,
  },
});
