import { describe, it, expect } from 'vitest';
import {
  blobAtCommit,
  blobInWorkingTree,
  callerEditsInCandidate,
  classifyPathsAgainstCandidate,
  excludedCommitsTouchingPath,
  gitReadFromExecSync,
  pathsTouchedByRange,
  uncommittedPaths,
  type GitRead,
} from './candidate-contains';

/**
 * P-004 (EI-18752644493166307). These assert the BEHAVIOURS the incident turned on,
 * not the shape of the object.
 *
 * The incident: two gate runs judged candidates that did not contain the caller's fix.
 * The suite reds on the PRE-FIX failure with the PRE-FIX count, which reads as "your fix
 * did not work" rather than "your fix was not present" — so the natural next move is to
 * re-debug correct code. Every case below encodes one way that misread can be produced.
 */

/**
 * A fake git keyed by arg shape. `null` means the command FAILED; `''` means it
 * succeeded with no output — the distinction the whole module rests on, so the fake
 * has to model it faithfully or the tests below prove nothing.
 */
function fakeGit(opts: {
  /** `${sha}:${path}` → blob sha at that commit. Absent key ⇒ git exits non-zero. */
  blobs?: Record<string, string>;
  /** path → working-tree blob sha. Absent ⇒ the file cannot be read. */
  tree?: Record<string, string>;
  log?: string;
  diff?: string;
  lsFiles?: string;
  /** Simulate a total git failure (bad repo, missing binary). */
  allFail?: boolean;
}): GitRead {
  return async (args) => {
    if (opts.allFail) return null;
    if (args[0] === 'rev-parse' && args[1] === '--verify') {
      return opts.blobs?.[args[2]] ?? null;
    }
    if (args[0] === 'hash-object') {
      return opts.tree?.[args[2]] ?? null;
    }
    if (args[0] === 'ls-files') return opts.lsFiles ?? '';
    if (args[0] === 'log') return opts.log ?? '';
    if (args[0] === 'diff') return opts.diff ?? '';
    return null;
  };
}

describe('blob reads distinguish "absent" from "unreadable"', () => {
  it('blobAtCommit returns the blob sha, and null when the path is absent at that commit', async () => {
    const git = fakeGit({ blobs: { 'cand1:a.ts': 'b'.repeat(40) } });
    expect(await blobAtCommit(git, 'cand1', 'a.ts')).toBe('b'.repeat(40));
    expect(await blobAtCommit(git, 'cand1', 'new.ts')).toBeNull();
  });

  it('rejects non-sha output rather than treating it as a blob id', async () => {
    // A git that prints a warning/usage line on stdout must not be read as an answer.
    const git = fakeGit({ blobs: { 'cand1:a.ts': 'fatal: not a valid object name' } });
    expect(await blobAtCommit(git, 'cand1', 'a.ts')).toBeNull();
  });

  it('blobInWorkingTree reads an UNTRACKED file — the case `git diff <commit>` cannot see', async () => {
    const git = fakeGit({ tree: { 'brand-new.test.ts': 'c'.repeat(40) } });
    expect(await blobInWorkingTree(git, 'brand-new.test.ts')).toBe('c'.repeat(40));
  });
});

describe('classifyPathsAgainstCandidate', () => {
  const SAME = 'a'.repeat(40);
  const OTHER = 'd'.repeat(40);

  it('identical blobs ⇒ the candidate carries exactly what you have', async () => {
    const git = fakeGit({ blobs: { 'cand:a.ts': SAME }, tree: { 'a.ts': SAME } });
    const [r] = await classifyPathsAgainstCandidate(git, 'cand', ['a.ts']);
    expect(r.inCandidate).toBe(true);
    expect(r.reason).toBeNull();
  });

  it('MISFIRE 1 — an uncommitted edit is missing, and the lever named is "commit it"', async () => {
    // The working tree differs from HEAD ⇒ the edit never left the tree, which is the
    // one thing the caller can act on.
    const git = fakeGit({
      blobs: { 'cand:a.ts': SAME, 'HEAD:a.ts': SAME },
      tree: { 'a.ts': OTHER },
    });
    const [r] = await classifyPathsAgainstCandidate(git, 'cand', ['a.ts']);
    expect(r.inCandidate).toBe(false);
    expect(r.reason).toBe('uncommitted');
  });

  it('MISFIRE 2 — committed, but the quiet-cut candidate predates it ⇒ newer-commit, not uncommitted', async () => {
    // HEAD matches the tree (so it IS committed); the candidate simply lags. Naming this
    // 'uncommitted' would send the caller to git-sync:run, which would not help.
    const git = fakeGit({
      blobs: { 'cand:a.ts': SAME, 'HEAD:a.ts': OTHER },
      tree: { 'a.ts': OTHER },
    });
    const [r] = await classifyPathsAgainstCandidate(git, 'cand', ['a.ts']);
    expect(r.inCandidate).toBe(false);
    expect(r.reason).toBe('newer-commit');
  });

  it('a NEW file absent from the candidate is missing, not silently fine', async () => {
    const git = fakeGit({ tree: { 'new.test.ts': OTHER } });
    const [r] = await classifyPathsAgainstCandidate(git, 'cand', ['new.test.ts']);
    expect(r.inCandidate).toBe(false);
    expect(r.reason).toBe('absent');
  });

  /**
   * THE central invariant. The naive implementation (`git diff --name-only <sha> -- <path>`,
   * empty ⇒ "same") converts a FAILED git call into "your change IS in the candidate" — a
   * false reassurance, which is precisely the misread this module exists to prevent. A
   * broken read must be `null`, and null must never be counted as included.
   */
  it('an unreadable working tree yields UNKNOWN, never a false "contained"', async () => {
    const git = fakeGit({ blobs: { 'cand:a.ts': SAME } });
    const [r] = await classifyPathsAgainstCandidate(git, 'cand', ['a.ts']);
    expect(r.inCandidate).toBeNull();
    expect(r.unknownReason).toMatch(/UNKNOWN, not confirmed/);
  });

  it('a totally failed git yields UNKNOWN for every path', async () => {
    const git = fakeGit({ allFail: true });
    const rs = await classifyPathsAgainstCandidate(git, 'cand', ['a.ts', 'b.ts']);
    expect(rs.map((r) => r.inCandidate)).toEqual([null, null]);
  });

  it('an unresolved candidate is UNKNOWN, not "missing" — there is nothing to compare against', async () => {
    const git = fakeGit({ tree: { 'a.ts': SAME } });
    const [r] = await classifyPathsAgainstCandidate(git, null, ['a.ts']);
    expect(r.inCandidate).toBeNull();
    expect(r.unknownReason).toMatch(/No candidate commit/);
  });
});

