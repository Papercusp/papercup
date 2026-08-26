/**
 * Recurrence tests for the canonical trial identity (P-004).
 *
 * The property under test is the one P-001 (WI-41656) found missing across the
 * LLM-eval family: a stored verdict must be BOUND to its subject, so it can be
 * reused when — and only when — the thing measured and the conditions it was
 * measured under are identical.
 *
 * The tests are organised around the failure directions, not the happy path:
 * a spurious SPLIT is acceptable (visible, recoverable), a spurious MERGE is not
 * (invisible, and it makes a broken comparison look sound).
 */
import { describe, expect, it } from 'vitest';

import type { TaskRunResult } from '@papercusp/bench-metrics';

import {
  trialFromHiveEvalRun,
  trialFromLlmTestRun,
  trialFromScorecard,
  trialFromTaskRunResult,
  type LlmTestRunRow,
} from './adapters';
import {
  EVALUATION_TRIAL_CONTRACT_VERSION,
  TRIAL_BINDING_FIELDS,
  areComparable,
  computeTrialIdentity,
  explainIncomparability,
} from './identity';
import type { EvaluationTrial } from './schema';
import type { HiveEvalRunRow, HiveEvalScoreRow } from '../pot-eval/store';
import type { RolloutRecord } from '../external-bench/reproducibility/schema';
import type { ScorecardRow } from '../scorecards';

function baseTrial(): EvaluationTrial {
  return {
    contractVersion: EVALUATION_TRIAL_CONTRACT_VERSION,
    subject: { family: 'llm-testing', corpus: 'operator', taskId: 'su-S11', taskRevision: 'sc-hash' },
    system: {
      modelId: 'model-a',
      modelVersion: null,
      harnessVersion: 'h1',
      harnessGitSha: null,
      environmentFingerprint: null,
    },
    configuration: {
      configHash: 'cfg-1',
      seed: 1,
      arm: null,
      matrixIndex: 0,
      budgets: { tokens: null, usd: null, wallClockMs: null, agents: null, capped: false, breaches: [] },
    },
    grader: { kind: 'llm-judge', family: 'llm-testing', version: 'operator.abc123def456', judgeModel: 'judge-a' },
    outcome: { status: 'passed', resolved: true, score: null, infraFailure: false, errors: [] },
    usage: {
      tokensIn: null,
      tokensOut: null,
      tokensTotal: null,
      tokensCacheRead: null,
      tokensCacheWrite: null,
      costUsd: 1,
      priceTableVersion: null,
      wallClockMs: null,
      turns: null,
    },
    evidence: {
      trajectoryRef: 'traj',
      trajectoryKind: 'transcript-zstd',
      submissionRef: null,
      rawGraderOutputRef: null,
      artifactRefs: [],
      privacy: 'unclassified',
      contentHash: 'idh',
    },
    lineage: { runId: 'run-1', groupId: null, repeat: null, parentTrialKey: null, sourceRef: 'llm-testing:run-1' },
    startedAt: '2026-08-26T00:00:00.000Z',
    finishedAt: '2026-08-26T00:01:00.000Z',
  };
}

describe('computeTrialIdentity — determinism', () => {
  it('does not depend on the order fields were assigned in', () => {
    const a = baseTrial();

    // Rebuild the same trial with the top-level groups inserted in reverse order.
    // A JSON.stringify-based hash would move here; a line-oriented one must not.
    const reordered = {} as Record<string, unknown>;
    const source = a as unknown as Record<string, unknown>;
    for (const key of Object.keys(source).reverse()) reordered[key] = source[key];

    expect(computeTrialIdentity(reordered as unknown as EvaluationTrial).bindingHash).toBe(
      computeTrialIdentity(a).bindingHash,
    );
  });

  it('produces a stable subject key and a full sha256 binding hash', () => {
    const id = computeTrialIdentity(baseTrial());
    expect(id.subjectKey).toBe('llm-testing/operator/su-S11@sc-hash');
    expect(id.bindingHash).toMatch(/^[0-9a-f]{64}$/);
    expect(id.trialKey).toBe(`${id.bindingHash.slice(0, 12)}:run-1`);
  });
});

