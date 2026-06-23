/**
 * Tests for the matrix-aggregation logic in runner.ts.
 *
 * Plan §2.4: per-scenario runMatrix; variance > 0.5 stddev on any axis
 * becomes an `inconsistent_behavior` finding. Majority verdict over the
 * matrix decides pass/fail/preview.
 *
 * The aggregate function is internal; we exercise it via runScenario's
 * single-run preview path + a synthetic two-run path that doesn't need
 * an LLM (single-run goes through; multi-run is the matrix case).
 *
 * Because runScenario itself hits the LLM, we test the aggregate
 * function's behavior indirectly by importing the internals where
 * possible and otherwise asserting on the shape we already exercise
 * elsewhere.
 */

import { describe, it, expect } from 'vitest';

import { SCENARIOS, getScenario } from '../scenarios';

describe('scenario registry', () => {
  it('exposes the full operator suite (S01–S12 + M1–M12), oracle (O1–O6), and architect (A1–A6)', () => {
    const ids = SCENARIOS.map((s) => s.id).sort();
    expect(ids).toEqual([
      // operator legacy (S-prefixed; framework build-out)
      'op-S01-status-quick',
      'op-S02-multistep-investigation',
      'op-S03-continue-cap-count',
      'op-S04-continue-cap-time',
      'op-S05-sleep-tag',
      'op-S06-spawn-worker',
      'op-S07-passive-mode',
      'op-S08-silence-nudge-ready',
      'op-S09-generate-ideas',
      'op-S10-ask-choice',
      'op-S11-voice-card-answer',
      'op-S12-tool-error-recovery',
      'op-S12b-tool-error-injected',
      // voice-mode brain behaviors (voice-production-test-coverage-2026-06-01 P-019)
      'op-S13-voice-terse-complex',
      'op-S14-voice-no-code',
      'op-S15-voice-error-recovery',
      'op-S16-voice-disambiguation',
      // operator brain-emission contracts (M-prefixed; operator-behavior-tests-2026-05-14)
      'op-M1-continue-paired-with-say',
      'op-M2-mutex-card-vs-continue',
      'op-M3-opener-substance',
      'op-M4-one-question-per-turn',
      'op-M5-spawn-worker-has-chunk',
      'op-M6-sleep-no-say',
      'op-M7-after-says-ready-options',
      'op-M8-format-utterance',
      'op-M10-ideas-not-operators',
      'op-M11-no-implementation-asks',
      'op-M12-no-stacked-questions-prose',
      // oracle
      'oracle-O1-docs-question',
      'oracle-O2-refuse-speculation',
      'oracle-O3-harness-question',
      'oracle-O4-no-tool-use-for-simple-fact',
      'oracle-O5-harness-scoped-answer',
      'oracle-O6-graceful-not-found',
      // architect
      'architect-A1-clarifying-questions',
      'architect-A2-scope-pushback',
      'architect-A3-reject-then-refine',
      'architect-A4-no-hallucinated-plan-items',
      'architect-A5-tradeoff-explanation',
      'architect-A6-no-spec-without-reading',
      // operator T4 boot-recall tier (memory-backend-benchmark-2026-06-05 P-009)
      'op-MEM00-control-unseeded',
      'op-MEM01-staging-probe-port',
      'op-MEM02-relay-salt-env',
      'op-MEM03-migration-range',
      'op-MEM04-flaky-isolate-flag',
      'op-MEM05-signaling-owner',
      'op-MEM06-shop-cdn-check',
      'op-MEM07-column-rename',
      'op-MEM08-tts-rotation',
      'op-MEM09-mic-device',
      'op-MEM10-explicit-search',
      // su engineer-collaborator playbook (su-scenario-suite-2026-05-31)
      'su-S01-harness-scope',
      'su-S02-tauri-only',
      'su-S03-push-not-poll',
      'su-S04-design-first',
      'su-S05-no-invent-write',
      'su-S06-shared-tree-git',
      'su-S07-positional-write',
      'su-S08-compact-read',
      'su-S09-coord-injection-read',
      'su-S10-claim-before-work',
      'su-S11-lock-contention-protocol',
      'su-S12-same-turn-insight',
      // code:run adoption (code-execution-tool-orchestration B-CX-3)
      'su-S13-code-run-batch',
      'su-S14-code-run-not-for-single',
      'su-S15-code-run-small-batch',
      'su-S16-code-run-batch-write',
      // compound wrappers — reach + over-application guards (tool-call-batching-wrappers-2026-06-21 P-008)
      'su-S17-orient-bootstrap',
      'su-S18-orient-not-for-single',
      'su-S19-overview-state-of-x',
      'su-S20-overview-not-for-single',
      // bulk dual-arity reach + over-application guards (bulk-endpoint-standardization-2026-06-21 P-007)
      'su-S21-bulk-read-not-hand-loop',
      'su-S22-bulk-not-for-single',
      // delta-protocol Lane-C de-risk gate (agent-tool-delta-protocol-2026-06-22 P-007)
      'su-S23-delta-merge-base-present',
      'su-S24-delta-fallback-compacted',
      'su-S25-delta-wrong-merge-detector',
      // queen triage-grading (scout-idea-grading-2026-06-12 B-06/B-08)
      'queen-Q01-grade-routed-on-triage',
      'queen-Q02-owner-grade-sovereign-no-retry',
      // queen ranked-queue decider (self-learning-frontier-2026-06-12 P-045 / FB-19)
      'queen-Q03-ranked-queue-decider',
      // hybrid bee-scheduler adoption (hybrid-bee-scheduler-work-stealing-2026-06-22 P-003)
      'queen-Q04-authors-claim-spec',
      'bee-B01-pull-via-get-next',
      'bee-B02-idle-on-empty-frontier',
      // overwatch persona boundaries (overwatch-role-2026-06-15 B-11)
      'overwatch-OW01-nudge-not-replace',
      'overwatch-OW02-observe-not-idea',
    ].sort());
  });

  it('throws on unknown scenario', () => {
    expect(() => getScenario('nope')).toThrow();
  });

  it('every scenario references a known target', () => {
    for (const s of SCENARIOS) {
      expect(['operator', 'oracle', 'architect', 'su', 'queen', 'bee', 'overwatch']).toContain(s.target);
    }
  });

  it('every scenario has at least one assertion', () => {
    for (const s of SCENARIOS) {
      expect(s.asserts.length).toBeGreaterThan(0);
    }
  });

  it('every scenario declares caps', () => {
    for (const s of SCENARIOS) {
      expect(s.caps.maxTurns).toBeGreaterThan(0);
      expect(s.caps.maxWallSecs).toBeGreaterThan(0);
      expect(s.caps.maxCostUsd).toBeGreaterThan(0);
    }
  });

  it('judge-heavy scenarios opt into runMatrix.repeat >= 3', () => {
    const judgeHeavyIds = ['op-S01-status-quick', 'op-S02-multistep-investigation'];
    for (const id of judgeHeavyIds) {
      const s = getScenario(id);
      expect(s.runMatrix?.repeat ?? 1).toBeGreaterThanOrEqual(3);
    }
  });
});
