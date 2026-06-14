import { describe, it, expect } from 'vitest';
import { createFailoverPool } from './account-failover';
import type { ActiveAccount } from './gateway';

const acct = (id: string): ActiveAccount => ({ accountId: id, token: async () => `${id}-tok`, invalidateToken: () => {} });

describe('createFailoverPool (EI-535)', () => {
  it('throws with an empty account list', () => {
    expect(() => createFailoverPool([])).toThrow(/at least one account/);
  });

  it('starts on the first (primary) account', () => {
    const p = createFailoverPool([acct('a'), acct('b')]);
    expect(p.active().accountId).toBe('a');
  });

  it('fails over to the next available account on exhaustion + makes it active', () => {
    const t = 1000;
    const p = createFailoverPool([acct('a'), acct('b')], { now: () => t });
    const next = p.onExhausted('a', t + 3_600_000);
    expect(next?.accountId).toBe('b');
    expect(p.active().accountId).toBe('b');
  });

  it('is idempotent under concurrent 429s — exhausting an already-rotated-away id is a no-op', () => {
    const t = 1000;
    const p = createFailoverPool([acct('a'), acct('b')], { now: () => t });
    p.onExhausted('a', t + 3_600_000); // now on b
    expect(p.onExhausted('a', t + 3_600_000)?.accountId).toBe('b'); // straggler for 'a' → stays on b
    expect(p.active().accountId).toBe('b');
  });

  it('returns null + stays put when ALL accounts are exhausted', () => {
    const t = 1000;
    const p = createFailoverPool([acct('a'), acct('b')], { now: () => t });
    p.onExhausted('a', t + 3_600_000); // → b
    expect(p.onExhausted('b', t + 3_600_000)).toBeNull(); // a still exhausted → none available
    expect(p.active().accountId).toBe('b'); // stays on the (now-exhausted) last active
  });

  it('an exhausted account rejoins the rotation once its reset passes', () => {
    let t = 1000;
    const p = createFailoverPool([acct('a'), acct('b')], { now: () => t });
    p.onExhausted('a', t + 1000); // a exhausted until t+1000 → on b
    expect(p.onExhausted('b', t + 3_600_000)).toBeNull(); // a not yet recovered
    t += 2000; // advance past a's reset
    expect(p.onExhausted('b', t + 3_600_000)?.accountId).toBe('a'); // recovered a is picked
  });

  it('round-robins across 3 accounts', () => {
    const t = 1000;
    const p = createFailoverPool([acct('a'), acct('b'), acct('c')], { now: () => t });
    expect(p.onExhausted('a', t + 9_000_000)?.accountId).toBe('b');
    expect(p.onExhausted('b', t + 9_000_000)?.accountId).toBe('c');
    expect(p.onExhausted('c', t + 9_000_000)).toBeNull(); // all exhausted
  });

  it('defaults to a 5h window when the reset is missing / already past', () => {
    let t = 1000;
    const p = createFailoverPool([acct('a'), acct('b')], { now: () => t });
    p.onExhausted('a', 0); // past reset → 5h default
    t += 60_000; // a minute later, a is still inside its 5h window
    p.onExhausted('b', t + 100); // b exhausted, a not recovered → null
    expect(p.active().accountId).toBe('b');
  });
});
