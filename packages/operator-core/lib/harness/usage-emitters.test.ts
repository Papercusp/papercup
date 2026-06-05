/**
 * P-070 emitters — coverage for the 8 lifecycle → usage-event mapping functions.
 * Each maps its event to the correct kind + ref_id + payload per
 * USAGE_EVENT_REF_CONVENTION. The emit SEAM is mocked (its own best-effort /
 * never-throws behaviour is covered in emit-usage.test.ts); here we assert the
 * mapping each call site relies on.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./emit-usage', () => ({ emitUsageEventBestEffort: vi.fn() }));
import { emitUsageEventBestEffort } from './emit-usage';
import {
  emitFeatureAuthored,
  emitFeatureQueued,
  emitFeatureWorkedStart,
  emitFeatureWorkedEnd,
  emitPrOpened,
  emitDecisionAdded,
  emitPlanAuthored,
  emitAgentRunCompleted,
} from './usage-emitters';

const seam = vi.mocked(emitUsageEventBestEffort);

describe('usage-emitters', () => {
  beforeEach(() => seam.mockReset());

  it('emitFeatureAuthored → feature_authored, ref_id=feature id, payload.title', () => {
    emitFeatureAuthored('papercup', 'F-1', { title: 'Do it' });
    expect(seam).toHaveBeenCalledWith('papercup', 'feature_authored', {
      ref_id: 'F-1',
      payload: { title: 'Do it' },
    });
  });

  it('emitFeatureQueued → feature_queued, ref_id=feature id, payload.from_status', () => {
    emitFeatureQueued('papercup', 'F-2', { fromStatus: 'validating' });
    expect(seam).toHaveBeenCalledWith('papercup', 'feature_queued', {
      ref_id: 'F-2',
      payload: { from_status: 'validating' },
    });
  });

  it('emitFeatureWorkedStart → feature_worked_start, ref_id=run id, payload.run_id+role', () => {
    emitFeatureWorkedStart('papercup', 'run-9', { role: 'worker' });
    expect(seam).toHaveBeenCalledWith('papercup', 'feature_worked_start', {
      ref_id: 'run-9',
      payload: { run_id: 'run-9', role: 'worker' },
    });
  });

  it('emitFeatureWorkedEnd → feature_worked_end, ref_id=run id, payload.run_id+outcome', () => {
    emitFeatureWorkedEnd('papercup', 'run-9', { outcome: 'completed' });
    expect(seam).toHaveBeenCalledWith('papercup', 'feature_worked_end', {
      ref_id: 'run-9',
      payload: { run_id: 'run-9', outcome: 'completed' },
    });
  });

  it('emitPrOpened → pr_opened, ref_id=pr number (string), payload pr_number+refs', () => {
    emitPrOpened('papercup', 123, { headRef: 'feat/x', baseRef: 'main' });
    expect(seam).toHaveBeenCalledWith('papercup', 'pr_opened', {
      ref_id: '123',
      payload: { pr_number: 123, head_ref: 'feat/x', base_ref: 'main' },
    });
  });

  it('emitDecisionAdded → decision_added, ref_id=decision id, payload.decision_id', () => {
    emitDecisionAdded('papercup', 'D-007');
    expect(seam).toHaveBeenCalledWith('papercup', 'decision_added', {
      ref_id: 'D-007',
      payload: { decision_id: 'D-007' },
    });
  });

  it('emitPlanAuthored → plan_authored, ref_id=plan slug, payload.plan_slug', () => {
    emitPlanAuthored('papercup', 'my-plan-2026-06-02');
    expect(seam).toHaveBeenCalledWith('papercup', 'plan_authored', {
      ref_id: 'my-plan-2026-06-02',
      payload: { plan_slug: 'my-plan-2026-06-02' },
    });
  });

  it('emitAgentRunCompleted → agent_run_completed, ref_id=run id, payload run_id+role+duration', () => {
    emitAgentRunCompleted('papercup', 'run-9', { role: 'reviewer', durationMs: 4200 });
    expect(seam).toHaveBeenCalledWith('papercup', 'agent_run_completed', {
      ref_id: 'run-9',
      payload: { run_id: 'run-9', role: 'reviewer', duration_ms: 4200 },
    });
  });

  it('omits undefined payload fields rather than emitting explicit undefined', () => {
    emitFeatureAuthored('papercup', 'F-3');
    expect(seam).toHaveBeenCalledWith('papercup', 'feature_authored', {
      ref_id: 'F-3',
      payload: {},
    });
  });
});
