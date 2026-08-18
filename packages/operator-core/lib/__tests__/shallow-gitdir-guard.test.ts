/**
 * The `npm run doctor` check for a repository in this checkout that has silently become
 * SHALLOW.
 *
 * THE GAP THIS PINS. `git fetch --depth=N` against a submodule of the shared tree converts
 * it into a shallow repository, and nothing anywhere reports it: no error at fetch time, a
 * clean `git status`, nothing for the git-sync sweep to commit, because the whole change is
 * a `shallow` file inside the gitdir. Measured 2026-08-18: an agent probing what four
 * submodule remotes contained shallowed all four (papercusp-desktop 1595 -> 71 commits,
 * libs/papercusp 2963 -> 120, libs/generic/sync 539 -> 38, libs/agent-chat 104 -> 3). Both
 * consequences mislead instead of failing: history reads return truncated answers with full
 * confidence, and pushes fail with "shallow update not allowed" — on that occasion, on
 * exactly the repos whose push failures were already under investigation.
 *
 * WHY THESE TESTS ARE SHAPED THIS WAY. They exercise the DISCOVERY MECHANISM against
 * synthetic gitdir fixtures, never the live tree. A test asserting "this checkout has no
 * shallow file" would assert a machine's present condition: it would pass on a box where the
 * detector is broken but nothing happens to be shallow, and it would fail on a legitimately
 * shallow CI clone. The mechanism is the invariant; the population is not.
 *
 * The nesting and discrimination cases are the ones that matter. `.git/modules` interleaves
 * real gitdirs with bare path components (`libs/sync` stores its gitdir at
 * `.git/modules/libs/sync`, where `libs` is only a directory), and submodules nest, so a
 * detector that stops at the first level or treats every directory as a gitdir would have
 * missed the damage that motivated this.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  findShallowGitdirs,
  formatShallowProblems,
  readGrafts,
  repairInstructions,
} from '../../../../scripts/lib/shallow-gitdirs.mjs';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'shallow-gitdir-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const SHA_A = '09d4514f75b1c0d2e3f4a5b6c7d8e9f0a1b2c3d4';
const SHA_B = '6d380feaa22a0b7174b8fc3e0049c7190453e790';

/**
 * Build a gitdir at `relative`. A gitdir is identified by its HEAD file — the same
 * discriminator the detector uses to tell `.git/modules/libs` (a path component) from
 * `.git/modules/libs/sync` (a real gitdir).
 */
function makeGitdir(relative: string, opts: { grafts?: string[] } = {}): string {
  const dir = join(root, relative);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'HEAD'), 'ref: refs/heads/main\n');
  // A realistic gitdir carries directories the walk must NOT descend into.
  mkdirSync(join(dir, 'objects', 'pack'), { recursive: true });
  mkdirSync(join(dir, 'refs', 'heads'), { recursive: true });
  if (opts.grafts) writeFileSync(join(dir, 'shallow'), `${opts.grafts.join('\n')}\n`);
  return dir;
}

const labels = (problems: Array<{ label: string }>) => problems.map((p) => p.label).sort();

