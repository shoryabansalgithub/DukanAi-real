import { defineConfig, devices } from '@playwright/test';

/**
 * The screen half of the failure drills (roadmap 9.18,
 * e2e-drills/drill-observer.spec.ts): a cashier at the POS, a second cashier
 * opening the POS mid-incident, the owner on the dashboard and a bill photo
 * in Smart Capture, in a real browser, against servers that are already running
 * (the drill stack of scripts/drills/drill-stack.sh or staging), recording
 * what the screens say while scripts/drills/drill.mjs injects a fault.
 * Nothing is started here. DRILL_WEB_URL is the web origin; DRILL_HOST_RESOLVER
 * maps the drill names to this machine (Chromium --host-resolver-rules); the
 * drill CA is not in Chromium's store, so certificate errors are ignored here
 * and the certificate drill is observed by the driver's verifying client.
 */
const WEB_URL = process.env.DRILL_WEB_URL ?? 'https://app.dukaanai.test:8443';
const resolver = process.env.DRILL_HOST_RESOLVER;

export default defineConfig({
  testDir: './e2e-drills',
  timeout: Number(process.env.DRILL_OBSERVER_TIMEOUT_MINUTES ?? 120) * 60_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  // One test that lasts as long as the drill it watches.
  reportSlowTests: null,
  outputDir: 'test-results-drills',
  use: {
    baseURL: WEB_URL,
    ignoreHTTPSErrors: true,
    trace: 'off',
    screenshot: 'off',
    video: 'off',
    launchOptions: resolver ? { args: [`--host-resolver-rules=${resolver}`, '--no-proxy-server'] } : undefined,
  },
  projects: [{ name: 'chromium-drills', use: { ...devices['Desktop Chrome'] } }],
});
