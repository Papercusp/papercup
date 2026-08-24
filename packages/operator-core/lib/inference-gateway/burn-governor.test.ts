/**
 * WI-41147 — burn-rate governor: retention (account-pool `history7d`), the pure rate
 * estimator, and the verdict ladder. All pure; no IO.
 */
import { describe, expect, it } from 'vitest';
import {
  HISTORY_7D_MAX_SAMPLES,
  HISTORY_7D_MIN_SPACING_MS,
  accountBurnAction,
  accountBurnVerdict,
  appendUtilization7dSample,
  recordAccountWindow,
  registerAccount,
  selectAccountForSpawn,
  type AccountPool,
} from '../deployment/account-pool';
import {
  BURN_EXHAUSTED_UTIL,
  DEFAULT_BURN_POLICY,
  accountBurnSamples,
  aggregatePoolBurn,
  estimateBurnRatePerHr,
  evaluateAccountBurn,
  evaluateBurn,
  type BurnSample,
} from './burn-governor';

const T0 = 1_800_000_000_000; // fixed epoch base
const MIN = 60_000;
const HR = 60 * MIN;

function samplesAt(pairs: [offsetMs: number, u: number][]): BurnSample[] {
  return pairs.map(([off, u]) => ({ at: T0 + off, u }));
}

// ── Retention: appendUtilization7dSample ─────────────────────────────────────

describe('appendUtilization7dSample', () => {
  it('appends a first sample to an undefined history', () => {
    expect(appendUtilization7dSample(undefined, { at: T0, u: 0.5 })).toEqual([{ at: T0, u: 0.5 }]);
  });

  it('appends when spacing >= HISTORY_7D_MIN_SPACING_MS', () => {
    const h = [{ at: T0, u: 0.5 }];
    const next = appendUtilization7dSample(h, { at: T0 + HISTORY_7D_MIN_SPACING_MS, u: 0.51 });
    expect(next).toHaveLength(2);
    expect(next[1]).toEqual({ at: T0 + HISTORY_7D_MIN_SPACING_MS, u: 0.51 });
  });

  it('skips a sample closer than the spacing floor (keeps the OLD point — freshest lives on the rate fields)', () => {
    const h = [{ at: T0, u: 0.5 }];
    const next = appendUtilization7dSample(h, { at: T0 + HISTORY_7D_MIN_SPACING_MS - 1, u: 0.9 });
    expect(next).toEqual([{ at: T0, u: 0.5 }]);
  });

  it('skips an out-of-order (clock-skew) sample', () => {
    const h = [{ at: T0, u: 0.5 }];
    expect(appendUtilization7dSample(h, { at: T0 - HR, u: 0.4 })).toEqual([{ at: T0, u: 0.5 }]);
  });

  it('caps at HISTORY_7D_MAX_SAMPLES, trimming the OLDEST', () => {
    let h: BurnSample[] | undefined;
    const n = HISTORY_7D_MAX_SAMPLES + 10;
    for (let i = 0; i < n; i++) {
      h = appendUtilization7dSample(h, { at: T0 + i * HISTORY_7D_MIN_SPACING_MS, u: i / n });
    }
    expect(h).toHaveLength(HISTORY_7D_MAX_SAMPLES);
    expect(h![0]!.at).toBe(T0 + 10 * HISTORY_7D_MIN_SPACING_MS); // oldest 10 trimmed
    expect(h![h!.length - 1]!.at).toBe(T0 + (n - 1) * HISTORY_7D_MIN_SPACING_MS);
  });

  it('drops non-finite junk from a hand-edited persisted row', () => {
    const junk = [
      { at: Number.NaN, u: 0.5 },
      { at: T0, u: Number.POSITIVE_INFINITY },
      { at: T0, u: 0.5 },
      null as unknown as BurnSample,
    ];
    const next = appendUtilization7dSample(junk, { at: T0 + HISTORY_7D_MIN_SPACING_MS, u: 0.6 });
    expect(next).toEqual([
      { at: T0, u: 0.5 },
      { at: T0 + HISTORY_7D_MIN_SPACING_MS, u: 0.6 },
    ]);
  });

  it('refuses a non-finite NEW sample (returns the cleaned history unchanged)', () => {
    const h = [{ at: T0, u: 0.5 }];
    expect(appendUtilization7dSample(h, { at: T0 + HR, u: Number.NaN })).toEqual(h);
  });
});

