/**
 * Centralized mobile CORS — Phase E3 (endpoint-unification-2026-05-21).
 *
 * The legacy `_hono/mobile.ts` router carried its own `cors()` block
 * (apps/operator/app/api/_hono/mobile.ts). As the 33 mobile routes
 * migrate to `defineRoute` (Phase E4), each one would otherwise have to
 * re-declare CORS. Instead a route opts in with `mobile: true` and
 * `registerRoute` applies this middleware for it — one allowlist, one
 * place.
 *
 * Origin policy (unchanged from the legacy block): the paired-phone
 * clients live cross-origin —
 *   - `*://tauri.localhost`         — the desktop WebView
 *   - `http://localhost:*`          — browser-dev tabs
 *   - `http://127.0.0.1:*`          — same, IP form
 *   - `http://10.0.2.2:*`           — the Android emulator's host alias
 * Anything else is refused (empty `Access-Control-Allow-Origin`).
 *
 * `credentials: true` is required because mobile requests carry the
 * device JWT in the `Authorization` header; with credentials enabled the
 * origin MUST be echoed exactly (never `*`) — the function form does that.
 */

import { cors } from 'hono/cors';
import type { MiddlewareHandler } from 'hono';

/** Returns the request origin when it is an allowed mobile client, else ''. */
export function mobileOrigin(origin: string | undefined | null): string {
  if (!origin) return origin ?? '';
  if (origin.endsWith('://tauri.localhost')) return origin;
  if (origin.startsWith('http://localhost:')) return origin;
  if (origin.startsWith('http://127.0.0.1:')) return origin;
  if (origin.startsWith('http://10.0.2.2:')) return origin;
  return '';
}

/**
 * The shared mobile CORS middleware. Applied by `registerRoute` to any
 * `defineRoute` declaring `mobile: true`. Handles the OPTIONS preflight
 * itself (204 + headers) so the route file never needs an OPTIONS
 * handler.
 */
export const mobileCors: MiddlewareHandler = cors({
  origin: (origin) => mobileOrigin(origin),
  allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowHeaders: ['authorization', 'content-type', 'last-event-id', 'x-papercusp-run-id'],
  credentials: true,
  maxAge: 600,
});
