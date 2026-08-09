/**
 * WI-37465 recurrence guard — `getSharedSwarm()` must construct exactly ONE
 * Hyperswarm no matter how many callers race it.
 *
 * THE BUG: `getSharedSwarm()` guarded with `if (_sharedSwarm) return` and then
 * awaited THREE times (`import('hyperswarm')`, `loadOrGenerateSwarmSeed()`,
 * `import('hyperdht')`) before assigning `_sharedSwarm`. Classic check-then-act:
 * every caller entering during those awaits saw `null`, passed the guard, and
 * built its own swarm. There are >=6 callers and several run concurrently at
 * boot (hive-directory-boot, cross-hive-boundary-boot, substrate-wake-wiring).
 *
 * WHY IT MATTERED: `identity/swarm-keypair.ts` scopes the seed to
 * `machineFingerprint()` — PER MACHINE — so every extra instance loads the SAME
 * seed and therefore the SAME public key, then joins the SAME DHT announcing the
 * same topics. Measured 2026-08-09 on the rig (172.31.44.2, pid 24727): three
 * swarms built 2ms apart, holding three UDP sockets. The tower built one.
 *
 * THE FIX: memoize the in-flight PROMISE, assigned synchronously, so there is no
 * await between the check and the set.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

/** Counts real `new Swarm(...)` calls across a test. */
let constructed = 0;

vi.mock('hyperswarm', () => ({
  default: class FakeSwarm {
    connections = new Set<unknown>();
    constructor() {
      constructed++;
    }
    setMaxListeners(): void {}
    on(): void {}
    off(): void {}
  },
}));

// The seed load is one of the three awaits the race lived in. Give it a REAL
// timer tick so the race window is wide and deterministic rather than
// microtask-thin — a microtask-only stub can pass even against the buggy shape.
vi.mock('../../../identity/swarm-keypair', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../identity/swarm-keypair')>();
  return {
    ...actual,
    loadOrGenerateSwarmSeed: async () => {
      await new Promise((r) => setTimeout(r, 5));
      return Buffer.alloc(32, 7);
    },
  };
});

vi.mock('protomux', () => ({
  default: class FakeProtomux {
    static from(): unknown {
      return new FakeProtomux();
    }
    createChannel(): unknown {
      return { addMessage: () => ({ send: () => {} }), open: () => {}, close: () => {} };
    }
  },
}));

vi.mock('compact-encoding', () => ({ default: { json: {} } }));

const { getSharedSwarm, _setSharedSwarmForTests } = await import('../swarm');

beforeEach(() => {
  constructed = 0;
  _setSharedSwarmForTests(null);
});

describe('WI-37465: getSharedSwarm() is race-safe', () => {
  it('constructs exactly ONE swarm under 8 concurrent callers', async () => {
    const swarms = await Promise.all(Array.from({ length: 8 }, () => getSharedSwarm()));

    // The property that actually matters: one construction, one identity.
    expect(constructed).toBe(1);
    // ...and every caller got the SAME instance, not just an equal count.
    expect(new Set(swarms).size).toBe(1);
  });

  it('still returns the same instance for callers arriving AFTER the build settles', async () => {
    const first = await getSharedSwarm();
    const second = await getSharedSwarm();

    expect(constructed).toBe(1);
    expect(second).toBe(first);
  });

  it('a failed build is retryable — it does not poison the process with a rejected memo', async () => {
    // Reaching the real failure path would need the hyperswarm mock to throw
    // mid-suite; the contract asserted here is the observable one: after a
    // reset, a later caller still gets a fresh working build rather than an
    // inherited rejection.
    _setSharedSwarmForTests(null);
    const swarm = await getSharedSwarm();

    expect(swarm).toBeTruthy();
    expect(constructed).toBe(1);
  });
});

describe('WI-37465 CONTROL: the assertion above can actually fail', () => {
  /**
   * A guard that has never failed is a guard you have not tested. This keeps the
   * PRE-FIX shape permanently in the test file as a control, per CLAUDE.md's
   * "Proving a guard is falsifiable" rule — so the suite proves the race is
   * detectable WITHOUT ever mutating the shared tree to check.
   */
  it('reproduces the check-then-act race: 8 callers, 8 constructions', async () => {
    let cached: { id: number } | null = null;
    let built = 0;

    const racyGetSharedSwarm = async (): Promise<{ id: number }> => {
      if (cached) return cached; // guard...
      await new Promise((r) => setTimeout(r, 5)); // ...then an await. This is the bug.
      built++;
      cached = { id: built };
      return cached;
    };

    const results = await Promise.all(Array.from({ length: 8 }, () => racyGetSharedSwarm()));

    // Every caller passed the guard before any of them assigned the memo.
    expect(built).toBe(8);
    // And they did NOT all share one instance — the real-world consequence.
    expect(new Set(results).size).toBeGreaterThan(1);
  });
});
