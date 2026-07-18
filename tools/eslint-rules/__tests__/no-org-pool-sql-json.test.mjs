/**
 * Unit test for the `papercusp/no-org-pool-sql-json` ESLint rule (EI-10445).
 *
 * Uses ESLint's built-in `RuleTester` to assert the rule flags `sql.json(x)`
 * ONLY in a file that imports one of the throwing db-org accessors
 * (getOrgPg/getOrgPgApp/getHarnessPg) from @papercusp/db-org — and stays
 * silent for a file using a DIFFERENT pool (e.g. dock-layouts.ts's own fresh
 * postgres() client), where sql.json() is the CORRECT form.
 */
import { createRequire } from 'node:module';
import { describe, it } from 'vitest';

// npm workspaces hoists `eslint` to the repo-root node_modules — a plain
// require('eslint') resolves it via normal Node module-resolution walk-up
// (EI-10445: fixed the sibling no-bare-jsonb-cast.test.mjs's hardcoded
// node_modules/.pnpm/eslint@… path the same way — this is an npm-only repo,
// no pnpm store ever exists here, so that path never resolved).
const require = createRequire(import.meta.url);
const { RuleTester } = require('eslint');

const rule = require('../no-org-pool-sql-json.js');

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