// ── Retention: recordAccountWindow wiring ────────────────────────────────────

describe('recordAccountWindow history7d retention', () => {
  function poolWithOne(): AccountPool {
    return registerAccount({ accounts: [] }, { id: 'a1', credentialRef: 'cred-a1' }, T0 - HR);
  }

  it('a 7d observation appends to history7d', () => {
    let pool = poolWithOne();
    pool = recordAccountWindow(pool, 'a1', { utilization7d: 0.4, windowResetAt7d: T0 + 24 * HR }, T0);
    pool = recordAccountWindow(pool, 'a1', { utilization7d: 0.45 }, T0 + HISTORY_7D_MIN_SPACING_MS);
    expect(pool.accounts[0]!.rate.history7d).toEqual([
      { at: T0, u: 0.4 },
      { at: T0 + HISTORY_7D_MIN_SPACING_MS, u: 0.45 },
    ]);
  });

  it('a 5h-only observation leaves history7d untouched (no stale-value flattening)', () => {
    let pool = poolWithOne();
    pool = recordAccountWindow(pool, 'a1', { utilization7d: 0.4 }, T0);
    pool = recordAccountWindow(pool, 'a1', { utilization: 0.7 }, T0 + HR);
    expect(pool.accounts[0]!.rate.history7d).toEqual([{ at: T0, u: 0.4 }]);
    // ...while the freshest-stamp still advances (existing behavior, unchanged):
    expect(pool.accounts[0]!.rate.utilizationAt).toBe(T0 + HR);
  });

  it('unknown id is a no-op (existing contract preserved)', () => {
    const pool = poolWithOne();
    expect(recordAccountWindow(pool, 'nope', { utilization7d: 0.4 }, T0)).toEqual(pool);
  });
});

// ── Estimator ────────────────────────────────────────────────────────────────

describe('estimateBurnRatePerHr', () => {
  const now = T0 + 2 * HR;

  it('null on undefined / empty / single-sample history', () => {
    expect(estimateBurnRatePerHr(undefined, now)).toBeNull();
    expect(estimateBurnRatePerHr([], now)).toBeNull();
    expect(estimateBurnRatePerHr(samplesAt([[0, 0.5]]), now)).toBeNull();
  });

  it('two clean points an hour apart → exact slope', () => {
    const rate = estimateBurnRatePerHr(
      samplesAt([
        [0, 0.5],
        [HR, 0.6],
      ]),
      now,
    );
    expect(rate).toBeCloseTo(0.1, 10);
  });

  it('least-squares over noisy points recovers the underlying trend', () => {
    // 0.05/hr underlying with ±0.005 alternating noise across 2h of 15-min samples.
    const pts: [number, number][] = [];
    for (let i = 0; i <= 8; i++) {
      const at = i * 15 * MIN;
      pts.push([at, 0.5 + (0.05 * at) / HR + (i % 2 === 0 ? 0.005 : -0.005)]);
    }
    const rate = estimateBurnRatePerHr(samplesAt(pts), now);
    expect(rate).toBeGreaterThan(0.045);
    expect(rate).toBeLessThan(0.055);
  });

  it('negative slope (decaying window) is returned as-is, not clamped', () => {
    const rate = estimateBurnRatePerHr(
      samplesAt([
        [0, 0.6],
        [HR, 0.5],
      ]),
      now,
    );
    expect(rate).toBeCloseTo(-0.1, 10);
  });

  it('null when the usable span is below minSpanMs', () => {
    const rate = estimateBurnRatePerHr(
      samplesAt([
        [0, 0.5],
        [DEFAULT_BURN_POLICY.minSpanMs - 1, 0.6],
      ]),
      T0 + DEFAULT_BURN_POLICY.minSpanMs,
    );
    expect(rate).toBeNull();
  });

  it('samples outside the lookback are excluded (stale trend cannot leak in)', () => {
    // Two old points showing a huge slope + one fresh point: only ≥2 in-lookback samples count.
    const rate = estimateBurnRatePerHr(
      samplesAt([
        [-30 * HR, 0.1],
        [-29 * HR, 0.9],
        [0, 0.5],
      ]),
      T0,
    );
    expect(rate).toBeNull(); // one usable sample after lookback filtering
  });

  it('future-dated and non-finite samples are dropped', () => {
    const rate = estimateBurnRatePerHr(
      [
        { at: T0, u: 0.5 },
        { at: T0 + HR, u: 0.6 },
        { at: now + HR, u: 0.99 }, // future — dropped
        { at: Number.NaN, u: 0.7 }, // junk — dropped
        { at: T0 + 30 * MIN, u: Number.NaN }, // junk — dropped
      ],
      now,
    );
    expect(rate).toBeCloseTo(0.1, 10);
  });

  it('duplicate timestamps are collapsed (freshest reading re-appended over its retained twin)', () => {
    const rate = estimateBurnRatePerHr(
      [
        { at: T0, u: 0.5 },
        { at: T0 + HR, u: 0.6 },
        { at: T0 + HR, u: 0.6 },
      ],
      now,
    );
    expect(rate).toBeCloseTo(0.1, 10);
  });
});

