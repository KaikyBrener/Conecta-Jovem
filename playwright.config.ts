import { defineConfig, devices } from '@playwright/test';
import { ANON_KEY, APP_PORT, APP_URL, FAKE_SUPABASE_PORT, SUPABASE_URL } from './tests/e2e/env.ts';

// Testes E2E rodam contra o app (Vite dev) + um Supabase FALSO local (PGlite com as
// migrations reais). Nunca usam o .env nem o banco real.
// Navegador: Chromium do Playwright (`npx playwright install chromium`).
// Para usar um navegador já instalado: E2E_CHANNEL=msedge (ou chrome).
const channel = process.env.E2E_CHANNEL || undefined;

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '**/*.spec.ts',
  // O banco falso é único e compartilhado: testes rodam em série.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  timeout: 30_000,
  expect: { timeout: 7_000 },
  use: {
    baseURL: APP_URL,
    locale: 'pt-BR',
    timezoneId: 'America/Sao_Paulo',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'desktop',
      testIgnore: '**/*.mobile.spec.ts',
      use: { ...devices['Desktop Chrome'], channel, viewport: { width: 1280, height: 800 } },
    },
    {
      name: 'mobile',
      testMatch: '**/*.mobile.spec.ts',
      use: { ...devices['Pixel 7'], channel },
    },
  ],
  webServer: [
    {
      command: 'node tests/e2e/fake-supabase/server.ts',
      url: `${SUPABASE_URL}/__test/health`,
      // o health exige o token de controle (403): o Playwright considera 2xx/3xx/400-403 como "servidor pronto"
      timeout: 60_000,
      // nunca reaproveitar: garante que o banco é o falso e começa limpo
      reuseExistingServer: false,
      env: { E2E_SUPABASE_PORT: String(FAKE_SUPABASE_PORT) },
    },
    {
      command: `npm run dev -- --host 127.0.0.1 --port ${APP_PORT} --strictPort`,
      url: APP_URL,
      timeout: 60_000,
      // nunca reaproveitar: um dev server já aberto apontaria para o Supabase real do .env
      reuseExistingServer: false,
      env: {
        // variáveis do processo têm prioridade sobre o .env no Vite
        VITE_SUPABASE_URL: SUPABASE_URL,
        VITE_SUPABASE_PUBLISHABLE_KEY: ANON_KEY,
      },
    },
  ],
});
