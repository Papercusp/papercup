import { defineConfig } from '@playwright/test';
import base from './playwright.config';

/** P-007 graph/UI acceptance runs through the owned Tauri verifier.
 * Keep this Playwright profile scoped to controlled UI states; it starts no server. */
export default defineConfig({
  ...base,
  testMatch: /engineering-evidence-controls\.live\.ts$/,
  fullyParallel: false, workers: 1, retries: 0,
  globalSetup: undefined, webServer: undefined, timeout: 12 * 60_000,
  use: { ...base.use, baseURL: process.env.OPERATOR_E2E_BASE_URL, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
});