describe('findShallowGitdirs', () => {
  it('reports nothing for a healthy tree — no shallow file anywhere', () => {
    makeGitdir('.git');
    makeGitdir('.git/modules/papercusp-desktop');
    makeGitdir('.git/modules/libs/sync');

    expect(findShallowGitdirs({ gitCommonDir: join(root, '.git') })).toEqual([]);
  });

  // THE CALIBRATION CASE. Without it, a detector that always returns [] would pass the
  // healthy-tree test above and every "does not false-positive" test below.
  it('detects a shallow submodule gitdir', () => {
    makeGitdir('.git');
    makeGitdir('.git/modules/papercusp-desktop', { grafts: [SHA_A, SHA_B] });

    const problems = findShallowGitdirs({ gitCommonDir: join(root, '.git') });

    expect(labels(problems)).toEqual(['papercusp-desktop']);
    expect(problems[0].grafts).toEqual([SHA_A, SHA_B]);
    expect(problems[0].shallowFile).toBe(join(root, '.git/modules/papercusp-desktop/shallow'));
  });

  it('detects a shallow SUPERPROJECT, labelled as such', () => {
    makeGitdir('.git', { grafts: [SHA_A] });
    makeGitdir('.git/modules/papercusp-desktop');

    expect(labels(findShallowGitdirs({ gitCommonDir: join(root, '.git') }))).toEqual([
      '(superproject)',
    ]);
  });

  // The 2026-08-18 damage sat at .git/modules/libs/sync and .git/modules/libs/agent-chat:
  // `libs` is a path component with no HEAD, so a walk that assumed every child of
  // `modules/` is a gitdir would have found neither.
  it('descends through bare path components to a nested gitdir', () => {
    makeGitdir('.git');
    makeGitdir('.git/modules/libs/sync', { grafts: [SHA_A] });
    makeGitdir('.git/modules/libs/agent-chat', { grafts: [SHA_B] });
    makeGitdir('.git/modules/libs/papercusp');

    expect(labels(findShallowGitdirs({ gitCommonDir: join(root, '.git') }))).toEqual([
      'libs/agent-chat',
      'libs/sync',
    ]);
  });

  it('finds a submodule-of-a-submodule (gitdir nested under another gitdir modules/)', () => {
    makeGitdir('.git');
    makeGitdir('.git/modules/libs/papercusp');
    makeGitdir('.git/modules/libs/papercusp/modules/libs/db', { grafts: [SHA_A] });

    expect(labels(findShallowGitdirs({ gitCommonDir: join(root, '.git') }))).toEqual([
      'libs/papercusp/libs/db',
    ]);
  });

  it('reports every shallow repo, not just the first', () => {
    makeGitdir('.git');
    for (const p of ['papercusp-desktop', 'libs/sync', 'libs/agent-chat', 'libs/papercusp']) {
      makeGitdir(`.git/modules/${p}`, { grafts: [SHA_A] });
    }

    expect(findShallowGitdirs({ gitCommonDir: join(root, '.git') })).toHaveLength(4);
  });

  // Git deletes the shallow file on unshallow; an empty leftover is not a shallow repo, and
  // failing the doctor over one would train people to ignore the check.
  it('treats an empty or whitespace-only shallow file as healthy', () => {
    makeGitdir('.git');
    const dir = makeGitdir('.git/modules/papercusp-desktop');
    writeFileSync(join(dir, 'shallow'), '\n  \n');

    expect(findShallowGitdirs({ gitCommonDir: join(root, '.git') })).toEqual([]);
  });

  // A `shallow` entry inside objects/ or refs/ is not a graft file, and descending into
  // objects/ on a real repo would also make the check expensive.
  it('ignores a file named shallow that is not at a gitdir root', () => {
    makeGitdir('.git');
    const dir = makeGitdir('.git/modules/papercusp-desktop');
    writeFileSync(join(dir, 'objects', 'shallow'), `${SHA_A}\n`);
    writeFileSync(join(dir, 'refs', 'heads', 'shallow'), `${SHA_A}\n`);

    expect(findShallowGitdirs({ gitCommonDir: join(root, '.git') })).toEqual([]);
  });

  it('returns [] rather than throwing when the gitdir does not exist', () => {
    expect(findShallowGitdirs({ gitCommonDir: join(root, 'no-such-dir') })).toEqual([]);
  });

  it('survives a modules/ tree it cannot read without losing the rest', () => {
    makeGitdir('.git');
    makeGitdir('.git/modules/papercusp-desktop', { grafts: [SHA_A] });
    writeFileSync(join(root, '.git/modules/not-a-dir'), 'stray file\n');

    expect(labels(findShallowGitdirs({ gitCommonDir: join(root, '.git') }))).toEqual([
      'papercusp-desktop',
    ]);
  });
});

describe('readGrafts', () => {
  it('parses one sha per line and drops blanks', () => {
    const dir = makeGitdir('.git');
    writeFileSync(join(dir, 'shallow'), `${SHA_A}\n\n  ${SHA_B}  \n`);

    expect(readGrafts(join(dir, 'shallow'))).toEqual([SHA_A, SHA_B]);
  });

  it('returns [] for an absent file instead of throwing', () => {
    expect(readGrafts(join(root, 'nope', 'shallow'))).toEqual([]);
  });
});

describe('the failure message', () => {
  // The repair is cheap but counter-intuitive: --depth deletes nothing, so the objects are
  // usually still local and `--unshallow` (network, and fails outright once a remote no
  // longer carries the history) is the wrong first move. A message that omitted the
  // verify-parents-first step would invite deleting the graft file blind, which is the one
  // way to turn a recoverable state into a corrupt one.
  it('names the repo, the graft count, and the verify-before-delete sequence', () => {
    const problem = {
      label: 'libs/sync',
      gitdir: '/repo/.git/modules/libs/sync',
      shallowFile: '/repo/.git/modules/libs/sync/shallow',
      grafts: [SHA_A, SHA_B],
    };
    const text = repairInstructions(problem);

    expect(text).toContain('libs/sync');
    expect(text).toContain('2 grafts');
    expect(text).toContain('/repo/.git/modules/libs/sync/shallow');
    expect(text).toContain('cat-file -e');
    expect(text).toContain('--is-shallow-repository');
    expect(text).toContain('fetch --unshallow');
    // verifying the parents must come BEFORE deleting the file
    expect(text.indexOf('cat-file -e')).toBeLessThan(text.indexOf('delete it'));
  });

  it('states both consequences and the rule that prevents a recurrence', () => {
    const text = formatShallowProblems([
      { label: 'libs/sync', gitdir: '/g', shallowFile: '/g/shallow', grafts: [SHA_A] },
    ]);

    expect(text).toContain('cannot push');
    expect(text).toContain('WRONG');
    expect(text).toContain('--depth');
  });
});
