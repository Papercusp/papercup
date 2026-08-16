import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock B-LOOP-1's upsertRoutine seam so we can assert the EXACT loop-routine row
// materializeLoop produces — the row fd5c0's fire (loop-fire.ts) + su-15ea2's
// completion-rebase consume. vi.hoisted so the spy exists when vi.mock hoists.
//
// EI-7613: materializeLoop now ALSO calls stampLoopArmedAt(sql, …) after every upsert
// (the dead-man clock's re-arm fix) — a bare `sql: {}` is not callable as a tagged
// template, so that best-effort UPDATE threw "db is not a function" and console.warn'd,
// which vitest-fail-on-console turns into a hard test failure across every materializeLoop
// case. `sqlStub` is a minimal callable tagged-template stand-in (resolves to `[]`) so
// that internal call succeeds silently, exactly like a real (if inert) postgres client.
const { upsertRoutineSpy, sqlStub } = vi.hoisted(() => ({
  upsertRoutineSpy: vi.fn(),
  sqlStub: (_strings: TemplateStringsArray, ..._values: unknown[]) => Promise.resolve([]),
}));
// EI-14928 root-cause class: a MINIMAL factory here (only getOrgPg/upsertRoutine)
// crashes vitest COLLECTION whenever some OTHER db-org export is dereferenced at
// module scope anywhere in this file's transitive import graph (e.g. autoloop.ts's
// `generated.autoloopStateInHarnessShared`) — the composed graph varies by which
// other test files share this worker, so the crash is run-order-dependent, not
// deterministic per-commit. Spread importOriginal so every real export (including
// `generated`, pure drizzle table defs) stays present; only override what this
// file actually needs to stub.
vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: sqlStub }),
  upsertRoutine: upsertRoutineSpy,
}));

// autoArmFleetMemberLoop (kickoff-prompt-absorption-2026-07-17 P-001) reads the
// LOOPS flag and best-effort arms an inbox-wake — both mocked so its unit tests
// stay pure (no PG, no live flag resolver).
const { getFlagSpy, armInboxWakeSpy } = vi.hoisted(() => ({
  getFlagSpy: vi.fn(async () => true),
  armInboxWakeSpy: vi.fn(async () => ({ awaitId: 1, eventKey: 'k', handleNote: 'n', minSleepSec: 60 })),
}));
vi.mock('@papercusp/flags/server', () => ({ getFlag: getFlagSpy }));
vi.mock('@papercusp/flags', () => ({ FLAGS: { LOOPS: 'papercusp-loops' } }));
vi.mock('../../events/await/inbox-wake-arm', () => ({ armInboxWake: armInboxWakeSpy }));

import {
  materializeLoop,
  buildLoopWakePrompt,
  detectDrivenWorkItemId,
  loopRoutineName,
  computeLoopStall,
  computeTurnsStalled,
  computeLifecycleBackoff,
  TURNS_STALLED_MIN_FIRE_COUNT,
  autoArmFleetMemberLoop,
  readActiveLoopFacts,
  getLoopStatuses,
  computeLoopCadence,
  computeCadenceDrift,
  LOOP_WAKE_ACTION,
  LOOP_INTERVAL_FLOOR_SEC,
  countAgentToolCallsInWindow,
} from './loop';

describe('buildLoopWakePrompt — instructs VALID work-item states (EI-6978)', () => {
  const prompt = buildLoopWakePrompt({ ownerId: 'su-x', intervalSec: 60, harness: 'papercusp', goal: 'do the thing' });

  it('does NOT carry the old broken directive "in_progress → completed" ("completed" is not a valid state, rejected every wake)', () => {
    expect(prompt).not.toContain('in_progress → completed');
  });

  it('directs terminal completion through work_items:complete, never a bare "done" assertion', () => {
    // fleet-member-native-guidance-2026-07-10 P-008: the exact call signature
    // (`state:'done'`) is now the persona's + the tool's own guidance to state, not
    // re-spelled in the wake prompt — the prompt just points at the contract.
    expect(prompt).toContain('work_items:complete');
    expect(prompt).toContain('never a bare "done" assertion');
  });

  it('does not prescribe a specific mid-work state literal (delegated to work_items:set_state\'s own EI-7478 aliasing guidance)', () => {
    // The prompt no longer mentions in_progress at all — it would be redundant with
    // (and risked drifting from) the tool's own description of issue-family state aliasing.
    expect(prompt).not.toContain("state:'in_progress'");
  });

  it('substitutes the template vars (no unreplaced {goal}/{harness}/{ownerId})', () => {
    expect(prompt).toContain('do the thing');
    expect(prompt).toContain('papercusp');
    expect(prompt).toContain('su-x');
    expect(prompt).not.toMatch(/\{(goal|harness|ownerId|intervalSec)\}/);
  });
});

describe('buildLoopWakePrompt — kind guidance is not hardcoded to task (EI-7674)', () => {
  const prompt = buildLoopWakePrompt({ ownerId: 'su-x', intervalSec: 60, harness: 'papercusp', goal: 'do the thing' });

  it('does NOT hardcode kind:\'task\' as the create example — task is NON-CODE only and most loop-driven work is code', () => {
    expect(prompt).not.toContain("kind:'task'");
  });

  it('tells the agent to pick kind by what the unit IS (fleet-member-native-guidance P-008: delegated to the persona\'s member-loop contract, not re-spelled per-wake)', () => {
    expect(prompt).toMatch(/pick `kind` by what it IS/);
    expect(prompt).toContain('Working as a fleet MEMBER — the member operating loop');
  });

  it('the kind/state mechanics (bug/change/task, the in_progress alias) are no longer spelled out per-wake — the persona + tool guidance own them now', () => {
    expect(prompt).not.toContain('a bug/change/task item is issue-family');
    expect(prompt).not.toContain("kind:'change'");
  });
});

