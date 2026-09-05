/**
 * Cupboard base-URL resolution (relocated with the module from the retired
 * per-harness publish route — comb-retire-per-harness-sharing-2026-06-11 P-006).
 *
 * The "default must be REACHABLE" guards are cupboard-dead-default-host-2026-07-19:
 * the default used to be the branded `cupboard.papercusp.com`, which resolves to
 * the papercusp.com apex (not Cloudflare) and hangs the TLS handshake. Every
 * process without a PAPERCUSP_CUPBOARD_URL override therefore ate a full fetch
 * timeout and surfaced an opaque HTTP 503 on every Cupboard call. These tests
 * exist so a dead default cannot silently come back.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BRANDED_CUPBOARD_URL, DEFAULT_CUPBOARD_URL, resolveCupboardBaseUrl } from './base-url';

const ORIGINAL_ENV = process.env.PAPERCUSP_CUPBOARD_URL;
beforeEach(() => { delete process.env.PAPERCUSP_CUPBOARD_URL; });
afterEach(() => {
  if (ORIGINAL_ENV !== undefined) process.env.PAPERCUSP_CUPBOARD_URL = ORIGINAL_ENV;
  else delete process.env.PAPERCUSP_CUPBOARD_URL;
});

describe('resolveCupboardBaseUrl', () => {
  it('defaults to the host the worker actually serves when no env var', () => {
    expect(resolveCupboardBaseUrl()).toBe(DEFAULT_CUPBOARD_URL);
  });

  it('uses PAPERCUSP_CUPBOARD_URL when set', () => {
    process.env.PAPERCUSP_CUPBOARD_URL = 'https://cupboard.example.com';
    expect(resolveCupboardBaseUrl()).toBe('https://cupboard.example.com');
  });

  it('strips trailing slashes', () => {
    process.env.PAPERCUSP_CUPBOARD_URL = 'https://cupboard.example.com/';
    expect(resolveCupboardBaseUrl()).toBe('https://cupboard.example.com');
  });

  it('falls back to default on blank env var', () => {
    process.env.PAPERCUSP_CUPBOARD_URL = '   ';
    expect(resolveCupboardBaseUrl()).toBe(DEFAULT_CUPBOARD_URL);
  });
});

describe('the shipped default must not carry account identity (WI-38321)', () => {
  it('defaults to the branded host', () => {
    expect(DEFAULT_CUPBOARD_URL).toBe(BRANDED_CUPBOARD_URL);
  });

  it('never defaults to an account-subdomain origin, whatever it is set to', () => {
    // A *.workers.dev origin embeds the Cloudflare ACCOUNT subdomain — here, the
    // owner's GitHub handle — and this constant is compiled into serve.mjs and
    // spa/assets/base-url-*.js in every desktop bundle, which is what put it in
    // front of the release identity gate (WI-38233 → WI-38321).
    //
    // Asserted against the VALUE's shape, not against one known-bad literal, so
    // a different account or a renamed worker cannot quietly reintroduce it.
    expect(new URL(DEFAULT_CUPBOARD_URL).hostname.endsWith('.workers.dev')).toBe(false);
  });

  it('does not hardcode any account-subdomain origin as a fallback either', () => {
    // The tempting "fix" for a local hang is to reintroduce the worker origin as
    // a fallback constant. That ships the handle again just as surely as the
    // default did. A local network exception belongs in PAPERCUSP_CUPBOARD_URL,
    // which resolveCupboardBaseUrl() already honours.
    expect(BRANDED_CUPBOARD_URL.includes('workers.dev')).toBe(false);
  });

  it('is a well-formed https origin with no trailing slash or path', () => {
    const url = new URL(DEFAULT_CUPBOARD_URL);
    expect(url.protocol).toBe('https:');
    expect(url.pathname).toBe('/');
    expect(DEFAULT_CUPBOARD_URL.endsWith('/')).toBe(false);
    // A bare origin — callers append `/listings`, `/listings/:id`, … directly.
    expect(DEFAULT_CUPBOARD_URL).toBe(`${url.protocol}//${url.host}`);
  });
});

/**
 * Opt-in LIVE reachability check. Off by default so unit runs stay hermetic and
 * CI never flakes on the public network; run it deliberately to confirm the
 * configured default still answers:
 *
 *   PAPERCUSP_CUPBOARD_LIVE_CHECK=1 npm run test:file -- packages/operator-core/lib/cupboard/base-url.test.ts
 */
const LIVE = process.env.PAPERCUSP_CUPBOARD_LIVE_CHECK === '1';
describe.skipIf(!LIVE)('live reachability of the default host', () => {
  it('serves /listings with a 200 well inside the proxy timeout', async () => {
    const res = await fetch(`${DEFAULT_CUPBOARD_URL}/listings?limit=1`, {
      headers: { 'User-Agent': 'papercusp-operator/1' },
      signal: AbortSignal.timeout(8_000),
    });
    expect(res.status).toBe(200);
  }, 15_000);
});
