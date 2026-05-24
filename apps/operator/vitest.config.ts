import { defineVitestConfig } from '@papercusp/test-config';
import { mergeConfig } from 'vitest/config';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Custom reporter (P-010) writes per-file results to
// harness_shared.test_runs. Fail-soft per D-007 — never throws.
// Opt-out via PAPERCUSP_DISABLE_TEST_RUNS_REPORTER=1 (used by the
// reporter's own tests to avoid infinite recursion).
const reportersExtra: Array<string | [string, Record<string, unknown>]> =
  process.env.PAPERCUSP_DISABLE_TEST_RUNS_REPORTER === '1'
    ? []
    : [resolve(__dirname, 'test/reporters/admin-test-runs-reporter.ts')];

export default mergeConfig(
  defineVitestConfig({
    layer: 'unit',
    exclude: ['**/test/**', '**/node_modules/**', '**/.next/**', '**/.next-prod/**'],
    // ResizeObserver polyfill for dockview-react in jsdom-environment
    // tests. Phase 0 of dockview-migration v4.
    setupFiles: [resolve(__dirname, 'vitest-shims/resize-observer.ts')],
  }),
  {
    test: {
      // mergeConfig array-merge appends, so the base reporter list is
      // preserved and the admin reporter runs alongside it.
      reporters: reportersExtra,
    },
    resolve: {
      alias: {
        // `server-only` is a Next.js sentinel package: importing it from
        // a client chunk errors at compile time. It has no real runtime,
        // so vitest can't resolve it. Alias to an empty file so unit
        // tests can load modules that declare `import 'server-only'` as
        // a guardrail (e.g. lib/sync-sse.ts, lib/operator-scans.ts).
        'server-only': resolve(__dirname, 'vitest-shims/server-only.ts'),
      },
    },
  },
);
