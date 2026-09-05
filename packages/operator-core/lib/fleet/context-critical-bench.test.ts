/**
 * context-critical-bench.test.ts — recurrence guard for P-009's claim-path auto-bench and
 * the bench park it shares with `fleet:bench`.
 *
 * These two hazards are the reason the module exists, and both are SILENT in production —
 * neither throws, and neither shows up in the refusal the caller sees:
 *
 *  1. An auto-bench that supersedes prior benches destroys a leader's staged assignment,
 *     and the leader never learns of it. The park shape is shared with `fleet:bench`, where
 *     superseding is CORRECT, so the wrong behaviour here is one boolean away and would look
 *     entirely reasonable in review.
 *  2. A bench failure that escapes converts a clean compact-first refusal into an error. The
 *     refusal is the load-bearing result; the bench is an observability improvement on top of
 *     it. Regressing that trades a working behaviour for a broken one.
 *
 * The deadline assertion guards the recovery GUARANTEE (D-009): with a non-null timeoutSec
 * the deadline is what returns a member that never compacts. A null deadline here would park
 * such a member forever while still passing every other assertion in this file.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  autoBenchContextCriticalCaller,
  contextCompactedWakeKey,
  CONTEXT_CRITICAL_BENCH_TIMEOUT_SEC,
  type AutoBenchDeps,
} from './context-critical-bench';
import { registerBenchPark } from './bench-park';
import { FLEET_BENCH_NOTE_PREFIX } from '../events/await/store';

const MEMBER = 'su-critical-member';

type RegisterAwaitArgs = Parameters<AutoBenchDeps['registerAwait']>[0];

function deps(over: Partial<AutoBenchDeps> = {}): AutoBenchDeps & { seen: RegisterAwaitArgs[] } {
  const seen: RegisterAwaitArgs[] = [];
  const base = {
    seen,
    listParkedAwaitsForSubscribers: async () => [],
    registerBenchPark,
    captureWakeHandleForOwner: async () => ({ handle: { kind: 'test' }, note: null }),
    registerAwait: async (args: RegisterAwaitArgs) => {
      seen.push(args);
      return { id: 4242, eventKey: args.eventKey, expiresTs: '2026-09-05T02:00:00.000Z', supersededPendingCount: 0 };
    },
    ...over,
  };
  return base as unknown as AutoBenchDeps & { seen: RegisterAwaitArgs[] };
}

describe('autoBenchContextCriticalCaller', () => {
  it('parks the refused member on its OWN compaction event, with a non-null deadline', async () => {
    const d = deps();
    const out = await autoBenchContextCriticalCaller({ ownerId: MEMBER, bucket: 'critical' }, d);

    expect(out?.benched).toBe(true);
    expect(d.seen).toHaveLength(1);
    const park = d.seen[0];

    // Per-owner: a peer's compaction must not wake this member.
    expect(park.eventKey).toBe(contextCompactedWakeKey(MEMBER));
    expect(park.eventKey).toContain(MEMBER);

    // The deadline IS the recovery guarantee (D-009). Null here strands a member that
    // never compacts — the exact failure this bench was added to prevent.
    expect(park.timeoutSec).toBe(CONTEXT_CRITICAL_BENCH_TIMEOUT_SEC);
    expect(park.timeoutSec).not.toBeNull();
    expect(park.timeoutBehavior).toBe('wake');

    // The numeric await-row id is carried out as-is, not stringified.
    expect(out?.benchId).toBe(4242);
  });

  it('NEVER supersedes prior benches — a leader\'s staged assignment must survive', async () => {
    const d = deps();
    await autoBenchContextCriticalCaller({ ownerId: MEMBER, bucket: 'critical' }, d);

    // The hazard: `fleet:bench` passes supersedePriorBenches:true, which is correct for a
    // leader staging a NEW assignment. The same value here silently destroys that staging.
    expect(d.seen[0].supersedePending).toBeUndefined();
  });

  it('stages no assignment — staging is a leader\'s act', async () => {
    const d = deps();
    await autoBenchContextCriticalCaller({ ownerId: MEMBER, bucket: 'critical' }, d);
    expect(d.seen[0].note).toBe(FLEET_BENCH_NOTE_PREFIX);
  });

  it('skips rather than double-parking when the member is already benched', async () => {
    const d = deps({
      listParkedAwaitsForSubscribers: async () => [
        { subscriberId: MEMBER, eventKey: 'work-item:claimable', note: `${FLEET_BENCH_NOTE_PREFIX}staged work` },
      ],
    });
    const out = await autoBenchContextCriticalCaller({ ownerId: MEMBER, bucket: 'critical' }, d);

    expect(out?.benched).toBe(false);
    expect(d.seen).toHaveLength(0);
  });

  it('does not bench when the gate did not refuse on a critical bucket', async () => {
    const d = deps();
    const out = await autoBenchContextCriticalCaller({ ownerId: MEMBER, bucket: null }, d);
    expect(out?.benched).toBe(false);
    expect(d.seen).toHaveLength(0);
  });

  // --- fail-soft: the refusal must ship regardless -------------------------------------

  it('never throws when the await table is unreadable', async () => {
    const d = deps({
      listParkedAwaitsForSubscribers: async () => {
        throw new Error('await table unreadable');
      },
    });
    const out = await autoBenchContextCriticalCaller({ ownerId: MEMBER, bucket: 'critical' }, d);

    // Fail-CLOSED on the bench (assume parked rather than risk a second park), and
    // crucially: it returned instead of propagating.
    expect(out?.benched).toBe(false);
    expect(d.seen).toHaveLength(0);
  });

  it('never throws when park registration itself fails', async () => {
    const d = deps({
      registerAwait: async () => {
        throw new Error('registerAwait exploded');
      },
    });
    const out = await autoBenchContextCriticalCaller({ ownerId: MEMBER, bucket: 'critical' }, d);

    expect(out?.benched).toBe(false);
    // The reason must say the refusal is intact, so a reader of the returned payload is not
    // left guessing whether the claim verdict was affected.
    expect(out?.reason).toContain('refusal unaffected');
  });

  it('never throws when the wake-handle capture fails', async () => {
    const d = deps({
      captureWakeHandleForOwner: async () => {
        throw new Error('no handle');
      },
    });
    await expect(
      autoBenchContextCriticalCaller({ ownerId: MEMBER, bucket: 'critical' }, d),
    ).resolves.toMatchObject({ benched: false });
  });

  it('reports registered:false when the park has no wake handle (deadline-only recovery)', async () => {
    const d = deps({ captureWakeHandleForOwner: async () => ({ handle: null, note: 'no live session' }) });
    const out = await autoBenchContextCriticalCaller({ ownerId: MEMBER, bucket: 'critical' }, d);

    // Still benched — the deadline alone will recover it — but the caller must be able to
    // tell that it cannot be woken in place.
    expect(out?.benched).toBe(true);
    expect(out?.registered).toBe(false);
  });
});

/**
 * FALSIFIABILITY CONTROLS.
 *
 * The two assertions above that matter most — "does not supersede" and "never throws" — are
 * both assertions about an ABSENCE, and an absence is exactly what a vacuous test also
 * reports. An in-tree mutation probe is not available for an imported subject here (and the
 * git-sync sweep can commit one), so the repo's prescribed form is a permanent controls
 * block: deliberately-wrong implementations, shaped like plausible future edits, each of
 * which the same invariant must REJECT. The calibration case guards the controls themselves —
 * without it, a broken invariant would "reject" everything and look rigorous.
 */
