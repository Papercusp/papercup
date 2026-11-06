/** Declaration/router coverage only; behavior receipts belong to their owning criteria. */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { assertCriterionCheckPathsResolve, validateCriterionTestCaseCitations } from '../rubrics-criterion-checks';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const prefix = 'packages/operator-core/lib/';
const rows = [
  ['manual-launch', 'release-checkpoint-launch.test.ts', 'targets the manual unit, sets no run-level wall clock, and runs the green-checkpoint CLI in the tree root'],
  ['deadline-representation', 'release-checkpoint-launch.test.ts', 'drops inherited request deadlines and clears any deadline in the service environment'],
  ['former-horizon', 'release/checkpoint-qualification-command.test.ts', 'owns lifetime beyond the old timer horizon despite request deadline 900'],
  ['cancellation', 'release/checkpoint-qualification-command.test.ts', 'keeps explicit cancellation and verified child release after multiple owned timer horizons'],
  ['worker-guard', 'release/checkpoint-qualification-command.test.ts', 'retains independent owned worker timeout (hard=true)'],
  ['clock-horizon', '__tests__/batch-watchdog.test.ts', 'keeps owned lifetime running beyond repeated Node timer horizons, with independent late worker bounds'],
  ['quiet-unknown-and-declared-advance', 'release/checkpoint-qualification-stalled-process.integration.test.ts', 'quiet live work retains unknown custody across the stall horizon and records only declared semantic completion'],
  ['chatter', 'release/checkpoint-qualification-stalled-process.integration.test.ts', 'bounds chatty while a healthy peer completes'],
  ['blocked-controller', 'release/checkpoint-qualification-stalled-process.integration.test.ts', 'bounds blocked-controller while a healthy peer completes'],
  ['irrelevant-counter', 'release/checkpoint-qualification-runner-liveness.test.ts', 'irrelevant-counter cannot renew useful progress'],
  ['spin', 'release/checkpoint-qualification-runner-liveness.test.ts', 'chatter-spin cannot renew useful progress'],
  ['observer-restart', 'release/checkpoint-qualification-runner-liveness.test.ts', 'observer-partition-restart requires two fresh healthy observations'],
  ['stale-sample', 'release/checkpoint-qualification-runner-liveness.test.ts', 'stale-sample-replay and non-increasing monotonic samples are rejected'],
  ['stale-attempt', 'release/checkpoint-qualification-runner-liveness.test.ts', 'phase-progress-fence: rejects an old attempt probe'],
  ['observer-failure', 'release/lost-gate-run-alarm.test.ts', 'observer-partition-restart: a failed probe is persisted and alarmed without a retry'],
  ['lease-expiry', 'release/checkpoint-qualification-runner-liveness.test.ts', 'does not treat an expired lease as proof that an unknown runner is dead'],
  ['failed-cleanup', 'release/checkpoint-qualification-command.test.ts', 'retains custody when scope death is unknown, even after a zero exit'],
  ['pid-scope-reuse', 'release/checkpoint-qualification-process.integration.test.ts', 'pid-scope-reuse: a real replacement under the same unit rejects the predecessor fence'],
  ['partial-scope-read', 'release/checkpoint-qualification-process.integration.test.ts', 'partial-scope-read: an unreadable enrolled sibling retains custody despite a dead parent scope'],
  ['durable-before-ack', 'release/checkpoint-qualification-terminal-outcomes.integration.test.ts', 'durable-before-ack: terminal replay preserves the frozen population and receipts'],
  ['after-ack', 'release/checkpoint-qualification-terminal-outcomes.integration.test.ts', 'after-ack: terminal replay preserves the frozen population and receipts'],
  ['delivered-before-receipt', 'release/checkpoint-qualification-terminal-outcomes.integration.test.ts', 'delivered-before-receipt: deployment stays uncertain and duplicate recovery does not repeat its effect'],
  ['frozen-composition', 'release/checkpoint-qualification-lifecycle.integration.test.ts', 'preserves a mixed durable failure frontier through runner death, replay and full composition'],
] as const;

it('every required qualification scenario has an exact maintained detector routed by grading', () => {
  const cases: { scenario: string; file: string; testName: string }[] = rows.map(
    ([scenario, file, testName]) => ({ scenario, file: prefix + file, testName }));
  for (const cause of ['no-output', 'dead-executor', 'deadline', 'restart', 'orphan']) {
    for (const liveness of ['live', 'unknown', 'dead']) cases.push({ scenario: `dbos-${cause}-${liveness}`,
      file: prefix + 'dbos/dbos-executor-reaper-queue-liveness.integration.test.ts',
      testName: `checks confined payload custody before ${cause} reaping: ${liveness}` });
  }
  for (const [scenario, testName] of [
    ['setup', 'WI-5610: quiet setup survives former idle/aggregate caps; explicit bounds still apply'],
    ['materialization', 'WI-5610: quiet writer wait + copy has neither a silence-only nor aggregate cap'],
    ['rescue-confirmation', 'retains rescue process-group cleanup without default aggregate or output-idle cancellation'],
  ]) cases.push({ scenario, file: 'apps/operator/lib/release/green-checkpoint.test.ts', testName });
  cases.push({ scenario: 'scheduled-execution', file: 'apps/operator/lib/release/green-checkpoint-qualification-execution.test.ts',
    testName: 'has no run-level wall clock without a transported deadline (WI-6554700010042457)' });
  expect(new Set(cases.map(row => row.scenario)).size).toBe(cases.length);
  const check = { kind: 'tests' as const, files: [...new Set(cases.map(row => row.file))],
    cases: cases.map(({ file, testName }) => ({ file, testName })) };
  const criteria = [{ key: 'qualification-detectors', check }];
  const validated = assertCriterionCheckPathsResolve(criteria, { root });
  expect(validated).toMatchObject({ ok: true, failures: [], scopeFailures: [], planned: [] });
  expect(validated.normalizedByKey['qualification-detectors']).toEqual(check.files);
  // A renamed case must fail even when its file is still runnable.
  const missing = [{ key: 'qualification-detectors', check: { ...check,
    cases: [{ file: check.files[0]!, testName: 'removed qualification detector negative control' }] } }];
  expect(validateCriterionTestCaseCitations(missing, validated)).toHaveLength(1);
});
