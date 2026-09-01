import { describe, expect, it } from 'vitest';
import {
  REPAIR_PROGRESS_COMMIT_USER_EMAIL,
  REPAIR_PROGRESS_COMMIT_USER_NAME,
  REPAIR_PROGRESS_REF_PREFIX,
  commitRepairWorktreeProgress,
  repairProgressRefName,
  type RepairProgressExecResult,
  type RepairWorktreeProgressDeps,
} from './repair-worktree-progress';

const WT = '/tmp/fake/worktrees/green-candidate-papercusp-5738f8817eb6';
const REF = repairProgressRefName('papercusp', '5738f8817eb6deadbeef');

interface Call {
  cmd: string;
  args: string[];
}

function ok(stdout = ''): RepairProgressExecResult {
  return { code: 0, stdout, stderr: '' };
}

function fail(code: number, stderr = '', stdout = ''): RepairProgressExecResult {
  return { code, stdout, stderr };
}

/** Scripted exec: matches on the git subcommand (first non-flag arg after -C <path>). */
function scriptedDeps(
  script: Partial<Record<string, RepairProgressExecResult | (() => RepairProgressExecResult)>>,
  opts: { hasGitDir?: boolean } = {},
): { deps: RepairWorktreeProgressDeps; calls: Call[]; logs: string[] } {
  const calls: Call[] = [];
  const logs: string[] = [];
  const deps: RepairWorktreeProgressDeps = {
    hasGitDir: () => opts.hasGitDir ?? true,
    log: (m) => logs.push(m),
    async exec(cmd, args) {
      calls.push({ cmd, args });
      // args: ['-C', WT, ...rest]; the subcommand is the first entry after the -C pair
      // that is not a `-c key=val` config injection.
      const rest = args.slice(2);
      let sub = rest[0];
      for (let i = 0; i < rest.length; i += 1) {
        if (rest[i] === '-c') {
          i += 1;
          continue;
        }
        sub = rest[i];
        break;
      }
      const entry = script[sub ?? ''];
      if (entry === undefined) throw new Error(`unscripted git subcommand: ${sub}`);
      return typeof entry === 'function' ? entry() : entry;
    },
  };
  return { deps, calls, logs };
}

function subcommands(calls: Call[]): string[] {
  return calls.map((c) => {
    const rest = c.args.slice(2);
    for (let i = 0; i < rest.length; i += 1) {
      if (rest[i] === '-c') {
        i += 1;
        continue;
      }
      return rest[i];
    }
    return '';
  });
}

describe('repairProgressRefName', () => {
  it('builds the namespaced ref from pipeline + candidate sha12', () => {
    expect(repairProgressRefName('papercusp', '5738f8817eb6deadbeefcafe')).toBe(
      `${REPAIR_PROGRESS_REF_PREFIX}papercusp-5738f8817eb6`,
    );
  });

  it('sanitizes hostile pipeline names and non-hex candidates instead of emitting an invalid refname', () => {
    const ref = repairProgressRefName('../evil name!', 'not-a-sha');
    expect(ref.startsWith(REPAIR_PROGRESS_REF_PREFIX)).toBe(true);
    expect(ref).not.toContain('..');
    expect(ref).not.toContain(' ');
    expect(ref).toBe(`${REPAIR_PROGRESS_REF_PREFIX}evil-name-aa`);
  });

  it('falls back to placeholders rather than an empty segment', () => {
    expect(repairProgressRefName('', '')).toBe(`${REPAIR_PROGRESS_REF_PREFIX}pipeline-unknown`);
  });
});