// ── accountBurnSamples ───────────────────────────────────────────────────────

describe('accountBurnSamples', () => {
  it('appends the freshest reading the spacing floor skipped', () => {
    const s = accountBurnSamples({
      history7d: [{ at: T0, u: 0.5 }],
      utilization7d: 0.52,
      utilizationAt: T0 + 2 * MIN, // closer than the floor — lives only on the rate fields
    });
    expect(s).toEqual([
      { at: T0, u: 0.5 },
      { at: T0 + 2 * MIN, u: 0.52 },
    ]);
  });

  it('tolerates a partially-hydrated row (no history, no reading)', () => {
    expect(accountBurnSamples({})).toEqual([]);
    expect(accountBurnSamples({ utilization7d: 0.5 })).toEqual([]); // no utilizationAt stamp → unusable
  });
});

// ── Verdict ladder ───────────────────────────────────────────────────────────

describe('evaluateBurn', () => {
  const now = T0;

  it('no reading → none, headroom null, reason names the gap', () => {
    const v = evaluateBurn({ utilization7d: undefined, burnRatePerHr: 0.1, now });
    expect(v.action).toBe('none');
    expect(v.headroomFraction).toBeNull();
    expect(v.projectedExhaustionAt).toBeNull();
    expect(v.reason).toMatch(/no 7d utilization reading/);
  });

  it('already at the wall (u = 1.0) → shed, projectedExhaustionAt = now', () => {
    const v = evaluateBurn({ utilization7d: 1.0, windowResetAt7d: now + 24 * HR, burnRatePerHr: null, now });
    expect(v.action).toBe('shed');
    expect(v.projectedExhaustionAt).toBe(now);
    expect(v.headroomFraction).toBe(0);
    expect(v.reason).toMatch(/already exhausted/);
  });

  it('over the wall (u > 1.0) with unknown reset → shed, reason says reset unknown', () => {
    const v = evaluateBurn({ utilization7d: 1.05, burnRatePerHr: 0.2, now });
    expect(v.action).toBe('shed');
    expect(v.exhaustsBeforeReset).toBe(false);
    expect(v.reason).toMatch(/reset unknown/);
  });

  it('insufficient history (rate null) → none, never act on missing data', () => {
    const v = evaluateBurn({ utilization7d: 0.9, windowResetAt7d: now + HR, burnRatePerHr: null, now });
    expect(v.action).toBe('none');
    expect(v.burnRatePerHr).toBeNull();
    expect(v.reason).toMatch(/insufficient burn history/);
  });

  it('zero rate → none (flat)', () => {
    const v = evaluateBurn({ utilization7d: 0.9, windowResetAt7d: now + HR, burnRatePerHr: 0, now });
    expect(v.action).toBe('none');
    expect(v.projectedExhaustionAt).toBeNull();
  });

  it('negative rate (decaying) → none, rate reported unclamped', () => {
    const v = evaluateBurn({ utilization7d: 0.9, windowResetAt7d: now + HR, burnRatePerHr: -0.05, now });
    expect(v.action).toBe('none');
    expect(v.burnRatePerHr).toBe(-0.05);
    expect(v.reason).toMatch(/flat or decaying/);
  });

  it('exhausts BEFORE reset, beyond the imminent horizon → throttle', () => {
    // u=0.5, rate=0.1/hr → exhausts in 5h; reset in 24h; horizon 2h.
    const v = evaluateBurn({ utilization7d: 0.5, windowResetAt7d: now + 24 * HR, burnRatePerHr: 0.1, now });
    expect(v.action).toBe('throttle');
    expect(v.exhaustsBeforeReset).toBe(true);
    expect(v.projectedExhaustionAt).toBeCloseTo(now + 5 * HR, -3);
    expect(v.reason).toMatch(/BEFORE the window resets/);
  });

  it('exhausts BEFORE reset AND inside the imminent horizon → shed', () => {
    // u=0.9, rate=0.1/hr → exhausts in 1h; reset in 24h; horizon 2h.
    const v = evaluateBurn({ utilization7d: 0.9, windowResetAt7d: now + 24 * HR, burnRatePerHr: 0.1, now });
    expect(v.action).toBe('shed');
    expect(v.exhaustsBeforeReset).toBe(true);
    expect(v.reason).toMatch(/imminent horizon/);
  });

  it('exhausts AFTER the reset → none (the reset relieves first)', () => {
    // u=0.9, rate=0.05/hr → exhausts in 2h; reset in 1h.
    const v = evaluateBurn({ utilization7d: 0.9, windowResetAt7d: now + HR, burnRatePerHr: 0.05, now });
    expect(v.action).toBe('none');
    expect(v.exhaustsBeforeReset).toBe(false);
    expect(v.reason).toMatch(/AFTER the window resets/);
  });

  it('reset in the PAST is stale → not exhaustsBeforeReset; imminent projection still throttles', () => {
    // u=0.9, rate=0.1/hr → exhausts in 1h (imminent); observed reset is behind the clock.
    const v = evaluateBurn({ utilization7d: 0.9, windowResetAt7d: now - HR, burnRatePerHr: 0.1, now });
    expect(v.exhaustsBeforeReset).toBe(false);
    expect(v.action).toBe('throttle');
    expect(v.reason).toMatch(/in the past — stale/);
  });

  it('reset never observed + imminent projection → throttle, reason says never observed', () => {
    const v = evaluateBurn({ utilization7d: 0.9, burnRatePerHr: 0.1, now });
    expect(v.action).toBe('throttle');
    expect(v.reason).toMatch(/never observed/);
  });

  it('reset never observed + far-off projection → none', () => {
    // u=0.2, rate=0.01/hr → exhausts in 80h.
    const v = evaluateBurn({ utilization7d: 0.2, burnRatePerHr: 0.01, now });
    expect(v.action).toBe('none');
    expect(v.reason).toMatch(/outside the .* imminent horizon/);
  });

  it('every verdict carries a non-empty reason (never silent)', () => {
    const cases = [
      { utilization7d: undefined, burnRatePerHr: null, now },
      { utilization7d: 1.2, burnRatePerHr: null, now },
      { utilization7d: 0.5, burnRatePerHr: null, now },
      { utilization7d: 0.5, burnRatePerHr: -0.1, now },
      { utilization7d: 0.5, windowResetAt7d: now + 24 * HR, burnRatePerHr: 0.1, now },
      { utilization7d: 0.99, windowResetAt7d: now + 24 * HR, burnRatePerHr: 0.5, now },
    ];
    for (const c of cases) expect(evaluateBurn(c).reason.length).toBeGreaterThan(10);
  });
});

