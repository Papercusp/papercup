/**
 * Unit test for the `papercusp/no-raw-route-handlers` ESLint rule.
 *
 * Uses ESLint's built-in `RuleTester` to assert that the rule flags raw
 * Hono route registrations (`app.get`, `app.post`, `app.use`,
 * `app.route(literal, …)`, `new Hono()`) while leaving non-Hono code
 * untouched.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, it } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// pnpm hoists eslint into `.pnpm/`; resolve through any matching dir
// so the test stays working across version bumps.
const pnpmDir = path.join(__dirname, '..', '..', '..', 'node_modules', '.pnpm');
const eslintPkg = readdirSync(pnpmDir).find((d) => d.startsWith('eslint@'));
const eslintModule = path.join(pnpmDir, eslintPkg, 'node_modules', 'eslint');
const { RuleTester } = require(eslintModule);

const rule = require('../no-raw-route-handlers.js');

const tester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
  },
});

describe('papercusp/no-raw-route-handlers', () => {
  it('passes RuleTester valid/invalid cases', () => {
    tester.run('no-raw-route-handlers', rule, {
      valid: [
        { code: `defineRoute({ method: 'GET', path: '/foo', handler() {} })` },
        { code: `app.fetch(req)` },
        { code: `app.handle(req)` },
        { code: `app.then(() => {})` },
        // Map/Set/Promise locals — receiver doesn't match a Hono name.
        { code: `const byId = new Map(); byId.get('x'); byId.delete('y');` },
        { code: `Promise.all(ps)` },
        { code: `set.delete(item)` },
        { code: `cache.get(key)` },
        // Host-seam file — allowlisted.
        {
          code: `app.get('/x', () => new Response())`,
          filename: path.resolve(
            __dirname,
            '..',
            '..',
            '..',
            'apps',
            'operator',
            'bin',
            'host-app.ts',
          ),
        },
        // `app.route(nonString)` — chainable form, not a mount.
        { code: `app.route(other).get('/x', h)` },
        // `app.use()` with no args — not a real registration.
        { code: `app.use()` },
      ],
      invalid: [
        { code: `app.get('/foo', () => new Response())`, errors: [{ messageId: 'rawHandler' }] },
        { code: `app.post('/bar', () => new Response())`, errors: [{ messageId: 'rawHandler' }] },
        { code: `app.put('/x', h)`, errors: [{ messageId: 'rawHandler' }] },
        { code: `app.delete('/x', h)`, errors: [{ messageId: 'rawHandler' }] },
        { code: `app.patch('/x', h)`, errors: [{ messageId: 'rawHandler' }] },
        { code: `app.use('/middleware', mw)`, errors: [{ messageId: 'rawHandler' }] },
        { code: `app.route('/sub', subApp)`, errors: [{ messageId: 'rawHandler' }] },
        { code: `harness.get('/projects', h)`, errors: [{ messageId: 'rawHandler' }] },
        { code: `const h = new Hono()`, errors: [{ messageId: 'newHono' }] },
      ],
    });
  });
});
