import { describe, it, expect } from 'vitest';
import { commitAttributedGroups, dirtyFiles } from './run-git-sync';
import type { FileAttribution } from './git-sync-attribution';

type GitResult = { code: number; stdout: string; stderr: string };
type RunGit = (args: string[], cwd: string) => Promise<GitResult>;

function fakeGit(opts: {
  porcelain?: string;
  addResults?: Array<Partial<GitResult>>;
  commitResults?: Array<Partial<GitResult>>;
  /** WI-38594: stdout for the per-group `git diff --cached --numstat` read. */
  numstat?: string;
}): { runGit: RunGit; calls: string[][] } {
  const calls: string[][] = [];
  let addIdx = 0;
  let commitIdx = 0;
  const runGit: RunGit = async (args) => {
    calls.push(args);
    if (args[0] === 'status') return { code: 0, stdout: opts.porcelain ?? '', stderr: '' };
    if (args[0] === 'add') {
      const r = opts.addResults?.[addIdx++] ?? { code: 0 };
      return { code: r.code ?? 0, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
    }
    if (args[0] === 'diff' && args.includes('--numstat')) {
      return { code: 0, stdout: opts.numstat ?? '', stderr: '' };
    }
    // WI-5111: commitAttributedGroups now prepends `-c user.name=... -c
    // user.email=...` (GIT_SYNC_IDENTITY_ARGS) before `commit` — match on
    // inclusion, not args[0].
    if (args.includes('commit')) {
      const r = opts.commitResults?.[commitIdx++] ?? { code: 0 };
      return { code: r.code ?? 0, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
    }
    return { code: 0, stdout: '', stderr: '' };
  };
  return { runGit, calls };
}

const MSG = 'chore(git-sync): auto-commit papercup [skip ci]';

describe('dirtyFiles (-z porcelain parse)', () => {
  it('lists modified/untracked/deleted paths and skips a rename origin', async () => {
    // ` M a.ts` modified, `?? b.ts` untracked, `R  new.ts`\0`old.ts` rename, ` D gone.ts` deleted.
    const porcelain = ' M a.ts\0?? b.ts\0R  new.ts\0old.ts\0 D gone.ts\0';
    const { runGit } = fakeGit({ porcelain });
    expect(await dirtyFiles(runGit, '/repo')).toEqual(['a.ts', 'b.ts', 'new.ts', 'gone.ts']);
  });
});

describe('commitAttributedGroups (P-004 + WI-38594 diff subjects)', () => {
  it('peels per-agent commits (diff subject + [skip ci], intent in the body, Co-Authored-By), leaving the remainder to the caller', async () => {
    const { runGit, calls } = fakeGit({
      porcelain: ' M a.ts\0 M b.ts\0 M c.ts\0',
      numstat: '10\t2\ta.ts\n5\t1\tb.ts\n',
    });
    const attribution = new Map<string, FileAttribution>([
      ['a.ts', { agent: 'ag1', intent: 'fix a' }],
      ['b.ts', { agent: 'ag1', intent: 'fix a' }],
      // c.ts unattributed → catch-all, NOT committed here
    ]);
    const res = await commitAttributedGroups(runGit, '/repo', attribution, [], MSG);

    expect(res).toEqual({ committedAny: true, committedCount: 1 });
    // staged exactly ag1's files (sorted), nothing about c.ts
    const add = calls.find((c) => c[0] === 'add');
    expect(add).toEqual(['add', '--', 'a.ts', 'b.ts']);
    // WI-38594: numstat read is scoped to the group's just-staged files
    const numstat = calls.find((c) => c[0] === 'diff')!;
    expect(numstat).toEqual(['diff', '--cached', '--numstat', '--', 'a.ts', 'b.ts']);
    // the per-agent commit: DIFF subject WITH the [skip ci] marker, intent line as the
    // first body paragraph, + a Co-Authored-By trailer
    const commit = calls.find((c) => c.includes('commit'))!;
    expect(commit).toContain('sync(root): a.ts, b.ts (2 files, +15/-3) [skip ci]');
    expect(commit).toContain('fix a'); // demoted to the body, not lost
    expect(commit).toContain('Co-Authored-By: ag1 <ag1@agents.papercusp>');
    // exactly ONE attributed commit (c.ts is the catch-all, left for the caller's add -A)
    expect(calls.filter((c) => c.includes('commit'))).toHaveLength(1);
  });

  it('diffSubjects:false preserves the pre-WI-38594 intent subject byte-identically (kill-switch)', async () => {
    const { runGit, calls } = fakeGit({ porcelain: ' M a.ts\0' });
    const attribution = new Map<string, FileAttribution>([['a.ts', { agent: 'ag1', intent: 'fix a' }]]);
    await commitAttributedGroups(runGit, '/repo', attribution, [], MSG, { diffSubjects: false });
    const commit = calls.find((c) => c.includes('commit'))!;
    expect(commit).toContain('fix a [skip ci]');
    // no numstat read, no body demotion on the OFF path
    expect(calls.some((c) => c[0] === 'diff')).toBe(false);
    expect(commit.filter((a) => a === 'fix a')).toHaveLength(0);
  });

  it('is a no-op when nothing is attributed (flag-OFF degradation): no add, no commit', async () => {
    const { runGit, calls } = fakeGit({ porcelain: ' M a.ts\0 M b.ts\0' });
    const res = await commitAttributedGroups(runGit, '/repo', new Map(), [], MSG);
    expect(res).toEqual({ committedAny: false, committedCount: 0 });
    expect(calls.some((c) => c[0] === 'add' || c.includes('commit'))).toBe(false);
  });

  it('returns an error when an attributed add fails and does not commit the unstaged group', async () => {
    const { runGit, calls } = fakeGit({
      porcelain: ' M a.ts\0 M b.ts\0',
      addResults: [{ code: 1, stderr: "fatal: Unable to create '.git/index.lock': File exists" }],
    });
    const attribution = new Map<string, FileAttribution>([['a.ts', { agent: 'ag1', intent: 'fix a' }]]);

    const res = await commitAttributedGroups(runGit, '/repo', attribution, [], MSG);

    expect(res.committedAny).toBe(false);
    expect(res.committedCount).toBe(0);
    expect(res.error).toMatch(/attributed add failed:.*index\.lock/);
    expect(calls.find((c) => c[0] === 'add')).toEqual(['add', '--', 'a.ts']);
    expect(calls.some((c) => c[0] === 'diff' || c.includes('commit'))).toBe(false);
  });

  it('skips excluded (oversized/content) files even when attributed', async () => {
    const { runGit, calls } = fakeGit({ porcelain: ' M a.ts\0 M big.bin\0' });
    const attribution = new Map<string, FileAttribution>([
      ['a.ts', { agent: 'ag1', intent: 'work' }],
      ['big.bin', { agent: 'ag1', intent: 'work' }],
    ]);
    await commitAttributedGroups(runGit, '/repo', attribution, ['big.bin'], MSG);
    const add = calls.find((c) => c[0] === 'add')!;
    expect(add).toEqual(['add', '--', 'a.ts']); // big.bin excluded
  });

  it('surfaces a real commit failure as an error (but tolerates nothing-to-commit)', async () => {
    const { runGit } = fakeGit({
      porcelain: ' M a.ts\0',
      commitResults: [{ code: 1, stderr: 'fatal: Unable to create index.lock' }],
    });
    const attribution = new Map<string, FileAttribution>([['a.ts', { agent: 'ag1', intent: 'x' }]]);
    const res = await commitAttributedGroups(runGit, '/repo', attribution, [], MSG);
    expect(res.error).toMatch(/attributed commit failed/);

    const { runGit: g2 } = fakeGit({ porcelain: ' M a.ts\0', commitResults: [{ code: 1, stdout: 'nothing to commit' }] });
    const res2 = await commitAttributedGroups(g2, '/repo', attribution, [], MSG);
    expect(res2).toEqual({ committedAny: false, committedCount: 0 }); // benign — no error
  });

  it('emits Papercusp-Agent/Work-Item/Session/Plan trailers when the attribution carries them (P-004 attribution)', async () => {
    const { runGit, calls } = fakeGit({ porcelain: ' M a.ts\0' });
    const attribution = new Map<string, FileAttribution>([
      ['a.ts', { agent: 'ag1', intent: 'fix a', workItems: ['WI-1', 'WI-2'], sessionId: 'sess-9', planSlug: 'plan-x' }],
    ]);
    await commitAttributedGroups(runGit, '/repo', attribution, [], MSG);
    const commit = calls.find((c) => c.includes('commit'))!;
    expect(commit).toContain('Papercusp-Agent: ag1');
    expect(commit).toContain('Papercusp-Work-Item: WI-1, WI-2');
    expect(commit).toContain('Papercusp-Session: sess-9');
    expect(commit).toContain('Papercusp-Plan: plan-x');
    // still carries a subject (diff-derived; empty numstat → no ±counts), the intent
    // body, + Co-Authored-By
    expect(commit).toContain('sync(root): a.ts (1 file) [skip ci]');
    expect(commit).toContain('fix a');
    expect(commit).toContain('Co-Authored-By: ag1 <ag1@agents.papercusp>');
  });

  it('emits Papercusp-Agent but NO Work-Item/Session/Plan trailers when the attribution lacks them', async () => {
    const { runGit, calls } = fakeGit({ porcelain: ' M a.ts\0' });
    const attribution = new Map<string, FileAttribution>([['a.ts', { agent: 'ag1', intent: 'x' }]]);
    await commitAttributedGroups(runGit, '/repo', attribution, [], MSG);
    const commit = calls.find((c) => c.includes('commit'))!;
    expect(commit).toContain('Papercusp-Agent: ag1');
    expect(commit.some((a) => a.startsWith('Papercusp-Work-Item:'))).toBe(false);
    expect(commit.some((a) => a.startsWith('Papercusp-Session:'))).toBe(false);
    expect(commit.some((a) => a.startsWith('Papercusp-Plan:'))).toBe(false);
  });

  it('creates separate commits when one agent edited files under different work-items', async () => {
    const { runGit, calls } = fakeGit({ porcelain: ' M old.ts\0 M new.ts\0' });
    const attribution = new Map<string, FileAttribution>([
      ['old.ts', { agent: 'ag1', intent: 'old lane', workItems: ['WI-40700'] }],
      ['new.ts', { agent: 'ag1', intent: 'new lane', workItems: [] }],
    ]);

    await commitAttributedGroups(runGit, '/repo', attribution, [], MSG);

    const commits = calls.filter((c) => c.includes('commit'));
    expect(commits).toHaveLength(2);
    const oldCommit = commits.find((c) => c.includes('old lane'))!;
    const newCommit = commits.find((c) => c.includes('new lane'))!;
    expect(oldCommit).toContain('Papercusp-Work-Item: WI-40700');
    expect(newCommit.some((a) => a.startsWith('Papercusp-Work-Item:'))).toBe(false);
  });
});
