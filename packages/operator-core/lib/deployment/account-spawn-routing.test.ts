/**
 * Regression lock for the Queen-INDEPENDENT, deterministic egress-account routing invariant
 * (multi-account-routing-verification D-001). The account a spawning bee egresses through is decided
 * ONLY by `selectSpawnAccount(ws, harness, priorAccountId?)` → `selectAccountForSpawn` (cache-affinity
 * + harness binding + budget-drain) at spawn time. The Queen PLACES the bee (it supplies the harness
 * `slug`) but passes NO account hint — `operator-spawn.ts` calls `selectSpawnAccount(workspaceId, slug)`
 * with no account/placement argument, and there is no such parameter to pass. These tests assert the
 * wrapper's contract so a future change can't sneak a Queen/placement account decision into the path.
 *
 * The pool IO (`../operator-state-pg`) is mocked so this is a pure unit test — no PG, no real pool.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DRAIN_UTIL_STALE_MS,
  bindAccount,
  emptyPool,
  recordAccountPenalty,
  recordAccountWindow,
  registerAccount,
  type AccountPool,
} from './account-pool';

const h = vi.hoisted(() => ({ pool: null as AccountPool | null, fail: false }));

vi.mock('../operator-state-pg', () => ({
  readOperatorState: async () => {
    if (h.fail) throw new Error('operator-state read failed (simulated IO error)');
    return h.pool;
  },
  writeOperatorState: async () => {},
}));

// Import AFTER the mock is registered (vi.mock is hoisted, so this is safe).
import { selectSpawnAccount } from './account-pool-store';

const ADDED = 1_700_000_000_000;
/** Deterministic RNG seed for the drain spread: `() => 0` → the spread returns its deterministic best,
 *  so these regression locks assert a stable account under a fixed seed while production spreads. */
const SEED0 = () => 0;

function poolOf(...ids: string[]): AccountPool {
  let p = emptyPool();
  ids.forEach((id, i) => (p = registerAccount(p, { id, credentialRef: `token:~/.papercusp/${id}` }, ADDED + i)));
  return p;
}

beforeEach(() => {
  h.pool = null;
  h.fail = false;
});

