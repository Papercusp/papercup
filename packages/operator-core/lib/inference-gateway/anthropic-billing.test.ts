/**
 * P-007 (anthropic-credits-gateway-2026-09-30) — billing-state parsing + credit-exhaustion walls.
 * Header and body shapes are the documented / CLI-observed ones (see anthropic-billing.ts header comment).
 */
import { describe, expect, it } from 'vitest';
import {
  CREDIT_WALL_DEFAULT_PAUSE_MS,
  classifyClaudeCreditWall,
  parseClaudeBillingState,
} from './anthropic-billing';

const errBody = (type: string, message: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type: 'error', error: { type, message, ...extra } });

describe('P-007 — subscription billing state from unified headers', () => {
  it('R-15: unified-status allowed with no overage in use parses to included', () => {
    expect(
      parseClaudeBillingState({
        'anthropic-ratelimit-unified-status': 'allowed',
        'anthropic-ratelimit-unified-overage-in-use': 'false',
        'anthropic-ratelimit-unified-representative-claim': 'five_hour',
      }),
    ).toEqual({ state: 'included', claim: 'five_hour' });
    expect(parseClaudeBillingState({ 'anthropic-ratelimit-unified-status': 'allowed_warning' })?.state).toBe('included');
  });

  it('R-16: overage in use parses to usage-credits', () => {
    const s = parseClaudeBillingState({
      'anthropic-ratelimit-unified-status': 'rejected',
      'anthropic-ratelimit-unified-overage-status': 'allowed',
      'anthropic-ratelimit-unified-overage-in-use': 'true',
      'anthropic-ratelimit-unified-overage-reset': '1790900000',
    });
    expect(s).toEqual({ state: 'usage-credits', resetAt: 1790900000 * 1000 });
    // Overage in use wins even if the unified status still reads allowed on this response.
    expect(
      parseClaudeBillingState({
        'anthropic-ratelimit-unified-status': 'allowed',
        'anthropic-ratelimit-unified-overage-in-use': 'true',
      })?.state,
    ).toBe('usage-credits');
  });

  it('R-16 (edge): allowance exhausted but overage allowed parses to usage-credits', () => {
    expect(
      parseClaudeBillingState({
        'anthropic-ratelimit-unified-status': 'rejected',
        'anthropic-ratelimit-unified-overage-status': 'allowed_warning',
      })?.state,
    ).toBe('usage-credits');
  });

  it('R-17: unified-status rejected + overage-status rejected parses to walled', () => {
    const s = parseClaudeBillingState({
      'anthropic-ratelimit-unified-status': 'rejected',
      'anthropic-ratelimit-unified-overage-status': 'rejected',
      'anthropic-ratelimit-unified-reset': '1790810000',
    });
    expect(s?.state).toBe('walled');
    expect(s?.resetAt).toBe(1790810000 * 1000);
  });

  it('R-18: a walled state carries the overage-disabled-reason header value as its reason', () => {
    const s = parseClaudeBillingState({
      'anthropic-ratelimit-unified-status': 'rejected',
      'anthropic-ratelimit-unified-overage-status': 'rejected',
      'anthropic-ratelimit-unified-overage-disabled-reason': 'out_of_credits',
    });
    expect(s).toMatchObject({ state: 'walled', reason: 'out_of_credits' });
  });

  it('a response with no unified-status header has no billing state (unknown is not included)', () => {
    expect(parseClaudeBillingState({ 'retry-after': '5' })).toBeNull();
    expect(parseClaudeBillingState({ 'anthropic-ratelimit-unified-status': '  ' })).toBeNull();
  });
});

describe('P-007 — API-key credit walls', () => {
  it('R-19: a 402 billing_error classifies as a credit wall', () => {
    expect(
      classifyClaudeCreditWall({
        status: 402,
        headers: {},
        body: errBody('billing_error', 'Your credit balance is too low to access the Anthropic API.'),
      }),
    ).toEqual({ cause: 'billing-error' });
    // An empty peek (timed out) is still Payment Required.
    expect(classifyClaudeCreditWall({ status: 402, headers: {}, body: '' })?.cause).toBe('billing-error');
  });

  it('R-20: a 429 whose error code is enforced_spend_limit_reached classifies as a credit wall', () => {
    const body = errBody('rate_limit_error', 'You have reached your spend limit.', {
      details: { error_code: 'enforced_spend_limit_reached' },
    });
    expect(classifyClaudeCreditWall({ status: 429, headers: {}, body })).toEqual({ cause: 'spend-limit' });
    // A truncated (non-JSON) peek still names the code.
    expect(classifyClaudeCreditWall({ status: 429, headers: {}, body: body.slice(0, -3) })?.cause).toBe('spend-limit');
  });

  it('R-21: a 400 stating the specified API usage limits were reached classifies as a credit wall', () => {
    const wall = classifyClaudeCreditWall({
      status: 400,
      headers: {},
      body: errBody(
        'invalid_request_error',
        'You have reached your specified API usage limits. You will regain access on 2026-10-01 at 00:00 UTC.',
      ),
    });
    expect(wall).toEqual({ cause: 'api-usage-limit', resetAt: Date.parse('2026-10-01T00:00:00Z') });
    expect(
      classifyClaudeCreditWall({
        status: 400,
        headers: {},
        body: errBody('invalid_request_error', 'You have reached your specified workspace API usage limits.'),
      })?.cause,
    ).toBe('api-usage-limit');
  });

  it('R-21 (negative): an ordinary 400 is not a credit wall', () => {
    expect(
      classifyClaudeCreditWall({ status: 400, headers: {}, body: errBody('invalid_request_error', 'max_tokens: must be positive') }),
    ).toBeNull();
  });

  it('R-22: an api-key 429 with retry-after and no spend-limit code is not a credit wall', () => {
    expect(
      classifyClaudeCreditWall({
        status: 429,
        headers: { 'retry-after': '12' },
        body: errBody('rate_limit_error', 'This request would exceed the rate limit for your organization of 50 requests per minute.'),
      }),
    ).toBeNull();
  });

  it('non-billing statuses never classify as credit walls', () => {
    for (const status of [200, 401, 403, 500, 529]) {
      expect(classifyClaudeCreditWall({ status, headers: {}, body: errBody('billing_error', 'x') })).toBeNull();
    }
    expect(CREDIT_WALL_DEFAULT_PAUSE_MS).toBeGreaterThan(0);
  });
});
