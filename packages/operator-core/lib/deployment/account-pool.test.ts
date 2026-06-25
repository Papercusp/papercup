/**
 * Unit tests for the pure account-pool core (cloud-deployment-layer Phase 7,
 * P-019/P-020/P-021). No PG / governor / deploy IO — pure value transforms.
 * Run: cd packages/operator-core && npx vitest run account-pool
 */
import { describe, it, expect } from 'vitest';
import {
  emptyPool,
  registerAccount,
  removeAccount,
  getAccount,
  accountByCredentialRef,
  bindAccount,
  unbindAccount,
  recordAccountPenalty,
  recordAccountReset,
  recordAccountWindow,
  isAvailable,
  isSustainedlyLimited,
  isSpawnEligible,
  selectAccountByHeadroom,
  selectAccountByDrain,
  selectAccountForSpawn,
  decideScaleOut,
  AccountPoolError,
  DEFAULT_SCALE_POLICY,
  DRAIN_UTIL_STALE_MS,
  type AccountPool,
} from './account-pool';

const T0 = 1_000_000_000_000; // a fixed epoch-ms base
const MIN = 60_000;

function poolOf(...ids: string[]): AccountPool {
  let p = emptyPool();
  ids.forEach((id, i) => (p = registerAccount(p, { id, credentialRef: `token:~/.papercusp/${id}` }, T0 + i)));
  return p;
}

describe('registerAccount', () => {
  it('appends a fresh account with empty bindings + zeroed rate state', () => {
    const p = registerAccount(emptyPool(), { id: 'acct-1', credentialRef: 'token:~/t', label: 'main' }, T0);
    const a = getAccount(p, 'acct-1')!;
    expect(a).toMatchObject({ id: 'acct-1', credentialRef: 'token:~/t', label: 'main', addedAt: T0, boundTo: [] });
    expect(a.rate).toEqual({ pausedUntil: 0, lastPenaltyAt: 0, penaltyCount: 0, windowStartedAt: 0 });
  });

  it('is idempotent on a repeat id — updates credentialRef/label, preserves bindings + rate', () => {
    let p = registerAccount(emptyPool(), { id: 'acct-1', credentialRef: 'token:~/old' }, T0);
    p = bindAccount(p, 'acct-1', 'harness-a');
    p = recordAccountPenalty(p, 'acct-1', T0 + MIN, { pausedUntil: T0 + 5 * MIN });
    p = registerAccount(p, { id: 'acct-1', credentialRef: 'token:~/new', label: 'renamed' }, T0 + 99);
    const a = getAccount(p, 'acct-1')!;
    expect(p.accounts).toHaveLength(1);
    expect(a.credentialRef).toBe('token:~/new');
    expect(a.label).toBe('renamed');
    expect(a.boundTo).toEqual(['harness-a']);
    expect(a.rate.pausedUntil).toBe(T0 + 5 * MIN);
  });

  it('persists a per-account egress binding (per-account IP routing) + updates it on re-register', () => {
    let p = registerAccount(emptyPool(), { id: 'acct-1', credentialRef: 'token:~/t', egress: { proxyUrl: 'http://10.0.0.1:3128' } }, T0);
    expect(getAccount(p, 'acct-1')!.egress).toEqual({ proxyUrl: 'http://10.0.0.1:3128' });
    p = registerAccount(p, { id: 'acct-1', credentialRef: 'token:~/t', egress: { localAddress: '203.0.113.7' } }, T0 + 1);
    expect(getAccount(p, 'acct-1')!.egress).toEqual({ localAddress: '203.0.113.7' });
  });

  it('defaults legacy registrations to claude and preserves explicit codex provider', () => {
    let p = registerAccount(emptyPool(), { id: 'claude-a', credentialRef: 'token:~/claude' }, T0);
    p = registerAccount(p, { id: 'codex-a', provider: 'codex', credentialRef: 'env:OPENAI_API_KEY' }, T0 + 1);
    expect(getAccount(p, 'claude-a')!.provider).toBe('claude');
    expect(getAccount(p, 'codex-a')!.provider).toBe('codex');
  });

  it('rejects ids containing the bucket-key delimiters or empty credentialRef', () => {
    expect(() => registerAccount(emptyPool(), { id: 'a:b', credentialRef: 'x' }, T0)).toThrow(AccountPoolError);
    expect(() => registerAccount(emptyPool(), { id: 'a@b', credentialRef: 'x' }, T0)).toThrow(AccountPoolError);
    expect(() => registerAccount(emptyPool(), { id: 'ok', credentialRef: '  ' }, T0)).toThrow(/credentialRef/);
  });
});