describe('commitRepairWorktreeProgress', () => {
  it('reports no-worktree without running any git command when .git is absent', async () => {
    const { deps, calls } = scriptedDeps({}, { hasGitDir: false });
    const result = await commitRepairWorktreeProgress({ worktreePath: WT, refName: REF, label: 'test', deps });
    expect(result).toEqual({ outcome: 'no-worktree' });
    expect(calls).toHaveLength(0);
  });

  it('reports clean on an empty porcelain status and never stages or commits', async () => {
    const { deps, calls } = scriptedDeps({ status: ok('') });
    const result = await commitRepairWorktreeProgress({ worktreePath: WT, refName: REF, label: 'test', deps });
    expect(result).toEqual({ outcome: 'clean' });
    expect(subcommands(calls)).toEqual(['status']);
  });

  it('commits dirty state with the gate identity, --no-verify, and pins the survivor ref', async () => {
    const sha = 'a'.repeat(40);
    const { deps, calls, logs } = scriptedDeps({
      status: ok(' M lib/a.ts\n?? lib/b.ts\n'),
      add: ok(),
      commit: ok(),
      'rev-parse': ok(`${sha}\n`),
      'update-ref': ok(),
    });
    const result = await commitRepairWorktreeProgress({
      worktreePath: WT,
      refName: REF,
      label: 'pre-converge dispatch',
      deps,
    });
    expect(result).toEqual({ outcome: 'committed', sha, dirtyPaths: 2, refPinned: true });
    expect(subcommands(calls)).toEqual(['status', 'add', 'commit', 'rev-parse', 'update-ref']);
    const commitCall = calls[2];
    expect(commitCall.args).toContain(`user.name=${REPAIR_PROGRESS_COMMIT_USER_NAME}`);
    expect(commitCall.args).toContain(`user.email=${REPAIR_PROGRESS_COMMIT_USER_EMAIL}`);
    expect(commitCall.args).toContain('--no-verify');
    const message = commitCall.args[commitCall.args.indexOf('-m') + 1];
    expect(message).toContain('pre-converge dispatch');
    expect(message).toContain('2 dirty path(s)');
    const pinCall = calls[4];
    expect(pinCall.args).toContain(REF);
    expect(pinCall.args).toContain(sha);
    expect(logs.some((l) => l.includes('preserved 2 dirty path(s)'))).toBe(true);
  });

  it('treats a nothing-to-commit refusal (ignored-only churn) as clean, not failure', async () => {
    const { deps, calls } = scriptedDeps({
      status: ok('!! node_modules/x\n'),
      add: ok(),
      commit: fail(1, '', 'nothing to commit, working tree clean'),
    });
    const result = await commitRepairWorktreeProgress({ worktreePath: WT, refName: REF, label: 'test', deps });
    expect(result).toEqual({ outcome: 'clean' });
    expect(subcommands(calls)).toEqual(['status', 'add', 'commit']);
  });

  it('fails soft (no throw) when status exits non-zero', async () => {
    const { deps } = scriptedDeps({ status: fail(128, 'fatal: not a git repository') });
    const result = await commitRepairWorktreeProgress({ worktreePath: WT, refName: REF, label: 'test', deps });
    expect(result.outcome).toBe('failed');
    expect((result as { detail: string }).detail).toContain('status failed');
  });

  it('fails soft (no throw) when exec itself throws — e.g. a live fixer holds index.lock', async () => {
    const { deps } = scriptedDeps({
      status: ok(' M lib/a.ts\n'),
      add: () => {
        throw new Error('index.lock exists');
      },
    });
    const result = await commitRepairWorktreeProgress({ worktreePath: WT, refName: REF, label: 'test', deps });
    expect(result).toEqual({ outcome: 'failed', detail: 'index.lock exists' });
  });

  it('reports committed with refPinned:false and a loud warn when the survivor ref write fails', async () => {
    const sha = 'b'.repeat(40);
    const { deps, logs } = scriptedDeps({
      status: ok(' M lib/a.ts\n'),
      add: ok(),
      commit: ok(),
      'rev-parse': ok(`${sha}\n`),
      'update-ref': fail(1, 'cannot lock ref'),
    });
    const result = await commitRepairWorktreeProgress({ worktreePath: WT, refName: REF, label: 'test', deps });
    expect(result).toMatchObject({ outcome: 'committed', sha, dirtyPaths: 1, refPinned: false });
    expect(logs.some((l) => l.includes('survivor ref') && l.includes('was not written'))).toBe(true);
  });
});
