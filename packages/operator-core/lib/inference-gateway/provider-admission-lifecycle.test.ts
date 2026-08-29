/**
 * P-010 conformance suite: Claude and Codex run the SAME admission lifecycle.
 *
 * The acceptance criterion is deliberately a PARAMETERIZED suite rather than
 * two provider-specific test blocks — a suite that has to be written twice is
 * exactly the duplication P-010 deletes, and two hand-kept copies are how the
 * retired Claude/Codex controllers drifted apart in the first place. Every case
 * below runs unchanged against every registered lane.
 *
 * Each negative assertion carries a CALIBRATION control in the same test, so a
 * suite that silently stopped exercising the subject cannot pass vacuously.
 */

import { describe, expect, it } from 'vitest';

import {
  INITIAL_PROVIDER_ADMISSION_WINDOW,
  PROVIDER_ADMISSION_LIFECYCLE_SCHEMA_VERSION,
  ProviderAdmissionLifecycle,
  type ProviderLaneId,
  type ProviderLaneQueue,
} from './provider-admission-lifecycle';

/** The ceilings P-010 retires. Named here so the "grows beyond" cases cite the real numbers. */
const RETIRED_CLAUDE_DEFAULT_CONCURRENCY = 24;
const RETIRED_CODEX_SLOTS_PER_ACCOUNT = 4;

class RecordingQueue implements ProviderLaneQueue {
  maxConcurrent: number | null = null;
  readonly tierCaps = new Map<number, number>();
  readonly maxConcurrentHistory: number[] = [];

  setMaxConcurrent(n: number): void {
    this.maxConcurrent = n;
    this.maxConcurrentHistory.push(n);
  }

  setTierCap(tier: number, cap: number): void {
    this.tierCaps.set(tier, cap);
  }
}

const LANES: readonly ProviderLaneId[] = ['claude', 'codex'];

function makeLifecycle(options: { tiered?: boolean; now?: () => number } = {}) {
  const queues = new Map<ProviderLaneId, RecordingQueue>();
  for (const id of LANES) queues.set(id, new RecordingQueue());
  const lifecycle = new ProviderAdmissionLifecycle({
    lanes: LANES.map((id) => ({
      id,
      queue: queues.get(id)!,
      ...(options.tiered ? { baseTierCaps: { 1: 4, 2: 3, 3: 2, 4: 2 } } : {}),
    })),
    now: options.now ?? (() => 1_000),
  });
  return { lifecycle, queues };
}

/** Drive `count` clean outcomes through one lane. */
function succeed(lifecycle: ProviderAdmissionLifecycle, lane: ProviderLaneId, count: number): void {
  for (let i = 0; i < count; i += 1) lifecycle.recordSuccess(lane);
}

/** Drive `count` throttles through one lane. */
function throttle(lifecycle: ProviderAdmissionLifecycle, lane: ProviderLaneId, count: number): void {
  for (let i = 0; i < count; i += 1) lifecycle.recordThrottle(lane);
}

