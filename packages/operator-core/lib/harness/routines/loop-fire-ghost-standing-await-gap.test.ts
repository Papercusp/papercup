/**
 * WI-2339 (defect #1) — CHARACTERIZATION / regression test locking in the loop's fire-success
 * gap found in the cold-loop death/respawn watchdog investigation, BEFORE any fix lands.
 *
 * Root cause (WI-2339 post 50246, su-4072faf3, 2026-07-04): `fireLoopWake` treats
 * `reached = (fan.woken ?? 0) > 0 || (fan.staged ?? 0) > 0` as its ONLY success signal — the
 * ONE path that would `deactivateLoop` / record `no-session-now` requires `reached === false`
 * (loop-fire.ts ~L237-238). But the standing (`once=false`) `coord:inbox-wake:<owner>` await
 * every psu/console session arms at launch (`armInboxWake` → `upsertInboxWakeAwait`,
 * store.ts: `once=false`, `timeout_behavior='expire'`, `expires_ts=NULL` — no TTL, ever) is
 * MATCHED WITHOUT CONSUMING on every emit (`fireAwaitsForKey`'s standing-watch branch), and is
 * cancelled ONLY by `cancelInboxWakeAwaits`, which runs ONLY off a graceful SessionEnd
 * lifecycle hook (inbox-wake-arm.ts, documented as "SessionEnd hygiene"). An unplanned death
 * (terminal killed / crash / OOM / desktop-session restart) never runs that hook — so the
 * standing await survives the death FOREVER, `wakeRecipients` (via `emitAwaitedEvent` →
 * `fireAwaitsForKey`) reports `woken:1` on every single tick till the end of time, and
 * `fireLoopWake` is structurally incapable of ever reaching its own `no-session-now`
 * auto-deactivation path for a session that died without a graceful exit.
 *
 * This test does NOT touch any fix — it documents today's (buggy) behavior so a future fix
 * (WI-2339 proposal A: make the fire-success signal reflect ACTUAL reachability via
 * `probeWakeReachability`, not a ghost-registration match) has a red-to-green target. Once
 * that fix lands, a `wake()` returning `woken:1` for a genuinely-dead target should no longer
 * be trusted as `reached` — this test's "TODAY (the bug)" assertions should then flip.
 */
import { describe, it, expect, vi } from 'vitest';
import { fireLoopWake, type LoopFireDeps } from './loop-fire';

function mkDeps(
  over: Partial<LoopFireDeps> = {},
): Required<Pick<LoopFireDeps, 'checkFireGate' | 'recordFire' | 'wake' | 'costCap' | 'deactivateLoop'>> {
  return {
    checkFireGate: vi.fn(async () => ({ allow: true, consecutiveErrors: 0 })) as never,
    recordFire: vi.fn(async () => {}) as never,
    wake: vi.fn(async () => ({ targets: ['su-dead'], keys: ['coord:inbox-wake:su-dead'], woken: 1, staged: 0 })) as never,
    costCap: vi.fn(async () => ({ breach: false, spendCents: 0, capCents: null })) as never,
    deactivateLoop: vi.fn(async () => true) as never,
    ...over,
  };
}

const baseInput = {
  routineId: 'rt_papercusp_loop_su-dead',
  routineName: 'loop-su-dead',
  workspaceId: 'papercusp-workspace',
  installSlug: 'papercusp',
  targetOwnerId: 'su-dead',
  payloadTemplate: null as Record<string, unknown> | null,
};

describe('fireLoopWake — WI-2339 gap: a ghost standing-await match is indistinguishable from a real delivery', () => {
  it('TODAY (the bug): wake() reporting woken:1 for a target whose SESSION IS ACTUALLY DEAD (a standing-await ghost match, not a real delivery) is reported fired:true, and the loop is NEVER deactivated / no error is ever recorded', async () => {
    // This `wake` mock represents exactly what the REAL `wakeRecipients` returns in
    // production for a dead target: `emitAwaitedEvent` → `fireAwaitsForKey`'s standing-watch
    // branch (`once=false`) matches the still-armed inbox-wake await UNCONDITIONALLY — it has
    // no concept of "is the matching session alive" at all, so `woken` is 1 regardless of
    // whether anything is actually there to receive the turn.
    const deps = mkDeps();
    const res = await fireLoopWake(baseInput, deps);

    expect(res).toMatchObject({ fired: true, woken: 1 });
    // The ONLY path that would ever deactivate the loop / record `no-session-now` requires
    // `reached === false` — a ghost woken:1 never produces that, so this dead loop is
    // re-armed by the routine engine forever, exactly like the WI-2339 soak-test subject
    // (su-95cf8308) whose loop kept firing ~3h after its terminal died.
    expect(deps.deactivateLoop).not.toHaveBeenCalled();
    expect(deps.recordFire).not.toHaveBeenCalledWith(
      baseInput.installSlug,
      baseInput.routineName,
      expect.stringContaining('no-session-now'),
      expect.anything(),
    );
    // Instead it's recorded as a normal successful enqueue — visually indistinguishable in
    // fire-history from a genuinely live loop.
    expect(deps.recordFire).toHaveBeenCalledWith(baseInput.installSlug, baseInput.routineName, 'queued', 'attempt');
  });

  it('for contrast: the ONLY way `fireLoopWake` ever sees "dead" is a wake() that reports BOTH woken:0 AND staged:0 — which the real ghost-standing-await path never produces once a session has died', async () => {
    // This is the branch the existing loop-fire.test.ts suite covers ("a missed wake ... auto-
    // ends the orphaned loop") — included here for contrast: it only fires when `wake()` itself
    // reports nothing matched, which requires the standing await to have been cancelled first.
    // Per the root cause above, nothing ever cancels it on an unplanned death, so production
    // code never naturally reaches this branch for a session that died without a graceful exit.
    const deps = mkDeps({
      wake: vi.fn(async () => ({ targets: ['su-dead'], keys: [], woken: 0, staged: 0 })) as never,
    });
    const res = await fireLoopWake(baseInput, deps);
    expect(res).toMatchObject({ fired: false, reason: 'no-session-now' });
    expect(deps.deactivateLoop).toHaveBeenCalledTimes(1);
  });
});
