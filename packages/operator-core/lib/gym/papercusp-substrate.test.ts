/**
 * papercusp-substrate.test.ts — the real-substrate plan + the validity gate.
 *
 * The rules under test are the ones that keep the corpus HONEST: the agent can
 * never be handed its own oracle, a task can never start already solved, and a
 * candidate that cannot be shown to discriminate never becomes a task. The
 * measured numbers behind the design live in plan decision D-006.
 */
import { describe, expect, it } from 'vitest';
import {
  SPARSE_CONE_DIRS,
  admitValidatedTasks,
  buildPinnedSubstratePlan,
  buildReferenceSolutionCommands,
  buildTaskSetupCommands,
  judgeDiscrimination,
  papercuspTaskToGymTask,
  type PapercuspTaskDescriptor,
} from './papercusp-substrate';

const PIN = '38ae7fafe0aeb59527af7419e64d4c50b30ee2c6';
const OLD = '285be0501111111111111111111111111111aaaa';

const TASK: PapercuspTaskDescriptor = {
  taskId: 'real-pipeline-position',
  pool: 'train',
  pinCommit: PIN,
  implPath: 'packages/operator-core/lib/agent-tools/dev/pipeline_position.ts',
  testPath: 'packages/operator-core/lib/agent-tools/dev/pipeline_position.test.ts',
  revertToCommit: OLD,
  spec: 'Restore the behaviour the real test requires.',
  intent: 'A real shipped change.',
  sourceRef: 'papercusp commit b30d4e92',
};

describe('buildPinnedSubstratePlan', () => {
  const plan = () =>
    buildPinnedSubstratePlan({
      sourceRepo: '/home/x/papercusp',
      commit: PIN,
      destDir: '/home/x/scratch/sub',
      nodeModulesDirs: ['node_modules', 'packages/operator-core/node_modules'],
    });

  it('clones WITHOUT a checkout, then narrows, then detaches — never materialising the binaries', () => {
    const argvs = plan().commands.map((c) => c.argv.join(' '));
    // Order is load-bearing: an eager checkout would pull the 8.1G of committed
    // model weights this whole plan exists to skip.
    expect(argvs[0]).toContain('--no-checkout');
    expect(argvs[1]).toContain('sparse-checkout init --cone');
    expect(argvs[2]).toContain('sparse-checkout set');
    expect(argvs[3]).toContain('checkout --detach');
  });

  it('omits papercusp-desktop from the cone — 94% of tracked bytes, unreachable from a unit test', () => {
    expect(SPARSE_CONE_DIRS).not.toContain('papercusp-desktop');
    // …while still carrying everything a workspace test needs to resolve.
    expect(SPARSE_CONE_DIRS).toEqual(expect.arrayContaining(['packages', 'libs', 'apps']));
  });

  it('uses --local so the 9.9G object store is hardlinked rather than copied', () => {
    expect(plan().commands[0].argv).toContain('--local');
  });

  it('symlinks node_modules instead of installing it', () => {
    expect(plan().symlinks).toEqual([
      { link: '/home/x/scratch/sub/node_modules', target: '/home/x/papercusp/node_modules' },
      {
        link: '/home/x/scratch/sub/packages/operator-core/node_modules',
        target: '/home/x/papercusp/packages/operator-core/node_modules',
      },
    ]);
  });

  it('rejects a non-absolute source — --local hardlinking needs a real local path', () => {
    expect(() =>
      buildPinnedSubstratePlan({ sourceRepo: 'https://github.com/x/y.git', commit: PIN, destDir: '/d', nodeModulesDirs: [] }),
    ).toThrow(/absolute local path/);
  });

  it('rejects a ref instead of a pinned SHA — a moving world is not reproducible', () => {
    expect(() =>
      buildPinnedSubstratePlan({ sourceRepo: '/repo', commit: 'staging', destDir: '/d', nodeModulesDirs: [] }),
    ).toThrow(/pinned hex SHA/);
  });
});