describe('remove / lookup / bind / unbind', () => {
  it('removeAccount drops it', () => {
    const p = removeAccount(poolOf('a', 'b'), 'a');
    expect(p.accounts.map((x) => x.id)).toEqual(['b']);
  });

  it('accountByCredentialRef reverse-looks-up', () => {
    const p = poolOf('a', 'b');
    expect(accountByCredentialRef(p, 'token:~/.papercusp/b')?.id).toBe('b');
    expect(accountByCredentialRef(p, 'nope')).toBeUndefined();
  });

  it('bind is idempotent; unbind removes the slug from whichever account holds it', () => {
    let p = poolOf('a', 'b');
    p = bindAccount(bindAccount(p, 'a', 'h1'), 'a', 'h1'); // double-bind = one entry
    expect(getAccount(p, 'a')!.boundTo).toEqual(['h1']);
    p = bindAccount(p, 'b', 'h2');
    p = unbindAccount(p, 'h1');
    expect(getAccount(p, 'a')!.boundTo).toEqual([]);
    expect(getAccount(p, 'b')!.boundTo).toEqual(['h2']);
  });
});

describe('recordAccountPenalty + window rolling', () => {
  it('opens a window of 1, then increments inside the window', () => {
    let p = poolOf('a');
    p = recordAccountPenalty(p, 'a', T0, { pausedUntil: T0 + MIN });
    expect(getAccount(p, 'a')!.rate).toMatchObject({ penaltyCount: 1, windowStartedAt: T0, lastPenaltyAt: T0 });
    p = recordAccountPenalty(p, 'a', T0 + 2 * MIN, { pausedUntil: T0 + 3 * MIN });
    expect(getAccount(p, 'a')!.rate).toMatchObject({ penaltyCount: 2, windowStartedAt: T0 });
  });

  it('a penalty past the window opens a fresh count', () => {
    let p = poolOf('a');
    p = recordAccountPenalty(p, 'a', T0, {});
    p = recordAccountPenalty(p, 'a', T0 + DEFAULT_SCALE_POLICY.windowMs + 1, {});
    expect(getAccount(p, 'a')!.rate.penaltyCount).toBe(1);
    expect(getAccount(p, 'a')!.rate.windowStartedAt).toBe(T0 + DEFAULT_SCALE_POLICY.windowMs + 1);
  });

  it('pausedUntil advances monotonically (never shortened by a later, nearer penalty)', () => {
    let p = poolOf('a');
    p = recordAccountPenalty(p, 'a', T0, { pausedUntil: T0 + 10 * MIN });
    p = recordAccountPenalty(p, 'a', T0 + MIN, { pausedUntil: T0 + 2 * MIN });
    expect(getAccount(p, 'a')!.rate.pausedUntil).toBe(T0 + 10 * MIN);
  });

  it('a penalty for an unknown id is a no-op', () => {
    const p = recordAccountPenalty(poolOf('a'), 'ghost', T0, { pausedUntil: T0 + MIN });
    expect(getAccount(p, 'a')!.rate.penaltyCount).toBe(0);
  });

  it('recordAccountReset clears the rate state', () => {
    let p = recordAccountPenalty(poolOf('a'), 'a', T0, { pausedUntil: T0 + 10 * MIN });
    p = recordAccountReset(p, 'a');
    expect(getAccount(p, 'a')!.rate).toEqual({ pausedUntil: 0, lastPenaltyAt: 0, penaltyCount: 0, windowStartedAt: 0 });
  });

  it('a 429 penalty PRESERVES the last-known observed budget (utilization survives)', () => {
    // Regression: the rate object was rebuilt on every penalty WITHOUT the utilization fields, so an
    // account's "% used" vanished the instant it got rate-limited — exactly when the Accounts tab
    // should show it. The reading must survive the penalty (only pause/penalty are recomputed).
    let p = recordAccountWindow(poolOf('a'), 'a', { utilization: 0.82, windowResetAt: T0 + 300 * MIN, utilization7d: 0.4 }, T0);
    p = recordAccountPenalty(p, 'a', T0 + MIN, { pausedUntil: T0 + 10 * MIN });
    const r = getAccount(p, 'a')!.rate;
    expect(r.utilization).toBe(0.82);
    expect(r.utilization7d).toBe(0.4);
    expect(r.windowResetAt).toBe(T0 + 300 * MIN);
    expect(r.utilizationAt).toBe(T0); // the observation time, untouched by the penalty
    expect(r.penaltyCount).toBe(1); // pause/penalty still recorded
    expect(r.pausedUntil).toBe(T0 + 10 * MIN);
  });

  it('recordAccountReset clears pause+penalty but PRESERVES the observed budget reading', () => {
    let p = recordAccountWindow(poolOf('a'), 'a', { utilization: 0.91, utilization7d: 0.55 }, T0);
    p = recordAccountPenalty(p, 'a', T0 + MIN, { pausedUntil: T0 + 10 * MIN });
    p = recordAccountReset(p, 'a');
    const r = getAccount(p, 'a')!.rate;
    expect(r.pausedUntil).toBe(0);
    expect(r.penaltyCount).toBe(0);
    expect(r.windowStartedAt).toBe(0);
    expect(r.utilization).toBe(0.91); // kept so the tab still renders "~91% used · as of …"
    expect(r.utilization7d).toBe(0.55);
    expect(r.utilizationAt).toBe(T0);
  });
});

