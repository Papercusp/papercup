/**
 * Centralized cross-origin CORS for the route layer.
 *
 * A route opts into cross-origin reachability with `cors: true` (default
 * allowlist) or `cors: { origins }` (explicit override); `registerRoute`
 * applies the matching middleware. Orthogonal to auth — see the `cors`
 * field on the route definition. Not device-specific: any cross-origin
 * client uses the same field.
 *
 * Default origin policy — the cross-origin clients (paired devices, the
 * desktop WebView, dev tabs):
 *   - `*://tauri.localhost`   — the desktop WebView
 *   - `http://localhost:*`    — browser-dev tabs
 *   - `http://127.0.0.1:*`    — same, IP form
 *   - `http://10.0.2.2:*`     — the Android emulator's host alias
 * Anything else is refused (empty `Access-Control-Allow-Origin`).
 *
 * `credentials: true` is required because device requests carry the JWT
 * in `Authorization`; with credentials enabled the origin MUST be echoed
 * exactly (never `*`) — the function form does that.
 */

import { cors } from 'hono/cors';
import type { MiddlewareHandler } from 'hono';

/** Default cross-origin allowlist test — returns the origin if allowed, else ''. */
export function defaultCorsOrigin(origin: string | undefined | null): string {
  if (!origin) return origin ?? '';
  if (origin.endsWith('://tauri.localhost')) return origin;
  if (origin.startsWith('http://localhost:')) return origin;
  if (origin.startsWith('http://127.0.0.1:')) return origin;
  if (origin.startsWith('http://10.0.2.2:')) return origin;
  return '';
}

/**
 * Build a CORS middleware. `origins` undefined → the default allowlist;
 * an explicit list → exact-match against it. Applied by `registerRoute`
 * for `cors`-enabled routes; handles the OPTIONS preflight itself (204 +
 * headers) so the route file never needs an OPTIONS handler.
 */
export function corsFor(origins?: readonly string[]): MiddlewareHandler {
  return cors({
    origin: origins
      ? (origin) => (origin && origins.includes(origin) ? origin : '')
      : (origin) => defaultCorsOrigin(origin),
    allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowHeaders: ['authorization', 'content-type', 'last-event-id', 'x-papercusp-run-id'],
    credentials: true,
    maxAge: 600,
  });
}