// ── End-to-end pure composition ──────────────────────────────────────────────

describe('evaluateAccountBurn (composition over a rate-shaped row)', () => {
  it('incident replay: steady 2h climb toward the wall with a far reset → shed before the wall', () => {
    // 0.80 → 0.92 over 2h (0.06/hr) with the freshest reading only on the rate fields;
    // reset 30h out. Time to exhaustion ≈ 1.33h < 2h horizon → shed. This is the verdict
    // that did NOT exist during the 2026-08-23 exhaustion incident.
    const now = T0 + 2 * HR + 2 * MIN;
    const v = evaluateAccountBurn(
      {
        history7d: [
          { at: T0, u: 0.8 },
          { at: T0 + 40 * MIN, u: 0.84 },
          { at: T0 + 80 * MIN, u: 0.88 },
          { at: T0 + 2 * HR, u: 0.92 },
        ],
        utilization7d: 0.921,
        utilizationAt: now - MIN,
        windowResetAt7d: T0 + 30 * HR,
      },
      now,
    );
    expect(v.action).toBe('shed');
    expect(v.exhaustsBeforeReset).toBe(true);
    expect(v.burnRatePerHr).toBeGreaterThan(0.05);
  });

  it('healthy account: slow climb, reset well before projection → none', () => {
    const now = T0 + 2 * HR;
    const v = evaluateAccountBurn(
      {
        history7d: [
          { at: T0, u: 0.3 },
          { at: T0 + HR, u: 0.31 },
          { at: T0 + 2 * HR, u: 0.32 },
        ],
        utilization7d: 0.32,
        utilizationAt: now,
        windowResetAt7d: now + 20 * HR,
      },
      now,
    );
    expect(v.action).toBe('none');
  });

  it('no history at all → none (insufficient), matching BURN_EXHAUSTED_UTIL wall override', () => {
    const now = T0;
    expect(evaluateAccountBurn({ utilization7d: 0.5, utilizationAt: now }, now).action).toBe('none');
    // ...but a walled reading sheds even with zero history:
    expect(evaluateAccountBurn({ utilization7d: BURN_EXHAUSTED_UTIL, utilizationAt: now }, now).action).toBe('shed');
  });
});