describe('isAvailable / isSustainedlyLimited', () => {
  it('isAvailable reflects the pause window', () => {
    let p = recordAccountPenalty(poolOf('a'), 'a', T0, { pausedUntil: T0 + 5 * MIN });
    expect(isAvailable(getAccount(p, 'a')!, T0 + MIN)).toBe(false);
    expect(isAvailable(getAccount(p, 'a')!, T0 + 6 * MIN)).toBe(true);
  });

  it('a single long pause alone is NOT sustained (D-003 false-exhaustion fix)', () => {
    // On Claude Max a single 429 routinely pauses to the multi-hour 5h/7d reset even when the account
    // is not actually over budget — that used to flip it straight to "exhausted" (false scale-out).
    const p = recordAccountPenalty(poolOf('a'), 'a', T0, { pausedUntil: T0 + 31 * MIN });
    expect(isSustainedlyLimited(getAccount(p, 'a')!, T0)).toBe(false);
  });

  it('fresh unified utilization at/over cap IS sustained, and self-heals as the window recovers', () => {
    let p = recordAccountWindow(poolOf('a'), 'a', { utilization: 1.01 }, T0);
    expect(isSustainedlyLimited(getAccount(p, 'a')!, T0)).toBe(true);
    p = recordAccountWindow(p, 'a', { utilization: 0.7 }, T0 + MIN); // recovered below cap
    expect(isSustainedlyLimited(getAccount(p, 'a')!, T0 + MIN)).toBe(false);
  });

  it('fresh unified 7d utilization at/over cap IS sustained even when 5h is fresh', () => {
    const p = recordAccountWindow(poolOf('a'), 'a', { utilization: 0.08, utilization7d: 1.01 }, T0);
    expect(isSustainedlyLimited(getAccount(p, 'a')!, T0)).toBe(true);
  });

  it('stale utilization at cap is NOT sustained (only a fresh budget reading counts)', () => {
    const p = recordAccountWindow(poolOf('a'), 'a', { utilization: 1.2 }, T0);
    expect(isSustainedlyLimited(getAccount(p, 'a')!, T0 + DRAIN_UTIL_STALE_MS + MIN)).toBe(false);
  });

  it('stale weekly-full utilization remains sustained until the weekly reset', () => {
    const p = recordAccountWindow(
      poolOf('a'),
      'a',
      { utilization: 0.05, utilization7d: 1.0, windowResetAt7d: T0 + 7 * 24 * 60 * MIN },
      T0,
    );
    expect(isSustainedlyLimited(getAccount(p, 'a')!, T0 + DRAIN_UTIL_STALE_MS + MIN)).toBe(true);
    expect(isSustainedlyLimited(getAccount(p, 'a')!, T0 + 8 * 24 * 60 * MIN)).toBe(false);
  });

  it('threshold penalties within the window is sustained; below it is not', () => {
    let p = poolOf('a');
    p = recordAccountPenalty(p, 'a', T0, { pausedUntil: T0 + MIN });
    p = recordAccountPenalty(p, 'a', T0 + MIN, { pausedUntil: T0 + 2 * MIN });
    expect(isSustainedlyLimited(getAccount(p, 'a')!, T0 + MIN)).toBe(false); // 2 < 3
    p = recordAccountPenalty(p, 'a', T0 + 2 * MIN, { pausedUntil: T0 + 3 * MIN });
    expect(isSustainedlyLimited(getAccount(p, 'a')!, T0 + 2 * MIN)).toBe(true); // 3 ≥ 3
  });
});