describe('selectSpawnAccount — deterministic, Queen-independent egress-account routing (D-001)', () => {
  it('returns undefined with ≤1 account — no per-bee routing; the gateway active() account serves', async () => {
    h.pool = poolOf('only');
    expect(await selectSpawnAccount('ws', 'harness-x')).toBeUndefined();
  });

  it('fails soft to undefined when the pool cannot be loaded (no header → gateway falls back)', async () => {
    h.fail = true;
    expect(await selectSpawnAccount('ws', 'harness-x')).toBeUndefined();
  });

  it('is Queen-independent: same (pool, harness, seed) → same account, regardless of placement / call order', async () => {
    h.pool = poolOf('a', 'b', 'c');
    const first = await selectSpawnAccount('ws', 'harness-x', undefined, 'claude', SEED0);
    expect(first).toBeDefined();
    // The Queen re-placing the same bee (or placing another bee into the same harness) passes NO account
    // hint — re-resolving for the same harness under the same seed is byte-identical. Selection never
    // depends on a Queen call. (Production spreads via Math.random; the seed isolates that here.)
    expect(await selectSpawnAccount('ws', 'harness-x', undefined, 'claude', SEED0)).toBe(first);
    expect(await selectSpawnAccount('ws', 'harness-x', undefined, 'claude', SEED0)).toBe(first);
  });

  it('routes by HARNESS cache-affinity (a bound account wins), proving (harness, pool) is the sole input', async () => {
    let p = poolOf('a', 'b');
    p = bindAccount(p, 'b', 'harness-x');
    h.pool = p;
    expect(await selectSpawnAccount('ws', 'harness-x')).toBe('b');
    // A DIFFERENT harness with no binding falls through to the budget-drain spread; under SEED0 that is
    // the deterministic best (oldest-added 'a') — the account tracks the harness, not who placed the bee.
    expect(await selectSpawnAccount('ws', 'other-harness', undefined, 'claude', SEED0)).toBe('a');
  });

  it('avoids a paused/over-budget account, picking a budgeted one (budget-aware selection)', async () => {
    const now = Date.now();
    let p = poolOf('a', 'b');
    // 'a' is the oldest-added (would win on recency), but it is paused → the spread prefers the
    // account that can serve immediately.
    p = recordAccountPenalty(p, 'a', now, { pausedUntil: now + 60 * 60_000 });
    h.pool = p;
    expect(await selectSpawnAccount('ws', undefined)).toBe('b');
  });

  it('does not pin a paused account when every pool account is currently paused', async () => {
    const now = Date.now();
    let p = poolOf('a', 'b');
    p = recordAccountPenalty(p, 'a', now, { pausedUntil: now + 60_000 });
    p = recordAccountPenalty(p, 'b', now, { pausedUntil: now + 120_000 });
    h.pool = p;

    // No account header is safer than a known-paused header: the gateway's
    // unpinned active/failover path can pace/rotate, while a hard pin returns a
    // terminal 429 to the spawned CLI and kills the autonomous turn.
    expect(await selectSpawnAccount('ws', undefined)).toBeUndefined();
  });

  it('SPREADS concurrent fresh bees across budgeted accounts instead of piling on one (anti-thundering-herd)', async () => {
    h.pool = poolOf('a', 'b', 'c'); // all equal headroom
    // Production rng (Math.random) over many fresh spawns must touch more than one account — the fix for
    // the owner-reported "accounts have usage but aren't being picked" funnel.
    const seen = new Set<string | undefined>();
    for (let i = 0; i < 40; i++) seen.add(await selectSpawnAccount('ws', undefined));
    expect(seen.size).toBeGreaterThan(1);
  });

  it('respects sticky prior-account affinity when still available (per-credential cache reuse)', async () => {
    h.pool = poolOf('a', 'b', 'c');
    expect(await selectSpawnAccount('ws', 'harness-x', 'c')).toBe('c');
  });

  it('filters by provider for Codex spawn routing, leaving legacy Claude selection unchanged', async () => {
    let p = poolOf('claude-a', 'claude-b');
    p = registerAccount(p, {
      id: 'codex-a',
      provider: 'codex',
      credentialRef: 'token:~/.papercusp/codex-a',
    }, ADDED + 10);
    p = registerAccount(p, {
      id: 'codex-b',
      provider: 'codex',
      credentialRef: 'token:~/.papercusp/codex-b',
    }, ADDED + 11);
    h.pool = p;

    expect(await selectSpawnAccount('ws', 'harness-x', undefined, 'codex')).toMatch(/^codex-/);
    expect(await selectSpawnAccount('ws', 'harness-y')).toMatch(/^claude-/);
  });
});

describe('selectSpawnAccount — accurate header-derived budget signal does not mis-route (P-004 / D-002, post-usage-accuracy-fix D-004)', () => {
  // Validates the spawn entry point against su-df00939e's usage-accuracy fix: the budget signal read
  // by selectAccountForSpawn → selectAccountByDrain is `rate.utilization` written by recordAccountWindow
  // (from the unified-5h header), gated by DRAIN_UTIL_STALE_MS freshness. A STALE/false 99% must NOT
  // push spawns off a budgeted account; a FRESH near-budget reading MUST be honored.
  it('a STALE high-utilization reading is ignored — a false-99% does NOT avoid a budgeted account', async () => {
    const now = Date.now();
    let p = poolOf('a', 'b');
    // 'a' got a 99% reading long ago (the false-exhaustion scenario) — now stale → treated as empty.
    p = recordAccountWindow(p, 'a', { utilization: 0.99 }, now - DRAIN_UTIL_STALE_MS - 60_000);
    // 'b' has a FRESH mid reading.
    p = recordAccountWindow(p, 'b', { utilization: 0.4 }, now);
    h.pool = p;
    // stale 'a' → drainUtil 0 (most-available) → the spread's best under SEED0; the false-99% did not mis-route.
    expect(await selectSpawnAccount('ws', undefined, undefined, 'claude', SEED0)).toBe('a');
  });

  it('a FRESH near-budget reading IS honored — the spawn avoids it for a budgeted account', async () => {
    const now = Date.now();
    let p = poolOf('a', 'b');
    p = recordAccountWindow(p, 'a', { utilization: 0.99 }, now); // genuinely near budget (fresh)
    p = recordAccountWindow(p, 'b', { utilization: 0.2 }, now); // budgeted
    h.pool = p;
    // Under SEED0 the spread returns its best (the budgeted 'b'); 'a' keeps only a slim weighted chance.
    expect(await selectSpawnAccount('ws', undefined, undefined, 'claude', SEED0)).toBe('b');
  });
});
