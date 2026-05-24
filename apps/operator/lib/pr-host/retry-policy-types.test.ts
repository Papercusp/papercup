import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RETRY_POLICY,
  EXPECTED_TRANSIENT_ERROR_KINDS,
  computeBackoffMs,
  continuesSequence,
  decideRetry,
  totalBackoffBudgetMs,
  type RetryContext,
} from './retry-policy-types';
import type { PrHostError } from './types';

function err(kind: PrHostError['kind'], extra: Partial<PrHostError> = {}): PrHostError {
  return { kind, message: kind, ...extra };
}

function ctx(over: Partial<RetryContext> = {}): RetryContext {
  return {
    attempt: 0,
    oauth_refresh_attempted: false,
    now: 1716_000_000_000,
    random: 0.5,
    ...over,
  };
}

describe('decideRetry — unauthorized handling', () => {
  it('first 401 → oauth_refresh_then_retry', () => {
    expect(decideRetry(err('unauthorized'), ctx())).toEqual({
      kind: 'oauth_refresh_then_retry',
    });
  });

  it('401 after refresh attempted → alert_user', () => {
    expect(
      decideRetry(err('unauthorized'), ctx({ oauth_refresh_attempted: true })),
    ).toEqual({
      kind: 'alert_user',
      reason: 'oauth_refresh_failed_user_action_needed',
    });
  });
});

describe('decideRetry — rate_limited handling', () => {
  it('honors retry_after_ms when set (P-042d)', () => {
    const d = decideRetry(
      err('rate_limited', { retry_after_ms: 30_000 }),
      ctx(),
    );
    expect(d.kind).toBe('wait');
    expect(d.kind === 'wait' && d.delay_ms).toBe(30_000);
    expect(d.kind === 'wait' && d.reason).toBe('rate_limit_reset_window');
  });

  it('falls back to exponential backoff when retry_after_ms absent', () => {
    const d = decideRetry(err('rate_limited'), ctx({ attempt: 0 }));
    expect(d.kind).toBe('wait');
    expect(d.kind === 'wait' && d.reason).toBe('exponential_backoff_5xx');
  });
});

describe('decideRetry — server_error / network_error', () => {
  it('server_error → exponential backoff', () => {
    const d = decideRetry(err('server_error'), ctx({ attempt: 0 }));
    expect(d.kind).toBe('wait');
    expect(d.kind === 'wait' && d.reason).toBe('exponential_backoff_5xx');
  });

  it('network_error → exponential backoff (transient_network reason)', () => {
    const d = decideRetry(err('network_error'), ctx({ attempt: 0 }));
    expect(d.kind).toBe('wait');
    expect(d.kind === 'wait' && d.reason).toBe('transient_network');
  });
});

describe('decideRetry — terminal errors', () => {
  it('not_found → give_up with reason=not_found (P-042f demote-to-gone)', () => {
    expect(decideRetry(err('not_found'), ctx())).toEqual({
      kind: 'give_up',
      reason: 'not_found',
    });
  });

  it('forbidden / conflict / validation / unsupported → give_up terminal', () => {
    for (const kind of ['forbidden', 'conflict', 'validation', 'unsupported'] as const) {
      const d = decideRetry(err(kind), ctx());
      expect(d.kind).toBe('give_up');
      expect(d.kind === 'give_up' && d.reason).toBe('terminal_error');
    }
  });
});

describe('decideRetry — max-attempts guard', () => {
  it('any error → give_up when attempt >= max_attempts', () => {
    const c = ctx({ attempt: DEFAULT_RETRY_POLICY.max_attempts });
    for (const kind of ['rate_limited', 'server_error', 'network_error', 'unauthorized'] as const) {
      const d = decideRetry(err(kind), c);
      expect(d.kind).toBe('give_up');
      expect(d.kind === 'give_up' && d.reason).toBe('max_attempts_exceeded');
    }
  });

  it('one attempt below the cap still retries', () => {
    const c = ctx({ attempt: DEFAULT_RETRY_POLICY.max_attempts - 1 });
    const d = decideRetry(err('server_error'), c);
    expect(d.kind).toBe('wait');
  });
});

