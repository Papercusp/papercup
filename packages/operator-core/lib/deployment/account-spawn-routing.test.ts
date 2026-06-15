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
  bindAccount,
  emptyPool,
  recordAccountPenalty,
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

  it('is a pure function of (pool, harness): same inputs → same account, regardless of placement / call order', async () => {
    h.pool = poolOf('a', 'b', 'c');
    const first = await selectSpawnAccount('ws', 'harness-x');
    expect(first).toBeDefined();
    // The Queen re-placing the same bee (or placing another bee into the same harness) passes NO account
    // hint — re-resolving for the same harness is byte-identical. Selection never depends on a Queen call.
    expect(await selectSpawnAccount('ws', 'harness-x')).toBe(first);
    expect(await selectSpawnAccount('ws', 'harness-x')).toBe(first);
  });

  it('routes by HARNESS cache-affinity (a bound account wins), proving (harness, pool) is the sole input', async () => {
    let p = poolOf('a', 'b');
    p = bindAccount(p, 'b', 'harness-x');
    h.pool = p;
    expect(await selectSpawnAccount('ws', 'harness-x')).toBe('b');
    // A DIFFERENT harness with no binding falls through to budget-drain order (oldest-added 'a') — the
    // account tracks the harness, not who/what placed the bee.
    expect(await selectSpawnAccount('ws', 'other-harness')).toBe('a');
  });

  it('avoids a paused/over-budget account, picking a budgeted one (budget-aware selection)', async () => {
    const now = Date.now();
    let p = poolOf('a', 'b');
    // 'a' is the oldest-added (would win on recency), but it is paused → selection must skip it for 'b'.
    p = recordAccountPenalty(p, 'a', now, { pausedUntil: now + 60 * 60_000 });
    h.pool = p;
    expect(await selectSpawnAccount('ws', undefined)).toBe('b');
  });

  it('respects sticky prior-account affinity when still available (per-credential cache reuse)', async () => {
    h.pool = poolOf('a', 'b', 'c');
    expect(await selectSpawnAccount('ws', 'harness-x', 'c')).toBe('c');
  });
});
