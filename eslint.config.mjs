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
      'packages/operator-core/lib/operator-*.ts',
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
  {
    // A bare `${x}::jsonb` is client-dependent — it double-encodes (stores a
    // jsonb *string*) under a fresh/testcontainer postgres() pool while working
    // under getOrgPg, so the same code is right in prod + wrong in tests.
    // Enforce the universal `${x}::text::jsonb`. See
    // `tools/eslint-rules/no-bare-jsonb-cast.js` + agent-insight
    // postgres-js-jsonb-binding (handoff-coordination-dx-followups §A2).
    files: [
      'packages/operator-core/lib/**/*.ts',
      'packages/coordination/src/**/*.ts',
      'libs/papercusp/libs/db/src/**/*.ts',
    ],
    plugins: {
      papercusp: papercuspRules,
    },
    rules: {
      'papercusp/no-bare-jsonb-cast': 'error',
    },
  },
];
