/**
 * Harness management API.
 *
 * All routes have been migrated off this module to `defineRoute`
 * handlers under `lib/endpoint-route/routes/harness/`. This stub
 * remains only so `_hono/app.ts` can keep the (now-empty) sub-app
 * mount until **A6** of `endpoint-hono-elimination-2026-05-21`
 * relocates the host seam and deletes the file.
 *
 * See `apps/operator/docs/plans/harness-finish-line-2026-05-21.md`
 * for the migration tracker.
 */
import { Hono } from 'hono';

export const harness = new Hono();
