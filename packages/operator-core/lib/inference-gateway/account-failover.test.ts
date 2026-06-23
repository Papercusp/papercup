import { describe, it, expect } from 'vitest';
import { createFailoverPool } from './account-failover';
import type { ActiveAccount } from './gateway';

const acct = (id: string): ActiveAccount => ({ accountId: id, token: async () => `${id}-tok`, invalidateToken: () => {} });

describe('createFailoverPool (EI-535) — load distribution', () => {
  it('throws with an empty account list', () => {
    expect(() => createFailoverPool([])).toThrow(/at least one account/);
  });

  it('round-robins active() across the whole pool so unpinned egress spreads (2026-06-18 concentration bug)', () => {
    const p = createFailoverPool([acct('a'), acct('b'), acct('c')]);
    // Successive unpinned requests cycle through every account instead of pinning to one.
    expect(p.active().accountId).toBe('a');
    expect(p.active().accountId).toBe('b');
    expect(p.active().accountId).toBe('c');
    expect(p.active().accountId).toBe('a');
  });

  it('a single-account pool always returns that account', () => {
    const p = createFailoverPool([acct('solo')]);
    expect(p.active().accountId).toBe('solo');
    expect(p.active().accountId).toBe('solo');
  });

  it('active() SKIPS an exhausted account so load only spreads across accounts with budget', () => {
    const t = 1000;
    const p = createFailoverPool([acct('a'), acct('b'), acct('c')], { now: () => t });
    p.onExhausted('b', t + 3_600_000); // b out of rotation
    const seen = new Set([p.active().accountId, p.active().accountId, p.active().accountId, p.active().accountId]);
    expect(seen.has('b')).toBe(false);
    expect(seen.has('a')).toBe(true);
    expect(seen.has('c')).toBe(true);
  });
});

describe('createFailoverPool — onExhausted failover', () => {
  it('returns the next DIFFERENT account that still has budget', () => {
    const t = 1000;
    const p = createFailoverPool([acct('a'), acct('b')], { now: () => t });
    const next = p.onExhausted('a', t + 3_600_000);
    expect(next?.accountId).toBe('b');
  });

  it('never returns the exhausted account itself', () => {
    const t = 1000;
    const p = createFailoverPool([acct('a'), acct('b'), acct('c')], { now: () => t });
    for (let i = 0; i < 6; i++) {
      const next = p.onExhausted('a', t + 3_600_000);
      expect(next?.accountId).not.toBe('a');
    }
  });

  it('returns null when ALL OTHER accounts are exhausted', () => {
    const t = 1000;
    const p = createFailoverPool([acct('a'), acct('b')], { now: () => t });
    p.onExhausted('a', t + 3_600_000);
    expect(p.onExhausted('b', t + 3_600_000)).toBeNull(); // a still exhausted → none other available
  });

  it('an exhausted account rejoins rotation once its reset passes', () => {
    let t = 1000;
    const p = createFailoverPool([acct('a'), acct('b')], { now: () => t });
    p.onExhausted('a', t + 1000); // a exhausted until t+1000
    expect(p.onExhausted('b', t + 3_600_000)).toBeNull(); // a not yet recovered, b just exhausted
    t += 2000; // advance past a's reset
    expect(p.onExhausted('b', t + 3_600_000)?.accountId).toBe('a'); // recovered a is picked
  });

  it('defaults to a 5h window when the reset is missing / already past', () => {
    let t = 1000;
    const p = createFailoverPool([acct('a'), acct('b')], { now: () => t });
    p.onExhausted('a', 0); // past reset → 5h default
    t += 60_000; // a minute later, a is still inside its 5h window
    expect(p.onExhausted('b', t + 100)).toBeNull(); // b exhausted, a not recovered → none available
  });
});

