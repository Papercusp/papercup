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
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
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

/**
 * P-005 (D-004): the gate's ready-to-verify path verifies the repair head AT ITS OWN SHA. The
 * queue decision above can only name the sha; whether the gate then re-runs the signature at
 * that sha or at the tip lives in apps/operator/lib/release/green-checkpoint.ts, which this
 * package cannot import — so the property is pinned at the SOURCE level, the way the doc-claims
 * suite pins CLAUDE.md's gate claims. Written as a falsifier first: on the pre-P-005 tree the
 * verify-repair branch called `proveFrozenRepairOutcomeAtStableTip`, whose deps Pick named
 * `resolveTip` and whose `full-suite-required` / `proved` arms re-cut the gate at the tip — every
 * assertion below was red there.
 */
// lib/release → lib → operator-core → packages → <repo root>
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const GATE_SOURCE = readFileSync(join(REPO_ROOT, 'apps/operator/lib/release/green-checkpoint.ts'), 'utf8');

describe('the ready-to-verify path verifies the repair head at its own sha, never the tip (P-005)', () => {
  it('the tip-proving predecessor is neither declared nor called', () => {
    // Prose mentions in docblocks are allowed (they explain what was retired and why); a
    // declaration or a call is not.
    expect(GATE_SOURCE).not.toMatch(/(?:function|await)\s+proveFrozenRepairOutcomeAtStableTip\s*\(/);
    expect(GATE_SOURCE).not.toContain('kind: "full-suite-required"');
    expect(GATE_SOURCE).not.toContain('kind: "tip-moved"');
    expect(GATE_SOURCE).not.toContain('kind: "proved"');
  });

  it('the verification deps Pick names the ref-taking runners and NO tip resolver (structural)', () => {
    const declaration = /export type RepairHeadVerificationDeps = Pick<\s*CheckpointDeps,\s*([^>]+)>/.exec(GATE_SOURCE);
    expect(declaration, 'RepairHeadVerificationDeps must be a Pick over CheckpointDeps').not.toBeNull();
    const keys = declaration![1]!
      .split('|')
      .map((key) => key.trim().replace(/^"|"$/g, ''))
      .filter(Boolean);
    expect(keys).toEqual(expect.arrayContaining(['runTestsAtRef', 'runGateAtRef', 'affectedTestsAtRef']));
    expect(keys).not.toContain('resolveTip');
  });

  it('the verify-repair branch hands verifyRepairHead the queue and never names the tip', () => {
    const start = GATE_SOURCE.indexOf('decision.kind === "verify-repair"');
    expect(start, 'the verify-repair branch must exist').toBeGreaterThan(-1);
    const rest = GATE_SOURCE.slice(start);
    const end = rest.indexOf('// QUIET CUT');
    expect(end, 'the quiet-cut block must follow the branch').toBeGreaterThan(-1);
    const branch = rest.slice(0, end);
    expect(branch).toContain('await verifyRepairHead(deps, repairQueue)');
    expect(branch).not.toMatch(/resolveTip|integrationBranch|transportedCandidate|stagingContainsFrozenRepair/);
    // A red re-queues from the repair head that was just tested; nothing on this path retires
    // the queue (`writeFrozenRepairQueue(null)`) or steps the candidate anywhere else.
    expect(branch).toContain('markFrozenRepairVerificationRed(repairQueue');
    expect(branch).not.toContain('writeFrozenRepairQueue?.(null)');
  });

  it('every runner call inside verifyRepairHead passes the repair head', () => {
    const start = GATE_SOURCE.indexOf('export async function verifyRepairHead(');
    expect(start).toBeGreaterThan(-1);
    const rest = GATE_SOURCE.slice(start);
    const body = rest.slice(0, rest.indexOf('\n}\n') + 3);
    const runnerCalls = [...body.matchAll(/deps\s*\.\s*(runTestsAtRef|runGateAtRef|affectedTestsAtRef)!?\s*\(\s*(\w+)/g)];
    expect(runnerCalls.length).toBeGreaterThanOrEqual(3);
    for (const call of runnerCalls) {
      expect(call[2], `${call[1]} must be called at the repair head`).toBe('head');
    }
    expect(body).toContain('const head = queue.repairHead;');
    expect(body).not.toMatch(/resolveTip|integrationBranch/);
  });
});
