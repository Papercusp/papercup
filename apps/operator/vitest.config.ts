import { defineVitestConfig } from '@papercusp/test-config';
import { mergeConfig } from 'vitest/config';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export default mergeConfig(
  defineVitestConfig({
    layer: 'unit',
    exclude: ['**/test/**', '**/node_modules/**', '**/.next/**', '**/.next-prod/**'],
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
  },
);