// ── Stale gate + selection wiring (WI-41147 legs a/d) ────────────────────────

describe('accountBurnVerdict stale gate', () => {
  it('never-observed reading → none, governor stands down', () => {
    const v = accountBurnVerdict({ pausedUntil: 0, lastPenaltyAt: 0, penaltyCount: 0, windowStartedAt: 0 }, T0);
    expect(v.action).toBe('none');
    expect(v.reason).toMatch(/never observed/);
  });

  it('stale reading (past DRAIN_UTIL_STALE_MS) → none even on an alarming trajectory', () => {
    const rate = {
      pausedUntil: 0,
      lastPenaltyAt: 0,
      penaltyCount: 0,
      windowStartedAt: 0,
      history7d: [
        { at: T0 - 2 * HR, u: 0.9 },
        { at: T0 - HR, u: 0.98 },
      ],
      utilization7d: 0.98,
      utilizationAt: T0 - HR, // 1h old ≫ 10min staleness window
      windowResetAt7d: T0 + 24 * HR,
    };
    const v = accountBurnVerdict(rate, T0);
    expect(v.action).toBe('none');
    expect(v.reason).toMatch(/stale/);
    // ...while the SAME row with a fresh stamp sheds:
    expect(accountBurnVerdict({ ...rate, utilizationAt: T0 }, T0).action).toBe('shed');
  });
});