describe('computeLoopStall (P2b — parked-healthy vs parked-dead)', () => {
  const STUCK = 30 * 60_000; // max(30min, 4×interval) for a ≤7.5min interval
  const NOW = 1_800_000_000_000; // arbitrary fixed epoch ms
  /** Build an input the way production does, where `parkedMs` IS `now - last_fired_at`, so
   *  the park duration and the fire timestamp can never disagree (WI-6639: they are the two
   *  halves of the same fact, and the old boolean interface let them drift apart). */
  const parkedFor = (
    parkedMs: number,
    o: { intervalSec?: number; completion?: boolean; lastActiveAtMs?: number | null } = {},
  ) => ({
    parked: true,
    parkedMs,
    intervalSec: o.intervalSec ?? 120,
    hasCompletionSinceFire: o.completion ?? false,
    lastFiredAtMs: NOW - parkedMs,
    lastActiveAtMs: o.lastActiveAtMs ?? null,
    nowMs: NOW,
  });

  it('not parked → never stalled', () => {
    expect(
      computeLoopStall({ ...parkedFor(99e9), parked: false }),
    ).toEqual({ stalled: false, stalledSinceMs: null });
  });
  it('parked but recently (under the stuck threshold) → healthy in-flight', () => {
    expect(computeLoopStall(parkedFor(60_000)).stalled).toBe(false);
  });
  it('parked long, no completion, no activity → STALLED with the parked duration', () => {
    const r = computeLoopStall(parkedFor(STUCK + 1000));
    expect(r.stalled).toBe(true);
    expect(r.stalledSinceMs).toBe(STUCK + 1000);
  });
  it('parked long but a completion marker exists → NOT stalled (the turn finished)', () => {
    expect(computeLoopStall(parkedFor(STUCK + 1000, { completion: true })).stalled).toBe(false);
  });
  it('parked long but the session is active RIGHT NOW → NOT stalled (a legitimately long turn)', () => {
    // Presence is both after the fire and fresh — the exemption this guard exists for.
    expect(
      computeLoopStall(parkedFor(STUCK + 1000, { lastActiveAtMs: NOW - 60_000 })).stalled,
    ).toBe(false);
  });

  // ── WI-6639 regression: the frozen-liveness blind spot ──────────────────────
  it('WI-6639: presence a minute AFTER the final fire, then dead for 160h → STALLED', () => {
    // THE BUG. `activeSinceFire` used to be the caller-computed `presence > lastFired`, a
    // comparison of two PAST instants. This session emitted one last beat just after its
    // final fire and then died, which pinned that boolean true FOREVER and permanently
    // disarmed the park check — measured live as 12 loops parked at 'infinity' for
    // 49h–160h, every one of them reporting `stalled: false`.
    const parkedMs = 160 * 60 * 60_000;
    const r = computeLoopStall(
      parkedFor(parkedMs, { lastActiveAtMs: NOW - parkedMs + 60_000 }),
    );
    expect(r.stalled).toBe(true);
    expect(r.stalledSinceMs).toBe(parkedMs);
  });
  it('WI-6639: presence after the fire but older than the floor → STALLED (liveness is judged against now)', () => {
    expect(
      computeLoopStall(parkedFor(STUCK * 3, { lastActiveAtMs: NOW - STUCK - 1000 })).stalled,
    ).toBe(true);
  });
  it('WI-6639: presence BEFORE the fire is never an exemption, however fresh the clock', () => {
    // A beat that predates the fire says nothing about the wake turn that followed it.
    expect(
      computeLoopStall(parkedFor(STUCK + 1000, { lastActiveAtMs: NOW - STUCK - 2000 })).stalled,
    ).toBe(true);
  });

  it('the threshold scales to 4×interval for a long interval', () => {
    // interval 1200s → 4× = 4800s = 80min > 30min, so 60min parked is NOT yet stalled.
    expect(computeLoopStall(parkedFor(60 * 60_000, { intervalSec: 1200 })).stalled).toBe(false);
    expect(computeLoopStall(parkedFor(90 * 60_000, { intervalSec: 1200 })).stalled).toBe(true);
  });
});

describe('computeTurnsStalled (EI-18712914572668391 — fires attempted vs turns produced)', () => {
  const NOW = 1_800_000_000_000; // arbitrary fixed epoch ms
  const intervalSec = 300; // 300s, matches the incident this item was filed on

  it('inactive loop → never flagged, regardless of the gap', () => {
    expect(
      computeTurnsStalled({
        active: false,
        fireCount: 50,
        lastFiredAtMs: NOW,
        lastTurnAtMs: NOW - 10 * 60 * 60_000,
        intervalSec,
        nowMs: NOW,
      }),
    ).toBe(false);
  });

  it('fewer than TURNS_STALLED_MIN_FIRE_COUNT fires → never flagged (no trend yet, avoid startup noise)', () => {
    expect(TURNS_STALLED_MIN_FIRE_COUNT).toBeGreaterThan(1);
    expect(
      computeTurnsStalled({
        active: true,
        fireCount: TURNS_STALLED_MIN_FIRE_COUNT - 1,
        lastFiredAtMs: NOW,
        lastTurnAtMs: null, // even the strongest signal (no turn EVER) is suppressed pre-threshold
        intervalSec,
        nowMs: NOW,
      }),
    ).toBe(false);
  });

  it('no last-fired timestamp → nothing to compare against, never flagged', () => {
    expect(
      computeTurnsStalled({
        active: true,
        fireCount: 10,
        lastFiredAtMs: null,
        lastTurnAtMs: null,
        intervalSec,
        nowMs: NOW,
      }),
    ).toBe(false);
  });

  it('NO turn has EVER completed for this owner, yet several fires landed → flagged (the strongest signal)', () => {
    expect(
      computeTurnsStalled({
        active: true,
        fireCount: TURNS_STALLED_MIN_FIRE_COUNT,
        lastFiredAtMs: NOW,
        lastTurnAtMs: null,
        intervalSec,
        nowMs: NOW,
      }),
    ).toBe(true);
  });

  it('the incident this item was filed on: 36 fires over ~3h @300s interval, carry-note/turn frozen ~3h behind → flagged', () => {
    // Mirrors the filed evidence: fireCount:36, armed 10:09, lastFiredAt 13:04 — the
    // session's last real activity (carry-note write) sat frozen at 10:08, ~3h behind.
    expect(
      computeTurnsStalled({
        active: true,
        fireCount: 36,
        lastFiredAtMs: NOW,
        lastTurnAtMs: NOW - 3 * 60 * 60_000, // ~3h behind the most recent fire
        intervalSec,
        nowMs: NOW,
      }),
    ).toBe(true);
  });

  it('a turn completed recently relative to the last fire (within the generous floor) → NOT flagged (healthy)', () => {
    expect(
      computeTurnsStalled({
        active: true,
        fireCount: 10,
        lastFiredAtMs: NOW,
        lastTurnAtMs: NOW - 2 * 60_000, // 2min behind — a normal in-flight turn
        intervalSec,
        nowMs: NOW,
      }),
    ).toBe(false);
  });

  // ── WI-6639 regression: the frozen-gap blind spot ───────────────────────────
  it('WI-6639: fires STOPPED too, so the fired-vs-turn gap froze small → still flagged', () => {
    // The measured population: last turn landed 4min after the last fire, then the whole
    // loop went silent for 156h. `lastFiredAtMs - lastTurnAtMs` is NEGATIVE here, so the
    // original gap check read healthy forever — 11 of 14 dead loops reported false.
    const dead = 156 * 60 * 60_000;
    expect(
      computeTurnsStalled({
        active: true,
        fireCount: 157,
        lastFiredAtMs: NOW - dead,
        lastTurnAtMs: NOW - dead + 4 * 60_000,
        lastActiveAtMs: NOW - dead + 5 * 60_000,
        intervalSec,
        nowMs: NOW,
      }),
    ).toBe(true);
  });

  it('WI-6639: a quiet-but-ALIVE session (fresh presence) is not flagged by the new clause', () => {
    // Guards the fix against false positives: fires are stale but the session is provably
    // active right now, so this is a long turn in flight, not a corpse.
    expect(
      computeTurnsStalled({
        active: true,
        fireCount: 20,
        lastFiredAtMs: NOW - 4 * 60 * 60_000,
        lastTurnAtMs: NOW - 4 * 60 * 60_000 + 60_000,
        lastActiveAtMs: NOW - 30_000, // beating right now
        intervalSec,
        nowMs: NOW,
      }),
    ).toBe(false);
  });

  it('the floor scales to 4×interval for a long-interval loop, mirroring computeLoopStall\'s own floor', () => {
    const longIntervalSec = 1200; // 4× = 80min > the 30min base floor
    expect(
      computeTurnsStalled({
        active: true,
        fireCount: 10,
        lastFiredAtMs: NOW,
        lastTurnAtMs: NOW - 60 * 60_000, // 60min behind — under the scaled 80min floor
        intervalSec: longIntervalSec,
        nowMs: NOW,
      }),
    ).toBe(false);
    expect(
      computeTurnsStalled({
        active: true,
        fireCount: 10,
        lastFiredAtMs: NOW,
        lastTurnAtMs: NOW - 90 * 60_000, // 90min behind — past the scaled 80min floor
        intervalSec: longIntervalSec,
        nowMs: NOW,
      }),
    ).toBe(true);
  });
});