describe('selectAccountForSpawn (P-005 cache-affinity)', () => {
  it('sticks to the prior account when it is still available (overrides headroom)', () => {
    const p = poolOf('a', 'b', 'c'); // headroom would pick 'a'
    expect(selectAccountForSpawn(p, T0, { priorAccountId: 'c' }).accountId).toBe('c');
  });

  it('falls through a paused prior account to the next rule', () => {
    let p = poolOf('a', 'b');
    p = recordAccountPenalty(p, 'b', T0, { pausedUntil: T0 + 10 * MIN });
    // rng: () => 0 → the drain spread picks its deterministic best (the clean, never-penalized 'a').
    expect(selectAccountForSpawn(p, T0 + MIN, { priorAccountId: 'b', rng: () => 0 }).accountId).toBe('a');
  });

  it('falls through a weekly-full prior account even when it is not paused', () => {
    let p = poolOf('a', 'b');
    p = recordAccountWindow(p, 'b', { utilization: 0.05, utilization7d: 1.0 }, T0);
    // A hard pin to a weekly-full prior account kills spawned CLI roles before they can emit artifacts.
    expect(selectAccountForSpawn(p, T0, { priorAccountId: 'b', rng: () => 0 }).accountId).toBe('a');
  });

  it('pins a harness to the account it is bound to (cache co-location)', () => {
    let p = poolOf('a', 'b', 'c');
    p = bindAccount(p, 'b', 'harness-x');
    expect(selectAccountForSpawn(p, T0, { harness: 'harness-x' }).accountId).toBe('b');
  });

  it('skips a paused bound account (manual-bind stays available-only) and falls back to headroom', () => {
    let p = poolOf('a', 'b');
    p = bindAccount(p, 'b', 'harness-x');
    p = recordAccountPenalty(p, 'b', T0, { pausedUntil: T0 + 10 * MIN });
    expect(selectAccountForSpawn(p, T0 + MIN, { harness: 'harness-x', rng: () => 0 }).accountId).toBe('a');
  });

  it('skips a weekly-full bound account and falls back to headroom', () => {
    let p = poolOf('a', 'b');
    p = bindAccount(p, 'b', 'harness-x');
    p = recordAccountWindow(p, 'b', { utilization: 0.02, utilization7d: 1.0 }, T0);
    expect(selectAccountForSpawn(p, T0, { harness: 'harness-x', rng: () => 0 }).accountId).toBe('a');
  });

  it('falls back to the least-loaded available account with no prior/harness', () => {
    expect(selectAccountForSpawn(poolOf('a', 'b'), T0, { rng: () => 0 }).accountId).toBe('a');
  });

  it('does not hard-pin a budget-healthy but currently paused account into a spawned CLI turn', () => {
    // A single 429 can carry a far-future pause even though the account still has budget, but a spawned
    // CLI turn with a hard account pin dies immediately on the gateway's pinned-account 429. Spawn
    // selection therefore returns no header when every account is paused; the unpinned gateway path can
    // pace/fail over without killing the autonomous turn on a known-bad pin.
    let p = poolOf('a', 'b');
    p = recordAccountPenalty(p, 'a', T0, { pausedUntil: T0 + 10 * MIN });
    p = recordAccountPenalty(p, 'b', T0, { pausedUntil: T0 + 10 * MIN });
    const pick = selectAccountForSpawn(p, T0 + MIN, { priorAccountId: 'a', harness: 'h', rng: () => 0 }).accountId;
    expect(pick).toBeUndefined();
  });

  it('does not hard-pin the soonest-recovering account when every account is genuinely exhausted', () => {
    // 3 penalties in-window = sustainedly limited (truly out of budget) → not spawn-eligible. A hard pin
    // to the soonest paused account still returns a terminal 429 to the spawned CLI, so emit no account
    // header and let the gateway own pacing/failover.
    let p = poolOf('a', 'b');
    for (let i = 0; i < 3; i++) p = recordAccountPenalty(p, 'a', T0 + i, { pausedUntil: T0 + 20 * MIN });
    for (let i = 0; i < 3; i++) p = recordAccountPenalty(p, 'b', T0 + i, { pausedUntil: T0 + 10 * MIN });
    expect(selectAccountForSpawn(p, T0 + MIN, { rng: () => 0 }).accountId).toBeUndefined();
  });

  it('does not hard-pin any account when every available account is weekly-full', () => {
    let p = poolOf('a', 'b');
    p = recordAccountWindow(p, 'a', { utilization: 0.05, utilization7d: 1.0 }, T0);
    p = recordAccountWindow(p, 'b', { utilization: 0.10, utilization7d: 0.99 }, T0);
    expect(selectAccountForSpawn(p, T0, { rng: () => 0 }).accountId).toBeUndefined();
  });

  it('does not re-admit a stale weekly-full account before its weekly reset', () => {
    let p = poolOf('a', 'b');
    p = recordAccountWindow(
      p,
      'a',
      { utilization: 0.05, utilization7d: 1.0, windowResetAt7d: T0 + 7 * 24 * 60 * MIN },
      T0,
    );
    p = recordAccountWindow(p, 'b', { utilization: 0.30, utilization7d: 0.40 }, T0);
    expect(selectAccountForSpawn(p, T0 + DRAIN_UTIL_STALE_MS + MIN, { rng: () => 0 }).accountId).toBe('b');
  });

  it('returns undefined for an empty pool', () => {
    expect(selectAccountForSpawn(emptyPool(), T0).accountId).toBeUndefined();
  });

  it('a soft-pinned harness PREFERS its pin but no longer funnels every concurrent bee onto it', () => {
    // Soft-pin harness 'h' to 'b' (a healthy account); the hive must spread, not 100%-pile on 'b'.
    let p = poolOf('a', 'b', 'c');
    p = { accounts: p.accounts.map((acc) => (acc.id === 'b' ? { ...acc, softPin: ['h'] } : acc)) };
    const picks = Array.from(
      { length: 60 },
      (_, i) => selectAccountForSpawn(p, T0, { harness: 'h', rng: () => i / 60 }).accountId,
    );
    const counts = picks.reduce<Record<string, number>>((m, id) => ((m[id!] = (m[id!] ?? 0) + 1), m), {});
    expect(Object.keys(counts).length).toBeGreaterThan(1); // fans out across the pool (not a funnel)
    expect(counts['b']).toBeGreaterThan(counts['a'] ?? 0); // ...while still PREFERRING the warm-cache pin
    expect(counts['b']).toBeGreaterThan(counts['c'] ?? 0);
  });

  it('does NOT re-pin the harness when a bee spills off its existing soft-pin (anchor stays stable)', () => {
    let p = poolOf('a', 'b');
    p = { accounts: p.accounts.map((acc) => (acc.id === 'b' ? { ...acc, softPin: ['h'] } : acc)) };
    // rng=0.1 lands in 'a's weight band (below 'b's affinity-boosted slice) → this bee SPILLS to 'a',
    // but newlyPinned must stay unset: the hive's pin 'b' holds; a spilled bee never re-anchors the harness.
    const sel = selectAccountForSpawn(p, T0, { harness: 'h', rng: () => 0.1 });
    expect(sel.accountId).toBe('a'); // spilled off the pin
    expect(sel.newlyPinned).toBeUndefined(); // ...without re-pinning the harness
  });

  it('establishes a fresh soft-pin (newlyPinned) only when the harness has none yet', () => {
    const sel = selectAccountForSpawn(poolOf('a', 'b'), T0, { harness: 'fresh-harness', rng: () => 0 });
    expect(sel.newlyPinned).toEqual({ harness: 'fresh-harness', accountId: sel.accountId });
  });
});

