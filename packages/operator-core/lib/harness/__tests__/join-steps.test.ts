/**
 * join-steps — the Model-B join step vocabulary (the orchestration logic
 * lives in join-shared-harness.ts, covered by its own test). This locks the
 * canonical step order, which both the join orchestrator and the JoinProgress
 * UI render against, so a reorder/rename can't silently drift them apart.
 */

import { describe, expect, it } from 'vitest';
import { ALL_STEP_IDS, JOIN_STEP_IDS, type JoinStepId } from '../join-steps';

describe('join-steps vocabulary', () => {
  it('lists the six Model-B join steps in canonical order', () => {
    expect(ALL_STEP_IDS).toEqual([
      'oauth_attest',
      'clone_repo',
      'publish_binding',
      'boot_federate',
      'await_admission_merge',
      'route_insights',
    ]);
  });

  it('JOIN_STEP_IDS is the public alias of ALL_STEP_IDS', () => {
    expect(JOIN_STEP_IDS).toBe(ALL_STEP_IDS);
  });

  it('step ids are unique', () => {
    expect(new Set(ALL_STEP_IDS).size).toBe(ALL_STEP_IDS.length);
  });

  it('publish_binding precedes boot_federate which precedes await_admission_merge (federation ordering invariant)', () => {
    const idx = (id: JoinStepId) => ALL_STEP_IDS.indexOf(id);
    expect(idx('publish_binding')).toBeLessThan(idx('boot_federate'));
    expect(idx('boot_federate')).toBeLessThan(idx('await_admission_merge'));
    expect(idx('await_admission_merge')).toBeLessThan(idx('route_insights'));
  });
});
