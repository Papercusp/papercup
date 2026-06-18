import { describe, it, expect } from 'vitest';

import { callWithRetry, isAuthFailure } from '../targets/su';

/**
 * Regression for the rotated-OAuth-token failure that aborted a su-target run mid-suite
 * (EI-281, hand-rolled-loop half): the SUT shares ONE Claude-Max session with the whole
 * fleet, which refreshes ~/.claude/.credentials.json frequently, so a token read at
 * turn-start can be stale by the next call → 401. `callWithRetry` must re-read the
 * credential + rebuild the client on a 401/403 (its own budget), not fail the scenario.
 */

function err(status: number, msg = 'error'): Error {
  const e = new Error(`${status} ${msg}`) as Error & { status: number };
  e.status = status;
  return e;
}
const OK = { content: [{ type: 'text' as const, text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } };
const noSleep = async (): Promise<void> => {};

describe('su target callWithRetry — rotated-token (EI-281) handling', () => {
  it('recovers from a mid-run 401 by re-reading the credential + rebuilding the client', async () => {
    let builds = 0;
    const makeClient = () => {
      const b = builds++;
      // The first two (re)builds carry the stale rotated-away token (401); the file then settles.
      return { messages: { create: async () => { if (b < 2) throw err(401, 'authentication_error'); return OK; } } };
    };
    const resp = await callWithRetry(makeClient, {}, new AbortController().signal, noSleep);
    expect(resp).toBe(OK);
    expect(builds).toBe(3); // initial build + 2 rebuilds (one per 401), then success
  });

  it('gives up after the auth-reread budget when the credential is genuinely dead (401 forever)', async () => {
    let builds = 0;
    const makeClient = () => { builds++; return { messages: { create: async () => { throw err(401); } } }; };
    await expect(callWithRetry(makeClient, {}, new AbortController().signal, noSleep)).rejects.toThrow();
    expect(builds).toBe(5); // initial + AUTH_REREAD_MAX(4) re-reads, then throws (not an infinite loop)
  });

  it('still retries a transient 429 by REUSING the client (no rebuild — existing behavior preserved)', async () => {
    let builds = 0;
    let creates = 0;
    const makeClient = () => { builds++; return { messages: { create: async () => { creates++; if (creates <= 2) throw err(429); return OK; } } }; };
    const resp = await callWithRetry(makeClient, {}, new AbortController().signal, noSleep);
    expect(resp).toBe(OK);
    expect(creates).toBe(3); // 2× 429 then success
    expect(builds).toBe(1); // a 429 is transient → retried on the SAME client, never a credential re-read
  });

  it('isAuthFailure classifies 401/403 + auth messages, but not a 429', () => {
    expect(isAuthFailure(err(401))).toBe(true);
    expect(isAuthFailure(err(403))).toBe(true);
    expect(isAuthFailure(new Error('401 {"type":"authentication_error"}'))).toBe(true);
    expect(isAuthFailure(new Error('Invalid authentication credentials'))).toBe(true);
    expect(isAuthFailure(err(429))).toBe(false);
    expect(isAuthFailure(new Error('rate_limit_error'))).toBe(false);
  });
});
