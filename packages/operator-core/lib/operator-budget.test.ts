/**
 * operator-budget — direct unit coverage (wave-8, Gaps 1 & 2).
 *
 * The operator daily-spend cap had ZERO direct tests; checkBudget /
 * recordSpend / loadBudget / setBudget were only ever reached through
 * mocks in sibling suites. This pins their contracts directly.
 *
 * Strategy: mock `./operator-state-pg` with a tiny in-memory store.
 *   - readOperatorState / writeOperatorState read/write `store.value`.
 *   - updateOperatorState mirrors the real read-modify-write: it loads the
 *     current value (defaulting), runs the mutator, and persists the result.
 *     For the atomicity test (Gap 2) we drive the captured mutator with
 *     two SEQUENTIAL states and assert it ACCUMULATES into today's entry
 *     rather than clobbering — the hermetic equivalent of the N-concurrent
 *     recordSpend → sum check (no testcontainers PG needed).
 *
 * `todayIso()` uses real `new Date()`; tests that touch "today" compute the
 * same ISO slice so they stay date-independent.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface Store {
  value: unknown;
  // captures the last mutator handed to updateOperatorState (Gap 2 driver)
  lastMutator: ((cur: unknown) => unknown) | null;
  lastDefault: unknown;
}

const store: Store = { value: null, lastMutator: null, lastDefault: null };

vi.mock('./operator-state-pg', () => ({
  readOperatorState: vi.fn(async () => store.value),
  writeOperatorState: vi.fn(async (_table: string, payload: unknown) => {
    store.value = payload;
  }),
  updateOperatorState: vi.fn(
    async (_table: string, defaultValue: unknown, mutator: (cur: unknown) => unknown) => {
      store.lastMutator = mutator;
      store.lastDefault = defaultValue;
      const cur = store.value == null ? defaultValue : store.value;
      const next = mutator(cur);
      store.value = next;
      return next;
    },
  ),
}));

// setBudget fires a fire-and-forget disposition-ledger write via dynamic
// import; stub both modules so it never touches PG / workspace-registry.
vi.mock('./decision-ledger/disposition', () => ({
  recordProactiveDisposition: vi.fn(async () => {}),
}));
vi.mock('./workspace-registry', () => ({
  activeWorkspaceId: () => 'test-ws',
}));

import { checkBudget, recordSpend, loadBudget, setBudget } from './operator-budget';

const todayIso = () => new Date().toISOString().slice(0, 10);

beforeEach(() => {
  store.value = null;
  store.lastMutator = null;
  store.lastDefault = null;
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('checkBudget', () => {
  it('returns exceeded:false, capUsd:0, state:null when no budget configured', async () => {
    store.value = null;
    const c = await checkBudget();
    expect(c).toEqual({ exceeded: false, todaySpendUsd: 0, capUsd: 0, state: null });
  });

  it('also treats a malformed (non-number dailyCapUsd) payload as unconfigured', async () => {
    store.value = { dailyCapUsd: 'oops', spend: [] };
    const c = await checkBudget();
    expect(c.state).toBeNull();
    expect(c.exceeded).toBe(false);
    expect(c.capUsd).toBe(0);
  });

  describe('exceeded boundary — flips EXACTLY at todaySpendUsd >= capUsd', () => {
    const CAP = 20;
    const EPS = 0.000001;

    it('false just BELOW the cap (capUsd - epsilon)', async () => {
      store.value = { dailyCapUsd: CAP, spend: [{ date: todayIso(), usd: CAP - EPS }] };
      expect((await checkBudget()).exceeded).toBe(false);
    });

    it('TRUE exactly AT the cap (todaySpendUsd === capUsd)', async () => {
      store.value = { dailyCapUsd: CAP, spend: [{ date: todayIso(), usd: CAP }] };
      expect((await checkBudget()).exceeded).toBe(true);
    });

    it('TRUE just ABOVE the cap (capUsd + epsilon)', async () => {
      store.value = { dailyCapUsd: CAP, spend: [{ date: todayIso(), usd: CAP + EPS }] };
      expect((await checkBudget()).exceeded).toBe(true);
    });
  });

  it('counts only TODAY spend toward the cap (a prior-day overrun does not trip it)', async () => {
    store.value = {
      dailyCapUsd: 5,
      spend: [
        { date: '2000-01-01', usd: 999 }, // ancient, irrelevant
        { date: todayIso(), usd: 1 },
      ],
    };
    const c = await checkBudget();
    expect(c.todaySpendUsd).toBe(1);
    expect(c.exceeded).toBe(false);
  });
});

describe('loadBudget', () => {
  it('returns null when payload absent or dailyCapUsd is not a number', async () => {
    store.value = null;
    expect(await loadBudget()).toBeNull();
    store.value = { spend: [] };
    expect(await loadBudget()).toBeNull();
    store.value = { dailyCapUsd: 'x', spend: [] };
    expect(await loadBudget()).toBeNull();
  });

  it('drops malformed spend entries (non-string date, non-number usd, null)', async () => {
    store.value = {
      dailyCapUsd: 20,
      spend: [
        { date: '2026-06-10', usd: 1 }, // keep
        { date: 12345, usd: 2 }, // drop: non-string date
        { date: '2026-06-11', usd: 'three' }, // drop: non-number usd
        null, // drop
        { date: '2026-06-12', usd: 4 }, // keep
      ],
    };
    const b = await loadBudget();
    expect(b?.spend).toEqual([
      { date: '2026-06-10', usd: 1 },
      { date: '2026-06-12', usd: 4 },
    ]);
  });

  it('keeps only the last 7 entries (slice(-7))', async () => {
    const spend = Array.from({ length: 12 }, (_, i) => ({
      date: `2026-06-${String(i + 1).padStart(2, '0')}`,
      usd: i,
    }));
    store.value = { dailyCapUsd: 20, spend };
    const b = await loadBudget();
    expect(b?.spend).toHaveLength(7);
    // the LAST 7 (indices 5..11)
    expect(b?.spend[0]).toEqual({ date: '2026-06-06', usd: 5 });
    expect(b?.spend[6]).toEqual({ date: '2026-06-12', usd: 11 });
  });

  it('coerces a missing/non-array spend to []', async () => {
    store.value = { dailyCapUsd: 20 };
    expect((await loadBudget())?.spend).toEqual([]);
    store.value = { dailyCapUsd: 20, spend: 'not-an-array' };
    expect((await loadBudget())?.spend).toEqual([]);
  });
});

describe('setBudget', () => {
  it('throws on a non-positive cap', async () => {
    await expect(setBudget(0)).rejects.toThrow(/positive/);
    await expect(setBudget(-5)).rejects.toThrow(/positive/);
  });

  it('throws on a non-finite cap (NaN / Infinity)', async () => {
    await expect(setBudget(NaN)).rejects.toThrow();
    await expect(setBudget(Infinity)).rejects.toThrow();
  });

  it('persists the cap and PRESERVES existing spend history', async () => {
    store.value = { dailyCapUsd: 5, spend: [{ date: '2026-06-10', usd: 2 }] };
    const next = await setBudget(50);
    expect(next.dailyCapUsd).toBe(50);
    expect(next.spend).toEqual([{ date: '2026-06-10', usd: 2 }]);
    // and it was written through
    expect(store.value).toEqual({ dailyCapUsd: 50, spend: [{ date: '2026-06-10', usd: 2 }] });
  });

  it('starts from empty spend when none existed', async () => {
    store.value = null;
    const next = await setBudget(20);
    expect(next).toEqual({ dailyCapUsd: 20, spend: [] });
  });
});

describe('recordSpend', () => {
  it('no-ops on usd <= 0 (does not call updateOperatorState)', async () => {
    const pg = await import('./operator-state-pg');
    store.value = { dailyCapUsd: 20, spend: [] };
    await recordSpend(0);
    await recordSpend(-3);
    expect(pg.updateOperatorState).not.toHaveBeenCalled();
    expect(store.value).toEqual({ dailyCapUsd: 20, spend: [] });
  });

  it('no-ops on NaN / non-finite usd', async () => {
    const pg = await import('./operator-state-pg');
    store.value = { dailyCapUsd: 20, spend: [] };
    await recordSpend(NaN);
    await recordSpend(Infinity);
    expect(pg.updateOperatorState).not.toHaveBeenCalled();
  });

  it('no-ops (leaves state untouched) when dailyCapUsd is undefined / unconfigured', async () => {
    // updateOperatorState still runs, but the mutator must return cur unchanged.
    store.value = null; // -> default { dailyCapUsd: undefined, spend: [] }
    await recordSpend(1.25);
    // default value carried through unchanged — no spend entry pushed
    expect((store.value as { spend: unknown[] }).spend).toEqual([]);
    expect((store.value as { dailyCapUsd: unknown }).dailyCapUsd).toBeUndefined();
  });

  it('pushes a NEW entry for today when none exists', async () => {
    store.value = { dailyCapUsd: 20, spend: [{ date: '2000-01-01', usd: 9 }] };
    await recordSpend(2.5);
    const spend = (store.value as { spend: { date: string; usd: number }[] }).spend;
    const today = spend.find((s) => s.date === todayIso());
    expect(today).toEqual({ date: todayIso(), usd: 2.5 });
  });

  it("ACCUMULATES into today's existing entry rather than overwriting", async () => {
    store.value = { dailyCapUsd: 20, spend: [{ date: todayIso(), usd: 1 }] };
    await recordSpend(0.5);
    const spend = (store.value as { spend: { date: string; usd: number }[] }).spend;
    expect(spend.find((s) => s.date === todayIso())).toEqual({ date: todayIso(), usd: 1.5 });
    // only one entry for today (accumulated, not duplicated)
    expect(spend.filter((s) => s.date === todayIso())).toHaveLength(1);
  });

  it('caps the persisted spend array at the last 7 entries', async () => {
    const spend = Array.from({ length: 7 }, (_, i) => ({
      date: `2026-06-${String(i + 1).padStart(2, '0')}`,
      usd: 1,
    }));
    store.value = { dailyCapUsd: 20, spend };
    await recordSpend(3); // pushes today (8th) -> slice(-7) drops the oldest
    const out = (store.value as { spend: { date: string; usd: number }[] }).spend;
    expect(out).toHaveLength(7);
    expect(out.some((s) => s.date === '2026-06-01')).toBe(false); // oldest dropped
    expect(out.some((s) => s.date === todayIso())).toBe(true);
  });
});

/**
 * Gap 2 — read-modify-write atomicity (HERMETIC unit, not a real PG run).
 *
 * The doc comment on recordSpend claims concurrent scans each get their full
 * spend recorded because the read-modify-write runs inside one PG
 * transaction (updateOperatorState's FOR UPDATE). We can't drive real
 * concurrency in a unit, but the load-bearing invariant is that the mutator
 * ACCUMULATES onto whatever committed state it is handed. We capture the
 * mutator recordSpend passes and replay it across two SEQUENTIAL states —
 * exactly what two serialized transactions would feed it — and assert the
 * sum is preserved (never clobbered). NOTE: hermetic unit (no testcontainers).
 */
