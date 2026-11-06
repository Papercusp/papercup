/** Real-plan replay grading uses the existing arm-blind grader port. The runner
 * prepares the isolated checkout and executes the task's frozen own tests; this
 * adapter validates its complete receipt before producing a benchmark grade.
 * Fixture receipts exercise this boundary, never establish trial performance. */
import { createHash } from 'node:crypto';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { ArmSubmission, BenchTask, GradeResult, OfficialGrader } from '../types';

export interface HarnessBenchTestResult {
  path: string;
  passed: number;
  failed: number;
  skipped: number;
  collectionFailed: boolean;
}

export interface HarnessBenchReceipt {
  instanceId: string;
  prefix: string;
  sourceCommit: string;
  graderCommit: string;
  submissionSha256: string;
  /** Real paths, measured by the runner rather than inferred from a task id. */
  checkoutRealpath: string;
  exitCode: number;
  tests: HarnessBenchTestResult[];
  rawOutput: string;
}

export interface HarnessBenchGraderConfig {
  version: string;
  sharedCheckoutRealpath: string;
  /** Task-owned trusted test material lives at graderCommit. Metadata uses the
   * existing graderMeta.testFiles and graderMeta.graderCommit fields. The runner
   * must restore those tests independently of the candidate patch and retain
   * their original results, including collection/finalization failures. */
  evaluate: (submission: Extract<ArmSubmission, { modality: 'diff' }>, task: BenchTask) => Promise<HarnessBenchReceipt>;
}

const commit = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const count = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const filePath = (value: unknown): value is string => typeof value === 'string' && value.length > 0 &&
  !isAbsolute(value) && !value.includes('\\') && !value.includes('\0') &&
  value.split('/').every(part => part !== '' && part !== '.' && part !== '..');
const isolated = (checkout: string, shared: string) => {
  if (!isAbsolute(checkout) || !isAbsolute(shared)) return false;
  const path = relative(resolve(shared), resolve(checkout));
  return path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path);
};

export function makeHarnessBenchGrader(config: HarnessBenchGraderConfig): OfficialGrader {
  if (!config.version.trim() || !isAbsolute(config.sharedCheckoutRealpath) || typeof config.evaluate !== 'function')
    throw new Error('harness-bench requires a version, shared realpath and task-owned test evaluator');
  return {
    family: 'harness-bench',
    modality: 'diff',
    async grade(submissions, tasks) {
      const taskIds = tasks.map(task => task.instanceId);
      const duplicateTasks = new Set(taskIds.filter((id, index) => taskIds.indexOf(id) !== index));
      const byId = new Map(tasks.map(task => [task.instanceId, task]));
      const usedCheckouts = new Set<string>();
      const grades: GradeResult[] = [];
      for (const submission of submissions) {
        let rawGraderOutput: unknown = { unmeasured: true };
        const grade: GradeResult = { instanceId: submission.instanceId, prefix: submission.prefix,
          resolved: false, rawGraderOutput, graderFamily: 'harness-bench', graderVersion: config.version };
        try {
          const task = byId.get(submission.instanceId);
          if (submission.modality !== 'diff' || !task || duplicateTasks.has(submission.instanceId) ||
              task.benchmark !== 'harness-bench' || !commit(task.baseCommit) ||
              !commit(task.graderMeta.graderCommit)) throw new Error('missing or ambiguous pinned replay task');
          const paths = task.graderMeta.testFiles;
          if (!Array.isArray(paths) || !paths.length || !paths.every(filePath) || new Set(paths).size !== paths.length)
            throw new Error('task own test files must be distinct repository-relative paths');
          const receipt = await config.evaluate(submission, task);
          rawGraderOutput = receipt;
          if (receipt.instanceId !== submission.instanceId || receipt.prefix !== submission.prefix ||
              receipt.sourceCommit !== task.baseCommit || receipt.graderCommit !== task.graderMeta.graderCommit ||
              receipt.submissionSha256 !== createHash('sha256').update(submission.patch).digest('hex'))
            throw new Error('replay receipt does not match the pinned task, grader and submission');
          if (typeof receipt.checkoutRealpath !== 'string' || !isolated(receipt.checkoutRealpath, config.sharedCheckoutRealpath))
            throw new Error('replay grader requires an isolated real checkout');
          const checkout = resolve(receipt.checkoutRealpath);
          if (usedCheckouts.has(checkout)) throw new Error('replay submissions reused a grader checkout');
          usedCheckouts.add(checkout);
          if (!Array.isArray(receipt.tests) || receipt.tests.length !== paths.length ||
              new Set(receipt.tests.map(test => test.path)).size !== paths.length ||
              receipt.tests.some(test => !paths.includes(test.path)))
            throw new Error('own-test receipt coverage differs from the frozen test population');
          if (typeof receipt.rawOutput !== 'string' || !receipt.rawOutput.trim() ||
              receipt.tests.some(test => ![test.passed, test.failed, test.skipped].every(count) ||
                test.collectionFailed !== false || test.passed + test.failed === 0 || test.skipped !== 0))
            throw new Error('own-test execution was incomplete, skipped or not measured');
          const failures = receipt.tests.reduce((sum, test) => sum + test.failed, 0);
          if ((failures === 0 && receipt.exitCode !== 0) || (failures > 0 && receipt.exitCode !== 1))
            throw new Error('own-test process exit contradicts the assertion verdict or failed to finalize');
          grade.resolved = failures === 0;
          grade.failToPass = receipt.tests.map(test => ({ test: test.path, passed: test.failed === 0 }));
        } catch (error) {
          grade.graderError = error instanceof Error ? error.message : String(error);
        }
        grade.rawGraderOutput = rawGraderOutput;
        grades.push(grade);
      }
      return grades;
    },
  };
}
