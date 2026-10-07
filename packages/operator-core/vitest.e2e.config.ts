import { defineVitestConfig } from '@papercusp/test-config/vitest-config';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// The e2e layer (EI-24442044145393058): `*.e2e.test.ts` files that drive a live running
// system. `npm run test:file` routes such a file here, so its test_runs row records
// testLayer 'e2e' from this config's runtime `provide` — acceptance BAR clauses whose
// requiredTestLayers name 'e2e' bind only to such a row. The unit config still collects
// these files too, so the gate's unit run keeps covering them.
export default defineVitestConfig({
  layer: 'e2e',
  // Optional selectors only. Fingerprints come from the running process ledger
  // and the kernel, never from the fixture or a caller-provided fingerprint.
  ...(process.env.PAPERCUSP_APP_OPERATION_LIVE_PROFILE ? {
    readRuntimeEnvironment: async () => {
      const profile = JSON.parse(readFileSync(resolve(__dirname, '../..',
        process.env.PAPERCUSP_APP_OPERATION_LIVE_PROFILE!), 'utf8'));
      const units: unknown = profile.runtimeUnits;
      if (!Array.isArray(units) || units.length === 0 || units.length > 32
        || units.some(unit => typeof unit !== 'string' || !unit.trim() || unit.length > 120)
        || new Set(units).size !== units.length) return null;
      const { listRuntimeVintage, measureRuntimeVintageEnvironment } = await import('./lib/runtime-vintage');
      const fingerprint = measureRuntimeVintageEnvironment(await listRuntimeVintage(), units);
      return fingerprint ? { schemaVersion: 1 as const, units, fingerprint, observedAt: new Date().toISOString() } : null;
    },
  } : {}),
  setupFiles: [
    resolve(__dirname, 'lib/coverage-census/attribution/setup-vitest.ts'),
    resolve(__dirname, 'lib/detached-imports/setup-vitest.ts'),
  ],
});
