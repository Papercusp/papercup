/**
 * Fixture for the `papercusp/no-raw-route-handlers` ESLint rule.
 *
 * THIS FILE INTENTIONALLY VIOLATES THE RULE — the path is itself in the
 * rule's allowlist (see `tools/eslint-rules/no-raw-route-handlers.js`)
 * so we can run the rule against this file in unit tests without
 * polluting the main `eslint .` exit code.
 *
 * The companion test lives at
 * `packages/operator-core/lib/eslint-rules/no-raw-route-handlers.test.ts`
 * (moved there by the EI-10445 follow-up — no vitest config owned this
 * `tools/` directory, so the tests here never ran). It runs the rule directly
 * via `RuleTester` on inline sources, and asserts this file's own path stays
 * allowlisted. Keep THIS fixture at THIS path: the allowlist entry in
 * `no-raw-route-handlers.js` matches it literally.
 */
import { Hono } from 'hono';

const app = new Hono();
app.get('/foo', () => new Response());
app.post('/bar', () => new Response());
app.use('/middleware', async (c, next) => { await next(); });
app.route('/sub', new Hono());

const harness = new Hono();
harness.get('/projects', () => new Response());
