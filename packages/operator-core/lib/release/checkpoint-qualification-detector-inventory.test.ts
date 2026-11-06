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
  ['quiet-progress', 'release/checkpoint-qualification-runner-liveness.test.ts', 'quiet-progress: only a new relevant selected completion renews useful progress'],
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
  ['pre-enrollment-crash', 'release/checkpoint-qualification-process.integration.test.ts', 'pre-enrollment-crash: a killed controller cannot fork before its enrollment commits'],
  ['returning-controller', 'release/checkpoint-qualification-process.integration.test.ts', 'returning-controller: delayed progress from a dead real controller cannot alter its successor'],
  ['pid-scope-reuse', 'release/checkpoint-qualification-process.integration.test.ts', 'pid-scope-reuse: a real replacement under the same unit rejects the predecessor fence'],
  ['partial-scope-read', 'release/checkpoint-qualification-process.integration.test.ts', 'partial-scope-read: an unreadable enrolled sibling retains custody despite a dead parent scope'],
  ['progress-before-stop', 'release/checkpoint-qualification-lifecycle.integration.test.ts', 'progress-before-stop: re-reads an advancing enrolled payload before a stale stop decision'],
  ['lease-live-child', 'release/checkpoint-qualification-transaction.test.ts', 'refuses a second runner even with an expired lease and live liveness'],
  ['lease-unknown-child', 'release/checkpoint-qualification-transaction.test.ts', 'refuses a second runner even with an expired lease and unknown liveness'],
  ['durable-before-ack', 'release/checkpoint-qualification-terminal-outcomes.integration.test.ts', 'durable-before-ack: terminal replay preserves the frozen population and receipts'],
  ['after-ack', 'release/checkpoint-qualification-terminal-outcomes.integration.test.ts', 'after-ack: terminal replay preserves the frozen population and receipts'],
  ['delivered-before-receipt', 'release/checkpoint-qualification-terminal-outcomes.integration.test.ts', 'delivered-before-receipt: deployment stays uncertain and duplicate recovery does not repeat its effect'],
  ['frozen-composition', 'release/checkpoint-qualification-lifecycle.integration.test.ts', 'preserves a mixed durable failure frontier through runner death, replay and full composition'],
  ['queue-continuation', 'release/checkpoint-qualification-lifecycle.integration.test.ts', 'executes only remaining eligible units after an unacknowledged callback interruption'],
  ['queue-durable-replacement', 'release/checkpoint-qualification-lifecycle.integration.test.ts', 'recovers exact pending test, guard and post-suite units from durable JSONB after runner replacement'],
  ['changed-proof-identity', 'release/checkpoint-qualification-transaction.test.ts', 'refuses selection, retry-policy, candidate, repair-head, and duplicate-completion changes'],
] as const;

// Independent population frozen by plan revision 30, Design's case-selector table.
// These are contract identities, not a population inferred from the available tests.
const frozenDesignSelectors = [
  'phase-progress-fence', 'irrelevant-counter', 'quiet-progress',
  'observer-partition-restart', 'stale-sample-replay', 'clock-rebase',
  'blocked-controller', 'chatter-spin', 'progress-before-stop', 'lease-live-child', 'failed-cleanup',
  'pre-enrollment-crash', 'pid-scope-reuse', 'returning-controller', 'partial-scope-read',
  'unlimited-generated-unit-env', 'manual-scheduled-ceilings',
  'unlimited-horizon-restart', 'retained-test-guard',
  'dbos-long-step', 'dbos-stalled', 'reaper-observer-race',
  'durable-before-ack', 'delivered-before-receipt', 'duplicate-recovery', 'changed-proof-identity',
  'full-matrix-composition', 'mismatched-artifact', 'inherited-obligation-still-open',
] as const;
const identities = ['attempt', 'candidate', 'repair', 'run', 'runner', 'pid', 'boot', 'scope',
  'phase', 'epoch', 'workspace', 'install'] as const;

