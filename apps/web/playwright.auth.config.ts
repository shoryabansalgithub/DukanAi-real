import { defineConfig, devices } from '@playwright/test';
import path from 'node:path';

/**
 * Real-authentication browser tests (roadmap 6.9): the same API and web
 * servers as playwright.config.ts but WITHOUT the auth bypass, on their own
 * ports, so every request carries a NextAuth session and the API's role
 * checks apply. Run sequentially after the bypass suite (`npm run
 * test:e2e:auth`); both use the `.next` dev cache, never at the same time.
 *
 * Overrides: E2E_AUTH_WEB_PORT, E2E_AUTH_API_PORT, E2E_API_COMMAND.
 */
const WEB_PORT = Number(process.env.E2E_AUTH_WEB_PORT ?? 3012);
const API_PORT = Number(process.env.E2E_AUTH_API_PORT ?? 3005);
const WEB_URL = `http://localhost:${WEB_PORT}`;
const API_URL = `http://localhost:${API_PORT}/api`;

const apiDir = path.resolve(__dirname, '../api');
const apiCommand = process.env.E2E_API_COMMAND ?? 'npx nest start';

export default defineConfig({
  testDir: './e2e-auth',
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never', outputFolder: 'playwright-report-auth' }]] : [['list']],
  outputDir: 'test-results-auth',
  use: {
    baseURL: WEB_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },
  metadata: { apiUrl: API_URL },
  projects: [{ name: 'chromium-real-auth', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: apiCommand,
      cwd: apiDir,
      url: `${API_URL}/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 240_000,
      stdout: 'ignore',
      stderr: 'pipe',
      env: {
        NODE_ENV: 'test',
        AUTH_DISABLED: 'false',
        PORT: String(API_PORT),
        FRONTEND_URL: WEB_URL,
      },
    },
    {
      command: `npx next dev -p ${WEB_PORT}`,
      cwd: __dirname,
      url: `${WEB_URL}/login`,
      reuseExistingServer: !process.env.CI,
      timeout: 240_000,
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        // Explicitly off: .env.development turns the bypass on for local work.
        NEXT_PUBLIC_AUTH_DISABLED: 'false',
        NEXT_PUBLIC_API_URL: API_URL,
        NEXTAUTH_URL: WEB_URL,
        NEXTAUTH_SECRET: 'e2e-real-auth-secret-0123456789abcdef0123456789',
      },
    },
  ],
});