describe('computeLifecycleBackoff (EI-19325288514307343 — backed-off vs dead, without opening the escalation queue)', () => {
  const NOW2 = Date.parse('2026-08-02T21:00:00.000Z');

  it('is null when the loop is not active — nothing to "resume"', () => {
    expect(
      computeLifecycleBackoff({
        active: false,
        lastDeliveryOutcome: 'loop-lifecycle-death:usage_limit',
        nextFireAtIso: new Date(NOW2 + 3_600_000).toISOString(),
        nowMs: NOW2,
      }),
    ).toBeNull();
  });

  it('is null when the last recorded outcome is not a lifecycle-death (the common/healthy case)', () => {
    for (const outcome of [null, 'ok', 'loop-lifecycle', 'loop-stuck-backstop']) {
      expect(
        computeLifecycleBackoff({
          active: true,
          lastDeliveryOutcome: outcome,
          nextFireAtIso: new Date(NOW2 + 60_000).toISOString(),
          nowMs: NOW2,
        }),
      ).toBeNull();
    }
  });

  it('extracts the reason suffix and the resume window from a lifecycle-death outcome', () => {
    const until = new Date(NOW2 + 3_607_000).toISOString();
    expect(
      computeLifecycleBackoff({
        active: true,
        lastDeliveryOutcome: 'loop-lifecycle-death:usage_limit',
        nextFireAtIso: until,
        nowMs: NOW2,
      }),
    ).toEqual({ reason: 'usage_limit', until, resumesInMs: 3_607_000 });
  });

  it('clears itself the instant a LATER fire records a normal outcome — never a sticky flag', () => {
    // Same routine, but the most recent recordFire call overwrote last_status after a
    // successful retry: lastDeliveryOutcome no longer carries the lifecycle-death prefix.
    expect(
      computeLifecycleBackoff({
        active: true,
        lastDeliveryOutcome: 'loop-lifecycle',
        nextFireAtIso: new Date(NOW2 + 60_000).toISOString(),
        nowMs: NOW2,
      }),
    ).toBeNull();
  });

  it('defaults an empty reason suffix to "unknown" rather than an empty string', () => {
    const out = computeLifecycleBackoff({
      active: true,
      lastDeliveryOutcome: 'loop-lifecycle-death:',
      nextFireAtIso: new Date(NOW2 + 60_000).toISOString(),
      nowMs: NOW2,
    });
    expect(out?.reason).toBe('unknown');
  });

  it('clamps resumesInMs to 0 rather than going negative when nextFireAt is already in the past', () => {
    const past = new Date(NOW2 - 60_000).toISOString();
    const out = computeLifecycleBackoff({
      active: true,
      lastDeliveryOutcome: 'loop-lifecycle-death:rate_limited',
      nextFireAtIso: past,
      nowMs: NOW2,
    });
    expect(out).toEqual({ reason: 'rate_limited', until: past, resumesInMs: 0 });
  });

  it('reports resumesInMs:null when nextFireAt is null (defensive — should not happen while active+un-parked)', () => {
    const out = computeLifecycleBackoff({
      active: true,
      lastDeliveryOutcome: 'loop-lifecycle-death:usage_limit',
      nextFireAtIso: null,
      nowMs: NOW2,
    });
    expect(out).toEqual({ reason: 'usage_limit', until: null, resumesInMs: null });
  });

  // EI-19381528967421062: loop-turn-outcome.ts's FAST observer (the common path — it
  // reacts the instant a resume turn's exit is seen, not the reconcile backstop) writes
  // `resume-turn-death:<klass>` via recordFire, NOT `loop-lifecycle-death:`. Before this
  // fix that prefix was invisible here, so a loop rate-limited through the fast path read
  // `lifecycleBackoff: null` while `nextFireAt` sat ~100 intervals out — silently absent,
  // not merely stale (measured live: EI-19381528967421062's own reporter hit exactly this).
  it('also recognizes resume-turn-death: (the fast-observer prefix), not just loop-lifecycle-death:', () => {
    const until = new Date(NOW2 + 6_000_000).toISOString();
    expect(
      computeLifecycleBackoff({
        active: true,
        lastDeliveryOutcome: 'resume-turn-death:rate_limited',
        nextFireAtIso: until,
        nowMs: NOW2,
      }),
    ).toEqual({ reason: 'rate_limited', until, resumesInMs: 6_000_000 });
  });

  it('extracts the reason suffix from a resume-turn-death: outcome the same way as loop-lifecycle-death:', () => {
    const until = new Date(NOW2 + 3_600_000).toISOString();
    const a = computeLifecycleBackoff({
      active: true,
      lastDeliveryOutcome: 'loop-lifecycle-death:usage_limit',
      nextFireAtIso: until,
      nowMs: NOW2,
    });
    const b = computeLifecycleBackoff({
      active: true,
      lastDeliveryOutcome: 'resume-turn-death:usage_limit',
      nextFireAtIso: until,
      nowMs: NOW2,
    });
    expect(a).toEqual(b);
  });
});