describe('callerEditsInCandidate', () => {
  const SAME = 'a'.repeat(40);
  const OTHER = 'd'.repeat(40);

  it('splits included / missing / unknown, and never counts an unknown as included', async () => {
    const git = fakeGit({
      blobs: { 'cand:in.ts': SAME, 'HEAD:in.ts': SAME, 'cand:out.ts': SAME, 'HEAD:out.ts': SAME },
      tree: { 'in.ts': SAME, 'out.ts': OTHER },
      // 'gone.ts' has no working-tree entry ⇒ unknown
    });
    const v = await callerEditsInCandidate(git, 'cand', ['in.ts', 'out.ts', 'gone.ts']);
    expect(v.included).toEqual(['in.ts']);
    expect(v.missing).toEqual(['out.ts']);
    expect(v.unknown).toEqual(['gone.ts']);
    expect(v.included).not.toContain('gone.ts');
  });
});

describe('uncommittedPaths', () => {
  it('reports untracked files — the input a committed candidate provably cannot contain', async () => {
    const git = fakeGit({ diff: 'packages/x/edited.ts', lsFiles: 'packages/x/brand-new.test.ts' });
    expect(await uncommittedPaths(git)).toEqual(['packages/x/edited.ts', 'packages/x/brand-new.test.ts']);
  });

  /**
   * The regression this parse was rewritten for: `git status --porcelain` encodes state
   * in a two-column PREFIX (`" M path"`), and every runner here trims stdout — which eats
   * the first line's leading space and shifts the column parse by one, silently yielding
   * a truncated path ("irty.ts" for "dirty.ts"). Bare-path reads have no column to lose,
   * so a trimmed answer is still a correct answer.
   */
  it('survives a TRIMMED first line — no leading-column dependency', async () => {
    const git = fakeGit({ diff: 'dirty.ts', lsFiles: '' });
    expect(await uncommittedPaths(git)).toEqual(['dirty.ts']);
  });

  it('de-duplicates a path reported by both reads', async () => {
    const git = fakeGit({ diff: 'a.ts\nb.ts', lsFiles: 'b.ts' });
    expect(await uncommittedPaths(git)).toEqual(['a.ts', 'b.ts']);
  });

  it('a clean tree is empty, and a failed read is empty rather than throwing', async () => {
    expect(await uncommittedPaths(fakeGit({ diff: '', lsFiles: '' }))).toEqual([]);
    expect(await uncommittedPaths(fakeGit({ allFail: true }))).toEqual([]);
  });
});

describe('excluded-commit attribution (the resolution of "if your fix is among them")', () => {
  it('names the commits that touch a specific path', async () => {
    const git = fakeGit({ log: 'abc1234 fix the thing\ndef5678 also the thing' });
    expect(await excludedCommitsTouchingPath(git, 'cand', 'tip', 'a.ts')).toEqual([
      'abc1234 fix the thing',
      'def5678 also the thing',
    ]);
  });

  it('short-circuits without a git call when nothing was excluded', async () => {
    let calls = 0;
    const git: GitRead = async () => {
      calls += 1;
      return '';
    };
    expect(await excludedCommitsTouchingPath(git, 'same', 'same', 'a.ts')).toEqual([]);
    expect(await pathsTouchedByRange(git, 'same', 'same')).toEqual([]);
    expect(calls).toBe(0);
  });

  it('de-duplicates the file footprint of the excluded window', async () => {
    const git = fakeGit({ diff: 'a.ts\nb.ts\na.ts' });
    expect(await pathsTouchedByRange(git, 'cand', 'tip')).toEqual(['a.ts', 'b.ts']);
  });
});

describe('gitReadFromExecSync', () => {
  it('preserves the "" vs null distinction a zero-exit empty answer depends on', async () => {
    const ok = gitReadFromExecSync(() => ({ status: 0, stdout: '' }), '/repo');
    const fail = gitReadFromExecSync(() => ({ status: 128, stdout: '' }), '/repo');
    expect(await ok(['status', '--porcelain'])).toBe('');
    expect(await fail(['status', '--porcelain'])).toBeNull();
  });

  it('scopes every read to the given repo with -C', async () => {
    let seen: string[] = [];
    const read = gitReadFromExecSync((_cmd, args) => {
      seen = args;
      return { status: 0, stdout: 'out' };
    }, '/my/repo');
    await read(['rev-parse', 'HEAD']);
    expect(seen).toEqual(['-C', '/my/repo', 'rev-parse', 'HEAD']);
  });
});
