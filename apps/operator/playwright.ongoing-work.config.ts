import { defineConfig } from '@playwright/test';
import base from './playwright.config';

/** Explicit real-data acceptance profile, reused for current-build rehearsal and final release. */
export default defineConfig({
  ...base,
  testMatch: /ongoing-work-shipment\.live\.ts$/,
  testIgnore: [],
  globalSetup: './e2e/_warm-ongoing-work.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  use: { ...base.use, trace: 'retain-on-failure' },
});