beforeEach(() => {
  upsertRoutineSpy.mockReset();
  // Echo the input back as a plausible RoutineRow (materializeLoop reads .id/.name/.nextFireAt/.targetRole).
  upsertRoutineSpy.mockImplementation(async (_sql: unknown, input: any) => ({
    id: `rt_${input.installSlug}_${input.name}`.replace(/[^a-z0-9_]/gi, '_').toLowerCase(),
    name: input.name,
    installSlug: input.installSlug,
    workspaceId: input.workspaceId,
    triggerKind: input.triggerKind,
    triggerConfig: input.triggerConfig,
    targetRole: input.targetRole,
    payloadTemplate: input.payloadTemplate,
    concurrency: input.concurrency,
    catchup: 'skip-old',
    active: input.active,
    lastFiredAt: null,
    nextFireAt: input.nextFireAt ?? null,
    rescheduleIntervalSec: input.rescheduleIntervalSec ?? null,
    targetOwnerId: input.targetOwnerId ?? null,
  }));
});

describe('buildLoopWakePrompt (the per-wake template, P-008)', () => {
  it('interpolates the loop specifics and carries the locked B-LOOP-4 self-assign convention', () => {
    const p = buildLoopWakePrompt({
      ownerId: 'su-abc',
      intervalSec: 300,
      harness: 'papercusp',
      goal: 'ship the widget',
    });
    expect(p).toContain('su-abc'); // the owner id the agent self-assigns to
    expect(p).toContain('300'); // the interval
    expect(p).toContain('papercusp'); // the harness
    expect(p).toContain('ship the widget'); // the goal
    // fleet-member-native-guidance-2026-07-10 P-008: the create+self-assign contract
    // (B-LOOP-4 / su-1ec26) now lives natively in the persona's member-loop section —
    // the wake prompt POINTS at it instead of re-spelling the call signature.
    expect(p).toContain('Working as a fleet MEMBER — the member operating loop');
    expect(p).toContain('assign_to');
    // how to stop (don't spin on empty wakes)
    expect(p).toContain('loop:end');
    // every placeholder was substituted
    expect(p).not.toMatch(/\{(intervalSec|harness|ownerId|goal)\}/);
  });

  it('a WARM loop (default / absent carry) is byte-identical — no cold addendum (su-cold-auto P-002)', () => {
    const warmDefault = buildLoopWakePrompt({ ownerId: 'su-x', intervalSec: 60, harness: 'papercusp', goal: 'g' });
    const warmExplicit = buildLoopWakePrompt({ ownerId: 'su-x', intervalSec: 60, harness: 'papercusp', goal: 'g', carry: 'warm' });
    expect(warmExplicit).toBe(warmDefault); // explicit warm == absent
    expect(warmDefault).not.toContain('loop:checkpoint');
    expect(warmDefault).not.toContain('COLD loop');
  });

  it("a COLD loop appends the bootstrap addendum instructing loop:checkpoint (so pre-anchor warm wakes seed the first carry-note)", () => {
    const warm = buildLoopWakePrompt({ ownerId: 'su-x', intervalSec: 60, harness: 'papercusp', goal: 'g', carry: 'warm' });
    const cold = buildLoopWakePrompt({ ownerId: 'su-x', intervalSec: 60, harness: 'papercusp', goal: 'g', carry: 'cold' });
    // the cold prompt is the warm one PLUS the addendum (superset, no base text lost)
    expect(cold.startsWith(warm)).toBe(true);
    expect(cold.length).toBeGreaterThan(warm.length);
    expect(cold).toContain('loop:checkpoint');
    for (const f of ['did', 'left', 'insight', 'next']) expect(cold).toContain(f);
    expect(cold).toContain('COLD loop');
  });

  it("a MONITOR loop gets the lean check/steer/checkpoint contract with NO work-item boilerplate (compaction-continuity P-001c)", () => {
    const monitor = buildLoopWakePrompt({
      ownerId: 'su-x', intervalSec: 120, harness: 'papercusp', goal: 'watch the bug-drain fleet', mode: 'monitor',
    });
    // The lean monitoring contract…
    expect(monitor).toContain('Monitor wake');
    expect(monitor).toContain('watch the bug-drain fleet');
    expect(monitor).toContain('120');
    expect(monitor).toContain('deltas');
    expect(monitor).toContain('loop:end');
    // …with NONE of the per-wake work-item contract (the boilerplate a monitor loop burned every wake).
    expect(monitor).not.toContain('work_items:create');
    expect(monitor).not.toContain('assign_to');
    expect(monitor).not.toContain('work_items:complete');
    // every placeholder was substituted
    expect(monitor).not.toMatch(/\{(intervalSec|harness|ownerId|goal)\}/);
  });

  it("mode 'work' (default / absent) is byte-identical to the existing template", () => {
    const workDefault = buildLoopWakePrompt({ ownerId: 'su-x', intervalSec: 60, harness: 'papercusp', goal: 'g' });
    const workExplicit = buildLoopWakePrompt({ ownerId: 'su-x', intervalSec: 60, harness: 'papercusp', goal: 'g', mode: 'work' });
    expect(workExplicit).toBe(workDefault);
    expect(workDefault).toContain('Working as a fleet MEMBER — the member operating loop');
  });

  it('the monitor mode composes with the cold/gated addenda like the work mode does', () => {
    const coldMonitor = buildLoopWakePrompt({
      ownerId: 'su-x', intervalSec: 60, harness: 'papercusp', goal: 'g', mode: 'monitor', carry: 'cold',
    });
    expect(coldMonitor).toContain('Monitor wake');
    expect(coldMonitor).toContain('COLD loop');
  });

  it("a SETTLE loop (default / absent continuation) has no gated addendum (flush-to-proceed P-005)", () => {
    const settleDefault = buildLoopWakePrompt({ ownerId: 'su-x', intervalSec: 60, harness: 'papercusp', goal: 'g' });
    const settleExplicit = buildLoopWakePrompt({
      ownerId: 'su-x', intervalSec: 60, harness: 'papercusp', goal: 'g', continuation: 'settle',
    });
    expect(settleExplicit).toBe(settleDefault); // explicit settle == absent
    expect(settleDefault).not.toContain('GATED loop');
    expect(settleDefault).not.toContain('continuation gate');
  });

  it('a GATED loop appends the continuation-gate addendum (superset of the base, no base text lost)', () => {
    const settle = buildLoopWakePrompt({ ownerId: 'su-x', intervalSec: 60, harness: 'papercusp', goal: 'g' });
    const gated = buildLoopWakePrompt({
      ownerId: 'su-x', intervalSec: 60, harness: 'papercusp', goal: 'g', continuation: 'gated',
    });
    expect(gated.startsWith(settle)).toBe(true);
    expect(gated.length).toBeGreaterThan(settle.length);
    expect(gated).toContain('GATED loop');
    expect(gated).toContain('CONTINUATION GATE');
    expect(gated).toContain('loop:checkpoint'); // the gate read lives on loop:checkpoint's return
    expect(gated).toContain('work_items:checkpoint'); // flush-first mandate
  });

  it('cold + gated compose (both addenda appended)', () => {
    const both = buildLoopWakePrompt({
      ownerId: 'su-x', intervalSec: 60, harness: 'papercusp', goal: 'g', carry: 'cold', continuation: 'gated',
    });
    expect(both).toContain('COLD loop');
    expect(both).toContain('GATED loop');
  });

  it('WI-2429 fix A: a COLD loop driving a workItem names it concretely in the prompt (not the soft "if you hold one")', () => {
    const withItem = buildLoopWakePrompt({
      ownerId: 'su-x', intervalSec: 60, harness: 'papercusp', goal: 'g', carry: 'cold', workItem: 'WI-2339',
    });
    const without = buildLoopWakePrompt({ ownerId: 'su-x', intervalSec: 60, harness: 'papercusp', goal: 'g', carry: 'cold' });
    expect(withItem.startsWith(without)).toBe(true); // superset — the concrete line is appended
    expect(withItem).toContain('DRIVING work-item WI-2339');
    expect(withItem).toContain("work_items:complete { id:'WI-2339'");
  });

  it('WI-2429 fix A: a WARM loop ignores workItem in the prompt (the concrete mandate is cold-only)', () => {
    const warm = buildLoopWakePrompt({ ownerId: 'su-x', intervalSec: 60, harness: 'papercusp', goal: 'g', carry: 'warm', workItem: 'WI-2339' });
    expect(warm).not.toContain('DRIVING work-item');
  });
});

