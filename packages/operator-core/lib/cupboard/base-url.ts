/**
 * Cupboard server base-URL resolution (relocated from the retired
 * per-harness publish route — comb-retire-per-harness-sharing-2026-06-11 P-006).
 *
 *   - PAPERCUSP_CUPBOARD_URL env var if set (override / self-host)
 *   - else DEFAULT_CUPBOARD_URL — the origin the worker actually serves
 *
 * ⚠ The default is deliberately the workers.dev origin, NOT the branded
 * `cupboard.papercusp.com` (cupboard-dead-default-host-2026-07-19). The branded
 * hostname resolves to the `papercusp.com` apex A record (18.204.152.241 — not
 * Cloudflare); it accepts TCP :443 but never completes the TLS handshake, so
 * every request against it HANGS until the caller's timeout and surfaces as an
 * opaque `HTTP 503` ("Couldn't reach the Cupboard server"). It was never bound
 * to the worker declaratively — the `[[routes]] custom_domain` block in
 * apps/operator-public/wrangler.toml is commented out — so it only ever worked
 * while someone had wired it by hand in the Cloudflare dashboard.
 *
 * A dead DEFAULT is far worse than an unbranded one: every process WITHOUT an
 * env override (a packaged desktop app, a fresh service launch) silently ate a
 * full timeout on every Cupboard call. Restore BRANDED_CUPBOARD_URL as the
 * default once DNS actually points at the worker — verify with
 *   curl -sS -o /dev/null -w '%{http_code}' https://cupboard.papercusp.com/listings
 * returning 200 rather than hanging. base-url.test.ts pins the default against
 * the known-unreachable host so it cannot silently drift back.
 */

/**
 * The branded hostname. NOT reachable today (see the note above) — kept named
 * so the intended canonical host stays discoverable, and so the guard test can
 * assert we are not defaulting to it while it is dead.
 */
export const BRANDED_CUPBOARD_URL = 'https://cupboard.papercusp.com';

/**
 * The origin the Cupboard worker actually serves (verified 2026-07-19: 200 in
 * ~0.3s for both /listings and /listings/:id).
 */
export const DEFAULT_CUPBOARD_URL = 'https://papercusp-cupboard.aviynw.workers.dev';

export function resolveCupboardBaseUrl(): string {
  const env = process.env.PAPERCUSP_CUPBOARD_URL;
  return env && env.trim() ? env.trim().replace(/\/+$/, '') : DEFAULT_CUPBOARD_URL;
}
