/**
 * Unit test for the `papercusp/no-bare-jsonb-cast` ESLint rule.
 *
 * Uses ESLint's built-in `RuleTester` to assert the rule flags + autofixes a
 * bare `${x}::jsonb` to `${x}::text::jsonb`, while leaving the already-correct
 * `::text::jsonb`, the postgres-js `sql.json()`/`pgJson()` helper forms, and
 * non-jsonb casts untouched.
 */
import { createRequire } from 'node:module';
import { describe, it } from 'vitest';

// npm workspaces hoists `eslint` to the repo-root node_modules — a plain
// require('eslint') resolves it via normal Node module-resolution walk-up
// (EI-10445: the previous node_modules/.pnpm/eslint@… scan never resolved in
// this npm-only repo — no pnpm store exists here at all — so this test file
// silently ran 0 tests, ENOENT'ing before RuleTester.run ever executed).
const require = createRequire(import.meta.url);
const { RuleTester } = require('eslint');

const rule = require('../no-bare-jsonb-cast.js');

const tester = new RuleTester({
  languageOptions: { ecmaVersion: 2022, sourceType: 'module' },
});

describe('papercusp/no-bare-jsonb-cast', () => {
  it('passes RuleTester valid/invalid cases', () => {
    tester.run('no-bare-jsonb-cast', rule, {
      valid: [
        // Already correct.
        { code: 'sql`INSERT INTO t (p) VALUES (${JSON.stringify(x)}::text::jsonb)`' },
        // postgres-js json-helper forms — a different binding strategy.
        { code: 'sql`INSERT INTO t (p) VALUES (${sql.json(x)}::jsonb)`' },
        { code: 'sql`INSERT INTO t (p) VALUES (${pg.json(x)}::jsonb)`' },
        { code: 'sql`INSERT INTO t (p) VALUES (${pgJson(ctx.pg, x)}::jsonb)`' },
        // Longer type names must not be touched.
        { code: 'sql`SELECT ${x}::jsonb[]`' },
        // Other casts.
        { code: 'sql`WHERE id = ${id}::uuid`' },
        { code: 'sql`AND n = ${n}::int`' },
        // No template at all.
        { code: 'const s = "x::jsonb";' },
      ],
      invalid: [
        {
          code: 'sql`INSERT INTO t (p) VALUES (${JSON.stringify(x)}::jsonb)`',
          output: 'sql`INSERT INTO t (p) VALUES (${JSON.stringify(x)}::text::jsonb)`',
          errors: [{ messageId: 'bare' }],
        },
        {
          code: 'sql`INSERT INTO t (a, b) VALUES (${x}::jsonb, ${y}::jsonb)`',
          output: 'sql`INSERT INTO t (a, b) VALUES (${x}::text::jsonb, ${y}::text::jsonb)`',
          errors: [{ messageId: 'bare' }, { messageId: 'bare' }],
        },
        {
          // dynamic placeholder build ($N::jsonb) — also flagged + fixed.
          code: 'const ph = cols.map((c, i) => `$${i + 1}::jsonb`)',
          output: 'const ph = cols.map((c, i) => `$${i + 1}::text::jsonb`)',
          errors: [{ messageId: 'bare' }],
        },
      ],
    });
  });
});
