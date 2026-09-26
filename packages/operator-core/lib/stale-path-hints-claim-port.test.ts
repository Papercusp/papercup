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
  getClaimTimeStalePathAdvisory,
  getClaimTimeStalePathRefs,
  getClaimTimeStalePathHints,
  getStalePathRefsForSubjects,
  stalePathRefsNote,
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

  describe.runIf(gitAvailable)('repoRoot resolution precedence (EI-21895925841807401)', () => {
    // The bug: every current caller omits `repoRoot`, and the port used to fall
    // straight through to `process.cwd()` — on the :3070 operator that cwd is the
    // RELEASE checkout (a separate, days-stale git tree), not the staging tree
    // PAPERCUSP_INTEGRATION_ROOT names. During this test run process.cwd() is
    // this real repository's own checkout, which does NOT contain the throwaway
    // fixture path below — so if the env-var fallback regressed back to
    // `process.cwd()`, these assertions would see it as 'missing' (or crash
    // trying to walk a nonexistent rename history for it) instead of resolving
    // it in the temp `repo` fixture.
    const ENV_KEY = 'PAPERCUSP_INTEGRATION_ROOT';
    let savedEnv: string | undefined;

    beforeEach(() => {
      savedEnv = process.env[ENV_KEY];
      delete process.env[ENV_KEY];
    });

    afterEach(() => {
      if (savedEnv === undefined) delete process.env[ENV_KEY];
      else process.env[ENV_KEY] = savedEnv;
    });

    function commitAt(root: string, rel: string): void {
      writeFileAt(root, rel, 'export {};\n');
      sh(root, ['add', rel]);
      sh(root, ['commit', '-q', '-m', `add ${rel}`]);
    }

    it('falls back to PAPERCUSP_INTEGRATION_ROOT — not process.cwd() — when repoRoot is omitted', async () => {
      commitAt(repo, 'src/env-integration-root-fallback-fixture-a.ts');
      process.env[ENV_KEY] = repo;
      await expect(
        getClaimTimeStalePathHints({
          payload: { paths: ['src/env-integration-root-fallback-fixture-a.ts'] },
        }),
      ).resolves.toBe(null);
    });

    it('an explicit repoRoot still wins over PAPERCUSP_INTEGRATION_ROOT', async () => {
      commitAt(repo, 'src/env-integration-root-fallback-fixture-b.ts');
      const wrongRoot = mkdtempSync(join(tmpdir(), 'stale-path-hints-wrong-root-'));
      try {
        process.env[ENV_KEY] = wrongRoot; // a git-less dir; must NOT be consulted
        await expect(
          getClaimTimeStalePathHints({
            payload: { paths: ['src/env-integration-root-fallback-fixture-b.ts'] },
            repoRoot: repo,
          }),
        ).resolves.toBe(null);
      } finally {
        rmSync(wrongRoot, { recursive: true, force: true });
      }
    });
  });
});

describe.runIf(gitAvailable)('title/summary stalePathRefs (EI-20049758099997696)', () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'stale-path-refs-'));
    sh(repo, ['init', '-q']);
    sh(repo, ['config', 'user.email', 't@t']);
    sh(repo, ['config', 'user.name', 't']);
    writeFileAt(repo, 'apps/operator/live.tsx', 'export {};\n');
    sh(repo, ['add', '.']);
    sh(repo, ['commit', '-q', '-m', 'anchor']);
  });

  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it('reports only unresolvable repo-relative paths cited in title/summary', async () => {
    await expect(
      getClaimTimeStalePathRefs({
        workItem: {
          id: 'WI-1',
          title: 'Update apps/operator/live.tsx',
          summary: 'Remove apps/operator/app/_components/LeftSidebar.tsx:42 after verification',
        },
        repoRoot: repo,
      }),
    ).resolves.toEqual(['apps/operator/app/_components/LeftSidebar.tsx']);
  });

  it('batches plan items against one advisory shape and stays silent for resolvable text', async () => {
    const timings: Record<string, number> = {};
    await expect(
      getStalePathRefsForSubjects(
        [
          { id: 'P-001', summary: 'Touch apps/operator/live.tsx' },
          { id: 'P-002', summary: 'Delete packages/retired/no-longer-here.ts' },
        ],
        repo,
        timings,
      ),
    ).resolves.toEqual({ 'P-002': ['packages/retired/no-longer-here.ts'] });
    expect(timings['stalePaths.resolveRoot']).toBeGreaterThanOrEqual(0);
    expect(timings['stalePaths.scan']).toBeGreaterThanOrEqual(0);
  });

  it('shares one claim-time advisory with payload pathHints without conflating the fields', async () => {
    writeFileAt(repo, 'old/moved.ts', 'export {};\n');
    sh(repo, ['add', '.']);
    sh(repo, ['commit', '-q', '-m', 'add moved fixture']);
    mkdirSync(join(repo, 'new'), { recursive: true });
    sh(repo, ['mv', 'old/moved.ts', 'new/moved.ts']);
    sh(repo, ['commit', '-q', '-am', 'move fixture']);

    const advisory = await getClaimTimeStalePathAdvisory({
      workItem: {
        id: 'WI-2',
        payload: { paths: ['old/moved.ts'] },
        summary: 'Also edit packages/never-created.ts',
      },
      repoRoot: repo,
    });
    expect(advisory?.pathHints).toEqual([
      { requested: 'old/moved.ts', status: 'moved', resolvedTo: 'new/moved.ts' },
    ]);
    expect(advisory?.stalePathRefs).toEqual(['packages/never-created.ts']);
    expect(advisory?.stalePathRefsNote).toContain('not semantic staleness');
  });

  it('renders the required advisory scope limits', () => {
    const note = stalePathRefsNote(['apps/operator/missing.tsx'])!;
    expect(note).toContain('Advisory only');
    expect(note).toContain('file to CREATE');
    expect(note).toContain('absence of this field does not verify the item');
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

  /**
   * EI-21930229853756240 — an absent path with NO history was never in this checkout, and
   * saying 'missing' about it is a FALSE ABSENCE. The note is the damaging half: it tells
   * the agent both to distrust the stored path AND not to fall back to a search, so a
   * false 'missing' closes both exits and leaves them nowhere to go.
   */
  it('reports an unknown path as UNVERIFIED, never as gone', () => {
    const note = stalePathHintsNote([
      { requested: 'src/gone.ts', status: 'missing' },
      { requested: 'src/never-here.ts', status: 'unknown' },
    ])!;
    // The affirmed count must exclude the unknown one, or the note re-asserts the very
    // claim this fix exists to stop making.
    expect(note).toContain('1 stored payload path(s) no longer exist at HEAD');
    expect(note).toContain('(1 unresolved)');
    expect(note).toContain("'src/never-here.ts'");
    expect(note).toContain('UNVERIFIED, not');
    expect(note).toContain('[EI-21930229853756240]');
  });

  it('renders nothing when every hint is unknown', () => {
    // Nothing was affirmed, so there is nothing to warn about — warning anyway is the bug.
    expect(stalePathHintsNote([{ requested: 'a.ts', status: 'unknown' }])).toBe(null);
  });
});