describe('selectAccountByHeadroom (P-020)', () => {
  it('returns undefined when the pool is empty / all excluded / all paused', () => {
    expect(selectAccountByHeadroom(emptyPool(), T0)).toBeUndefined();
    expect(selectAccountByHeadroom(poolOf('a'), T0, { exclude: ['a'] })).toBeUndefined();
    const paused = recordAccountPenalty(poolOf('a'), 'a', T0, { pausedUntil: T0 + 10 * MIN });
    expect(selectAccountByHeadroom(paused, T0 + MIN)).toBeUndefined();
  });

  it('skips paused accounts and picks an available one', () => {
    let p = poolOf('a', 'b');
    p = recordAccountPenalty(p, 'a', T0, { pausedUntil: T0 + 10 * MIN });
    expect(selectAccountByHeadroom(p, T0 + MIN)!.id).toBe('b');
  });

  it('prefers the least-recently-penalized available account', () => {
    let p = poolOf('a', 'b');
    // both available now, but b was penalized more recently
    p = recordAccountPenalty(p, 'b', T0, { pausedUntil: T0 + 1 }); // pause already elapsed by T0+MIN
    expect(selectAccountByHeadroom(p, T0 + MIN)!.id).toBe('a');
  });

  it('preferUnbound spreads load to a fresh account', () => {
    let p = poolOf('a', 'b');
    p = bindAccount(p, 'a', 'h1'); // a bound; a was added first so without preferUnbound it'd tie-break to... fewest bindings = b
    expect(selectAccountByHeadroom(p, T0, { preferUnbound: true })!.id).toBe('b');
  });
});

