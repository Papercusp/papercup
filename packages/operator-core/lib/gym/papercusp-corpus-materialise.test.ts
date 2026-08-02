/**
 * papercusp-corpus-materialise.test.ts — executing the task-commit plan.
 *
 * The rule under test is D-007: a task's `repoCommit` must be a commit whose
 * tree already carries the REWOUND file. The failure this guards is silent —
 * a task that starts already solved still runs, still scores, and scores
 * PERFECTLY — so the tests assert the mechanism (stdout captures threaded into
 * the right steps) rather than just the happy-path return value.
 */
import { describe, expect, it } from 'vitest';
import { materialisePapercuspCorpus, materialiseTaskCommit, type RunGit } from './papercusp-corpus-materialise';
import type { PapercuspTaskDescriptor } from './papercusp-substrate';
import type { GitCommand } from './clone';

const PIN = '38ae7fafe0aeb59527af7419e64d4c50b30ee2c6';
const OLD = '285be0501111111111111111111111111111aaaa';
const TREE = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const COMMIT = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

const desc = (over: Partial<PapercuspTaskDescriptor> = {}): PapercuspTaskDescriptor => ({
  taskId: 'real-pattern',
  pool: 'train',
  pinCommit: PIN,
  implPath: 'packages/operator-core/lib/events/await/pattern.ts',
  testPath: 'packages/operator-core/lib/events/await/pattern.test.ts',
  revertToCommit: OLD,
  spec: 'Restore the behaviour the real test requires.',
  intent: 'A real shipped change.',
  sourceRef: 'papercusp commit deadbeef',
  ...over,
});

/** A fake git that records argv and answers the two capture steps. */
function fakeGit(over: { lsTree?: string } = {}): { run: RunGit; calls: GitCommand[] } {
  const calls: GitCommand[] = [];
  const run: RunGit = async (cmd) => {
    calls.push(cmd);
    const verb = cmd.argv[3];
    if (verb === 'ls-tree') return over.lsTree ?? `100644 blob cafe\t${desc().implPath}\n`;
    if (verb === 'write-tree') return `${TREE}\n`;
    if (verb === 'commit-tree') return `${COMMIT}\n`;
    return '';
  };
  return { run, calls };
}

describe('materialiseTaskCommit', () => {
  it('threads write-tree stdout into commit-tree, and commit-tree stdout into update-ref', async () => {
    const { run, calls } = fakeGit();
    const got = await materialiseTaskCommit(desc(), '/scratch/sub', run);

    expect(got.taskCommit).toBe(COMMIT);
    const commitTree = calls.find((c) => c.argv[3] === 'commit-tree');
    expect(commitTree?.argv).toContain(TREE); // the captured tree, not a literal
    const updateRef = calls.find((c) => c.argv[3] === 'update-ref');
    expect(updateRef?.argv).toEqual(['git', '-C', '/scratch/sub', 'update-ref', got.branchName, COMMIT]);
  });

  it('feeds the ls-tree line into update-index as stdin, preserving the file mode', async () => {
    const line = `100755 blob cafebabe\t${desc().implPath}\n`;
    const { run, calls } = fakeGit({ lsTree: line });
    await materialiseTaskCommit(desc(), '/scratch/sub', run);
    const splice = calls.find((c) => c.argv.includes('--index-info'));
    expect(splice?.stdin).toBe(line);
  });

  it('never touches the substrate working tree', async () => {
    const { run, calls } = fakeGit();
    await materialiseTaskCommit(desc(), '/scratch/sub', run);
    for (const c of calls) expect(c.argv.join(' ')).not.toMatch(/\b(checkout|reset|switch)\b/);
  });

  it('refuses a rewind point where the file does not exist — that is a DELETE, not a revert', async () => {
    const { run } = fakeGit({ lsTree: '' });
    await expect(materialiseTaskCommit(desc(), '/scratch/sub', run)).rejects.toThrow(/would DELETE the file/);
  });

  /**
   * A runner that returned stderr, an empty string, or a git warning would
   * otherwise pass junk straight into commit-tree and fail two steps later
   * with a message pointing at the wrong command.
   */
  it('fails at the step that actually misbehaved when a capture is not a SHA', async () => {
    const run: RunGit = async (cmd) => (cmd.argv[3] === 'ls-tree' ? '100644 blob cafe\tx.ts\n' : cmd.argv[3] === 'write-tree' ? 'warning: something\n' : '');
    await expect(materialiseTaskCommit(desc(), '/scratch/sub', run)).rejects.toThrow(/write-tree did not return a 40-hex SHA/);
  });
});

describe('materialisePapercuspCorpus', () => {
  it("produces corpus:'real' rows whose repoCommit is the generated commit, never the pin (D-007)", async () => {
    const { run } = fakeGit();
    const [task] = await materialisePapercuspCorpus([desc()], '/scratch/sub', run);
    expect(task.gymTask.repoCommit).toBe(COMMIT);
    expect(task.gymTask.repoCommit).not.toBe(PIN);
    expect(task.gymTask.corpus).toBe('real');
  });

  it('rejects a duplicate taskId — two tasks sharing one branch would silently share one commit', async () => {
    const { run } = fakeGit();
    await expect(materialisePapercuspCorpus([desc(), desc()], '/scratch/sub', run)).rejects.toThrow(/duplicate taskId/);
  });

  it('materialises each descriptor onto its own branch', async () => {
    const { run } = fakeGit();
    const tasks = await materialisePapercuspCorpus([desc(), desc({ taskId: 'real-send' })], '/scratch/sub', run);
    expect(tasks.map((t) => t.branchName)).toEqual(['refs/heads/gym-task/real-pattern', 'refs/heads/gym-task/real-send']);
  });
});
