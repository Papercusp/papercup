import { defineVitestConfig, BASELINE_SCHEMA_GLOBAL_SETUP_PATH } from '@papercusp/test-config/vitest-config';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tsImport } from 'tsx/esm/api';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Preload the existing host resolver before the reporter's bounded witness
// read. Ordinary isolated integration suites do not open the live-host graph.
const liveRuntime = process.env.PAPERCUSP_WOE_SERVED_AUDIT === '1'
  ? await tsImport('./lib/runtime-vintage.ts', import.meta.url) : null;

// The SP1 C4 carve moved the plans/cross_harness integration tests here; they
// inject('baselineSchemaDsn') via _pg-tool-fixture, so this package needs the
// shared baseline-schema globalSetup (was only wired in apps/operator before).
// The admin test-runs reporter is auto-wired by defineVitestConfig.
// Coverage-census attribution (P-004) — see the note in vitest.config.ts. The INTEGRATION
// layer is where this actually produces rows: it is the layer with a reachable Postgres, so a
// flush lands instead of disabling the sink.
export default defineVitestConfig({
  layer: 'integration',
  ...(liveRuntime ? {
    readRuntimeEnvironment: async () => {
      const units = ['hono-host:3170'];
      const fingerprint = liveRuntime.measureRuntimeVintageEnvironment(
        await liveRuntime.listRuntimeVintage('papercusp-workspace'), units,
      );
      return fingerprint ? { schemaVersion: 1 as const, units, fingerprint, observedAt: new Date().toISOString() } : null;
    },
  } : {}),
  globalSetup: [BASELINE_SCHEMA_GLOBAL_SETUP_PATH, resolve(__dirname, 'test/_org-template.globalSetup.ts')],
  setupFiles: [
    resolve(__dirname, 'lib/coverage-census/attribution/setup-vitest.ts'),
    // Integration routes also start tracked lazy imports (e.g. session end).
    // Join them before teardown, using the same registry as the unit lane.
    resolve(__dirname, 'lib/detached-imports/setup-vitest.ts'),
  ],
});