describe('selectAccountForSpawn burn wiring', () => {
  // Build a 2-account pool: `bad` has MORE 5h headroom (would win the drain) but a burn
  // trajectory; `ok` is flat. Selection at T0+35min keeps the last reading fresh (<10min).
  const SEL_NOW = T0 + 35 * MIN;

  function poolWith(badTrajectory: { u0: number; u1: number; resetAt?: number }): AccountPool {
    let pool: AccountPool = { accounts: [] };
    pool = registerAccount(pool, { id: 'bad', credentialRef: 'cred-bad' }, T0 - HR);
    pool = registerAccount(pool, { id: 'ok', credentialRef: 'cred-ok' }, T0 - HR);
    // `bad`: low 5h util (drain-attractive), climbing 7d util.
    pool = recordAccountWindow(
      pool,
      'bad',
      { utilization: 0.1, utilization7d: badTrajectory.u0, windowResetAt7d: badTrajectory.resetAt },
      T0,
    );
    pool = recordAccountWindow(pool, 'bad', { utilization: 0.1, utilization7d: badTrajectory.u1 }, T0 + 30 * MIN);
    // `ok`: higher 5h util (drain-unattractive), flat 7d.
    pool = recordAccountWindow(pool, 'ok', { utilization: 0.5, utilization7d: 0.5, windowResetAt7d: T0 + 24 * HR }, T0);
    pool = recordAccountWindow(pool, 'ok', { utilization: 0.5, utilization7d: 0.5 }, T0 + 30 * MIN);
    return pool;
  }

  it('a SHED-trajectory account is refused the hard pin — at LOW absolute utilization, where the drain selector alone would still pick it', () => {
    // 0.31 → 0.45 in 30min = 0.28/hr → exhausts in ~1.96h (imminent), reset 24h out → shed.
    // Effective drain util for `bad` = max(0.1, 0.45) = 0.45 < `ok`'s 0.5, so WITHOUT the
    // governor the drain would pick `bad` (the flag-off test below proves that) — this is the
    // trajectory-not-threshold case the governor exists for.
    const pool = poolWith({ u0: 0.31, u1: 0.45, resetAt: T0 + 24 * HR });
    expect(accountBurnAction(pool.accounts[0]!, SEL_NOW)).toBe('shed');
    const sel = selectAccountForSpawn(pool, SEL_NOW, { rng: () => 0 });
    expect(sel.accountId).toBe('ok');
  });

  it('a THROTTLE-trajectory account yields to a non-throttled peer (first-pass preference) despite better drain', () => {
    // 0.30 → 0.40 in 30min = 0.2/hr → exhausts in ~3h (not imminent) BEFORE the 24h reset → throttle.
    // Effective drain util for `bad` = 0.40 < `ok`'s 0.5 — drain alone would pick `bad`.
    const pool = poolWith({ u0: 0.3, u1: 0.4, resetAt: T0 + 24 * HR });
    expect(accountBurnAction(pool.accounts[0]!, SEL_NOW)).toBe('throttle');
    const sel = selectAccountForSpawn(pool, SEL_NOW, { rng: () => 0 });
    expect(sel.accountId).toBe('ok');
  });

  it('when EVERY candidate is throttled the second pass still serves one (graceful, never bricks the pool)', () => {
    let pool = poolWith({ u0: 0.5, u1: 0.55, resetAt: T0 + 24 * HR });
    // Make `ok` throttled too.
    pool = {
      accounts: pool.accounts.map((a) =>
        a.id === 'ok'
          ? {
              ...a,
              rate: {
                ...a.rate,
                history7d: [
                  { at: T0, u: 0.5 },
                  { at: T0 + 30 * MIN, u: 0.56 },
                ],
                utilization7d: 0.56,
                windowResetAt7d: T0 + 24 * HR,
              },
            }
          : a,
      ),
    };
    expect(accountBurnAction(pool.accounts[1]!, SEL_NOW)).toBe('throttle');
    const sel = selectAccountForSpawn(pool, SEL_NOW, { rng: () => 0 });
    expect(sel.accountId).toBeDefined(); // still serves — throttle is a preference, not a wall
  });

  it('all-shed pool → no hard pin (the gateway unpinned failover path takes over)', () => {
    let pool = poolWith({ u0: 0.9, u1: 0.95, resetAt: T0 + 24 * HR });
    pool = {
      accounts: pool.accounts.map((a) =>
        a.id === 'ok'
          ? {
              ...a,
              rate: {
                ...a.rate,
                history7d: [
                  { at: T0, u: 0.88 },
                  { at: T0 + 30 * MIN, u: 0.94 },
                ],
                utilization7d: 0.94,
                windowResetAt7d: T0 + 24 * HR,
              },
            }
          : a,
      ),
    };
    const sel = selectAccountForSpawn(pool, SEL_NOW, { rng: () => 0 });
    expect(sel.accountId).toBeUndefined();
  });

  it('burnGovernor: false restores pre-governor selection (the shed-trajectory account wins on drain again)', () => {
    // Same low-absolute-util shed trajectory as above: effective drain util 0.45 vs 0.5 means
    // pre-governor drain picks `bad` — proving the governor (not the existing 7d wall ranking)
    // is what flipped the choice in the shed test.
    const pool = poolWith({ u0: 0.31, u1: 0.45, resetAt: T0 + 24 * HR });
    const sel = selectAccountForSpawn(pool, SEL_NOW, { rng: () => 0, burnGovernor: false });
    expect(sel.accountId).toBe('bad'); // kill-switch semantics: byte-identical to pre-governor
  });

  it('a sticky prior account with a shed trajectory is evacuated', () => {
    const pool = poolWith({ u0: 0.9, u1: 0.95, resetAt: T0 + 24 * HR });
    const sel = selectAccountForSpawn(pool, SEL_NOW, { rng: () => 0, priorAccountId: 'bad' });
    expect(sel.accountId).toBe('ok'); // sticky would have kept 'bad'; shed breaks the pin
  });

  it('a sticky prior account with only a THROTTLE trajectory keeps the pin (cache affinity dominates)', () => {
    const pool = poolWith({ u0: 0.5, u1: 0.55, resetAt: T0 + 24 * HR });
    const sel = selectAccountForSpawn(pool, SEL_NOW, { rng: () => 0, priorAccountId: 'bad' });
    expect(sel.accountId).toBe('bad');
    expect(sel.pinSource).toBe('sticky');
  });
});

