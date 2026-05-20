import { defineVitestConfig } from '@papercusp/test-config';
import { mergeConfig } from 'vitest/config';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

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
      alias: {
        // `server-only` is a Next.js sentinel package: importing it from
        // a client chunk errors at compile time. It has no real runtime,
        // so vitest can't resolve it. Alias to an empty file so unit
        // tests can load modules that declare `import 'server-only'` as
        // a guardrail (e.g. lib/sync-sse.ts, lib/operator-scans.ts).
        'server-only': resolve(__dirname, 'vitest-shims/server-only.ts'),
      },
    },
    plugins: [
      {
        // fumadocs-mdx content collections are imported as
        // `*.mdx?collection=<name>` and depend on a loader the Next
        // build supplies. Vitest's vite has no such loader, so the raw
        // markdown reaches `vite:import-analysis` and fails to parse as
        // JS. Any test that imports the agent-tools registry transitively
        // pulls in the internal-docs collection (the `docs:*` tools), so
        // this breaks unrelated suites (e.g. endpoint-ipc E2E). Stub
        // `.mdx` to empty modules — unit tests never assert on doc
        // *content*; docs tools are covered by integration tests against
        // the live route.
        name: 'papercusp:stub-mdx-for-vitest',
        enforce: 'pre' as const,
        load(id: string): string | undefined {
          if (/\.mdx(\?|$)/.test(id)) {
            return 'export default {}; export const frontmatter = {}; export const toc = [];';
          }
          return undefined;
        },
      },
    ],
  },
);
