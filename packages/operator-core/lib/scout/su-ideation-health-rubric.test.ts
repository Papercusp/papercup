/**
 * su-ideation-health-rubric tests (su-ideate-learning-substrate-2026-07-10 P-013).
 * Pins the PROPOSED rubric spec (the four named criteria) and the D-012 PARITY guard:
 * the emitter emits status:'proposed' ONLY — it never self-ratifies to 'active'
 * (ratification stays owner/Mug via rubrics:ratify). Hermetic + $0 (injected propose port).
 */
import { describe, it, expect, vi } from 'vitest';
import {
  SU_IDEATION_HEALTH_RUBRIC_ID,
  SU_IDEATION_HEALTH_CHARACTERISTIC,
  SU_IDEATION_HEALTH_CRITERIA,
  SU_IDEATION_HEALTH_RUBRIC,
  proposeSuIdeationHealthRubric,
  type ProposeSuIdeationHealthDeps,
} from './su-ideation-health-rubric';
import type { Rubric, ProposeRubricInput } from '../rubrics';

const EXPECTED_KEYS = ['pass-cadence', 'outcome-read-freshness', 'grade-loop-latency', 'lens-diversity'];

/** An injected propose port: a spy that records the exact input it was handed. */
function makeDeps(): { deps: ProposeSuIdeationHealthDeps; calls: ProposeRubricInput[] } {
  const calls: ProposeRubricInput[] = [];
  const deps: ProposeSuIdeationHealthDeps = {
    propose: vi.fn(async (input: ProposeRubricInput) => {
      calls.push(input);
      return { rubricId: input.rubricId, status: input.status ?? 'proposed' } as Rubric;
    }),
  };
  return { deps, calls };
}

describe('su-ideation-health rubric spec', () => {
  it('declares exactly the four named criteria, in order, with stable keys', () => {
    expect(SU_IDEATION_HEALTH_CRITERIA.map((c) => c.key)).toEqual(EXPECTED_KEYS);
  });

  it('every criterion is well-formed (non-empty title / model / method / driftMarkers)', () => {
    for (const c of SU_IDEATION_HEALTH_CRITERIA) {
      expect(c.key.length).toBeGreaterThan(0);
      expect(c.title.trim().length).toBeGreaterThan(0);
      expect(c.model.trim().length).toBeGreaterThan(0);
      expect(c.method.trim().length).toBeGreaterThan(0);
      expect(c.driftMarkers.trim().length).toBeGreaterThan(0);
    }
  });

  it('the proposal input carries the id + characteristic and pre-sets NO status', () => {
    expect(SU_IDEATION_HEALTH_RUBRIC.rubricId).toBe(SU_IDEATION_HEALTH_RUBRIC_ID);
    expect(SU_IDEATION_HEALTH_RUBRIC.characteristic).toBe(SU_IDEATION_HEALTH_CHARACTERISTIC);
    expect(SU_IDEATION_HEALTH_RUBRIC.status).toBeUndefined();
    expect(SU_IDEATION_HEALTH_RUBRIC.criteria).toHaveLength(4);
  });
});

describe('proposeSuIdeationHealthRubric — emit the proposal only (D-012 parity)', () => {
  it('emits with status "proposed" — never self-ratifies to active', async () => {
    const { deps, calls } = makeDeps();
    await proposeSuIdeationHealthRubric({}, deps);
    expect(deps.propose).toHaveBeenCalledTimes(1);
    expect(calls[0].status).toBe('proposed');
    expect(calls[0].rubricId).toBe(SU_IDEATION_HEALTH_RUBRIC_ID);
    expect(calls[0].criteria.map((c) => c.key)).toEqual(EXPECTED_KEYS);
  });

  it('threads the proposer ownerId (by) through, still as a proposal', async () => {
    const { deps, calls } = makeDeps();
    await proposeSuIdeationHealthRubric({ by: 'su-01293' }, deps);
    expect(calls[0].by).toBe('su-01293');
    expect(calls[0].status).toBe('proposed');
  });
});
