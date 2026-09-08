/**
 * complete.finish-plan-stamp-coverage-guard.test — WI-38908 / EI-19972048649686949,
 * second instance EI-20576535595925497.
 *
 * TWO paths reflect a completed work-item's terminal state onto its stamped plan item:
 *
 *   1. `reflect-rules.ts:141` — the reaction FALLBACK. It passes
 *      `onlyIfNoOtherOpenCoverage: true`, and its comment block documents the 1:N
 *      hazard it was added for.
 *   2. `complete.ts` `synchronizeFinishWork` — the SYNCHRONOUS finish leg inside
 *      `work_items:complete`. It fires the identical `plans:set-status`.
 *
 * The fallback SUPPRESSES ITSELF when the synchronous leg already succeeded
 * (`reflect-rules.ts:162` skips when the finish receipt's `planItem` is already
 * done/dropped). So guarding only path 2's fallback left the path that actually runs
 * unguarded, and the guard was effectively unreachable on any successful complete():
 * completing ONE of N work-items sharing a `payload.plan_item` stamp marked the plan
 * item terminal, and `plan-item-reconcile` then closed the siblings.
 *
 * Live instance this pins: `release-build-vm-dev-parity-audit-2026-08-13#P-004` —
 * WI-39352 (an OFFLINE artifact sub-lane) completed 2026-08-16T02:19:54Z, flipped P-004
 * `done` 1.5s later, and the reconciler closed WI-38600 (the Windows clean-install +
 * live-drive verdict) at 02:38:05Z with `completionAuthority='proposed'` and
 * `terminalCompletionRef=null` — on a guest with no OS installed. 126 plan items were
 * affected fleet-wide before the fix.
 *
 * These pin that the SYNCHRONOUS leg carries the same guards as the fallback.
 */
import { describe, expect, it, vi } from 'vitest';

import { synchronizeFinishWork } from './complete';

const STAMP = { plan_slug: 'some-plan-2026-08-13', item_id: 'P-004', harness_slug: 'papercusp' };

const ctx = { ownerId: 'me', workspaceId: 'default', harnessSlug: 'papercusp' } as never;

/** One reaction dispatch as `synchronizeFinishWork` issues it. */
type FiredReaction = { fire: string; args: Record<string, unknown> };

/** Run the finish saga with a fake `fire`, and hand back every reaction it fired. */
async function runFinish(
  state: string,
  stamp: unknown = STAMP,
  committedStatus: string | null = state === 'deprecated' ? 'dropped' : state,
) {
  // Typed parameter, not a bare `async () => ...`: an untyped vi.fn infers its args as
  // the empty tuple `[]`, so reading `calls[n][0]` below is a type error (TS2493).
  const fire = vi.fn(async (_opts: FiredReaction) => ({ ok: true as const }));
  const clearCheckpoint = vi.fn(async () => undefined) as never;
  const readPlanItemStatus = vi.fn(async () => committedStatus);
  const receipt = await synchronizeFinishWork(
    {
      id: 'WI-39352',
      workItem: { state, harness: 'papercusp', payload: stamp ? { plan_item: stamp } : {} },
      completionEvidenceStored: true,
      ctx,
    },
    { fire: fire as never, clearCheckpoint, readPlanItemStatus },
  );
  const calls: FiredReaction[] = fire.mock.calls.map((c) => c[0]);
  return {
    receipt,
    calls,
    readPlanItemStatus,
    setStatus: calls.find((c) => c.fire === 'plans:set-status'),
  };
}