describe.each(LANES)('provider admission lifecycle conformance — %s lane', (lane) => {
  it('publishes its starting window to the queue at registration', () => {
    const { lifecycle, queues } = makeLifecycle();
    expect(queues.get(lane)!.maxConcurrent).toBe(INITIAL_PROVIDER_ADMISSION_WINDOW);
    expect(lifecycle.windowFor(lane)).toBe(INITIAL_PROVIDER_ADMISSION_WINDOW);
  });

  it('starts both lanes from the SAME window — no provider-specific seed arithmetic', () => {
    const { lifecycle } = makeLifecycle();
    const windows = LANES.map((id) => lifecycle.windowFor(id));
    expect(new Set(windows).size).toBe(1);
    // Calibration: the assertion above is only meaningful if more than one lane exists.
    expect(LANES.length).toBeGreaterThan(1);
  });

  it('grows past every retired ceiling under sustained clean traffic', () => {
    const { lifecycle, queues } = makeLifecycle();
    succeed(lifecycle, lane, 400);

    const window = lifecycle.windowFor(lane);
    expect(window).toBeGreaterThan(INITIAL_PROVIDER_ADMISSION_WINDOW);
    expect(window).toBeGreaterThan(RETIRED_CLAUDE_DEFAULT_CONCURRENCY);
    expect(window).toBeGreaterThan(RETIRED_CODEX_SLOTS_PER_ACCOUNT);
    expect(queues.get(lane)!.maxConcurrent).toBe(window);

    // CALIBRATION: a lane that received no successes must still sit at the seed,
    // proving the growth above came from the recorded outcomes and not from a
    // lifecycle that simply publishes a large number.
    const other = LANES.find((id) => id !== lane)!;
    expect(lifecycle.windowFor(other)).toBe(INITIAL_PROVIDER_ADMISSION_WINDOW);
  });

  it('contracts multiplicatively under sustained throttling but never below the floor', () => {
    const { lifecycle } = makeLifecycle();
    succeed(lifecycle, lane, 400);
    const grown = lifecycle.windowFor(lane);

    throttle(lifecycle, lane, 6);
    const contracted = lifecycle.windowFor(lane);
    expect(contracted).toBeLessThan(grown);

    throttle(lifecycle, lane, 600);
    const floored = lifecycle.windowFor(lane);
    expect(floored).toBeGreaterThanOrEqual(1);
    expect(floored).toBe(lifecycle.snapshotFor(lane).minimumWindow);

    // CALIBRATION: the floor claim is vacuous unless a contraction actually ran.
    expect(lifecycle.snapshotFor(lane).contractions).toBeGreaterThan(0);
  });

  it('absorbs an isolated throttle without contracting', () => {
    const { lifecycle } = makeLifecycle();
    const before = lifecycle.windowFor(lane);
    lifecycle.recordThrottle(lane);
    expect(lifecycle.windowFor(lane)).toBe(before);
    expect(lifecycle.snapshotFor(lane).contractions).toBe(0);
    // CALIBRATION: the throttle was genuinely recorded, it just did not trip.
    expect(lifecycle.snapshotFor(lane).pressure).toBe(1);
  });

  it('contracts immediately when an admitted request dies hard', () => {
    const { lifecycle } = makeLifecycle();
    succeed(lifecycle, lane, 400);
    const grown = lifecycle.windowFor(lane);
    lifecycle.recordHardFailure(lane);
    expect(lifecycle.windowFor(lane)).toBeLessThan(grown);
    expect(lifecycle.snapshotFor(lane).hardFailures).toBe(1);
  });

  it('sheds tier caps against its own high-water mark, not a configured cap', () => {
    const { lifecycle, queues } = makeLifecycle({ tiered: true });
    succeed(lifecycle, lane, 400);
    const queue = queues.get(lane)!;
    const peak = lifecycle.snapshotFor(lane).observedPeak;
    // At the peak nothing is shed: the lane is running at the most it has held.
    expect(queue.tierCaps.get(4)).toBe(2);

    throttle(lifecycle, lane, 6);
    expect(lifecycle.snapshotFor(lane).observedPeak).toBe(peak);
    // Tier 1 is protected; the sheddable bands give up headroom first.
    expect(queue.tierCaps.get(1)).toBe(4);
    expect(queue.tierCaps.get(4)!).toBeLessThan(2);
  });

  it('reports a snapshot a status consumer can read', () => {
    const { lifecycle } = makeLifecycle();
    const snapshot = lifecycle.snapshot();
    expect(snapshot.schemaVersion).toBe(PROVIDER_ADMISSION_LIFECYCLE_SCHEMA_VERSION);
    expect(snapshot.lanes.map((l) => l.lane)).toEqual([...LANES]);
    expect(snapshot.lanes.find((l) => l.lane === lane)!.window).toBe(lifecycle.windowFor(lane));
  });
});