describe('recordAccountWindow (D-003 unified-5h projection)', () => {
  it('records utilization + reset + a freshness stamp; an undefined field keeps its prior value', () => {
    let p = poolOf('a');
    p = recordAccountWindow(p, 'a', { utilization: 0.4, windowResetAt: T0 + 60 * MIN }, T0);
    let r = getAccount(p, 'a')!.rate;
    expect(r.utilization).toBe(0.4);
    expect(r.windowResetAt).toBe(T0 + 60 * MIN);
    expect(r.utilizationAt).toBe(T0);
    // a later partial update bumps utilization but keeps the prior reset
    p = recordAccountWindow(p, 'a', { utilization: 0.6 }, T0 + MIN);
    r = getAccount(p, 'a')!.rate;
    expect(r.utilization).toBe(0.6);
    expect(r.windowResetAt).toBe(T0 + 60 * MIN);
    expect(r.utilizationAt).toBe(T0 + MIN);
  });

  it('is a no-op for an unknown id', () => {
    const p = recordAccountWindow(poolOf('a'), 'nope', { utilization: 0.9 }, T0);
    expect(getAccount(p, 'a')!.rate.utilization).toBeUndefined();
  });
});

describe('selectAccountByDrain (D-003 budget-draining selector)', () => {
  it('with no budget data, degrades to recency order (oldest-added among clean accounts)', () => {
    expect(selectAccountByDrain(poolOf('a', 'b'), T0)!.id).toBe('a');
  });

  it('prefers the account with the most remaining 5h budget (lowest utilization)', () => {
    let p = poolOf('a', 'b');
    p = recordAccountWindow(p, 'a', { utilization: 0.8 }, T0);
    p = recordAccountWindow(p, 'b', { utilization: 0.2 }, T0);
    expect(selectAccountByDrain(p, T0)!.id).toBe('b');
  });

  it('drains an about-to-reset window first (use-it-before-you-lose-it), over a lower-util fresh window', () => {
    let p = poolOf('a', 'b');
    // a is busier (0.6) but resets in 5 min → its budget vanishes soon → drain it first
    p = recordAccountWindow(p, 'a', { utilization: 0.6, windowResetAt: T0 + 5 * MIN }, T0);
    // b is fresher (0.1) but resets in 4h → its budget persists → keep in reserve
    p = recordAccountWindow(p, 'b', { utilization: 0.1, windowResetAt: T0 + 240 * MIN }, T0);
    expect(selectAccountByDrain(p, T0)!.id).toBe('a');
  });

  it('does NOT treat an about-to-reset but already-full account as urgent', () => {
    let p = poolOf('a', 'b');
    p = recordAccountWindow(p, 'a', { utilization: 0.99, windowResetAt: T0 + 5 * MIN }, T0); // full → not urgent
    p = recordAccountWindow(p, 'b', { utilization: 0.3, windowResetAt: T0 + 240 * MIN }, T0);
    expect(selectAccountByDrain(p, T0)!.id).toBe('b');
  });

  it('7d-aware: avoids a 5h-fresh but 7d-near-cap account (the aviynw2 trap), preferring both-window headroom', () => {
    let p = poolOf('a', 'b');
    // a = aviynw2: 5h-fresh (0.09) but 7d near the WEEKLY cap (0.96) → effective fullness 0.96.
    p = recordAccountWindow(p, 'a', { utilization: 0.09, utilization7d: 0.96 }, T0);
    // b = aviynw6: headroom in BOTH windows (5h 0.49, 7d 0.39) → effective fullness 0.49 → preferred.
    p = recordAccountWindow(p, 'b', { utilization: 0.49, utilization7d: 0.39 }, T0);
    // 5h-only ranking would (wrongly) pick 'a' (0.09 < 0.49); 7d-aware picks 'b'.
    expect(selectAccountByDrain(p, T0)!.id).toBe('b');
  });

  it('ignores stale utilization (older than the staleness horizon) → treats it as most-available', () => {
    let p = poolOf('a', 'b');
    // a's high utilization is stale → treated as 0; b's is fresh at 0.5 → a wins as "emptier"
    p = recordAccountWindow(p, 'a', { utilization: 0.9 }, T0);
    p = recordAccountWindow(p, 'b', { utilization: 0.5 }, T0 + DRAIN_UTIL_STALE_MS + MIN);
    expect(selectAccountByDrain(p, T0 + DRAIN_UTIL_STALE_MS + MIN)!.id).toBe('a');
  });

  it('skips paused accounts and honors exclude', () => {
    let p = poolOf('a', 'b', 'c');
    p = recordAccountPenalty(p, 'a', T0, { pausedUntil: T0 + 10 * MIN });
    expect(selectAccountByDrain(p, T0 + MIN, { exclude: ['b'] })!.id).toBe('c');
  });
});

