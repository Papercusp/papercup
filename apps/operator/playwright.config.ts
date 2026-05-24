import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.OPERATOR_E2E_PORT ?? 3055);
const BASE_URL = process.env.OPERATOR_E2E_BASE_URL ?? `http://localhost:${PORT}`;

const reuseExisting = process.env.OPERATOR_E2E_REUSE_SERVER === '1';

export default defineConfig({
  testDir: './e2e',
  testMatch: /.*\.spec\.ts$/,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 2 : 4,
  reporter: (() => {
    // Custom reporter (P-011) writes per-file Playwright results to
    // harness_shared.test_runs. Fail-soft per D-007 — never throws.
    // Opt-out via PAPERCUSP_DISABLE_TEST_RUNS_REPORTER=1.
    const adminReporter: Array<string | [string, Record<string, unknown>]> =
      process.env.PAPERCUSP_DISABLE_TEST_RUNS_REPORTER === '1'
        ? []
        : [['./test/reporters/admin-test-runs-reporter-playwright.ts', {}]];
    return process.env.CI
      ? [['junit', { outputFile: 'junit-e2e.xml' }], ['html', { open: 'never' }], ...adminReporter]
      : [['list'], ...adminReporter];
  })(),
  timeout: 60_000,
  use: {
    baseURL: BASE_URL,
    actionTimeout: 10_000,
    navigationTimeout: 30_000,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: reuseExisting
    ? undefined
    : {
        command: 'npm run dev',
        url: BASE_URL,
        reuseExistingServer: true,
        timeout: 120_000,
        stdout: 'ignore',
        stderr: 'pipe',
      },
});