describe('detectDrivenWorkItemId (WI-2429 fix A — goal auto-detect)', () => {
  it('returns the single WI-/EI-/F- id a goal names', () => {
    expect(detectDrivenWorkItemId('root-cause WI-2339 and fix it')).toBe('WI-2339');
    expect(detectDrivenWorkItemId('drive EI-7284 to green')).toBe('EI-7284');
    expect(detectDrivenWorkItemId('implement F-12')).toBe('F-12');
  });
  it('normalizes a lower-case id to canonical upper-case', () => {
    expect(detectDrivenWorkItemId('work wi-2339')).toBe('WI-2339');
  });
  it('returns null when the goal names NO work-item id', () => {
    expect(detectDrivenWorkItemId('keep the fleet healthy')).toBeNull();
    expect(detectDrivenWorkItemId('')).toBeNull();
  });
  it('returns null when the goal is AMBIGUOUS (multiple distinct ids) — never guess which is driven', () => {
    expect(detectDrivenWorkItemId('reconcile WI-1 against WI-2')).toBeNull();
  });
  it('a repeated single id is still unambiguous (one distinct id)', () => {
    expect(detectDrivenWorkItemId('WI-5: continue WI-5')).toBe('WI-5');
  });
});

describe('materializeLoop — the loop routine row (consumed by the B-LOOP-3 fire)', () => {
  it('writes a PURE loop row the engine treats as the third recurrence kind', async () => {
    const now = new Date('2026-06-20T00:00:00.000Z');
    const res = await materializeLoop({
      workspaceId: 'ws',
      harnessSlug: 'papercusp',
      ownerId: 'su-pinned',
      intervalSec: 120,
      kickoff: 'do the thing',
      costCapCents: 500,
      now,
    });

    expect(upsertRoutineSpy).toHaveBeenCalledTimes(1);
    const input = upsertRoutineSpy.mock.calls[0][1];

    // A PURE loop: trigger_kind 'cron' (rides listDueCronRoutines) but trigger_config {}
    // (no cron/rrule ⇒ claim.ts parks it at 'infinity' in-flight) + the loop columns set.
    expect(input).toMatchObject({
      installSlug: 'papercusp',
      name: 'loop-su-pinned',
      triggerKind: 'cron',
      triggerConfig: {},
      targetRole: LOOP_WAKE_ACTION,
      concurrency: 'skip',
      active: true,
      rescheduleIntervalSec: 120,
      targetOwnerId: 'su-pinned',
    });

    // The fire reads the wake text from payload_template.kickoff and the cap from .costCapCents.
    expect(input.payloadTemplate).toEqual({ kickoff: 'do the thing', costCapCents: 500 });

    // First fire = now + interval (FINITE, so the existing claim path fires it once; the
    // completion-rebase then owns re-arming the parked loop).
    expect(input.nextFireAt.getTime()).toBe(now.getTime() + 120_000);

    expect(res.name).toBe('loop-su-pinned');
    expect(res.targetRole).toBe(LOOP_WAKE_ACTION);
  });

  it('omits costCapCents from payload_template when no cap is given', async () => {
    await materializeLoop({
      workspaceId: 'ws',
      harnessSlug: 'h',
      ownerId: 'o',
      intervalSec: 60,
      kickoff: 'k',
    });
    const input = upsertRoutineSpy.mock.calls[0][1];
    expect(input.payloadTemplate).toEqual({ kickoff: 'k' });
    expect('costCapCents' in input.payloadTemplate).toBe(false);
  });

  it('stamps customWakePrompt only for an explicitly custom kickoff', async () => {
    await materializeLoop({
      workspaceId: 'ws',
      harnessSlug: 'h',
      ownerId: 'o',
      intervalSec: 60,
      kickoff: 'custom wake instruction',
      customWakePrompt: true,
    });
    expect(upsertRoutineSpy.mock.calls[0][1].payloadTemplate).toEqual({
      kickoff: 'custom wake instruction',
      customWakePrompt: true,
    });
  });

  it('reads only the strict customWakePrompt marker; legacy rows remain non-custom', async () => {
    const sql = vi.fn(async () => [
      {
        active: true,
        reschedule_interval_sec: 60,
        install_slug: 'h',
        // Typed as the production signature (loop.ts: `payload_template: Record<string, unknown> | null`)
        // rather than letting vi.fn() infer the element type from THIS literal. Without the
        // annotation the inferred type requires `customWakePrompt`, which makes the legacy row
        // below — a row that genuinely predates the marker — impossible to express. The point of
        // this test is that such rows exist, so the mock must be able to produce one.
        payload_template: { kickoff: 'custom wake instruction', customWakePrompt: true } as Record<
          string,
          unknown
        >,
        fire_count: 2,
        armed_at: null,
      },
    ]);
    const facts = await readActiveLoopFacts('o', { sql: sql as never });
    expect(facts).toMatchObject({ kickoff: 'custom wake instruction', customWakePrompt: true });

    sql.mockResolvedValueOnce([
      {
        active: true,
        reschedule_interval_sec: 60,
        install_slug: 'h',
        payload_template: { kickoff: 'legacy kickoff' },
        fire_count: 2,
        armed_at: null,
      },
    ]);
    const legacyFacts = await readActiveLoopFacts('o', { sql: sql as never });
    expect(legacyFacts?.customWakePrompt).toBe(false);
  });

  it('stamps carry:"cold" onto payload_template only when armed cold (su-cold-auto P-003)', async () => {
    await materializeLoop({
      workspaceId: 'ws',
      harnessSlug: 'h',
      ownerId: 'o',
      intervalSec: 60,
      kickoff: 'k',
      carry: 'cold',
    });
    expect(upsertRoutineSpy.mock.calls[0][1].payloadTemplate).toEqual({ kickoff: 'k', carry: 'cold' });
  });

  it('stamps continuation:"gated" onto payload_template only when armed gated (flush-to-proceed P-005)', async () => {
    await materializeLoop({
      workspaceId: 'ws', harnessSlug: 'h', ownerId: 'o', intervalSec: 60, kickoff: 'k', continuation: 'gated',
    });
    expect(upsertRoutineSpy.mock.calls[0][1].payloadTemplate).toEqual({ kickoff: 'k', continuation: 'gated' });
  });

  it('a SETTLE (or absent) continuation leaves payload_template byte-identical to today (no continuation key)', async () => {
    await materializeLoop({
      workspaceId: 'ws', harnessSlug: 'h', ownerId: 'o', intervalSec: 60, kickoff: 'k', continuation: 'settle',
    });
    const input = upsertRoutineSpy.mock.calls[0][1];
    expect(input.payloadTemplate).toEqual({ kickoff: 'k' });
    expect('continuation' in input.payloadTemplate).toBe(false);
  });

  it('a WARM (or absent) carry leaves payload_template byte-identical to today (no carry key)', async () => {
    await materializeLoop({
      workspaceId: 'ws',
      harnessSlug: 'h',
      ownerId: 'o',
      intervalSec: 60,
      kickoff: 'k',
      carry: 'warm',
    });
    const input = upsertRoutineSpy.mock.calls[0][1];
    expect(input.payloadTemplate).toEqual({ kickoff: 'k' });
    expect('carry' in input.payloadTemplate).toBe(false);
  });

  it("WI-5345: stamps mode:'monitor' onto payload_template only when armed with mode:'monitor'", async () => {
    await materializeLoop({
      workspaceId: 'ws', harnessSlug: 'h', ownerId: 'o', intervalSec: 60, kickoff: 'k', mode: 'monitor',
    });
    expect(upsertRoutineSpy.mock.calls[0][1].payloadTemplate).toEqual({ kickoff: 'k', mode: 'monitor' });
  });

  it("WI-5345: a WORK (or absent) mode leaves payload_template byte-identical to today (no mode key)", async () => {
    await materializeLoop({
      workspaceId: 'ws', harnessSlug: 'h', ownerId: 'o', intervalSec: 60, kickoff: 'k', mode: 'work',
    });
    const input = upsertRoutineSpy.mock.calls[0][1];
    expect(input.payloadTemplate).toEqual({ kickoff: 'k' });
    expect('mode' in input.payloadTemplate).toBe(false);
  });

  it('honours an explicit firstFireInSec (first wake sooner than one interval)', async () => {
    const now = new Date('2026-06-20T00:00:00.000Z');
    await materializeLoop({
      workspaceId: 'ws',
      harnessSlug: 'h',
      ownerId: 'o',
      intervalSec: 600,
      kickoff: 'k',
      firstFireInSec: 60,
      now,
    });
    const input = upsertRoutineSpy.mock.calls[0][1];
    expect(input.nextFireAt.getTime()).toBe(now.getTime() + 60_000);
  });
});

