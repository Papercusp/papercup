/**
 * Unit test for the `papercusp/no-bare-jsonb-cast` ESLint rule.
 *
 * Uses ESLint's built-in `RuleTester` to assert the rule flags + autofixes a
 * bare `${x}::jsonb` to `${x}::text::jsonb`, while leaving the already-correct
 * `::text::jsonb`, the postgres-js `sql.json()`/`pgJson()` helper forms, and
 * non-jsonb casts untouched.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, it } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const pnpmDir = path.join(__dirname, '..', '..', '..', 'node_modules', '.pnpm');
const eslintPkg = readdirSync(pnpmDir).find((d) => d.startsWith('eslint@'));
const eslintModule = path.join(pnpmDir, eslintPkg, 'node_modules', 'eslint');
const { RuleTester } = require(eslintModule);

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