describe('task setup — the surgical revert', () => {
  it('rewinds ONLY the implementation file, leaving the oracle and the world at the pin', () => {
    const argvs = buildTaskSetupCommands(TASK, '/d').map((c) => c.argv.join(' '));
    expect(argvs.every((a) => a.endsWith(TASK.implPath))).toBe(true);
    expect(argvs.some((a) => a.includes(TASK.testPath))).toBe(false);
  });

  it('normalises to the pin BEFORE rewinding, so a reused substrate carries no prior task', () => {
    const argvs = buildTaskSetupCommands(TASK, '/d').map((c) => c.argv.join(' '));
    expect(argvs[0]).toContain(PIN);
    expect(argvs[1]).toContain(OLD);
  });

  it('the reference solution is the real shipped file at the pin', () => {
    const argv = buildReferenceSolutionCommands(TASK, '/d')[0].argv.join(' ');
    expect(argv).toContain(PIN);
    expect(argv).toContain(TASK.implPath);
  });

  it('refuses a task that starts already solved', () => {
    expect(() => buildTaskSetupCommands({ ...TASK, revertToCommit: PIN }, '/d')).toThrow(/already solved/);
  });

  it('refuses to hand the agent its own oracle to edit', () => {
    expect(() => buildTaskSetupCommands({ ...TASK, implPath: TASK.testPath }, '/d')).toThrow(/same file|test file/);
    expect(() =>
      buildTaskSetupCommands({ ...TASK, implPath: 'packages/x/lib/thing.test.ts' }, '/d'),
    ).toThrow(/never be asked to edit the oracle/);
  });
});

describe('judgeDiscrimination — the validity gate', () => {
  it('admits the one shape that proves the test moves with the implementation', () => {
    expect(judgeDiscrimination({ reverted: 'failed', restored: 'passed' })).toEqual({ valid: true });
  });

  it('rejects no-oracle: reverted still passes, so doing nothing would score', () => {
    // The measured case (agent-facts/store): a real change with no test covering
    // it. This is the dangerous rejection — it looks exactly like a task.
    expect(judgeDiscrimination({ reverted: 'passed', restored: 'passed' })).toEqual({
      valid: false,
      reason: 'no-oracle',
    });
  });

  it('rejects broken-baseline: the real shipped code does not pass, so nobody could score', () => {
    expect(judgeDiscrimination({ reverted: 'passed', restored: 'failed' })).toEqual({
      valid: false,
      reason: 'broken-baseline',
    });
  });

  it('rejects inverted: both fail, so the test measures the harness, not the agent', () => {
    expect(judgeDiscrimination({ reverted: 'failed', restored: 'failed' })).toEqual({
      valid: false,
      reason: 'inverted',
    });
  });
});

describe('admitValidatedTasks', () => {
  it('admits only the discriminating candidates and reports why each other was dropped', () => {
    const { admitted, rejected } = admitValidatedTasks([
      { descriptor: { ...TASK, taskId: 'good' }, evidence: { reverted: 'failed', restored: 'passed' } },
      { descriptor: { ...TASK, taskId: 'uncovered' }, evidence: { reverted: 'passed', restored: 'passed' } },
      { descriptor: { ...TASK, taskId: 'flaky' }, evidence: { reverted: 'failed', restored: 'failed' } },
    ]);
    expect(admitted.map((t) => t.taskId)).toEqual(['good']);
    expect(rejected).toEqual([
      { taskId: 'uncovered', reason: 'no-oracle' },
      { taskId: 'flaky', reason: 'inverted' },
    ]);
  });

  it('an empty corpus is the honest outcome when nothing discriminates — never a default pass', () => {
    const { admitted } = admitValidatedTasks([
      { descriptor: TASK, evidence: { reverted: 'passed', restored: 'passed' } },
    ]);
    expect(admitted).toEqual([]);
  });
});

describe('papercuspTaskToGymTask', () => {
  it("claims corpus:'real' — the label P-011's release bar reads", () => {
    const row = papercuspTaskToGymTask(TASK, '/scratch/sub');
    expect(row.corpus).toBe('real');
    expect(row.repoCommit).toBe(PIN);
  });

  it('tells the agent the oracle is off-limits and names the real gate command', () => {
    const ctx = papercuspTaskToGymTask(TASK, '/scratch/sub').projectContext;
    expect(ctx).toContain('do not edit it');
    expect(ctx).toContain(`npm run test:file -- ${TASK.testPath}`);
    expect(ctx).toContain(TASK.sourceRef);
  });

  it('carries the same pin guards, so an unvalidated descriptor cannot mint a real-corpus row', () => {
    expect(() => papercuspTaskToGymTask({ ...TASK, pinCommit: 'HEAD' }, '/s')).toThrow(/pinned hex SHA/);
  });
});