describe('provider outcome isolation', () => {
  it('keeps one provider’s throttle storm off every other lane', () => {
    const { lifecycle } = makeLifecycle();
    succeed(lifecycle, 'claude', 400);
    succeed(lifecycle, 'codex', 400);
    const claudeBefore = lifecycle.windowFor('claude');
    const codexBefore = lifecycle.windowFor('codex');
    expect(claudeBefore).toBe(codexBefore);

    throttle(lifecycle, 'codex', 60);

    // FALSIFIER: the retired design fed both providers' outcomes into one
    // controller, so a Codex storm moved the Claude queue. If the lanes ever
    // share evidence again this assertion fails.
    expect(lifecycle.windowFor('claude')).toBe(claudeBefore);
    expect(lifecycle.windowFor('codex')).toBeLessThan(codexBefore);
    expect(lifecycle.snapshotFor('claude').contractions).toBe(0);
    // CALIBRATION: the storm was real.
    expect(lifecycle.snapshotFor('codex').contractions).toBeGreaterThan(0);
  });

  it('lets one lane grow while another is contracted', () => {
    const { lifecycle } = makeLifecycle();
    throttle(lifecycle, 'codex', 60);
    succeed(lifecycle, 'claude', 400);
    expect(lifecycle.windowFor('claude')).toBeGreaterThan(RETIRED_CLAUDE_DEFAULT_CONCURRENCY);
    expect(lifecycle.windowFor('codex')).toBe(lifecycle.snapshotFor('codex').minimumWindow);
  });
});

describe('hermetic by construction (EI-21746976692199819 recurrence guard)', () => {
  it('does not share admission state between two lifecycles in one process', () => {
    const first = makeLifecycle();
    const second = makeLifecycle();

    succeed(first.lifecycle, 'claude', 400);
    throttle(second.lifecycle, 'claude', 60);

    // Neither instance may observe the other's window. An ambient module-scoped
    // gate — the coupling that made governor-causal-lane-scoping.test.ts flaky
    // under parallel execution — fails here deterministically instead of once
    // every few runs.
    expect(first.lifecycle.windowFor('claude')).toBeGreaterThan(RETIRED_CLAUDE_DEFAULT_CONCURRENCY);
    expect(second.lifecycle.windowFor('claude')).toBe(second.lifecycle.snapshotFor('claude').minimumWindow);
    expect(first.queues.get('claude')!.maxConcurrent).not.toBe(second.queues.get('claude')!.maxConcurrent);
  });

  it('reads only the injected clock', () => {
    let ticks = 0;
    const { lifecycle } = makeLifecycle({
      now: () => {
        ticks += 1;
        return 5_000;
      },
    });
    succeed(lifecycle, 'claude', 400);
    expect(ticks).toBeGreaterThan(0);
    expect(lifecycle.snapshotFor('claude').lastChangeAtMs).toBe(5_000);
  });
});

describe('registration contract', () => {
  it('refuses a lane registered twice', () => {
    expect(
      () =>
        new ProviderAdmissionLifecycle({
          lanes: [
            { id: 'claude', queue: new RecordingQueue() },
            { id: 'claude', queue: new RecordingQueue() },
          ],
        }),
    ).toThrow(/registered twice/);
  });

  it('refuses an unregistered lane rather than inventing a window', () => {
    const lifecycle = new ProviderAdmissionLifecycle({
      lanes: [{ id: 'claude', queue: new RecordingQueue() }],
    });
    expect(() => lifecycle.windowFor('codex')).toThrow(/not registered/);
  });

  it('treats an explicit seed as initial state, not a ceiling', () => {
    const queue = new RecordingQueue();
    const lifecycle = new ProviderAdmissionLifecycle({
      lanes: [{ id: 'claude', queue }],
      initialWindow: 3,
      minimumWindow: 2,
    });
    expect(lifecycle.windowFor('claude')).toBe(3);
    succeed(lifecycle, 'claude', 200);
    // FALSIFIER: a seed that behaved as a cap would pin this at 3.
    expect(lifecycle.windowFor('claude')).toBeGreaterThan(3);
  });
});
