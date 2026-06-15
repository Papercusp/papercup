/**
 * host-benign-errors.test.ts — the EI-714 / EI-12 host-survival classification.
 *
 * These predicates decide whether the hono-host process-level guards SWALLOW an
 * error (log, keep serving) or FAIL FAST (exit). Getting them wrong either way
 * is severe: too narrow → one malformed frame downs :3070 for the whole fleet
 * (EI-714); too broad → a real host bug is silently swallowed. So the boundary
 * is pinned here.
 */

import { describe, expect, it } from 'vitest';
import { isBenignHostError, isBenignRequestParse, isBenignStreamClose } from './host-benign-errors';

/** Produce a REAL JSON.parse SyntaxError (not a hand-built one) so the message
 *  matched is exactly what Node throws on the wire. */
function realJsonParseError(bad: string): unknown {
  try {
    JSON.parse(bad);
  } catch (e) {
    return e;
  }
  throw new Error('expected JSON.parse to throw');
}

describe('isBenignRequestParse (EI-714 — malformed JSON-RPC body must not crash the host)', () => {
  it('classifies the exact EI-714 repro body (stray trailing brace) as benign', () => {
    // The body from the issue: a valid object followed by an extra `}`.
    const e = realJsonParseError(
      '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"papercusp:list_workspaces","arguments":{}}}}',
    );
    expect(e).toBeInstanceOf(SyntaxError);
    expect(isBenignRequestParse(e)).toBe(true);
  });

  it('classifies every common JSON.parse failure shape as benign', () => {
    for (const bad of ['{bad', '', '{"a":}', '[1,2,', 'not json at all', '{"a":1}trailing']) {
      expect(isBenignRequestParse(realJsonParseError(bad)), `for input ${JSON.stringify(bad)}`).toBe(true);
    }
  });

  it('does NOT classify a non-SyntaxError as a benign parse error', () => {
    expect(isBenignRequestParse(new TypeError('cannot read x of undefined'))).toBe(false);
    expect(isBenignRequestParse(new Error('boom'))).toBe(false);
    expect(isBenignRequestParse(new RangeError('out of range'))).toBe(false);
    expect(isBenignRequestParse(null)).toBe(false);
    expect(isBenignRequestParse('a string')).toBe(false);
  });

  it('does NOT classify a non-JSON SyntaxError as benign (real code bugs still surface)', () => {
    // A SyntaxError whose message is unrelated to JSON parsing — e.g. a bad
    // regex/dynamic eval — must stay fatal so a genuine bug isn't masked.
    expect(isBenignRequestParse(new SyntaxError('Invalid regular expression: missing /'))).toBe(false);
  });
});

describe('isBenignStreamClose (EI-12 — mid-stream client disconnect must not crash the host)', () => {
  it('classifies the already-closed-controller class as benign', () => {
    const byCode = Object.assign(new Error('whatever'), { code: 'ERR_INVALID_STATE' });
    expect(isBenignStreamClose(byCode)).toBe(true);
    expect(isBenignStreamClose(new Error('Controller is already closed'))).toBe(true);
  });

  it('does NOT classify unrelated errors as a stream close', () => {
    expect(isBenignStreamClose(new Error('database connection lost'))).toBe(false);
    expect(isBenignStreamClose(null)).toBe(false);
  });
});

describe('isBenignHostError (the combined fail-fast boundary)', () => {
  it('is true for either benign class', () => {
    expect(isBenignHostError(realJsonParseError('{bad'))).toBe(true);
    expect(isBenignHostError(Object.assign(new Error('x'), { code: 'ERR_INVALID_STATE' }))).toBe(true);
  });

  it('is FALSE for a real host bug — the guard must still exit on these', () => {
    expect(isBenignHostError(new TypeError("Cannot read properties of undefined (reading 'foo')"))).toBe(false);
    expect(isBenignHostError(new Error('PG pool exhausted'))).toBe(false);
    expect(isBenignHostError(new RangeError('Maximum call stack size exceeded'))).toBe(false);
  });
});