describe('autoArmFleetMemberLoop (kickoff-prompt-absorption-2026-07-17 P-001)', () => {
  const baseOpts = {
    workspaceId: 'ws',
    ownerId: 'su-member-1',
    harnessSlug: 'papercusp',
    planSlug: 'backlog-drain-2026-07-16',
    fleetSlug: 'backlog-drain',
    fleetRole: 'member',
  };

  // A minimal fake tagged-template sql matching the shared sqlStub's contract
  // (always resolves []) — sufficient for both getLoopStatuses' SELECT (0 rows
  // ⇒ not-armed) and materializeLoop's FOR-UPDATE existing-check (0 rows ⇒ the
  // insert branch, which routes through the mocked `upsertRoutine` regardless
  // of which sql instance was passed in).
  const emptySql = (_strings: TemplateStringsArray, ..._values: unknown[]) => Promise.resolve([]);

  beforeEach(() => {
    getFlagSpy.mockReset().mockResolvedValue(true);
    armInboxWakeSpy.mockReset().mockResolvedValue({ awaitId: 1, eventKey: 'k', handleNote: 'n', minSleepSec: 60 });
  });

  it('skips a LEADER — never auto-arms outside the member role', async () => {
    const res = await autoArmFleetMemberLoop({ ...baseOpts, fleetRole: 'leader', sql: emptySql as any });
    expect(res).toEqual({ armed: false, reason: 'not-a-member' });
    expect(getFlagSpy).not.toHaveBeenCalled();
  });

  it('skips an UNPLANNED member — nothing to derive a goal from', async () => {
    const res = await autoArmFleetMemberLoop({ ...baseOpts, planSlug: null, sql: emptySql as any });
    expect(res).toEqual({ armed: false, reason: 'no-plan-bound' });
    expect(getFlagSpy).not.toHaveBeenCalled();
  });

  it('skips when the papercusp-loops flag is OFF', async () => {
    getFlagSpy.mockResolvedValue(false);
    const res = await autoArmFleetMemberLoop({ ...baseOpts, sql: emptySql as any });
    expect(res).toEqual({ armed: false, reason: 'loops-disabled' });
    expect(getFlagSpy).toHaveBeenCalledWith('papercusp-loops', 'system');
  });

  it('reports (not throws) when the flag check itself errors', async () => {
    getFlagSpy.mockRejectedValue(new Error('resolver down'));
    const res = await autoArmFleetMemberLoop({ ...baseOpts, sql: emptySql as any });
    expect(res.armed).toBe(false);
    expect(res.reason).toContain('flag-check-failed');
    expect(res.reason).toContain('resolver down');
  });

  it('happy path: arms via materializeLoop and skips the live inbox-wake leg under an injected test sql', async () => {
    const res = await autoArmFleetMemberLoop({ ...baseOpts, sql: emptySql as any });
    expect(res.armed).toBe(true);
    expect(res.reason).toBe('armed');
    expect(res.loopName).toBe('loop-su-member-1');
    // The goal names the plan + fleet so the wake prompt orients the member.
    const insertInput = upsertRoutineSpy.mock.calls.at(-1)?.[1];
    expect(insertInput.payloadTemplate.kickoff).toContain('backlog-drain-2026-07-16');
    expect(insertInput.payloadTemplate.kickoff).toContain('backlog-drain');
    expect(insertInput.targetOwnerId).toBe('su-member-1');
    // The test-sql seam bypasses the live-singleton-only armInboxWake leg entirely.
    expect(armInboxWakeSpy).not.toHaveBeenCalled();
  });

  it('is idempotent: an existing ACTIVE loop for this owner is never clobbered', async () => {
    const activeRow = {
      install_slug: 'papercusp',
      name: 'loop-su-member-1',
      active: true,
      reschedule_interval_sec: 60,
      target_owner_id: 'su-member-1',
      payload_template: { kickoff: 'existing kickoff' },
      fire_count: 3,
      last_fired_at: null,
      parked: false,
      next_fire_at: null,
      parked_ms: null,
      last_delivery_outcome: null,
      consecutive_errors: 0,
      lifecycle_completed_at: null,
      presence_last_active_at: null,
    };
    // Classify by query text: the DISTINCT-ON status read gets the active row;
    // everything else (materializeLoop would never even run past the early
    // return, but keep it inert regardless) gets [].
    const statusSql = (strings: TemplateStringsArray, ..._values: unknown[]) => {
      const text = strings.join(' ? ');
      if (/DISTINCT ON/.test(text)) return Promise.resolve([activeRow]);
      return Promise.resolve([]);
    };
    const res = await autoArmFleetMemberLoop({ ...baseOpts, sql: statusSql as any });
    expect(res).toEqual({ armed: false, reason: 'already-armed', loopName: 'loop-su-member-1' });
    expect(upsertRoutineSpy).not.toHaveBeenCalled();
    expect(armInboxWakeSpy).not.toHaveBeenCalled();
  });
});

