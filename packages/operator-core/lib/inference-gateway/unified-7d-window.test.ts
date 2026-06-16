/**
 * unified-7d-window.test.ts — the 7d (weekly) budget-window capture
 * (accounts-pool-tab-2026-06-15 P-006). Anthropic exposes a LONGER weekly limit
 * via `anthropic-ratelimit-unified-7d-*` alongside the 5h; this pins the gateway
 * parser + the account-pool projection storing it. Purely additive to the 5h path.
 */
import { describe, it, expect } from 'vitest';
import { parseUnified7dWindow } from './gateway';
import { recordAccountWindow, type AccountPool } from '../deployment/account-pool';

describe('parseUnified7dWindow (P-006)', () => {
  it('parses the 7d utilization + reset headers (reset → epoch ms)', () => {
    const out = parseUnified7dWindow({
      'anthropic-ratelimit-unified-7d-utilization': '0.42',
      'anthropic-ratelimit-unified-7d-reset': '1700000000',
    });
    expect(out.utilization7d).toBe(0.42);
    expect(out.windowResetAt7d).toBe(1_700_000_000 * 1000);
  });

  it('reads ONLY the 7d headers — ignores the 5h ones', () => {
    const out = parseUnified7dWindow({
      'anthropic-ratelimit-unified-5h-utilization': '0.9',
      'anthropic-ratelimit-unified-5h-reset': '1700000000',
    });
    expect(out).toEqual({});
  });

  it('returns empty for missing / malformed values', () => {
    expect(parseUnified7dWindow({})).toEqual({});
    expect(parseUnified7dWindow({ 'anthropic-ratelimit-unified-7d-utilization': 'NaN' })).toEqual({});
    expect(parseUnified7dWindow({ 'anthropic-ratelimit-unified-7d-reset': 'abc' })).toEqual({});
  });
});

describe('recordAccountWindow — 7d window storage (P-006)', () => {
  const base: AccountPool = {
    accounts: [
      {
        id: 'a1',
        credentialRef: 'token:/x/a1',
        boundTo: [],
        addedAt: 1,
        rate: { pausedUntil: 0, lastPenaltyAt: 0, penaltyCount: 0, windowStartedAt: 0 },
      },
    ],
  };

  it('stores the 7d utilization + reset alongside the 5h window', () => {
    const next = recordAccountWindow(
      base,
      'a1',
      { utilization: 0.5, windowResetAt: 111, utilization7d: 0.3, windowResetAt7d: 222 },
      999,
    );
    const r = next.accounts[0].rate;
    expect(r.utilization).toBe(0.5);
    expect(r.windowResetAt).toBe(111);
    expect(r.utilization7d).toBe(0.3);
    expect(r.windowResetAt7d).toBe(222);
    expect(r.utilizationAt).toBe(999);
  });

  it('preserves a prior 7d value when a later write omits it (5h-only update)', () => {
    const seeded = recordAccountWindow(base, 'a1', { utilization7d: 0.7, windowResetAt7d: 555 }, 1);
    const next = recordAccountWindow(seeded, 'a1', { utilization: 0.9 }, 2);
    expect(next.accounts[0].rate.utilization7d).toBe(0.7);
    expect(next.accounts[0].rate.windowResetAt7d).toBe(555);
  });
});
