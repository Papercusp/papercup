/**
 * Unit test for the `papercusp/no-org-pool-sql-json` ESLint rule (EI-10445).
 *
 * Uses ESLint's built-in `RuleTester` to assert the rule flags `sql.json(x)`
 * only when the receiver is a SQL client binding derived from one of the
 * throwing db-org accessors (getOrgPg/getOrgPgApp/getHarnessPg). Unrelated
 * Response.json()/req.json() calls in the same module must remain valid.
 *
 * WHY IT LIVES HERE and not next to the rule (EI-10445 follow-up): this file
 * and its two siblings previously sat in `tools/eslint-rules/__tests__/`,
 * which NO vitest config owns — `tools/` is not an npm workspace, is absent
 * from the root `workspaces[]`, and no CI/gate step referenced it, so all
 * three guards silently never executed. That is not hypothetical rot: the
 * sibling `no-raw-route-handlers` test resolved eslint through
 * `node_modules/.pnpm/eslint@…`, a path that has never existed in this
 * npm-only repo, so it would have thrown ENOENT at import — undetected for as
 * long as it sat there. Relocating into an already-covered workspace follows
 * the repo's own precedent for testing repo tooling
 * (`packages/operator-core/lib/dbos/no-raw-setinterval-guard.test.ts`, which
 * imports `scripts/check-no-raw-setinterval.mjs` across the tree) and needs no
 * new workspace or vitest config.
 */
import { createRequire } from 'node:module';
import { describe, it } from 'vitest';

// npm workspaces hoists `eslint` to the repo-root node_modules — a plain
// require('eslint') resolves it via the normal Node module-resolution walk-up.
// (Never re-introduce a hardcoded node_modules/.pnpm/eslint@… path: this is an
// npm-only repo — `only-allow npm` — so no pnpm store ever exists here.)
const require = createRequire(import.meta.url);
const { RuleTester } = require('eslint');

const rule = require('../../../../tools/eslint-rules/no-org-pool-sql-json.js');

const tester = new RuleTester({
  languageOptions: { ecmaVersion: 2022, sourceType: 'module' },
});

describe('papercusp/no-org-pool-sql-json', () => {
  it('passes RuleTester valid/invalid cases', () => {
    tester.run('no-org-pool-sql-json', rule, {
      valid: [
        // No db-org import at all — sql.json() untouched (a different pool,
        // e.g. dock-layouts.ts's own fresh postgres() client, is CORRECT
        // using sql.json()).
        { code: "const db = postgres(url); db\`INSERT INTO t (p) VALUES (${sql.json(x)})\`;" },
        // db-org imported, but NOT one of the throwing accessors.
        {
          code: "import { withWorkspace } from '@papercusp/db-org';\nsql\`INSERT INTO t (p) VALUES (${sql.json(x)})\`;",
        },
        // Throwing accessor imported, but no sql.json() call anywhere —
        // the safe ::text::jsonb convention.
        {
          code: "import { getOrgPg } from '@papercusp/db-org';\nconst { sql } = getOrgPg();\nawait sql\`INSERT INTO t (p) VALUES (${JSON.stringify(x)}::text::jsonb)\`;",
        },
        // The throwing accessor can coexist with ordinary HTTP JSON helpers.
        {
          code:
            "import { getOrgPg } from '@papercusp/db-org';\n" +
            "const { sql } = getOrgPg();\n" +
            "const response = Response.json({ ok: true });\n" +
            "const body = await req.json();\n" +
            "void sql; void response; void body;",
        },
        // A same-named `sql` binding from another pool is not known to be the
        // throwing client just because this module imports db-org elsewhere.
        {
          code:
            "import { getOrgPg } from '@papercusp/db-org';\n" +
            "const { db } = getOrgPg();\n" +
            "const sql = external.sql;\n" +
            "sql.json(x);\n" +
            "void db;",
        },
      ],
      invalid: [
        {
          code: "import { getOrgPg } from '@papercusp/db-org';\nconst { sql } = getOrgPg();\nawait sql\`INSERT INTO t (p) VALUES (${sql.json(x)})\`;",
          errors: [{ messageId: 'throws' }],
        },
        {
          code: "import { getOrgPgApp } from '@papercusp/db-org';\nconst { sql } = getOrgPgApp();\nawait sql\`INSERT INTO t (p) VALUES (${sql.json(x)})\`;",
          errors: [{ messageId: 'throws' }],
        },
        {
          code: "import { getHarnessPg } from '@papercusp/db-org';\nconst sql = getHarnessPg(slug);\nawait sql\`INSERT INTO t (p) VALUES (${sql.json(x)})\`;",
          errors: [{ messageId: 'throws' }],
        },
        {
          // Direct call-chain form without introducing a local binding.
          code: "import { getHarnessPg } from '@papercusp/db-org';\nawait getHarnessPg(slug).sql.json(x);",
          errors: [{ messageId: 'throws' }],
        },
        {
          // Destructured alias form.
          code: "import { getOrgPg as getAdmin } from '@papercusp/db-org';\nconst { sql: client } = getAdmin();\nclient.json(x);",
          errors: [{ messageId: 'throws' }],
        },
        {
          // Dynamic `await import(...)` destructure form (e.g. system-health/liveness-alarm.ts).
          code: "async function f() {\n  const { getOrgPg } = await import('@papercusp/db-org');\n  const { sql } = getOrgPg();\n  await sql\`INSERT INTO t (p) VALUES (${sql.json(x)})\`;\n}",
          errors: [{ messageId: 'throws' }],
        },
        {
          // Two throwing calls in one file — both flagged.
          code: "import { getOrgPg } from '@papercusp/db-org';\nconst { sql } = getOrgPg();\nawait sql\`INSERT INTO a (p) VALUES (${sql.json(x)})\`;\nawait sql\`INSERT INTO b (q) VALUES (${sql.json(y)})\`;",
          errors: [{ messageId: 'throws' }, { messageId: 'throws' }],
        },
      ],
    });
  });
});