describe('createFailoverPool — select() header-pinned routing (x-papercusp-account)', () => {
  it('returns the named pool entry without disturbing the round-robin cursor', () => {
    const p = createFailoverPool([acct('a'), acct('b'), acct('c')]);
    expect(p.select!('b')?.accountId).toBe('b');
    expect(p.select!('c')?.accountId).toBe('c');
    // select is a pure lookup — it does not advance the round-robin cursor.
    expect(p.active().accountId).toBe('a');
  });

  it('returns null for an unknown account id (the gateway then falls back to active())', () => {
    const p = createFailoverPool([acct('a'), acct('b')]);
    expect(p.select!('ghost')).toBeNull();
  });

  it('keeps a header-pinned request on its OWN credential regardless of rotation/exhaustion', () => {
    const t = 1_000_000;
    const p = createFailoverPool([acct('a'), acct('b')], { now: () => t });
    p.onExhausted('a', t + 3_600_000); // 5h-exhaust 'a'
    // A request still header-pinned to 'a' routes to a's credential (cache affinity is per-credential),
    // independent of rotation/exhaustion — that is the whole point of select().
    expect(p.select!('a')?.accountId).toBe('a');
    expect(p.select!('b')?.accountId).toBe('b');
  });
});

describe('createFailoverPool — reload() hot-swap (B-HOT-1)', () => {
  it('atomically swaps the live entries — active()/select() reflect the new pool, same object identity', () => {
    const p = createFailoverPool([acct('a'), acct('b')]);
    expect(p.active().accountId).toBe('a');
    p.reload!([acct('x'), acct('y'), acct('z')]);
    // Every subsequent active() comes from the NEW set; the OLD accounts are gone.
    const seen = new Set([p.active().accountId, p.active().accountId, p.active().accountId, p.active().accountId]);
    expect([...seen].every((id) => ['x', 'y', 'z'].includes(id))).toBe(true);
    expect(p.select!('a')).toBeNull(); // departed account no longer selectable
    expect(p.select!('y')?.accountId).toBe('y'); // new account present
  });

  it('throws on an empty reload — the gateway must always have ≥1 egress account', () => {
    const p = createFailoverPool([acct('a')]);
    expect(() => p.reload!([])).toThrow(/at least one account/);
  });

  it('a still-present paused account KEEPS its pause across the swap; a departed one is pruned', () => {
    let t = 1000;
    const p = createFailoverPool([acct('a'), acct('b'), acct('c')], { now: () => t });
    p.onExhausted('a', t + 3_600_000); // pause 'a' for ~1h
    p.onExhausted('b', t + 3_600_000); // pause 'b' for ~1h
    p.reload!([acct('a'), acct('c')]); // KEEP a (paused) + c; DROP b (its pause is pruned)
    // 'a' is still paused → active() skips it and serves 'c'.
    const seen = new Set([p.active().accountId, p.active().accountId, p.active().accountId]);
    expect(seen.has('a')).toBe(false);
    expect(seen.has('c')).toBe(true);
    // Once a's reset passes, it rejoins rotation (its pause was preserved, not reset, by the swap).
    t += 3_600_001;
    expect(new Set([p.active().accountId, p.active().accountId]).has('a')).toBe(true);
  });
});

describe('createFailoverPool — readmit() (egress-circuit half-open recovery)', () => {
  it('clears an account pause AHEAD of its reset so it rejoins rotation immediately', () => {
    const t = 1000;
    const p = createFailoverPool([acct('a'), acct('b')], { now: () => t });
    p.onExhausted('a', t + 3_600_000); // a out of rotation for ~1h
    // a is skipped while paused
    expect(new Set([p.active().accountId, p.active().accountId]).has('a')).toBe(false);
    p.readmit!('a'); // a half-open egress probe confirmed a's proxy recovered
    // a is back in rotation immediately — well before its 1h reset would have passed
    expect(new Set([p.active().accountId, p.active().accountId]).has('a')).toBe(true);
  });

  it('is a no-op for an account that is not paused (or unknown) — never throws, never disturbs rotation', () => {
    const p = createFailoverPool([acct('a'), acct('b')]);
    expect(() => p.readmit!('a')).not.toThrow(); // a was never paused
    expect(() => p.readmit!('ghost')).not.toThrow(); // not even in the pool
    // rotation cursor untouched by the no-op readmit
    expect(p.active().accountId).toBe('a');
    expect(p.active().accountId).toBe('b');
  });
});