describe('getLoopStatuses — firesSinceArm (WI-36070: the number maxFires is actually compared against)', () => {
  // One fake row shaped like the SELECT's output. Only the fire counters and the bound matter
  // here; everything else is filler the mapper reads but this suite does not assert on.
  function rowSql(over: Record<string, unknown> = {}) {
    const row = {
      install_slug: 'papercusp',
      name: 'loop-su-x',
      active: true,
      reschedule_interval_sec: 60,
      target_owner_id: 'su-x',
      payload_template: { carry: 'warm', continuation: 'settle', mode: 'work', maxFires: 40 },
      fire_count: 113,
      fire_count_at_arm: 98,
      last_fired_at: null,
      armed_at: '2026-08-08T17:30:29.385Z',
      parked: false,
      next_fire_at: null,
      parked_ms: null,
      last_delivery_outcome: 'queued',
      consecutive_errors: 0,
      lifecycle_completed_at: null,
      last_turn_at: null,
      last_real_turn_at: null,
      last_wake_channel: null,
      last_wake_status: null,
      last_wake_at: null,
      last_wake_error: null,
      presence_last_active_at: null,
      ...over,
    };
    return (_s: TemplateStringsArray, ..._v: unknown[]) => Promise.resolve([row]);
  }

  // THE DEFECT. These are the real numbers measured on su-7854d874's own loop, which is what
  // made this filable: 113 lifetime fires against a bound of 40 reads as a breached dead-man on
  // an `active: true` loop, and the reading is wrong — the guard had 25 fires of headroom left.
  it('reports fires SINCE ARM, not the lifetime fireCount, so an arm-relative bound is readable', async () => {
    const out = await getLoopStatuses(['su-x'], { sql: rowSql() as any });
    const s = out.get('su-x')!;
    expect(s.fireCount).toBe(113); // lifetime — unchanged, still reported
    expect(s.firesSinceArm).toBe(15); // 113 - 98: what checkLoopDeadMan decides on
    expect(s.maxFires).toBe(40);
    // The whole point: against the RIGHT counter this loop is nowhere near its bound.
    expect(s.firesSinceArm).toBeLessThan(s.maxFires!);
    // ...while the comparison the payload used to permit says the opposite. This assertion is
    // the guard: it fails if anyone ever "simplifies" firesSinceArm back to the lifetime count.
    expect(s.fireCount).toBeGreaterThan(s.maxFires!);
  });

  it('CALIBRATION: with no baseline stamped (a loop armed before fire_count_at_arm existed) it degrades to the lifetime count, never to a negative', async () => {
    const out = await getLoopStatuses(['su-x'], { sql: rowSql({ fire_count: 7, fire_count_at_arm: 0 }) as any });
    expect(out.get('su-x')!.firesSinceArm).toBe(7);
  });

  it('CLAMPS at 0 — a baseline ahead of the lifetime count never reports negative headroom consumed', async () => {
    const out = await getLoopStatuses(['su-x'], { sql: rowSql({ fire_count: 3, fire_count_at_arm: 10 }) as any });
    expect(out.get('su-x')!.firesSinceArm).toBe(0);
  });

  it('a FRESHLY re-armed loop reports 0 fires since arm even with a long lifetime history', async () => {
    const out = await getLoopStatuses(['su-x'], { sql: rowSql({ fire_count: 500, fire_count_at_arm: 500 }) as any });
    const s = out.get('su-x')!;
    expect(s.firesSinceArm).toBe(0);
    expect(s.fireCount).toBe(500);
  });
});

describe('computeLoopCadence (EI-20217869515819188 — configured vs observed cadence)', () => {
  const armedAtMs = Date.parse('2026-08-11T20:03:22.000Z');
  const nowMs = armedAtMs + (7 * 60 * 60 + 47 * 60) * 1000;

  it('reports expected opportunities, effective interval, and slow-cadence ratio from arm-relative fires', () => {
    const out = computeLoopCadence({
      intervalSec: 60,
      armedAtMs,
      firesSinceArm: 15,
      lastFiredAtMs: armedAtMs + 15 * 31 * 60 * 1000,
      longestObservedGapSec: 2.5 * 60 * 60,
      nowMs,
    });

    expect(out.expectedFiresSinceArm).toBe(467);
    expect(out.effectiveIntervalSec).toBe(31 * 60);
    expect(out.cadenceRatio).toBe(31);
    expect(out.longestObservedGapSec).toBe(2.5 * 60 * 60);
  });

  it('keeps every metric null when its timestamps are insufficient, never fabricating zero', () => {
    expect(
      computeLoopCadence({
        intervalSec: 60,
        armedAtMs: null,
        firesSinceArm: 0,
        lastFiredAtMs: null,
        longestObservedGapSec: null,
        nowMs,
      }),
    ).toEqual({
      expectedFiresSinceArm: null,
      effectiveIntervalSec: null,
      cadenceRatio: null,
      longestObservedGapSec: null,
    });
  });

  it('preserves a measured zero gap while rejecting invalid history values', () => {
    expect(
      computeLoopCadence({
        intervalSec: 60,
        armedAtMs,
        firesSinceArm: 1,
        lastFiredAtMs: armedAtMs,
        longestObservedGapSec: 0,
        nowMs: armedAtMs,
      }).longestObservedGapSec,
    ).toBe(0);
    expect(
      computeLoopCadence({
        intervalSec: 60,
        armedAtMs,
        firesSinceArm: 1,
        lastFiredAtMs: armedAtMs,
        longestObservedGapSec: -1,
        nowMs: armedAtMs,
      }).longestObservedGapSec,
    ).toBeNull();
  });
});