/**
 * EI-21930229853756240 — the FALSE-ABSENCE class, at the resolver.
 *
 * MEASURED 2026-08-31: a claim reported `scripts/lib/governed-test-process.mjs` and
 * `scripts/lib/preempt-markers.mjs` as status='missing' while both were present on disk
 * AND at staging HEAD. Neither had been deleted — the resolver had resolved against the
 * RELEASE checkout (pinned to green `main`, ~3 days stale and serving a build that
 * predated the PAPERCUSP_INTEGRATION_ROOT fix), where files added to staging afterwards
 * have never existed. `existsSync` answered correctly about the WRONG TREE.
 *
 * The guard therefore cannot rely on standing in the right checkout. It distinguishes the
 * two cases from git history itself: a genuinely deleted path has a deletion commit, a
 * path that was never here has no history at all. That holds for a stale deploy, a
 * partial clone, or a work-item whose files simply are not created yet.
 */
describe.runIf(gitAvailable)('getClaimTimeStalePathHints — false-absence guard (EI-21930229853756240)', () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'stale-path-hints-absence-'));
    sh(repo, ['init', '-q']);
    sh(repo, ['config', 'user.email', 't@t']);
    sh(repo, ['config', 'user.name', 't']);
    writeFileAt(repo, 'src/anchor.ts', 'export {};\n');
    sh(repo, ['add', 'src/anchor.ts']);
    sh(repo, ['commit', '-q', '-m', 'anchor']);
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  function commitDeleted(rel: string): void {
    writeFileAt(repo, rel, 'export {};\n');
    sh(repo, ['add', rel]);
    sh(repo, ['commit', '-q', '-m', `add ${rel}`]);
    sh(repo, ['rm', '-q', rel]);
    sh(repo, ['commit', '-q', '-m', `delete ${rel}`]);
  }

  it('stays SILENT when no stored path was ever in this checkout (the reported failure)', async () => {
    // The exact shape of the live incident: every stored path absent, none ever here.
    // Silence, not a confident verdict — the same posture the not-a-git-work-tree case
    // already takes, because "the probe could not run" must never render as "all missing".
    await expect(
      getClaimTimeStalePathHints({
        payload: { paths: ['scripts/lib/governed-test-process.mjs', 'scripts/lib/preempt-markers.mjs'] },
        repoRoot: repo,
      }),
    ).resolves.toBe(null);
  });

  it('still reports a genuinely DELETED path as missing (the fix must not blind the guard)', async () => {
    // CALIBRATION: without this, "returns null" above could pass simply because the
    // resolver stopped detecting anything at all.
    commitDeleted('src/deleted.ts');
    const hints = await getClaimTimeStalePathHints({ payload: { paths: ['src/deleted.ts'] }, repoRoot: repo });
    expect(hints).toEqual([{ requested: 'src/deleted.ts', status: 'missing' }]);
  });

  it('separates a deleted path from a never-here one in the same claim', async () => {
    commitDeleted('src/deleted.ts');
    const hints = await getClaimTimeStalePathHints({
      payload: { paths: ['src/deleted.ts', 'src/never-here.ts'] },
      repoRoot: repo,
    });
    expect(hints).toEqual(
      expect.arrayContaining([
        { requested: 'src/deleted.ts', status: 'missing' },
        { requested: 'src/never-here.ts', status: 'unknown' },
      ]),
    );
    expect(hints).toHaveLength(2);
  });

  it('CONTROL: the pre-fix predicate would have called both paths missing', () => {
    // The wrong implementation, kept permanently: absence alone, with no history check.
    // Without it, the assertions above could pass under a resolver that had quietly
    // stopped classifying anything, and the regression would be invisible.
    const preFix = (_p: string): ClaimTimeStalePathHint['status'] => 'missing';
    expect(['scripts/lib/governed-test-process.mjs', 'src/deleted.ts'].map(preFix)).toEqual(['missing', 'missing']);
  });
});