describe('computeTrialIdentity — what binds and what does not', () => {
  it('moves the binding hash when ANY binding field changes', () => {
    const base = computeTrialIdentity(baseTrial()).bindingHash;
    const seen = new Set<string>([base]);

    for (const field of TRIAL_BINDING_FIELDS) {
      const trial = baseTrial();
      const segments = field.split('.');
      const leaf = segments.pop() as string;
      let cursor = trial as unknown as Record<string, unknown>;
      for (const segment of segments) cursor = cursor[segment] as Record<string, unknown>;
      cursor[leaf] = 'MUTATED';

      const moved = computeTrialIdentity(trial).bindingHash;
      expect(moved, `changing ${field} must move the binding hash`).not.toBe(base);
      expect(seen.has(moved), `changing ${field} collided with another binding`).toBe(false);
      seen.add(moved);
    }
  });

  it('does NOT move the binding hash when the measurement changes', () => {
    const base = computeTrialIdentity(baseTrial()).bindingHash;

    const differentOutcome = baseTrial();
    differentOutcome.outcome = { status: 'failed', resolved: false, score: 0, infraFailure: false, errors: ['x'] };
    differentOutcome.usage.costUsd = 999;
    differentOutcome.evidence.trajectoryRef = 'other-traj';
    differentOutcome.lineage.runId = 'run-2';
    differentOutcome.finishedAt = '2027-01-01T00:00:00.000Z';

    expect(computeTrialIdentity(differentOutcome).bindingHash).toBe(base);
  });
});

describe('computeTrialIdentity — unrecorded vs recorded-absent', () => {
  it('marks a trial incomplete and names the field when a binding is unrecorded', () => {
    const trial = baseTrial();
    trial.system.harnessVersion = undefined;

    const id = computeTrialIdentity(trial);
    expect(id.bindingComplete).toBe(false);
    expect(id.missingBindings).toEqual(['system.harnessVersion']);
  });

  it('stays complete when a binding is RECORDED as absent', () => {
    const trial = baseTrial();
    trial.system.harnessGitSha = null;

    const id = computeTrialIdentity(trial);
    expect(id.bindingComplete).toBe(true);
    expect(id.missingBindings).toEqual([]);
  });

  it('hashes unrecorded and recorded-absent DIFFERENTLY', () => {
    // The load-bearing case. If these collided, a family that stopped recording a
    // field would silently keep matching rows that recorded it as absent.
    const unrecorded = baseTrial();
    unrecorded.system.harnessGitSha = undefined;
    const recordedAbsent = baseTrial();
    recordedAbsent.system.harnessGitSha = null;

    expect(computeTrialIdentity(unrecorded).bindingHash).not.toBe(
      computeTrialIdentity(recordedAbsent).bindingHash,
    );
  });

  it('CONTROL: the naive implementation this distinction replaces really does collide', () => {
    // A guard that has never been shown to fail is a guard nobody has tested. The
    // obvious implementation — treat "not recorded" as "absent" — is written out
    // here as a deliberately-wrong control and shown to produce the exact silent
    // merge the real implementation prevents. Keeping the control in the test file
    // (rather than mutating the module) is the repo's tier-2 discipline: no shared
    // file is ever left mutated, so a git-sync sweep cannot commit the mutant.
    const collapseUndefinedToNull = (trial: EvaluationTrial): string =>
      TRIAL_BINDING_FIELDS.map((field) => {
        let cursor: unknown = trial;
        for (const segment of field.split('.')) {
          cursor = (cursor as Record<string, unknown> | null | undefined)?.[segment];
        }
        return `${field}=${cursor ?? 'ABSENT'}`;
      }).join('\n');

    const unrecorded = baseTrial();
    unrecorded.system.harnessGitSha = undefined;
    const recordedAbsent = baseTrial();
    recordedAbsent.system.harnessGitSha = null;

    // The wrong implementation cannot tell them apart...
    expect(collapseUndefinedToNull(unrecorded)).toBe(collapseUndefinedToNull(recordedAbsent));
    // ...and the real one can. Both halves are asserted so a future change that
    // silently reintroduces the collapse fails here rather than passing quietly.
    expect(computeTrialIdentity(unrecorded).bindingHash).not.toBe(
      computeTrialIdentity(recordedAbsent).bindingHash,
    );
  });
});

