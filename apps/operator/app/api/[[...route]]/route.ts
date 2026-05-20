/**
 * Next.js shim for the Hono API entrypoint.
 *
 * App construction (routes, middleware, plugin dispatcher) lives in
 * `../_hono/app.ts`; background-process side effects (FS watchers,
 * sweepers, voice WS, plugin-route population) live in
 * `../_hono/bootstrap.ts`. Other hosts (operator-vite Phase C via
 * `@hono/node-server`, in-process tests) consume the same two modules.
 *
 * `runBootstrap()` is idempotent — it's safe to call at module init even
 * though Next dev re-evaluates this file on HMR.
 */
import { handle } from 'hono/vercel';
import { app } from '../_hono/app';
import { runBootstrap } from '../_hono/bootstrap';

export const dynamic = 'force-dynamic';

runBootstrap();

export const GET = handle(app);
export const POST = handle(app);
export const PUT = handle(app);
export const PATCH = handle(app);
export const DELETE = handle(app);
export const OPTIONS = handle(app);