describe('recordSpend — atomicity (mutator accumulates across serialized states)', () => {
  it('two serialized applications sum into one today-entry', async () => {
    store.value = { dailyCapUsd: 20, spend: [{ date: todayIso(), usd: 0 }] };

    // tab A records $4 — mutator sees committed {usd:0}
    await recordSpend(4);
    const mutator = store.lastMutator!;
    expect(mutator).toBeTypeOf('function');

    // tab B's transaction now sees tab A's COMMITTED state as input (FOR UPDATE
    // serialization). Replay the captured mutator on that committed state with
    // a fresh $6 to prove it accumulates onto — never replaces — the prior write.
    const afterA = store.value as { dailyCapUsd: number; spend: { date: string; usd: number }[] };
    expect(afterA.spend.find((s) => s.date === todayIso())?.usd).toBe(4);

    // Drive recordSpend a second time (it re-derives its own mutator) — store
    // already holds tab A's commit, so this is the serialized "second tab".
    await recordSpend(6);
    const final = store.value as { spend: { date: string; usd: number }[] };
    expect(final.spend.find((s) => s.date === todayIso())?.usd).toBe(10); // 4 + 6, nothing lost
  });

  it('the captured mutator itself is pure-accumulate (clobbering it would fail this)', async () => {
    store.value = { dailyCapUsd: 20, spend: [{ date: todayIso(), usd: 2 }] };
    await recordSpend(3);
    const mutator = store.lastMutator!;
    // Hand the mutator a DIFFERENT committed state (as a racing tx would) and
    // assert it adds 3 to whatever it is given (here 100), not to a stale copy.
    const out = mutator({ dailyCapUsd: 20, spend: [{ date: todayIso(), usd: 100 }] }) as {
      spend: { date: string; usd: number }[];
    };
    expect(out.spend.find((s) => s.date === todayIso())?.usd).toBe(103);
  });
});