describe('synchronizeFinishWork plan-item reflection carries the coverage guard', () => {
  it('passes onlyIfNoOtherOpenCoverage on a `done` reflection', async () => {
    const { setStatus } = await runFinish('done');

    // Calibration: the reflection fired at all, at the stamped item.
    expect(setStatus).toBeDefined();
    expect(setStatus!.args).toMatchObject({ slug: STAMP.plan_slug, item: STAMP.item_id, status: 'done' });

    // The regression itself: without this, completing one of N stamped siblings
    // de-queues a plan item other live work still covers.
    expect(setStatus!.args.onlyIfNoOtherOpenCoverage).toBe(true);
  });

  it('reports the canonical status left by a guarded no-op instead of the requested terminal status', async () => {
    const { receipt, readPlanItemStatus } = await runFinish('done', STAMP, 'wip');

    expect(readPlanItemStatus).toHaveBeenCalledOnce();
    expect(receipt).toMatchObject({ complete: true, planItem: 'wip' });
  });

  it('fails the finish leg when the committed plan-item status cannot be read back', async () => {
    const { receipt } = await runFinish('done', STAMP, null);

    expect(receipt).toMatchObject({ complete: false, planItem: 'failed' });
    expect(receipt.errors?.join(' ')).toMatch(/status readback failed.*not found/);
  });

  it('passes BOTH guards on a `dropped` reflection, matching reflect-rules.ts', async () => {
    // 'deprecated' maps to the dropped branch via reflectedTerminalStatus.
    const { setStatus } = await runFinish('deprecated');

    expect(setStatus!.args).toMatchObject({ status: 'dropped' });
    expect(setStatus!.args.onlyIfNoOtherOpenCoverage).toBe(true);
    // EI-20129670928216719: stop a done -> dropped DOWNGRADE whose real completer is
    // itself terminal, and therefore invisible to the open-coverage scan.
    expect(setStatus!.args.onlyIfNotCompleted).toBe(true);
  });

  it('keeps onlyIfNotCompleted drop-only — a `done` flip cannot be a downgrade', async () => {
    const { setStatus } = await runFinish('done');
    expect(setStatus!.args.onlyIfNotCompleted).toBeUndefined();
  });

  it('fires no plan reflection at all when the work-item carries no stamp', async () => {
    // Calibration for the assertions above: they would also "pass" vacuously if the
    // reflection never fired, so pin that a missing stamp is the ONLY reason it doesn't.
    const { calls, receipt } = await runFinish('done', null);
    expect(calls.find((c) => c.fire === 'plans:set-status')).toBeUndefined();
    expect(receipt.planItem).toBe('not-linked');
  });

  it('fires no plan reflection when the completion left the item non-terminal', async () => {
    const { calls } = await runFinish('open');
    expect(calls.find((c) => c.fire === 'plans:set-status')).toBeUndefined();
  });

  it('keeps a terminal close truthful and retries only the missing checkpoint cleanup leg', async () => {
    // EI-22703164970810180: terminal state/evidence can commit before boundedOrgTxn
    // acquisition for checkpoint cleanup times out. The caller must see incomplete finish
    // convergence, then be able to retry the same completion without losing the close.
    const clearCheckpoint = vi
      .fn<(_ref: unknown, _checkpoint: string | null) => Promise<void>>()
      .mockRejectedValueOnce(new Error('db-call-deadline: boundedOrgTxn:acquire(admin)'))
      .mockResolvedValueOnce(undefined);
    const fire = vi.fn(async (_opts: FiredReaction) => ({ ok: true as const }));
    const readPlanItemStatus = vi.fn(async () => 'done');
    const args = {
      id: 'EI-22703164970810180',
      workItem: { state: 'done', harness: 'papercusp', payload: { plan_item: STAMP } },
      completionEvidenceStored: true,
      ctx,
    };

    const first = await synchronizeFinishWork(args, {
      fire: fire as never,
      clearCheckpoint: clearCheckpoint as never,
      readPlanItemStatus,
    });
    expect(first).toMatchObject({ complete: false, checkpointCleared: false, planItem: 'done' });
    expect(first.errors?.join(' ')).toContain('checkpoint cleanup failed: db-call-deadline');

    const retry = await synchronizeFinishWork(args, {
      fire: fire as never,
      clearCheckpoint: clearCheckpoint as never,
      readPlanItemStatus,
    });
    expect(retry).toMatchObject({ complete: true, checkpointCleared: true, planItem: 'done' });
    expect(clearCheckpoint).toHaveBeenCalledTimes(2);
  });
});