describe('isSpawnEligible (account-spawn-eligibility — D-003 stranding fix)', () => {
  it('an available account is eligible', () => {
    expect(isSpawnEligible(getAccount(poolOf('a'), 'a')!, T0)).toBe(true);
  });

  it('a budget-healthy account is eligible EVEN while paused (a stale single-429 pause must not strand it)', () => {
    // The aviynw case: util5h=0, penaltyCount=1, yet paused to the far-future window reset.
    let p = poolOf('a');
    p = recordAccountPenalty(p, 'a', T0, { pausedUntil: T0 + 26 * MIN });
    const a = getAccount(p, 'a')!;
    expect(isAvailable(a, T0 + MIN)).toBe(false); // narrow availability would exclude it...
    expect(isSpawnEligible(a, T0 + MIN)).toBe(true); // ...but it still has budget, so it's selectable
  });

  it('a genuinely rate-exhausted account (sustained penalties) is NOT eligible', () => {
    let p = poolOf('a');
    for (let i = 0; i < 3; i++) p = recordAccountPenalty(p, 'a', T0 + i, { pausedUntil: T0 + 20 * MIN });
    expect(isSpawnEligible(getAccount(p, 'a')!, T0 + MIN)).toBe(false);
  });

  it('a paused account at/over its fresh budget cap is NOT eligible', () => {
    let p = poolOf('a');
    p = recordAccountWindow(p, 'a', { utilization: 1.0 }, T0); // fresh at-cap reading
    p = recordAccountPenalty(p, 'a', T0, { pausedUntil: T0 + 20 * MIN });
    expect(isSpawnEligible(getAccount(p, 'a')!, T0 + MIN)).toBe(false);
  });
});

