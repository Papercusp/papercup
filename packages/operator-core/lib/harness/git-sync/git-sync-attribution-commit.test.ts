import { describe, it, expect, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  /** WI-10006519: answer for `rev-parse --absolute-git-dir` (the stale-lock recovery
   *  looks for `<gitDir>/index.lock`). Defaults to a path that does not exist. */
  gitDir?: string;
}): { runGit: RunGit; calls: string[][] } {
  const calls: string[][] = [];
  let addIdx = 0;
  let commitIdx = 0;
  const runGit: RunGit = async (args) => {
    calls.push(args);
    if (args[0] === 'status') return { code: 0, stdout: opts.porcelain ?? '', stderr: '' };
    if (args[0] === 'rev-parse' && args.includes('--absolute-git-dir')) {
      return { code: 0, stdout: `${opts.gitDir ?? '/nonexistent-git-sync-attribution-test/.git'}\n`, stderr: '' };
    }
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

const tmpDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

/** A real git runner for the on-disk regression below. */
const realRunGit: RunGit = (args, cwd) =>
  new Promise((resolve) => {
    execFile('git', args, { cwd, encoding: 'utf8' }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1) : 0;
      resolve({ code, stdout, stderr });
    });
  });

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

  it('returns an error when an attributed add keeps hitting a FRESH (live) index.lock, and never removes it', async () => {
    // WI-10006519: a fresh lock is a live writer's. Recovery retries a bounded number of
    // times and then surfaces the error; it must not unlink the lock.
    const gitDir = await mkdtemp(join(tmpdir(), 'gs-attr-fresh-'));
    tmpDirs.push(gitDir);
    await writeFile(join(gitDir, 'index.lock'), '');
    const lockErr = { code: 1, stderr: "fatal: Unable to create '.git/index.lock': File exists" };
    const { runGit, calls } = fakeGit({
      porcelain: ' M a.ts\0 M b.ts\0',
      addResults: [lockErr, lockErr, lockErr, lockErr, lockErr, lockErr],
      gitDir,
    });
    const attribution = new Map<string, FileAttribution>([['a.ts', { agent: 'ag1', intent: 'fix a' }]]);
    const logs: string[] = [];

    const res = await commitAttributedGroups(runGit, '/repo', attribution, [], MSG, { log: (m) => logs.push(m) });

    expect(res.committedAny).toBe(false);
    expect(res.committedCount).toBe(0);
    expect(res.error).toMatch(/attributed add failed:.*index\.lock/);
    const adds = calls.filter((c) => c[0] === 'add');
    expect(adds[0]).toEqual(['add', '--', 'a.ts']);
    expect(adds.length).toBe(4); // first try + 3 bounded retries; the fresh lock is never cleared
    expect(calls.some((c) => c[0] === 'diff' || c.includes('commit'))).toBe(false);
    expect(existsSync(join(gitDir, 'index.lock'))).toBe(true);
    expect(logs.some((m) => m.includes('FRESH'))).toBe(true);
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
      // A non-lock failure: lock failures now go through stale-lock recovery (WI-10006519).
      commitResults: [{ code: 1, stderr: 'error: gpg failed to sign the data' }],
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

describe('commitAttributedGroups stale index.lock recovery (WI-10006519, real git)', () => {
  it('clears an aged, holderless index.lock and commits the attributed group instead of failing every tick', async () => {
    // 2026-10-06 07:09Z and 08:00Z: a 0-byte index.lock left by a killed git process made
    // the attributed `git add` fail on every git-sync tick. This is that state on disk.
    const repo = await mkdtemp(join(tmpdir(), 'gs-attr-stale-'));
    tmpDirs.push(repo);
    expect((await realRunGit(['init', '-q'], repo)).code).toBe(0);
    await mkdir(join(repo, 'src'));
    await writeFile(join(repo, 'src', 'a.ts'), 'export const a = 1;\n');
    const lockPath = join(repo, '.git', 'index.lock');
    await writeFile(lockPath, '');
    const tenMinutesAgo = new Date(Date.now() - 10 * 60_000);
    await utimes(lockPath, tenMinutesAgo, tenMinutesAgo);
    // Positive control: with the orphan in place, a plain add really does fail.
    const plain = await realRunGit(['add', '--', 'src/a.ts'], repo);
    expect(plain.code).not.toBe(0);
    expect(`${plain.stdout}${plain.stderr}`).toMatch(/index\.lock/);

    const attribution = new Map<string, FileAttribution>([['src/a.ts', { agent: 'ag1', intent: 'add a' }]]);
    const logs: string[] = [];
    const res = await commitAttributedGroups(realRunGit, repo, attribution, [], MSG, { log: (m) => logs.push(m) });

    expect(res.error).toBeUndefined();
    expect(res.committedCount).toBe(1);
    expect(existsSync(lockPath)).toBe(false);
    expect(logs.some((m) => m.includes('cleared STALE index.lock'))).toBe(true);
    const files = await realRunGit(['show', '--name-only', '--format=', 'HEAD'], repo);
    expect(files.stdout.trim()).toBe('src/a.ts');
  });
});