describe('aggregatePoolBurn — the pool verdict for the concurrency lever (leg b)', () => {
  it('empty pool → none (never act on missing data)', () => {
    const agg = aggregatePoolBurn([]);
    expect(agg.action).toBe('none');
    expect(agg.total).toBe(0);
    expect(agg.reason).toContain('no accounts');
  });

  it('all shed → shed (nowhere to route)', () => {
    const agg = aggregatePoolBurn(['shed', 'shed', 'shed']);
    expect(agg.action).toBe('shed');
    expect(agg.counts).toEqual({ none: 0, throttle: 0, shed: 3 });
    expect(agg.reason).toContain('nowhere to route');
  });

  it('every account throttle-or-shed (zero none) → throttle (spreading cannot relieve)', () => {
    const agg = aggregatePoolBurn(['throttle', 'shed', 'throttle']);
    expect(agg.action).toBe('throttle');
    expect(agg.counts).toEqual({ none: 0, throttle: 2, shed: 1 });
    expect(agg.reason).toContain('slow the fleet');
  });

  it('all throttle → throttle', () => {
    const agg = aggregatePoolBurn(['throttle', 'throttle']);
    expect(agg.action).toBe('throttle');
    expect(agg.counts).toEqual({ none: 0, throttle: 2, shed: 0 });
  });

  it('a single none account stands the lever down — even beside universal shed', () => {
    const agg = aggregatePoolBurn(['shed', 'shed', 'none']);
    expect(agg.action).toBe('none');
    expect(agg.reason).toContain('route around');
    expect(agg.counts).toEqual({ none: 1, throttle: 0, shed: 2 });
  });
});
