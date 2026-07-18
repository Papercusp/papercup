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
import tseslint from 'typescript-eslint';

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
    // TypeScript syntax support — PARSER ONLY, no type-aware linting and no
    // recommended rule sets (the rule surface stays exactly the custom
    // papercusp rules below). Without this, espree choked on any TS-only
    // syntax (inline `type` imports, generics, interfaces…), so the guard
    // rules silently never ran on most TS/TSX files
    // (memory-taxonomy-and-debt-followups P-005).
    files: ['**/*.ts', '**/*.tsx', '**/*.mts', '**/*.cts'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
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
  {
    // EI-10445: sql.json(x) throws under every canonical db-org client
    // (getOrgPg/getOrgPgApp/getHarnessPg — prepare:false mis-binds it), a
    // trap at least a dozen files independently rediscovered and hand-
    // documented instead of a mechanical guard catching it. Self-scoping (the
    // rule only fires in a file that actually imports one of those throwing
    // accessors from @papercusp/db-org — a DIFFERENT pool, e.g. dock-layouts.ts's
    // own fresh postgres() client, is correctly never flagged), so this is wired
    // broadly across every dir observed importing @papercusp/db-org rather than
    // a narrow allowlist. See `tools/eslint-rules/no-org-pool-sql-json.js` +
    // agent-insights/postgres-js-jsonb-binding.
    files: [
      'packages/**/*.ts',
      'apps/operator/**/*.ts',
      'libs/papercusp/libs/db/src/**/*.ts',
      'libs/generic/sync/src/**/*.ts',
    ],
    plugins: {
      papercusp: papercuspRules,
    },
    rules: {
      'papercusp/no-org-pool-sql-json': 'error',
    },
  },
];
