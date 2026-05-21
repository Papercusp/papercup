/**
 * Root ESLint config.
 *
 * Wires the project's custom rules from tools/eslint-rules/. Most
 * notably enforces tx-only inside transaction callbacks for files in
 * @papercusp/agent-mcp/ and the substrate code paths that use
 * withWorkspace().
 *
 * Per-package configs may layer on top.
 */

import papercuspRules from './tools/eslint-rules/index.js';

export default [
  {
    ignores: [
      '**/node_modules/**',
      '**/.next/**',
      '**/dist/**',
      '**/build/**',
      '**/*.d.ts',
      '**/.turbo/**',
    ],
  },
  {
    files: [
      'packages/agent-mcp/**/*.ts',
      'libs/papercusp/libs/db/src/**/*.ts',
      'apps/operator/app/api/agent-mcp/**/*.ts',
      'apps/operator/lib/operator-*.ts',
    ],
    plugins: {
      papercusp: papercuspRules,
    },
    rules: {
      'papercusp/no-bare-db-in-tx': 'error',
    },
  },
  {
    // Regression guard for `endpoint-hono-elimination-2026-05-21` —
    // every application route must use `defineRoute`. Raw Hono
    // (`app.get/post/use/route/...`, `new Hono()`) is restricted to
    // `bin/host-*.ts` (the host seam). See
    // `tools/eslint-rules/no-raw-route-handlers.js`.
    files: [
      'apps/operator/**/*.ts',
      'apps/operator/**/*.tsx',
      'packages/agent-mcp/**/*.ts',
    ],
    plugins: {
      papercusp: papercuspRules,
    },
    rules: {
      'papercusp/no-raw-route-handlers': 'error',
    },
  },
];
