import { defineConfig, devices } from '@playwright/test';

/**
 * The browser half of the simulated business day (roadmap 9.17,
 * e2e-load/business-day.spec.ts): two sessions per shop through the UI for
 * the whole compressed day, against servers that are already running (the
 * local stack of apps/api/load/business-day.sh or a staging deployment).
 * Nothing is started here. BUSINESS_DAY_WEB_URL is the web origin;
 * BUSINESS_DAY_MINUTES sizes the test timeout; BUSINESS_DAY_UI_JSON adds the
 * JSON reporter.
 */
const WEB_URL = process.env.BUSINESS_DAY_WEB_URL ?? 'http://localhost:3043';
const MINUTES = Number(process.env.BUSINESS_DAY_MINUTES ?? 90);
const jsonReport = process.env.BUSINESS_DAY_UI_JSON;

export default defineConfig({
  testDir: './e2e-load',
  timeout: (MINUTES + 20) * 60_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list'], ...(jsonReport ? [['json', { outputFile: jsonReport }] as const] : [])],
  outputDir: 'test-results-business-day',
  use: {
    baseURL: WEB_URL,
    trace: 'off',
    screenshot: 'off',
    video: 'off',
  },
  projects: [{ name: 'chromium-business-day', use: { ...devices['Desktop Chrome'] } }],
});
