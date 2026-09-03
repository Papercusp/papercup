/**
 * P-013(b) (frozen-candidate-stays-frozen-through-all-fixes-2026-09-03, D-003/D-005):
 * while a repair queue row exists in ANY phase, the gate's decision never judges the moving
 * integration tip — the candidate it names is always the frozen candidate or its repairHead,
 * and it never asks for a re-cut.
 *
 * Written as a falsifier FIRST: on the pre-plan code an exhausted queue under the default
 * limits yields `recut-at-tip` (P-048's escape hatch), which this file refuses. D-005 deletes
 * that hatch; until P-009 removes the decision kind from the union this guard is the thing
 * that keeps it unreachable. The resolver-level structural guard (green-checkpoint.ts never
 * calling `revParse(cfg.integrationBranch)` while a queue row exists) lands with P-009.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FROZEN_REPAIR_QUEUE_LIMITS,
  FROZEN_REPAIR_ZERO_ATTEMPT_STALL_MS,
  decideFrozenCandidateRepairQueue,
  type FrozenCandidateRepairPhase,
  type FrozenCandidateRepairQueue,
  type FrozenRepairQueueObservation,
} from './frozen-candidate-repair-queue';

const C = '1111111111111111111111111111111111111111';
const R = '2222222222222222222222222222222222222222';
const T0 = 1_800_000_000_000;
const { maxAgeMs, maxAttempts } = DEFAULT_FROZEN_REPAIR_QUEUE_LIMITS;

const PHASES: FrozenCandidateRepairPhase[] = ['ready-to-test', 'awaiting-fixer', 'ready-to-verify', 'ready-to-promote', 'blocked'];

function row(phase: FrozenCandidateRepairPhase, overrides: Partial<FrozenCandidateRepairQueue> = {}): FrozenCandidateRepairQueue {
  const base: FrozenCandidateRepairQueue = {
    schemaVersion: 3,
    phase,
    candidate: C,
    base: null,
    repairHead: phase === 'ready-to-test' ? C : R,
    worktreePath: '/repo/.papercusp/worktrees/green-candidate-11111111',
    attempts: phase === 'ready-to-test' ? 0 : 1,
    openedAtMs: T0,
    updatedAtMs: T0,
    fixerSpawnId: phase === 'ready-to-verify' || phase === 'ready-to-promote' ? 'spawn-1' : null,
    failingTests: ['lib/a.test.ts'],
    ...(phase === 'blocked' ? { blockedReason: 'attempts-exhausted' as const } : {}),
  };
  return { ...base, ...overrides };
}

/** Every observation shape that has ever produced an exhaustion or a re-cut, plus the calm ones. */
const OBSERVATIONS: Array<{ label: string; obs: FrozenRepairQueueObservation }> = [
  { label: 'fresh', obs: { nowMs: T0 + 1 } },
  { label: 'fixer dead', obs: { nowMs: T0 + 1, fixerAlive: false } },
  { label: 'fixer alive', obs: { nowMs: T0 + 1, fixerAlive: true } },
  { label: 'wall clock exhausted', obs: { nowMs: T0 + maxAgeMs + 1 } },
  { label: 'wall clock exhausted, fixer dead', obs: { nowMs: T0 + maxAgeMs + 1, fixerAlive: false } },
  { label: 'dispatch infeasible after the stall window', obs: { nowMs: T0 + FROZEN_REPAIR_ZERO_ATTEMPT_STALL_MS + 1, dispatchFeasible: false } },
  { label: 'staging contains the repair', obs: { nowMs: T0 + 1, stagingContainsRepair: true } },
  { label: 'staging lacks the repair', obs: { nowMs: T0 + 1, stagingContainsRepair: false } },
  // A stale caller still passing the deleted P-048 budget observation: ignored, never honoured.
  { label: 'stale priorEscapes observation', obs: { nowMs: T0 + maxAgeMs + 1, priorEscapes: 0 } as unknown as FrozenRepairQueueObservation },
];

const ROW_VARIANTS: Array<{ label: string; make: (phase: FrozenCandidateRepairPhase) => FrozenCandidateRepairQueue }> = [
  { label: 'as-is', make: (p) => row(p) },
  { label: 'attempts exhausted, fixer named', make: (p) => row(p, { attempts: maxAttempts, fixerSpawnId: 'spawn-x' }) },
  { label: 'attempts exhausted, unassigned', make: (p) => row(p, { attempts: maxAttempts, fixerSpawnId: null }) },
  { label: 'zero attempts, unassigned', make: (p) => row(p, { attempts: 0, fixerSpawnId: null }) },
  { label: 'blocked on wall clock', make: (p) => row(p, p === 'blocked' ? { blockedReason: 'wall-clock-exhausted' } : {}) },
];

const TIP_JUDGING_KINDS = new Set(['run-normal-gate', 'recut-at-tip']);

describe('a queue row in any phase never lets the gate judge the tip (P-013(b))', () => {
  for (const phase of PHASES) {
    for (const variant of ROW_VARIANTS) {
      for (const { label, obs } of OBSERVATIONS) {
        it(`${phase} / ${variant.label} / ${label}`, () => {
          const queue = variant.make(phase);
          const decision = decideFrozenCandidateRepairQueue(queue, obs);
          expect(TIP_JUDGING_KINDS.has(decision.kind), `decision ${decision.kind} judges the tip`).toBe(false);
          if ('candidate' in decision && typeof decision.candidate === 'string') {
            expect([queue.candidate, queue.repairHead]).toContain(decision.candidate);
          }
          if ('repairHead' in decision && typeof decision.repairHead === 'string') {
            expect(decision.repairHead).toBe(queue.repairHead);
          }
          if ('abandonedCandidate' in decision) {
            throw new Error(`decision ${decision.kind} abandons the frozen candidate`);
          }
        });
      }
    }
  }

  it('the limits carry NO candidate-escape budget at all (D-005: the P-048 hatch is deleted, not zeroed)', () => {
    // A zeroed budget would be a switch someone could flip back on; the field's ABSENCE is
    // the property. A stray value on a stale caller's limits object is ignored, never honoured.
    expect(DEFAULT_FROZEN_REPAIR_QUEUE_LIMITS).not.toHaveProperty('maxCandidateEscapes');
    expect(Object.keys(DEFAULT_FROZEN_REPAIR_QUEUE_LIMITS).sort()).toEqual(['maxAgeMs', 'maxAttempts']);
  });

  it('no queue row at all is the ONLY input that judges the tip', () => {
    expect(decideFrozenCandidateRepairQueue(null, { nowMs: T0 })).toMatchObject({ kind: 'run-normal-gate' });
  });
});