describe('computeCadenceDrift (EI-20247200923975596 — advisory sustained drift)', () => {
  // The clock is PINNED (nowMs + a fixed nextFireAt) rather than left to Date.now(): overdue-ness
  // is now part of the verdict, so a fixture that lets real time drift under it would decide the
  // assertion by how long the suite took to reach this line.
  const NOW_MS = Date.parse('2026-08-16T00:10:00.000Z');
  const base = {
    active: true,
    intervalSec: 60,
    firesSinceArm: 5,
    expectedFiresSinceArm: 62,
    cadenceRatio: 12.13396,
    longestObservedGapSec: 1207.28,
    parked: false,
    // 600s late against a 60s interval — well past the 4-interval (240s) overdue floor.
    nextFireAt: '2026-08-16T00:00:00.000Z',
    nowMs: NOW_MS,
  };

  it('flags multiple fires with missed opportunities, a slow ratio, and a corroborating gap', () => {
    expect(computeCadenceDrift(base)).toBe(true);
  });

  it('stays quiet for startup, normal cadence, missing history, or inactive loops', () => {
    expect(computeCadenceDrift({ ...base, firesSinceArm: 2 })).toBe(false);
    expect(computeCadenceDrift({ ...base, expectedFiresSinceArm: 7, cadenceRatio: 1.4 })).toBe(false);
    expect(computeCadenceDrift({ ...base, longestObservedGapSec: null })).toBe(false);
    expect(computeCadenceDrift({ ...base, active: false })).toBe(false);
  });

  // The settling gate (loop.ts) — every statistical precondition above is already satisfied by
  // `base`, so each case here isolates the gate itself. Without these, the gate could be deleted
  // and the suite would stay green.
  describe('the settling gate — drift needs a demonstrably LATE fire, not just a slow ratio', () => {
    it('never flags a PARKED loop: a mid-turn loop is settling, and settling is not drift', () => {
      expect(computeCadenceDrift({ ...base, parked: true })).toBe(false);
    });

    it('stays quiet when nextFireAt is absent or unparseable — overdue-ness is unestablished, not proven', () => {
      expect(computeCadenceDrift({ ...base, nextFireAt: null })).toBe(false);
      expect(computeCadenceDrift({ ...base, nextFireAt: undefined })).toBe(false);
      expect(computeCadenceDrift({ ...base, nextFireAt: 'not-a-timestamp' })).toBe(false);
    });

    it('stays quiet when the next fire is still in the FUTURE — nothing is late yet', () => {
      expect(computeCadenceDrift({ ...base, nextFireAt: '2026-08-16T00:15:00.000Z' })).toBe(false);
    });

    it('holds the 4-interval overdue floor from both sides', () => {
      // 239s late — one second short of the floor.
      expect(computeCadenceDrift({ ...base, nextFireAt: '2026-08-16T00:06:01.000Z' })).toBe(false);
      // Exactly 240s late — the floor is inclusive (`>=`).
      expect(computeCadenceDrift({ ...base, nextFireAt: '2026-08-16T00:06:00.000Z' })).toBe(true);
    });
  });
});

describe('countAgentToolCallsInWindow (EI-19984789589075138 — the cold-wake un-checkpointed-work evidence check)', () => {
  function countSql(n: number) {
    const sql = ((_s: TemplateStringsArray, ..._v: unknown[]) => Promise.resolve([{ n }])) as any;
    sql.unsafe = (identifier: string) => identifier;
    return sql;
  }
  function throwingSql() {
    return (_s: TemplateStringsArray, ..._v: unknown[]) => Promise.reject(new Error('boom'));
  }

  it('returns the row count when the query succeeds', async () => {
    const out = await countAgentToolCallsInWindow('su-x', 0, 1000, { sql: countSql(3) as any });
    expect(out).toBe(3);
  });

  it('returns 0 (not null) for a genuinely empty window — a real, confirmed answer', async () => {
    const out = await countAgentToolCallsInWindow('su-x', 0, 1000, { sql: countSql(0) as any });
    expect(out).toBe(0);
  });

  it('filters explicit automatic origins while retaining legacy NULL rows', async () => {
    const calls: { strings: readonly string[]; values: unknown[] }[] = [];
    const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
      calls.push({ strings: [...strings], values });
      return Promise.resolve([{ n: 1 }]);
    }) as any;
    sql.unsafe = (identifier: string) => identifier;

    const out = await countAgentToolCallsInWindow('su-x', 0, 1000, { sql });

    expect(out).toBe(1);
    const rendered = calls.flatMap((call) => call.strings).join(' ');
    const values = calls.flatMap((call) => call.values.flatMap((value: unknown) => Array.isArray(value) ? value : [value]));
    expect(rendered).toContain('IS NULL');
    expect(values).toEqual(expect.arrayContaining(['call_origin', 'tool_name', 'agent', 'unknown', 'activity:report', 'coord:glance', 'coord:inbox']));
  });

  it('EI-20543456503122446: binds the carry-note bookkeeping exclusion so the note-writing call cannot count itself', async () => {
    // A tool_invocations row is stamped at INSERT, after the handler's write commits, so
    // the loop:checkpoint that WROTE the note lands inside the window this note opens.
    // Without the exclusion the guard's `0` downgrade is unreachable for any session that
    // checkpoints and then dies — i.e. exactly the bounced-fire case it exists for.
    // NOTE: this asserts COMPOSITION only. The fake sql below never executes the
    // predicate, which is why the semantic proof lives in loop.integration.test.ts.
    const calls: { strings: readonly string[]; values: unknown[] }[] = [];
    const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
      calls.push({ strings: [...strings], values });
      return Promise.resolve([{ n: 0 }]);
    }) as any;
    sql.unsafe = (identifier: string) => identifier;

    await countAgentToolCallsInWindow('su-x', 0, 1000, { sql });

    const rendered = calls.flatMap((call) => call.strings).join(' ');
    const values = calls.flatMap((call) =>
      call.values.flatMap((value: unknown) => (Array.isArray(value) ? value : [value])),
    );
    expect(rendered).toContain('tool_name <> ALL');
    expect(values).toEqual(expect.arrayContaining(['loop:checkpoint', 'work_items:checkpoint']));
  });

  it('returns null (never 0) when the query itself fails — "unavailable" must not read as "confirmed zero"', async () => {
    // The catch path deliberately console.warn's (best-effort logging) — expect it
    // explicitly (vitest-fail-on-console) rather than letting it fail the test.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const out = await countAgentToolCallsInWindow('su-x', 0, 1000, { sql: throwingSql() as any });
    expect(out).toBeNull();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });
});

describe('loop constants / naming', () => {
  it('loopRoutineName is deterministic per owner (the upsert key)', () => {
    expect(loopRoutineName('su-x')).toBe('loop-su-x');
  });
  it('the policy floor is the 60s /loop floor', () => {
    expect(LOOP_INTERVAL_FLOOR_SEC).toBe(60);
  });
  it('the loop target_role is the stable self-documenting value', () => {
    expect(LOOP_WAKE_ACTION).toBe('system:loop-wake');
  });
});