describe('computeBackoffMs', () => {
  it('returns initial backoff at attempt 0 (random=0.5 → no jitter)', () => {
    expect(computeBackoffMs(0, 0.5)).toBe(DEFAULT_RETRY_POLICY.initial_backoff_ms);
  });

  it('doubles each attempt before the cap', () => {
    expect(computeBackoffMs(0, 0.5)).toBe(1000);
    expect(computeBackoffMs(1, 0.5)).toBe(2000);
    expect(computeBackoffMs(2, 0.5)).toBe(4000);
    expect(computeBackoffMs(3, 0.5)).toBe(8000);
    expect(computeBackoffMs(4, 0.5)).toBe(16000);
    expect(computeBackoffMs(5, 0.5)).toBe(32000);
    expect(computeBackoffMs(6, 0.5)).toBe(64000);
    expect(computeBackoffMs(7, 0.5)).toBe(128000);
  });

  it('caps at max_backoff_ms (5min default)', () => {
    expect(computeBackoffMs(20, 0.5)).toBe(DEFAULT_RETRY_POLICY.max_backoff_ms);
    expect(computeBackoffMs(100, 0.5)).toBe(DEFAULT_RETRY_POLICY.max_backoff_ms);
  });

  it('jitter expands proportionally', () => {
    // jitter_fraction=0.1, random=1.0 → +10%
    expect(computeBackoffMs(0, 1.0)).toBe(1100);
    // jitter_fraction=0.1, random=0.0 → -10%
    expect(computeBackoffMs(0, 0.0)).toBe(900);
  });

  it('respects custom config', () => {
    const custom = {
      ...DEFAULT_RETRY_POLICY,
      initial_backoff_ms: 500,
      backoff_multiplier: 3,
      max_backoff_ms: 60_000,
      jitter_fraction: 0,
    };
    expect(computeBackoffMs(0, 0.5, custom)).toBe(500);
    expect(computeBackoffMs(1, 0.5, custom)).toBe(1500);
    expect(computeBackoffMs(2, 0.5, custom)).toBe(4500);
    expect(computeBackoffMs(20, 0.5, custom)).toBe(60_000); // capped
  });

  it('never returns a negative delay', () => {
    expect(computeBackoffMs(0, 0)).toBeGreaterThanOrEqual(0);
    expect(computeBackoffMs(0, 1)).toBeGreaterThanOrEqual(0);
  });
});

describe('continuesSequence', () => {
  it('returns true for wait + oauth_refresh_then_retry', () => {
    expect(continuesSequence({ kind: 'wait', delay_ms: 1, reason: 'transient_network' })).toBe(true);
    expect(continuesSequence({ kind: 'oauth_refresh_then_retry' })).toBe(true);
  });

  it('returns false for terminal decisions', () => {
    expect(continuesSequence({ kind: 'give_up', reason: 'terminal_error' })).toBe(false);
    expect(continuesSequence({ kind: 'alert_user', reason: 'oauth_refresh_failed_user_action_needed' })).toBe(false);
  });
});

describe('totalBackoffBudgetMs', () => {
  it('sums every attempt up to max_attempts', () => {
    const total = totalBackoffBudgetMs();
    // With default 8 attempts: 1+2+4+8+16+32+64+128 = 255s ≈ 4.25 min
    expect(total).toBe((1 + 2 + 4 + 8 + 16 + 32 + 64 + 128) * 1000);
  });
});

describe('EXPECTED_TRANSIENT_ERROR_KINDS', () => {
  it('lists rate_limited / server_error / network_error / unauthorized', () => {
    expect([...EXPECTED_TRANSIENT_ERROR_KINDS]).toEqual([
      'rate_limited',
      'server_error',
      'network_error',
      'unauthorized',
    ]);
  });

  it('does NOT include terminal kinds', () => {
    expect([...EXPECTED_TRANSIENT_ERROR_KINDS]).not.toContain('not_found');
    expect([...EXPECTED_TRANSIENT_ERROR_KINDS]).not.toContain('forbidden');
    expect([...EXPECTED_TRANSIENT_ERROR_KINDS]).not.toContain('validation');
  });
});

describe('DEFAULT_RETRY_POLICY constants per P-042c', () => {
  it('max_backoff_ms is 5 minutes', () => {
    expect(DEFAULT_RETRY_POLICY.max_backoff_ms).toBe(5 * 60 * 1000);
  });

  it('backoff_multiplier is 2 (doubling)', () => {
    expect(DEFAULT_RETRY_POLICY.backoff_multiplier).toBe(2);
  });

  it('initial_backoff_ms is 1 second', () => {
    expect(DEFAULT_RETRY_POLICY.initial_backoff_ms).toBe(1000);
  });

  it('jitter_fraction is in [0, 1)', () => {
    expect(DEFAULT_RETRY_POLICY.jitter_fraction).toBeGreaterThanOrEqual(0);
    expect(DEFAULT_RETRY_POLICY.jitter_fraction).toBeLessThan(1);
  });
});
