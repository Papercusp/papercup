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
vi.mock('@papercusp/db-org', () => ({
  getOrgPg: () => ({ sql: sqlStub }),
  upsertRoutine: upsertRoutineSpy,
}));

import {
  materializeLoop,
  buildLoopWakePrompt,
  detectDrivenWorkItemId,
  loopRoutineName,
  computeLoopStall,
  LOOP_WAKE_ACTION,
  LOOP_INTERVAL_FLOOR_SEC,
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
  it('not parked → never stalled', () => {
    expect(computeLoopStall({ parked: false, parkedMs: 99e9, intervalSec: 120, hasCompletionSinceFire: false, activeSinceFire: false })).toEqual({ stalled: false, stalledSinceMs: null });
  });
  it('parked but recently (under the stuck threshold) → healthy in-flight', () => {
    expect(computeLoopStall({ parked: true, parkedMs: 60_000, intervalSec: 120, hasCompletionSinceFire: false, activeSinceFire: false }).stalled).toBe(false);
  });
  it('parked long, no completion, no activity → STALLED with the parked duration', () => {
    const r = computeLoopStall({ parked: true, parkedMs: STUCK + 1000, intervalSec: 120, hasCompletionSinceFire: false, activeSinceFire: false });
    expect(r.stalled).toBe(true);
    expect(r.stalledSinceMs).toBe(STUCK + 1000);
  });
  it('parked long but a completion marker exists → NOT stalled (the turn finished)', () => {
    expect(computeLoopStall({ parked: true, parkedMs: STUCK + 1000, intervalSec: 120, hasCompletionSinceFire: true, activeSinceFire: false }).stalled).toBe(false);
  });
  it('parked long but session ACTIVE since the fire → NOT stalled (a legitimately long turn)', () => {
    expect(computeLoopStall({ parked: true, parkedMs: STUCK + 1000, intervalSec: 120, hasCompletionSinceFire: false, activeSinceFire: true }).stalled).toBe(false);
  });
  it('the threshold scales to 4×interval for a long interval', () => {
    // interval 1200s → 4× = 4800s = 80min > 30min, so 60min parked is NOT yet stalled.
    expect(computeLoopStall({ parked: true, parkedMs: 60 * 60_000, intervalSec: 1200, hasCompletionSinceFire: false, activeSinceFire: false }).stalled).toBe(false);
    expect(computeLoopStall({ parked: true, parkedMs: 90 * 60_000, intervalSec: 1200, hasCompletionSinceFire: false, activeSinceFire: false }).stalled).toBe(true);
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