describe('createFailoverPool — deeper edges (depth pass, su-7f3e0376)', () => {
  it('when EVERY account is exhausted, active() still returns something (round-robin over paused) so egress never starves', () => {
    const t = 1000;
    const p = createFailoverPool([acct('a'), acct('b')], { now: () => t });
    p.onExhausted('a', t + 3_600_000);
    p.onExhausted('b', t + 3_600_000); // whole pool out of budget
    const picks = [p.active().accountId, p.active().accountId, p.active().accountId, p.active().accountId];
    // never undefined / never throws — the gateway still picks SOMETHING; the governor/retry loop paces it.
    expect(picks.every((id) => id === 'a' || id === 'b')).toBe(true);
    expect(picks).toContain('a');
    expect(picks).toContain('b'); // the fallback still spreads across the (paused) pool, not pinning one
  });

  it('a SINGLE exhausted account: onExhausted returns null, yet active() still serves it (governor-paced)', () => {
    const t = 1000;
    const p = createFailoverPool([acct('solo')], { now: () => t });
    expect(p.onExhausted('solo', t + 3_600_000)).toBeNull(); // no other account to fail over to
    // ...but the one account must still egress — the gateway cannot refuse all traffic.
    expect(p.active().accountId).toBe('solo');
    expect(p.active().accountId).toBe('solo');
  });

  it('re-exhausting an already-paused account REFRESHES (extends) its reset — idempotent, not additive', () => {
    let t = 1000;
    const p = createFailoverPool([acct('a'), acct('b')], { now: () => t });
    p.onExhausted('a', 5_000); // a paused until 5000
    p.onExhausted('a', 20_000); // re-exhaust → its reset is refreshed out to 20000
    t = 6_000; // past the ORIGINAL 5000 reset, before the refreshed 20000
    // a is still paused (the refresh extended it), so failing 'b' over finds NO available account.
    // Had the reset NOT refreshed, a would have recovered at 5000 and this would return 'a' instead of null.
    expect(p.onExhausted('b', t + 3_600_000)).toBeNull();
  });

  it('reload() to a SMALLER pool clamps the round-robin cursor and serves only the new set', () => {
    const p = createFailoverPool([acct('a'), acct('b'), acct('c')]);
    p.active(); // rrIdx → 1
    p.active(); // rrIdx → 2 (near the end of the old 3-account pool)
    p.reload!([acct('solo')]); // shrink to 1 — the cursor must clamp (2 % 1 = 0), no out-of-range read
    expect(p.active().accountId).toBe('solo');
    expect(p.active().accountId).toBe('solo');
    expect(p.select!('a')).toBeNull(); // departed accounts are gone
  });

  it('healthyCount(extra) — the optional predicate narrows the serviceable count to what the gateway will actually serve (Fix 2, 2026-06-23)', () => {
    const t = 1000;
    const p = createFailoverPool([acct('a'), acct('b'), acct('c'), acct('d')], { now: () => t });
    expect(p.healthyCount!()).toBe(4); // no predicate → all in rotation (pool-available)
    p.onExhausted('a', t + 3_600_000); // a hard-paused (exhaustedUntil) → drops out of the pool-available set
    expect(p.healthyCount!()).toBe(3);
    // The gateway passes a governor-not-paused predicate: 'b'/'c' are predictively governor-paused (near their
    // rolling cap) though the pool still has them available — WITHOUT the predicate they'd be miscounted as
    // healthy (the over-report that masks a thundering herd). WITH it, only 'd' is truly serviceable.
    const govPaused = new Set(['b', 'c']);
    expect(p.healthyCount!((id) => !govPaused.has(id))).toBe(1); // only 'd' (a pool-exhausted, b/c gov-paused)
  });

  it('peek() returns the current-best WITHOUT advancing the round-robin cursor (H3, 2026-06-23)', () => {
    const p = createFailoverPool([acct('a'), acct('b'), acct('c')]);
    expect(p.peek!().accountId).toBe('a');
    expect(p.peek!().accountId).toBe('a'); // idempotent — a read never advances the cursor
    expect(p.active().accountId).toBe('a'); // active() returns the same current-best…
    expect(p.active().accountId).toBe('b'); // …but DID advance, so the next active() rotates
    expect(p.peek!().accountId).toBe('c'); // peek reflects the advanced cursor, still no advance
    expect(p.peek!().accountId).toBe('c');
  });
});