it('every required qualification scenario has an exact maintained detector routed by grading', () => {
  const cases: { scenario: string; file: string; testName: string }[] = rows.map(
    ([scenario, file, testName]) => ({ scenario, file: prefix + file, testName }));
  for (const identity of identities) cases.push({ scenario: `identity-${identity}`,
    file: prefix + 'release/checkpoint-qualification-runner-liveness.test.ts',
    testName: `phase-progress-fence: rejects an old ${identity} probe` });
  for (const offset of [-60_000, 60_000, 200_000]) cases.push({ scenario: `clock-rebase-${offset}`,
    file: prefix + 'release/checkpoint-qualification-runner-liveness.test.ts',
    testName: `clock-rebase or missed pass (${offset}ms) demands a baseline` });
  for (const reason of ['admission-starved', 'admission-deferred']) {
    for (const completed of [0, 2]) cases.push({ scenario: `queue-${reason}-${completed}`,
      file: prefix + '__tests__/affected-tests-budgeted-scheduler.test.ts',
      testName: `retains settled shard evidence on ${reason}: ${completed} completed` });
    cases.push({ scenario: `queue-durable-${reason}`,
      file: prefix + 'release/checkpoint-qualification-lifecycle.integration.test.ts',
      testName: `retains durable receipt identities across ${reason} and resumes only unfinished units` });
  }
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
  // A selector's file may have moved since Design; bind its actual assertions.
  // R-7/R-8 deliberately require authoritative manual artifact/ledger comparisons.
  // Their registration here never constitutes passing deployed/live evidence.
  const crosswalk: Record<string, { scenarios?: string[]; manualBar?: string }> = {
    'phase-progress-fence': { scenarios: identities.map(identity => `identity-${identity}`) },
    'irrelevant-counter': { scenarios: ['irrelevant-counter'] },
    'quiet-progress': { scenarios: ['quiet-progress', 'quiet-unknown-and-declared-advance'] },
    'observer-partition-restart': { scenarios: ['observer-restart', 'observer-failure'] },
    'stale-sample-replay': { scenarios: ['stale-sample'] },
    'clock-rebase': { scenarios: [-60_000, 60_000, 200_000].map(offset => `clock-rebase-${offset}`) },
    'blocked-controller': { scenarios: ['blocked-controller'] },
    'chatter-spin': { scenarios: ['spin', 'chatter'] },
    'progress-before-stop': { scenarios: ['progress-before-stop'] },
    'lease-live-child': { scenarios: ['lease-live-child', 'lease-unknown-child', 'lease-expiry'] },
    'failed-cleanup': { scenarios: ['failed-cleanup'] },
    'pre-enrollment-crash': { scenarios: ['pre-enrollment-crash'] },
    'pid-scope-reuse': { scenarios: ['pid-scope-reuse'] },
    'returning-controller': { scenarios: ['returning-controller'] },
    'partial-scope-read': { scenarios: ['partial-scope-read'] },
    'unlimited-generated-unit-env': { scenarios: ['deadline-representation'] },
    'manual-scheduled-ceilings': { scenarios: ['manual-launch', 'scheduled-execution', 'setup', 'materialization', 'rescue-confirmation'] },
    'unlimited-horizon-restart': { scenarios: ['clock-horizon', 'former-horizon'] },
    'retained-test-guard': { scenarios: ['worker-guard', 'cancellation'] },
    'dbos-long-step': { scenarios: ['dbos-no-output-live', 'dbos-no-output-unknown'] },
    'dbos-stalled': { scenarios: ['dbos-no-output-dead'] },
    'reaper-observer-race': { scenarios: ['dbos-restart-live', 'dbos-restart-unknown', 'dbos-restart-dead'] },
    'durable-before-ack': { scenarios: ['durable-before-ack', 'after-ack'] },
    'delivered-before-receipt': { scenarios: ['delivered-before-receipt'] },
    'duplicate-recovery': { scenarios: ['delivered-before-receipt'] },
    'changed-proof-identity': { scenarios: ['changed-proof-identity'] },
    'full-matrix-composition': { scenarios: ['frozen-composition'] },
    'mismatched-artifact': { manualBar: 'R-7' },
    'inherited-obligation-still-open': { manualBar: 'R-8' },
  };
  expect(Object.keys(crosswalk).sort()).toEqual([...frozenDesignSelectors].sort());
  const registered = new Set(cases.map(row => row.scenario));
  for (const binding of Object.values(crosswalk)) {
    expect(Boolean(binding.manualBar)).not.toBe(Boolean(binding.scenarios?.length));
    if (binding.manualBar) expect(['R-7', 'R-8']).toContain(binding.manualBar);
    for (const scenario of binding.scenarios ?? []) expect(registered.has(scenario), scenario).toBe(true);
  }
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