describe('areComparable — fails toward split, never toward merge', () => {
  it('accepts two complete identities with identical bindings', () => {
    const a = computeTrialIdentity(baseTrial());
    const b = baseTrial();
    b.lineage.runId = 'run-2';
    b.outcome.status = 'failed';

    expect(areComparable(a, computeTrialIdentity(b))).toBe(true);
    expect(explainIncomparability(a, computeTrialIdentity(b))).toBeNull();
  });

  it('REFUSES two incomplete identities even when their hashes match exactly', () => {
    // Two trials that both fail to record their harness version are not thereby
    // known to share one. Pooling them is the silent merge this contract exists
    // to prevent, so an equal hash is not enough.
    const one = baseTrial();
    one.system.harnessVersion = undefined;
    const two = baseTrial();
    two.system.harnessVersion = undefined;

    const idOne = computeTrialIdentity(one);
    const idTwo = computeTrialIdentity(two);

    expect(idOne.bindingHash).toBe(idTwo.bindingHash);
    expect(areComparable(idOne, idTwo)).toBe(false);
    expect(explainIncomparability(idOne, idTwo)).toContain('system.harnessVersion');
  });

  it('refuses complete identities whose bindings differ, and says so', () => {
    const a = computeTrialIdentity(baseTrial());
    const other = baseTrial();
    other.system.modelId = 'model-b';

    const explanation = explainIncomparability(a, computeTrialIdentity(other));
    expect(areComparable(a, computeTrialIdentity(other))).toBe(false);
    expect(explanation).toContain('binding hashes differ');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Adapters — each family projects in, and its real gaps stay visible
// ───────────────────────────────────────────────────────────────────────────

function llmRow(over: Partial<LlmTestRunRow> = {}): LlmTestRunRow {
  return {
    id: 'run-uuid',
    scenario_id: 'su-S11',
    scenario_version: 2,
    scenario_target: 'operator',
    scenario_hash: 'sc-hash',
    identity_hash: 'idh',
    matrix_group_id: null,
    matrix_index: 0,
    rubric_version: 'operator.abc123def456',
    sut_model: 'model-a',
    judge_model: 'judge-a',
    persona_id: 'p1',
    persona_traits_json: { terse: true },
    workspace_mode: 'sealed',
    transport_mode: 'sse',
    status: 'passed',
    started_at: new Date('2026-08-26T00:00:00.000Z'),
    finished_at: new Date('2026-08-26T00:01:00.000Z'),
    cost_usd: '1.25',
    cap_breaches: [],
    ...over,
  };
}

function benchRow(over: Partial<TaskRunResult> = {}): TaskRunResult {
  return {
    runId: 'run-1',
    suite: 'swe-bench-pro',
    modality: 'diff',
    taskId: 'task-1',
    arm: 'papercusp' as TaskRunResult['arm'],
    seed: 3,
    resolved: true,
    graderStatus: 'passed',
    graderFamily: 'swebench-official',
    graderVersion: '2.0',
    score: null,
    tokensIn: 10,
    tokensOut: 20,
    tokensTotal: 30,
    costUsd: 0.5,
    priceTableVersion: 'price-table-v1',
    wallClockMs: 1_000,
    turns: 7,
    capped: false,
    generationStatus: 'completed',
    modelId: 'model-a',
    harnessVersion: 'h1',
    preregHash: 'prereg-abc',
    rolloutId: 'rollout-1',
    createdAt: '2026-08-26T00:00:00.000Z',
    ...over,
  };
}

describe('adapters', () => {
  it('stamp the derived contract version rather than a literal', () => {
    expect(trialFromLlmTestRun(llmRow()).contractVersion).toBe(EVALUATION_TRIAL_CONTRACT_VERSION);
    expect(trialFromTaskRunResult(benchRow()).contractVersion).toBe(EVALUATION_TRIAL_CONTRACT_VERSION);
  });

  it('llm-testing binds on the scenario hash it already records, and names the gaps it does not', () => {
    const trial = trialFromLlmTestRun(llmRow());
    expect(trial.subject.taskRevision).toBe('sc-hash');
    expect(trial.grader.version).toBe('operator.abc123def456');

    // P-001's finding, made mechanical: this family cannot re-derive its verdict,
    // and it does not yet record the harness it ran at or its seed.
    const id = computeTrialIdentity(trial);
    expect(id.bindingComplete).toBe(false);
    expect(id.missingBindings).toEqual([
      'configuration.seed',
      'system.environmentFingerprint',
      'system.harnessGitSha',
      'system.harnessVersion',
      'system.modelVersion',
    ]);
  });

  it('llm-testing trials with the same scenario hash but different SUT models are not comparable', () => {
    const a = computeTrialIdentity(trialFromLlmTestRun(llmRow({ sut_model: 'model-a' })));
    const b = computeTrialIdentity(trialFromLlmTestRun(llmRow({ sut_model: 'model-b' })));
    expect(a.bindingHash).not.toBe(b.bindingHash);
  });

  it('external-bench records more once the Rollout Card is supplied', () => {
    const withoutCard = computeTrialIdentity(trialFromTaskRunResult(benchRow()));
    expect(withoutCard.missingBindings).toEqual([
      'configuration.configHash',
      'system.environmentFingerprint',
      'system.harnessGitSha',
      'system.modelVersion',
    ]);

    const card = {
      rolloutId: 'rollout-1',
      runId: 'run-1',
      preregHash: 'prereg-abc',
      suite: 'swe-bench-pro',
      taskId: 'task-1',
      arm: 'papercusp',
      seed: 3,
      configSnapshot: { temperature: 0 },
      modelId: 'model-a',
      modelVersion: '2026-08-01',
      harnessVersion: 'h1',
      harnessGitSha: 'a'.repeat(40),
      envFingerprint: { node: '22' },
      graderFamily: 'swebench-official',
      graderVersion: '2.0',
      createdAt: '2026-08-26T00:00:00.000Z',
    } as RolloutRecord;

    const withCard = computeTrialIdentity(trialFromTaskRunResult(benchRow(), card));
    expect(withCard.bindingComplete).toBe(true);
    expect(withCard.bindingHash).not.toBe(withoutCard.bindingHash);
  });

  it('an infra failure is not recorded as a genuine fail', () => {
    const trial = trialFromTaskRunResult(benchRow({ generationStatus: 'timeout', resolved: null }));
    expect(trial.outcome.status).toBe('timeout');
    expect(trial.outcome.infraFailure).toBe(true);
    expect(trial.outcome.resolved).toBeNull();
  });

  it('pot-eval reports that it records no model identity for what it measured', () => {
    const run: HiveEvalRunRow = {
      runId: 'hive-run-1',
      instanceId: 'inst-1',
      scenarioId: 'scenario-1',
      shape: 'wide' as HiveEvalRunRow['shape'],
      repeat: 0,
      seed: 7,
      budgetUsdCap: 10,
      beeCap: 4,
      startedAt: new Date('2026-08-26T00:00:00.000Z'),
      finishedAt: new Date('2026-08-26T00:10:00.000Z'),
      observations: {
        terminalState: 'drained',
        wallClockMs: 600_000,
        frontierDrained: true,
        workItemsTotal: 5,
        workItemsCompleted: 5,
        costUsd: 2,
      },
    };
    const score = {
      runId: 'hive-run-1',
      rubricHash: 'rh',
      rubricVersion: 'hive.v1',
      outcomeGatePassed: true,
      efficiencyScore: 1,
      speedScore: 1,
      composite: 9,
      regressions: false,
      plantedBugCaught: true,
      fabricationDetected: false,
      criticalPathRatio: 1,
      floorCeiling: 10,
      detail: {},
    } as HiveEvalScoreRow;

    const id = computeTrialIdentity(trialFromHiveEvalRun(run, score));
    expect(id.bindingComplete).toBe(false);
    expect(id.missingBindings).toContain('system.modelId');
    expect(id.missingBindings).toContain('subject.taskRevision');
  });

  it('scorecard projects its recorded rubric revision into the grader binding', () => {
    // The writer records the plan-row revision at emit time. The adapter must
    // preserve it as the grader version, while legacy rows remain unrecorded.
    const card = {
      issueId: 'EI-1',
      createdAt: '2026-08-26T00:00:00.000Z',
      createdBy: 'su-1',
      subject: { ref: 'plan-x', kind: 'plan' as const },
      rubricRef: 'plan-class-feature-ship',
      rubricRevision: 7,
      ratings: {},
      nKeys: 3,
      missingKeys: [],
      extraKeys: [],
      rubricResolved: true,
      evidenceFingerprint: 'ev-fp',
      synthesized: false,
      score10: 8,
      linkedItems: [],
    } as unknown as ScorecardRow;

    const trial = trialFromScorecard(card);
    expect(trial.subject.taskRevision).toBe('ev-fp');
    expect(trial.grader.version).toBe('7');
    expect(trial.outcome.score).toBe(0.8);

    const id = computeTrialIdentity(trial);
    expect(id.bindingComplete).toBe(false);
    expect(id.missingBindings).not.toContain('grader.version');

    const legacyId = computeTrialIdentity(trialFromScorecard({ ...card, rubricRevision: undefined }));
    expect(legacyId.missingBindings).toContain('grader.version');
  });

  it('classifies evidence privacy as unclassified rather than guessing', () => {
    // No eval surface in the tree records a privacy classification today. The
    // adapters say so explicitly; the day one starts recording it, only the
    // adapter changes.
    expect(trialFromLlmTestRun(llmRow()).evidence.privacy).toBe('unclassified');
    expect(trialFromTaskRunResult(benchRow()).evidence.privacy).toBe('unclassified');
  });
});
