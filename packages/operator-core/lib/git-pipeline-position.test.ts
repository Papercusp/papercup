import { describe, it, expect } from 'vitest';
import {
  gitPipelinePosition,
  summarizePosition,
  type GitRunner,
  type PipelinePosition,
} from './git-pipeline-position';
import type { DevDeployState } from './dev-deploy-state';
import type { GitPipelineSnapshot } from './git-pipeline-stats';

/** A fake `git` runner keyed by arg shape + a per-ref containment map. */
function fakeGit(opts: {
  submodules?: string[];
  dirty?: boolean;
  pathCommit?: string | null;
  subject?: string;
  /** ref → set of shas that ref's history contains (ancestor-or-equal). */
  contains?: Record<string, string[]>;
}): GitRunner {
  return async (_repo, args) => {
    if (args[0] === 'config' && args.includes('.gitmodules')) {
      const subs = opts.submodules ?? [];
      return subs.length ? subs.map((p, i) => `submodule.s${i}.path ${p}`).join('\n') : null;
    }
    if (args[0] === 'status') return opts.dirty ? 'M somefile' : '';
    if (args[0] === 'rev-parse') return args[args.length - 1].replace('^{commit}', '');
    if (args[0] === 'log' && args.includes('--pretty=%H')) return opts.pathCommit ?? null;
    if (args[0] === 'log' && args.includes('--pretty=%s')) return opts.subject ?? 'subj';
    if (args[0] === 'rev-list' && args[1] === '--count') {
      const [ref, sha] = args[2].split('..');
      const set = new Set(opts.contains?.[ref] ?? []);
      return set.has(sha) ? '0' : '3';
    }
    return null;
  };
}

const deploy = (over: Partial<DevDeployState> = {}): DevDeployState =>
  ({ integrationRoot: '/repo', deployed: { sha: 'deployedsha0' } as DevDeployState['deployed'], ...over } as DevDeployState);

const snap = (gate: Partial<GitPipelineSnapshot['gate']> = {}, lastStatus = 'synced'): GitPipelineSnapshot =>
  ({
    gate: { stalled: false, consecutiveReds: 0, lastGreenAtMs: 1, ...gate },
    gitSync: { lastStatus },
  } as GitPipelineSnapshot);

describe('gitPipelinePosition (P-002)', () => {
  it('a fully-promoted+deployed superproject path reads committed→staging→main→deployed (live)', async () => {
    const git = fakeGit({
      pathCommit: 'abc1234567',
      subject: 'my fix',
      contains: {
        HEAD: ['abc1234567'],
        'origin/staging': ['abc1234567'],
        'origin/main': ['abc1234567'],
        deployedsha0: ['abc1234567'],
      },
    });
    const res = await gitPipelinePosition(
      { path: 'apps/operator/app/x.ts' },
      { git, loadDeploy: async () => deploy(), loadSnapshot: async () => snap() },
    );
    expect(res.positions).toEqual({ committedLocal: true, onStaging: true, inMain: true, deployed: true });
    expect(res.submodule).toBeNull();
    expect(res.summary).toContain('(live)');
  });

  it('a change stuck at staging behind a STALLED gate reads main ✗ + surfaces the stall', async () => {
    const git = fakeGit({
      pathCommit: 'def7654321',
      contains: {
        HEAD: ['def7654321'],
        'origin/staging': ['def7654321'],
        'origin/main': [], // not promoted
        deployedsha0: [],
      },
    });
    const res = await gitPipelinePosition(
      { path: 'apps/operator/app/y.ts' },
      { git, loadDeploy: async () => deploy(), loadSnapshot: async () => snap({ stalled: true, consecutiveReds: 3 }) },
    );
    expect(res.positions.onStaging).toBe(true);
    expect(res.positions.inMain).toBe(false);
    expect(res.positions.deployed).toBe(false);
    expect(res.summary).toContain('main ✗');
    expect(res.summary).toContain('STALLED');
  });

  it('a submodule path is detected, annotated, and resolved against the submodule (not staging)', async () => {
    const git = fakeGit({
      submodules: ['libs/papercusp'],
      pathCommit: 'sub1234567',
      contains: { HEAD: ['sub1234567'], 'origin/HEAD': ['sub1234567'] },
    });
    const res = await gitPipelinePosition(
      { path: 'libs/papercusp/packages/harness/x.ts' },
      { git, loadDeploy: async () => deploy(), loadSnapshot: async () => snap() },
    );
    expect(res.submodule).toBe('libs/papercusp');
    expect(res.positions.committedLocal).toBe(true);
    expect(res.positions.onStaging).toBe(true); // origin/HEAD
    expect(res.positions.inMain).toBe(false); // not tracked for submodule paths
    expect(res.summary).toContain('submodule libs/papercusp');
    expect(res.notes.join(' ')).toMatch(/submodule/i);
  });

  it('a newly-created uncommitted file reports no commit + the dirty flag', async () => {
    const git = fakeGit({ pathCommit: null, dirty: true });
    const res = await gitPipelinePosition(
      { path: 'apps/operator/app/new.ts' },
      { git, loadDeploy: async () => deploy(), loadSnapshot: async () => snap() },
    );
    expect(res.targetSha).toBeNull();
    expect(res.dirtyUncommitted).toBe(true);
    expect(res.summary).toContain('no commit found');
  });

  it('summarizePosition is pure over the resolved facts', () => {
    const base: Omit<PipelinePosition, 'summary'> = {
      input: { path: 'a.ts', sha: null },
      repoRoot: '/repo',
      submodule: null,
      targetSha: 'aaaaaaa',
      targetShortSha: 'aaaaaaa',
      targetSubject: 'subj',
      dirtyUncommitted: false,
      positions: { committedLocal: true, onStaging: true, inMain: true, deployed: false },
      deployedSha: 'deployedsha0',
      gate: { stalled: false, consecutiveReds: 0, lastGreenAtMs: 1 },
      gitSyncLastStatus: 'synced',
      notes: [],
    };
    expect(summarizePosition(base)).toContain('deployed ✗');
    expect(summarizePosition(base)).not.toContain('(live)');
  });
});