describe('falsifiability controls', () => {
  const supersedeInvariant = (args: RegisterAwaitArgs) => args.supersedePending === undefined;
  const failSoftInvariant = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      return true;
    } catch {
      return false;
    }
  };

  it('CALIBRATION: the real auto-bench passes both invariants', async () => {
    const d = deps();
    expect(await failSoftInvariant(() => autoBenchContextCriticalCaller({ ownerId: MEMBER, bucket: 'critical' }, d))).toBe(
      true,
    );
    expect(supersedeInvariant(d.seen[0])).toBe(true);
  });

  it('control A — an auto-bench that copies the leader\'s supersede flag is REJECTED', async () => {
    // The plausible wrong edit: reaching for the same call shape fleet:bench uses.
    const seen: RegisterAwaitArgs[] = [];
    await registerBenchPark(
      { member: MEMBER, eventKey: contextCompactedWakeKey(MEMBER), timeoutSec: 900, supersedePriorBenches: true },
      {
        captureWakeHandleForOwner: (async () => ({ handle: {}, note: null })) as never,
        registerAwait: (async (args: RegisterAwaitArgs) => {
          seen.push(args);
          return { id: 1, eventKey: args.eventKey, expiresTs: null, supersededPendingCount: 0 };
        }) as never,
      },
    );
    expect(supersedeInvariant(seen[0])).toBe(false);
  });

  it('control B — a bench whose failure escapes is REJECTED', async () => {
    // The plausible wrong edit: dropping the try/catch once the happy path looks solid.
    const leaky = async () => {
      throw new Error('registerAwait exploded');
    };
    expect(await failSoftInvariant(leaky)).toBe(false);
  });

  it('control C — a park with a null deadline is REJECTED', async () => {
    // The plausible wrong edit: treating timeoutSec as optional because fleet:bench's is.
    const seen: RegisterAwaitArgs[] = [];
    await registerBenchPark(
      { member: MEMBER, eventKey: contextCompactedWakeKey(MEMBER), timeoutSec: null, supersedePriorBenches: false },
      {
        captureWakeHandleForOwner: (async () => ({ handle: {}, note: null })) as never,
        registerAwait: (async (args: RegisterAwaitArgs) => {
          seen.push(args);
          return { id: 1, eventKey: args.eventKey, expiresTs: null, supersededPendingCount: 0 };
        }) as never,
      },
    );
    expect(seen[0].timeoutSec).toBeNull();
    expect(seen[0].timeoutSec === CONTEXT_CRITICAL_BENCH_TIMEOUT_SEC).toBe(false);
  });
});

describe('registerBenchPark supersedePriorBenches', () => {
  // The leader half of the same switch. Asserted here beside the auto-bench case so the two
  // opposite-but-correct behaviours are visible in one place; bench.test.ts covers the
  // leader path end-to-end.
  it('supersedes every prior bench for the member when the leader asks it to', async () => {
    const seen: RegisterAwaitArgs[] = [];
    await registerBenchPark(
      {
        member: MEMBER,
        eventKey: 'work-item:claimable',
        stagedAssignment: 'next up',
        timeoutSec: null,
        supersedePriorBenches: true,
      },
      {
        captureWakeHandleForOwner: (async () => ({ handle: { kind: 'test' }, note: null })) as never,
        registerAwait: (async (args: RegisterAwaitArgs) => {
          seen.push(args);
          return { id: 1, eventKey: args.eventKey, expiresTs: null, supersededPendingCount: 3 };
        }) as never,
      },
    );

    expect(seen[0].supersedePending).toEqual({
      allEventKeys: true,
      includeNotePrefix: FLEET_BENCH_NOTE_PREFIX,
    });
  });
});
