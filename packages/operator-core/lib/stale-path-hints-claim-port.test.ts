/**
 * Tests for stale-path-hints-claim-port (EI-21267393427094356).
 *
 * Resolution is exercised against a REAL throwaway git repo in a tmpdir —
 * rename detection is precisely the thing a fixture would fake, and git is a
 * dev/CI given (same posture as plans/git-history.test.ts, which skips cleanly
 * when git cannot run). Every assertion pins the CONTRACT the claim surfaces
 * rely on: dead hint → moved/missing verdict, live hint → silence, broken
 * environment → total silence.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  getClaimTimeStalePathHints,
  stalePathHintsNote,
  type ClaimTimeStalePathHint,
} from './stale-path-hints-claim-port';

let gitAvailable = true;
try {
  execFileSync('git', ['--version'], { stdio: 'ignore', timeout: 30_000, killSignal: 'SIGKILL' });
} catch {
  gitAvailable = false;
}

function sh(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore', timeout: 30_000, killSignal: 'SIGKILL' });
}

function writeFileAt(root: string, rel: string, contents: string): void {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, contents);
}

describe('getClaimTimeStalePathHints', () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'stale-path-hints-'));
    sh(repo, ['init', '-q']);
    sh(repo, ['config', 'user.email', 't@t']);
    sh(repo, ['config', 'user.name', 't']);
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  describe.runIf(gitAvailable)('against a real git repo', () => {
    function commit(rel: string, contents: string): void {
      writeFileAt(repo, rel, contents);
      sh(repo, ['add', rel]);
      sh(repo, ['commit', '-q', '-m', `add ${rel}`]);
    }

    function move(from: string, to: string): void {
      mkdirSync(dirname(join(repo, to)), { recursive: true });
      sh(repo, ['mv', from, to]);
      sh(repo, ['commit', '-q', '-am', `move ${from} -> ${to}`]);
    }

    it('returns null when every stored path still exists', async () => {
      commit('src/live.ts', 'export {};\n');
      await expect(getClaimTimeStalePathHints({ payload: { paths: ['src/live.ts'] }, repoRoot: repo })).resolves.toBe(
        null,
      );
    });

    it('resolves a single-hop rename to its current location', async () => {
      commit('lib/hive/watchdog.ts', 'export {};\n');
      move('lib/hive/watchdog.ts', 'lib/pot/watchdog.ts');
      const hints = await getClaimTimeStalePathHints({
        payload: { paths: ['lib/hive/watchdog.ts'] },
        repoRoot: repo,
      });
      expect(hints).toEqual([{ requested: 'lib/hive/watchdog.ts', status: 'moved', resolvedTo: 'lib/pot/watchdog.ts' }]);
    });

    it('walks a multi-hop rename chain to the live path', async () => {
      commit('a/one.ts', 'export 1;\n');
      move('a/one.ts', 'b/two.ts');
      move('b/two.ts', 'c/three.ts');
      const hints = await getClaimTimeStalePathHints({ payload: { paths: ['a/one.ts'] }, repoRoot: repo });
      expect(hints).toEqual([{ requested: 'a/one.ts', status: 'moved', resolvedTo: 'c/three.ts' }]);
    });

    it("reports 'missing' for a delete without a rename", async () => {
      commit('src/gone.ts', 'export {};\n');
      sh(repo, ['rm', '-q', 'src/gone.ts']);
      sh(repo, ['commit', '-q', '-m', 'delete src/gone.ts']);
      const hints = await getClaimTimeStalePathHints({ payload: { paths: ['src/gone.ts'] }, repoRoot: repo });
      expect(hints).toEqual([{ requested: 'src/gone.ts', status: 'missing' }]);
    });

    it('reports only the stale subset of a mixed payload and skips globs silently', async () => {
      commit('src/kept.ts', 'export {};\n');
      commit('src/moved.ts', 'export {};\n');
      move('src/moved.ts', 'dst/moved.ts');
      const hints = (await getClaimTimeStalePathHints({
        payload: { paths: ['src/kept.ts', 'src/moved.ts', 'src/glob*.ts'] },
        repoRoot: repo,
      })!) as ClaimTimeStalePathHint[];
      expect(hints).toEqual([{ requested: 'src/moved.ts', status: 'moved', resolvedTo: 'dst/moved.ts' }]);
    });

    it('accepts the workItem-wrapped subject shape the port documents', async () => {
      commit('old/x.ts', 'export {};\n');
      move('old/x.ts', 'new/x.ts');
      await expect(
        getClaimTimeStalePathHints({ workItem: { payload: { paths: ['old/x.ts'] } }, repoRoot: repo }),
      ).resolves.toEqual([{ requested: 'old/x.ts', status: 'moved', resolvedTo: 'new/x.ts' }]);
    });
  });

  it('is silent about a non-git directory rather than labelling everything missing', async () => {
    const plain = mkdtempSync(join(tmpdir(), 'stale-path-hints-plain-'));
    try {
      writeFileSync(join(plain, 'never-existed.ts'), 'x');
      await expect(
        getClaimTimeStalePathHints({ payload: { paths: ['never-existed.ts'] }, repoRoot: plain }),
      ).resolves.toBe(null);
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });

  it.each([
    ['no payload', undefined],
    ['paths absent', {}],
    ['paths not an array', { paths: 'src/a.ts' }],
    ['paths empty', { paths: [] }],
    ['paths all non-strings', { paths: [1, null] }],
  ])('returns null for %s', async (_label, payload) => {
    await expect(getClaimTimeStalePathHints({ payload })).resolves.toBe(null);
  });
});

describe('stalePathHintsNote', () => {
  it('names each moved pair and the unresolved count', () => {
    const note = stalePathHintsNote([
      { requested: 'lib/hive/watchdog.ts', status: 'moved', resolvedTo: 'lib/pot/watchdog.ts' },
      { requested: 'src/gone.ts', status: 'missing' },
    ]);
    expect(note).toContain("'lib/hive/watchdog.ts' → 'lib/pot/watchdog.ts'");
    expect(note).toContain('(1 unresolved)');
    expect(note).toContain('[EI-21267393427094356]');
  });

  it('renders nothing for an empty verdict', () => {
    expect(stalePathHintsNote(null)).toBe(null);
    expect(stalePathHintsNote([])).toBe(null);
  });
});