describe('selectAccountByDrain spread (anti-thundering-herd, 2026-06-23)', () => {
  it('rng()===0 reproduces the deterministic best (spread is opt-in and order-preserving)', () => {
    let p = poolOf('a', 'b', 'c');
    p = recordAccountWindow(p, 'a', { utilization: 0.8 }, T0);
    p = recordAccountWindow(p, 'b', { utilization: 0.1 }, T0); // b has the most headroom
    p = recordAccountWindow(p, 'c', { utilization: 0.8 }, T0);
    expect(selectAccountByDrain(p, T0, { spread: true, rng: () => 0 })!.id).toBe('b');
    expect(selectAccountByDrain(p, T0)!.id).toBe('b'); // == non-spread
  });

  it('spreads a burst across budget-healthy accounts instead of piling on one', () => {
    const p = poolOf('a', 'b', 'c'); // all equal headroom (no util data)
    // Deterministic (no spread): every pick is the same account → the thundering herd.
    const herd = new Set(Array.from({ length: 20 }, () => selectAccountByDrain(p, T0)!.id));
    expect(herd.size).toBe(1);
    // Spread: walking rng across [0,1) lands on multiple distinct accounts → load fans out.
    const spread = new Set(
      Array.from({ length: 20 }, (_, i) => selectAccountByDrain(p, T0, { spread: true, rng: () => i / 20 })!.id),
    );
    expect(spread.size).toBeGreaterThan(1);
  });

  it('prefers AVAILABLE accounts; a budget-healthy paused one is selectable only when none are available', () => {
    // One paused (but budget-healthy), one available → the spread must NOT demote the available account.
    let pMixed = poolOf('a', 'b');
    pMixed = recordAccountPenalty(pMixed, 'a', T0, { pausedUntil: T0 + 26 * MIN });
    const mixed = new Set(
      Array.from({ length: 20 }, (_, i) =>
        selectAccountByDrain(pMixed, T0 + MIN, { spread: true, rng: () => i / 20, eligible: isSpawnEligible })!.id,
      ),
    );
    expect(mixed).toEqual(new Set(['b'])); // only the available account is used while one exists

    // BOTH paused but budget-healthy → the narrow `isAvailable` filter strands them (undefined: the bug);
    // spawn eligibility keeps them selectable so the spread still routes across them (no frame-default herd).
    let pBoth = poolOf('a', 'b');
    pBoth = recordAccountPenalty(pBoth, 'a', T0, { pausedUntil: T0 + 26 * MIN });
    pBoth = recordAccountPenalty(pBoth, 'b', T0, { pausedUntil: T0 + 26 * MIN });
    expect(selectAccountByDrain(pBoth, T0 + MIN)).toBeUndefined(); // narrow filter → stranded
    const both = new Set(
      Array.from({ length: 20 }, (_, i) =>
        selectAccountByDrain(pBoth, T0 + MIN, { spread: true, rng: () => i / 20, eligible: isSpawnEligible })!.id,
      ),
    );
    expect(both.has('a')).toBe(true);
    expect(both.has('b')).toBe(true);
  });
});

describe('decideScaleOut (P-021)', () => {
  it('not-sustained when the exhausted account has not crossed the threshold', () => {
    let p = poolOf('a', 'b');
    p = recordAccountPenalty(p, 'a', T0, { pausedUntil: T0 + MIN });
    const d = decideScaleOut(p, 'a', T0 + 30_000);
    expect(d).toEqual({ provision: false, reason: 'not-sustained' });
  });

  it('provisions a fresh account when sustained + a fresh one exists', () => {
    let p = poolOf('a', 'b');
    p = recordAccountWindow(p, 'a', { utilization: 1.01 }, T0); // genuinely over 5h budget = sustained
    const d = decideScaleOut(p, 'a', T0);
    expect(d).toEqual({ provision: true, account: expect.objectContaining({ id: 'b' }) });
  });

  it('no-fresh-account when sustained but every other account is paused too', () => {
    let p = poolOf('a', 'b');
    p = recordAccountWindow(p, 'a', { utilization: 1.01 }, T0); // a genuinely over budget
    p = recordAccountPenalty(p, 'b', T0, { pausedUntil: T0 + 20 * MIN }); // b paused → no fresh account
    const d = decideScaleOut(p, 'a', T0);
    expect(d).toEqual({ provision: false, reason: 'no-fresh-account' });
  });

  it('requireSustained:false provisions even on a single penalty (the manual-trigger path)', () => {
    let p = poolOf('a', 'b');
    p = recordAccountPenalty(p, 'a', T0, { pausedUntil: T0 + MIN });
    const d = decideScaleOut(p, 'a', T0 + 30_000, { requireSustained: false });
    expect(d).toMatchObject({ provision: true, account: { id: 'b' } });
  });
});
