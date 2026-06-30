import { defineVitestConfig } from '@papercusp/test-config';
import { mergeConfig } from 'vitest/config';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// The admin test-runs reporter (the /admin/testing status chips) is AUTO-WIRED by
// defineVitestConfig — no per-config wiring needed. This mergeConfig only carries
// the apps/operator-specific resolve alias below.
export default mergeConfig(
  defineVitestConfig({
    layer: 'unit',
    exclude: ['**/test/**', '**/node_modules/**', '**/.next/**', '**/.next-prod/**'],
    // ResizeObserver polyfill for dockview-react in jsdom-environment
    // tests. Phase 0 of dockview-migration v4.
    setupFiles: [resolve(__dirname, 'vitest-shims/resize-observer.ts')],
  }),
  {
    resolve: {
      alias: [
        // `server-only` is a Next.js sentinel package: importing it from
        // a client chunk errors at compile time. It has no real runtime,
        // so vitest can't resolve it. Alias to an empty file so unit
        // tests can load modules that declare `import 'server-only'` as
        // a guardrail (e.g. lib/sync-sse.ts, lib/operator-scans.ts).
        { find: 'server-only', replacement: resolve(__dirname, 'vitest-shims/server-only.ts') },
        // `@/` → apps/operator/* : mirror operator-vite's app `@` alias so component
        // tests resolve `@/lib/...` imports (e.g. `@/lib/use-workspace-id`) the same
        // way the app bundle does. vite-tsconfig-paths (ignoreConfigErrors) does not
        // apply the tsconfig `@/*`→`./*` mapping for these in the unit env, so a
        // component importing `@/lib/...` fails to load its test suite without this.
        { find: /^@\//, replacement: `${resolve(__dirname)}/` },
      ],
    },
  },
);
