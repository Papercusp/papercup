/**
 * Fixture for the `papercusp/no-raw-route-handlers` ESLint rule.
 *
 * THIS FILE INTENTIONALLY VIOLATES THE RULE — the path is itself in the
 * rule's allowlist (see `tools/eslint-rules/no-raw-route-handlers.js`)
 * so we can run the rule against this file in unit tests without
 * polluting the main `eslint .` exit code.
 *
 * The companion test (`tools/eslint-rules/__tests__/no-raw-route-handlers.test.js`)
 * removes the allowlist entry, runs the rule directly via `RuleTester`,
 * and asserts that each line below produces exactly one violation.
 */
import { Hono } from 'hono';

const app = new Hono();
app.get('/foo', () => new Response());
app.post('/bar', () => new Response());
app.use('/middleware', async (c, next) => { await next(); });
app.route('/sub', new Hono());

const harness = new Hono();
harness.get('/projects', () => new Response());
