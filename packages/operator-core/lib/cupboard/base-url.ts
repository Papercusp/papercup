/**
 * Cupboard server base-URL resolution (relocated from the retired
 * per-harness publish route — comb-retire-per-harness-sharing-2026-06-11 P-006).
 *
 *   - PAPERCUSP_CUPBOARD_URL env var if set (override / self-host)
 *   - else DEFAULT_CUPBOARD_URL — the branded origin the worker serves
 *
 * The default is the branded `cupboard.papercusp.com` (WI-38321). This REVERSES
 * cupboard-dead-default-host-2026-07-19, which had pointed the default at the
 * workers.dev origin because the branded host was then unbound: it resolved to
 * the papercusp.com apex A record (18.204.152.241, not Cloudflare), accepted TCP
 * :443 but never completed the TLS handshake, so every call hung to timeout and
 * surfaced an opaque `HTTP 503`. That plan wrote its own restore criterion —
 * "flip back once DNS actually points at the worker, verified by
 *   curl -sS -o /dev/null -w '%{http_code}' https://cupboard.papercusp.com/listings
 * returning 200 rather than hanging" — and that criterion is now MET.
 *
 * Measured 2026-09-05 before this change:
 *   - 1.1.1.1 and 8.8.8.8 both resolve cupboard.papercusp.com to 104.21.73.140 /
 *     172.67.145.145 (Cloudflare), not the old apex address.
 *   - GET /listings → HTTP 200 in 0.58s, `server: cloudflare` with a cf-ray.
 *   - Its body is BYTE-IDENTICAL to the workers.dev origin's (46,107 bytes,
 *     content-type application/json), which is what proves the branded host is
 *     serving THIS worker rather than a papercusp.com Pages catch-all. A 200
 *     alone would not have shown that — an SPA fallback also returns 200.
 *
 * Why branded is now the right default: the workers.dev hostname embeds the
 * owner's personal GitHub handle as the Cloudflare account subdomain, and it is
 * compiled into every shipped desktop bundle (serve.mjs, spa/assets/base-url-*.js).
 * It is on the wire for every user, so it cannot be scrubbed — only replaced.
 *
 * ⚠ The one property still worth watching: the binding's DURABILITY. The branded
 * host answers today, but this repo has never had a declarative record of that —
 * the `[[routes]] custom_domain` block in apps/operator-public/wrangler.toml was
 * commented out, so the binding existed only as a hand-made Cloudflare dashboard
 * entry, which is exactly how it silently died before. That block is uncommented
 * as part of WI-38321 so the next `wrangler deploy` reasserts it declaratively.
 * base-url.test.ts keeps a live reachability check against the default, so a
 * default that stops answering fails loudly instead of hanging every caller.
 */

/**
 * The branded hostname — the canonical Cupboard origin and the current default.
 */
export const BRANDED_CUPBOARD_URL = 'https://cupboard.papercusp.com';

/**
 * The origin the Cupboard worker serves (verified 2026-09-05: 200 in ~0.6s for
 * /listings, byte-identical payload to the workers.dev origin).
 *
 * Deliberately an alias of BRANDED_CUPBOARD_URL rather than a second string
 * literal: the workers.dev literal must not reappear in shipped bytes, since
 * removing it from the bundle is the entire point of WI-38321.
 */
export const DEFAULT_CUPBOARD_URL = BRANDED_CUPBOARD_URL;

export function resolveCupboardBaseUrl(): string {
  const env = process.env.PAPERCUSP_CUPBOARD_URL;
  return env && env.trim() ? env.trim().replace(/\/+$/, '') : DEFAULT_CUPBOARD_URL;
}
