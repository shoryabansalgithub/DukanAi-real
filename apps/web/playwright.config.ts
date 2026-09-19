import { defineConfig, devices } from '@playwright/test';
import path from 'node:path';

/**
 * Browser-level POS verification (roadmap layer 6).
 *
 * Boots the API in `NODE_ENV=test` (apps/api/.env.test: MySQL `dukaanai_test`
 * on localhost:3306, Redis db 1, port 3003) with `AUTH_DISABLED=true`, and the
 * web app in dev mode with `NEXT_PUBLIC_AUTH_DISABLED=true` pointed at that
 * API. With the bypass on, every request runs as the provisioned system user
 * (OWNER of its own shop), so the spec needs no login and creates its own data
 * through the API.
 *
 * Overrides: E2E_WEB_PORT, E2E_API_PORT, E2E_API_URL, E2E_WEB_URL,
 * E2E_API_COMMAND (e.g. `node dist/main` after `npm run build`).
 */
const WEB_PORT = Number(process.env.E2E_WEB_PORT ?? 3000);
const API_PORT = Number(process.env.E2E_API_PORT ?? 3003);
const WEB_URL = process.env.E2E_WEB_URL ?? `http://localhost:${WEB_PORT}`;
const API_URL = process.env.E2E_API_URL ?? `http://localhost:${API_PORT}/api`;

const apiDir = path.resolve(__dirname, '../api');
const apiCommand = process.env.E2E_API_COMMAND ?? 'npx nest start';

export default defineConfig({
  testDir: './e2e',
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL: WEB_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },
  metadata: { apiUrl: API_URL },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: apiCommand,
      cwd: apiDir,
      url: `${API_URL}/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 240_000,
      // Prisma query logging in .env.test makes stdout very noisy; errors still surface.
      stdout: 'ignore',
      stderr: 'pipe',
      env: {
        NODE_ENV: 'test',
        AUTH_DISABLED: 'true',
        PORT: String(API_PORT),
        FRONTEND_URL: WEB_URL,
      },
    },
    {
      command: `npx next dev -p ${WEB_PORT}`,
      cwd: __dirname,
      url: `${WEB_URL}/billing`,
      reuseExistingServer: !process.env.CI,
      timeout: 240_000,
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        NEXT_PUBLIC_AUTH_DISABLED: 'true',
        NEXT_PUBLIC_API_URL: API_URL,
        NEXTAUTH_URL: WEB_URL,
      },
    },
  ],
});
