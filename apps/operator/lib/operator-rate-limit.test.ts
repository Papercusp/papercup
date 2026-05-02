import { afterEach, describe, expect, it } from 'vitest';
import { checkRate, record503, recordSuccess, resetBreaker, inspectState } from './operator-rate-limit';

const WS = `test-ws-${Math.random().toString(36).slice(2)}`;

afterEach(() => {
  resetBreaker(WS);
});

describe('checkRate', () => {
  it('allows up to the limit per window', () => {
    expect(checkRate(WS, 2).allowed).toBe(true);
    expect(checkRate(WS, 2).allowed).toBe(true);
    const r = checkRate(WS, 2);
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('rate-limit');
    expect(r.retryAfterSec).toBeGreaterThan(0);
  });
});

describe('circuit breaker', () => {
  it('opens after 5 consecutive 503s', () => {
    for (let i = 0; i < 5; i++) record503(WS);
    const r = checkRate(WS);
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('circuit-breaker');
    expect(inspectState(WS).breakerUntilMs).toBeGreaterThan(Date.now());
  });

  it('recordSuccess resets the consecutive counter (but not an open breaker)', () => {
    record503(WS);
    record503(WS);
    recordSuccess(WS);
    expect(inspectState(WS).consecutive503).toBe(0);
  });
});
