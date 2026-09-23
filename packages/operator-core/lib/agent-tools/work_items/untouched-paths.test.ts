/**
 * P-005 (plan `design-to-code-coverage-seam-2026-09-02`), governed by D-016.
 *
 * The detector is pure at its decision seam: existence, working-tree dirtiness, git
 * history and submodule layout are all injected, so BOTH directions — it fires, and it
 * stays silent — are falsifiable without a real checkout.
 *
 * The silence cases are not padding. A false accusation here lowers an honest agent's
 * grade, so every "stays silent" test below pins a specific way this check could have
 * manufactured one.
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  MAX_UNTOUCHED_PROBES,
  UNTOUCHED_GRACE_SEC,
  isDirtyManyViaGit,
  lastCommitAtManyViaGit,
  untouchedPathsInCompletion,
} from './untouched-paths';
import { stripCommentsAndStrings } from '../../../../../scripts/lib/strip-comments-and-strings.mjs';
import { LANDING_RACE_WINDOW_SEC } from '../../../../../scripts/lib/tsc-baseline-gate.mjs';

const ROOT = '/repo';
/** The work began here. Every timestamp below is expressed relative to it. */
const SINCE_SEC = 1_780_000_000;
const SINCE_ISO = new Date(SINCE_SEC * 1000).toISOString();

/** Well before the window opens, and outside the grace — the only accusable shape. */
const OLD_SEC = SINCE_SEC - UNTOUCHED_GRACE_SEC - 3600;
/** After the work began — proof git-sync already swept the edit. */
const RECENT_SEC = SINCE_SEC + 600;

const evidence = (...filesChanged: string[]) => ({ summary: 'did the thing', filesChanged });

/** A tree where everything exists, nothing is dirty, and history is ancient. */
const baseProbe = {
  repoRoots: [ROOT],
  exists: () => true,
  isDirty: () => false,
  lastCommitAt: () => OLD_SEC,
  submodulePrefixes: () => [] as string[],
};

const batchProbe = {
  repoRoots: [ROOT],
  exists: () => true,
  submodulePrefixes: () => [] as string[],
};

describe('untouchedPathsInCompletion', () => {
  it('fires on a real file that is clean and last committed before the work began', async () => {
    const result = await untouchedPathsInCompletion(evidence('packages/real.ts'), SINCE_SEC, baseProbe);

    expect(result).toEqual({
      since: SINCE_ISO,
      untouched: [{ path: 'packages/real.ts', lastCommitAt: new Date(OLD_SEC * 1000).toISOString() }],
    });
  });

  it('reports only the untouched paths and leaves the genuinely changed ones alone', async () => {
    const result = await untouchedPathsInCompletion(
      evidence('packages/changed.ts', 'packages/stale.ts'),
      SINCE_SEC,
      { ...baseProbe, lastCommitAt: (_root, p) => (p.endsWith('changed.ts') ? RECENT_SEC : OLD_SEC) },
    );

    expect(result?.untouched.map((u) => u.path)).toEqual(['packages/stale.ts']);
  });

  it('uses one batched status and history read per checkout for multiple paths', async () => {
    let dirtyCalls = 0;
    let historyCalls = 0;
    let dirtyPaths: readonly string[] = [];
    let historyPaths: readonly string[] = [];

    const result = await untouchedPathsInCompletion(evidence('packages/one.ts', 'packages/two.ts'), SINCE_SEC, {
      ...batchProbe,
      isDirtyMany: (_root, paths) => {
        dirtyCalls += 1;
        dirtyPaths = paths;
        return new Map(paths.map((path) => [path, false] as const));
      },
      lastCommitAtMany: (_root, paths) => {
        historyCalls += 1;
        historyPaths = paths;
        return new Map(paths.map((path) => [path, OLD_SEC] as const));
      },
    });

    expect(result?.untouched.map((entry) => entry.path)).toEqual(['packages/one.ts', 'packages/two.ts']);
    expect(dirtyCalls).toBe(1);
    expect(historyCalls).toBe(1);
    expect(dirtyPaths).toEqual(['packages/one.ts', 'packages/two.ts']);
    expect(historyPaths).toEqual(['packages/one.ts', 'packages/two.ts']);
  });

  it('keeps per-path injected seams authoritative over the batch seams', async () => {
    let dirtyCalls = 0;
    let historyCalls = 0;
    const result = await untouchedPathsInCompletion(evidence('packages/real.ts'), SINCE_SEC, {
      ...batchProbe,
      isDirty: () => {
        dirtyCalls += 1;
        return false;
      },
      lastCommitAt: () => {
        historyCalls += 1;
        return OLD_SEC;
      },
      isDirtyMany: () => {
        throw new Error('batch status seam must not replace the per-path seam');
      },
      lastCommitAtMany: () => {
        throw new Error('batch history seam must not replace the per-path seam');
      },
    });

    expect(result?.untouched).toHaveLength(1);
    expect(dirtyCalls).toBe(1);
    expect(historyCalls).toBe(1);
  });

  // ── Proof-of-work route 1: the edit exists but git-sync has not swept it ──────────────
  //
  // This is the case that makes the check safe to grade on at all. This repo has ONE
  // shared tree swept on a schedule, so at close time an honest edit is usually still
  // uncommitted and its git history still predates the item.

  it('stays silent when the working tree is dirty at the path, however old its history', async () => {
    const result = await untouchedPathsInCompletion(evidence('packages/in-flight.ts'), SINCE_SEC, {
      ...baseProbe,
      isDirty: () => true,
      lastCommitAt: () => OLD_SEC,
    });

    expect(result).toBeUndefined();
  });

  it('stays silent when dirtiness cannot be read, rather than assuming clean', async () => {
    const result = await untouchedPathsInCompletion(evidence('packages/real.ts'), SINCE_SEC, {
      ...baseProbe,
      isDirty: () => undefined,
    });

    expect(result).toBeUndefined();
  });

  // ── Proof-of-work route 2: git-sync already swept the edit ───────────────────────────

  it('stays silent when a commit touched the path inside the work window', async () => {
    const result = await untouchedPathsInCompletion(evidence('packages/real.ts'), SINCE_SEC, {
      ...baseProbe,
      lastCommitAt: () => RECENT_SEC,
    });

    expect(result).toBeUndefined();
  });

  it('clears a commit that landed just BEFORE the window, inside the grace', async () => {
    const result = await untouchedPathsInCompletion(evidence('packages/real.ts'), SINCE_SEC, {
      ...baseProbe,
      lastCommitAt: () => SINCE_SEC - Math.floor(UNTOUCHED_GRACE_SEC / 2),
    });

    expect(result).toBeUndefined();
  });

  it('still fires once the commit is older than the grace, so the widening is bounded', async () => {
    const justOutside = SINCE_SEC - UNTOUCHED_GRACE_SEC - 1;
    const result = await untouchedPathsInCompletion(evidence('packages/real.ts'), SINCE_SEC, {
      ...baseProbe,
      lastCommitAt: () => justOutside,
    });

    expect(result?.untouched).toEqual([
      { path: 'packages/real.ts', lastCommitAt: new Date(justOutside * 1000).toISOString() },
    ]);
  });

  // ── Undecidable shapes are silence, never accusations ────────────────────────────────

  it('never judges a path inside a submodule, where superproject git log is empty for a real file', async () => {
    const result = await untouchedPathsInCompletion(
      evidence('libs/papercusp/libs/db/sql/727-thing.sql'),
      SINCE_SEC,
      {
        ...baseProbe,
        submodulePrefixes: () => ['libs/papercusp'],
        // The shape that would otherwise manufacture the accusation: superproject git
        // knows nothing about a file that is real inside the submodule.
        lastCommitAt: () => OLD_SEC,
      },
    );

    expect(result).toBeUndefined();
  });

  it('stays silent when git knows nothing about the path (null is not an accusation)', async () => {
    const result = await untouchedPathsInCompletion(evidence('packages/real.ts'), SINCE_SEC, {
      ...baseProbe,
      lastCommitAt: () => null,
    });

    expect(result).toBeUndefined();
  });

  it('stays silent when the history read could not be made at all', async () => {
    const result = await untouchedPathsInCompletion(evidence('packages/real.ts'), SINCE_SEC, {
      ...baseProbe,
      lastCommitAt: () => undefined,
    });

    expect(result).toBeUndefined();
  });

  it('leaves a path absent from disk to the fabricated-path detector, keeping the two disjoint', async () => {
    const result = await untouchedPathsInCompletion(evidence('packages/gone.ts'), SINCE_SEC, {
      ...baseProbe,
      exists: () => false,
    });

    expect(result).toBeUndefined();
  });

  it('stays silent for globs and absolute paths, which are not single-path claims', async () => {
    expect(await untouchedPathsInCompletion(evidence('packages/**/*.ts'), SINCE_SEC, baseProbe)).toBeUndefined();
    expect(await untouchedPathsInCompletion(evidence('/etc/hosts'), SINCE_SEC, baseProbe)).toBeUndefined();
  });

  it('stays silent for a path escaping the repo root', async () => {
    const result = await untouchedPathsInCompletion(evidence('../elsewhere/file.ts'), SINCE_SEC, baseProbe);
    expect(result).toBeUndefined();
  });

  it('stays silent with no usable repo root, rather than guessing one', async () => {
    expect(await untouchedPathsInCompletion(evidence('packages/real.ts'), SINCE_SEC, { ...baseProbe, repoRoots: [] })).toBeUndefined();
  });

  it('stays silent with no usable window, rather than treating "now" as the start of work', async () => {
    expect(await untouchedPathsInCompletion(evidence('packages/real.ts'), undefined, baseProbe)).toBeUndefined();
    expect(await untouchedPathsInCompletion(evidence('packages/real.ts'), 'not-a-date', baseProbe)).toBeUndefined();
  });

  it('stays silent when no paths were declared at all', async () => {
    expect(await untouchedPathsInCompletion(evidence(), SINCE_SEC, baseProbe)).toBeUndefined();
    expect(await untouchedPathsInCompletion(undefined, SINCE_SEC, baseProbe)).toBeUndefined();
  });

  it('treats a throwing probe as cannot-judge rather than letting it escape', async () => {
    const result = await untouchedPathsInCompletion(evidence('packages/real.ts'), SINCE_SEC, {
      ...baseProbe,
      isDirty: () => {
        throw new Error('git exploded');
      },
    });

    expect(result).toBeUndefined();
  });

  // ── Bounds and multi-root semantics ──────────────────────────────────────────────────

  it('is cleared by ANY root, so a second checkout carrying the edit exonerates the path', async () => {
    const result = await untouchedPathsInCompletion(evidence('packages/real.ts'), SINCE_SEC, {
      ...baseProbe,
      repoRoots: ['/repo-a', '/repo-b'],
      isDirty: (root) => root === '/repo-b',
    });

    expect(result).toBeUndefined();
  });

  it('does not judge past the probe cap', async () => {
    const many = Array.from({ length: MAX_UNTOUCHED_PROBES + 5 }, (_, i) => `packages/f${i}.ts`);
    const result = await untouchedPathsInCompletion(evidence(...many), SINCE_SEC, baseProbe);

    expect(result?.untouched).toHaveLength(MAX_UNTOUCHED_PROBES);
  });

  it('accepts Date, ISO and millisecond windows as the same instant', async () => {
    const asIso = await untouchedPathsInCompletion(evidence('packages/real.ts'), SINCE_ISO, baseProbe);
    const asMs = await untouchedPathsInCompletion(evidence('packages/real.ts'), SINCE_SEC * 1000, baseProbe);
    const asDate = await untouchedPathsInCompletion(evidence('packages/real.ts'), new Date(SINCE_SEC * 1000), baseProbe);

    expect(asIso?.since).toBe(SINCE_ISO);
    expect(asMs?.since).toBe(SINCE_ISO);
    expect(asDate?.since).toBe(SINCE_ISO);
  });

  // ── The grace constant ───────────────────────────────────────────────────────────────

  it('keeps a grace that strictly covers the git-sync sweep window it must absorb', async () => {
    // The grace exists to absorb TWO sources of boundary error, and must cover the larger.
    // The sweep race is the one the repo already quantifies, so it is the floor: a grace
    // at or below it would accuse edits git-sync simply had not swept yet. The rest of the
    // margin is for work that predates its own work-item, which no constant bounds — see
    // the measurement recorded on UNTOUCHED_GRACE_SEC for why it is set at a day.
    expect(UNTOUCHED_GRACE_SEC).toBeGreaterThan(LANDING_RACE_WINDOW_SEC);
    expect(UNTOUCHED_GRACE_SEC).toBe(24 * 60 * 60);
  });
});

/**
 * WI-10002704. The default probes run inside `work_items:complete` on the shared operator
 * process, where a synchronous git spawn froze EVERY request on :3070 for up to 5s per
 * completion. These exercise the REAL default probes against a throwaway repo.
 */
describe('default git probes never block the event loop (WI-10002704)', () => {
  let dir = '';
  let repo = '';
  const isolatedGitEnv = (sec?: number) => ({
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    ...(sec === undefined ? {} : { GIT_AUTHOR_DATE: `@${sec} +0000`, GIT_COMMITTER_DATE: `@${sec} +0000` }),
  });
  const commitFileAt = (sec: number, file: string, body: string) => {
    writeFileSync(join(repo, file), body);
    const env = isolatedGitEnv(sec);
    execFileSync('git', ['-C', repo, 'add', file], { env, stdio: 'ignore' });
    execFileSync(
      'git',
      ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', 'commit', '-q', '--no-verify', '-m', file],
      { env, stdio: 'ignore' },
    );
  };
  /** A git stand-in whose bash `body` runs first, so a test controls timing and output. */
  const fakeGit = (name: string, body: string): string => {
    const path = join(dir, name);
    writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(path, 0o755);
    return path;
  };
  // Emits one history record for a.ts, then stalls as if still walking a long history.
  const STALLING_WALK = "printf '__PAPERCUSP_LAST_COMMIT__1700000500\\0\\na.ts\\0'\nexec sleep 30";

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'untouched-paths-git-'));
    repo = join(dir, 'repo');
    mkdirSync(repo);
    execFileSync('git', ['-C', repo, 'init', '-q'], { env: isolatedGitEnv(), stdio: 'ignore' });
    commitFileAt(1_700_000_000, 'a.ts', 'one');
    commitFileAt(1_700_000_100, 'b.ts', 'two');
    commitFileAt(1_700_000_200, 'a.ts', 'three');
    writeFileSync(join(repo, 'c.ts'), 'never committed');
  });
  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('reads each path’s newest commit from real git, null for a path with no history', async () => {
    const result = await lastCommitAtManyViaGit(repo, ['a.ts', 'b.ts', 'c.ts']);
    expect(Object.fromEntries(result)).toEqual({ 'a.ts': 1_700_000_200, 'b.ts': 1_700_000_100, 'c.ts': null });
  });

  it('reads dirtiness from real git, an untracked file counting as dirty', async () => {
    const result = await isDirtyManyViaGit(repo, ['a.ts', 'c.ts']);
    expect(Object.fromEntries(result)).toEqual({ 'a.ts': false, 'c.ts': true });
  });

  it('still flags a real clean path committed before the window, through the default probes', async () => {
    const since = 1_700_000_200 + 2 * UNTOUCHED_GRACE_SEC;
    const result = await untouchedPathsInCompletion(evidence('a.ts'), since, { repoRoots: [repo] });
    expect(result?.untouched).toEqual([
      { path: 'a.ts', lastCommitAt: new Date(1_700_000_200 * 1000).toISOString() },
    ]);
  });

  it('hands the event loop back while git runs: a 400ms git must not stall the caller', async () => {
    const slowGit = fakeGit('slow-git', 'sleep 0.4\nexec git "$@"');
    let ticks = 0;
    const timer = setInterval(() => {
      ticks += 1;
    }, 20);
    try {
      let t0 = performance.now();
      const commits = lastCommitAtManyViaGit(repo, ['a.ts'], { gitBinary: slowGit });
      const commitsBlockedMs = performance.now() - t0;
      t0 = performance.now();
      const dirty = isDirtyManyViaGit(repo, ['a.ts'], { gitBinary: slowGit });
      const dirtyBlockedMs = performance.now() - t0;
      const [commitsResult, dirtyResult] = await Promise.all([commits, dirty]);
      // A synchronous spawn would hold the caller for the whole 400ms and starve the timer.
      expect(commitsBlockedMs).toBeLessThan(200);
      expect(dirtyBlockedMs).toBeLessThan(200);
      expect(ticks).toBeGreaterThanOrEqual(5);
      expect(commitsResult.get('a.ts')).toBe(1_700_000_200);
      expect(dirtyResult.get('a.ts')).toBe(false);
    } finally {
      clearInterval(timer);
    }
  });

  it('stops the history walk once every requested path is seen, instead of reading to the root', async () => {
    const stalling = fakeGit('stalling-git', STALLING_WALK);
    const t0 = performance.now();
    const result = await lastCommitAtManyViaGit(repo, ['a.ts'], { gitBinary: stalling, timeoutMs: 20_000 });
    expect(performance.now() - t0).toBeLessThan(3_000);
    expect(result.get('a.ts')).toBe(1_700_000_500);
  });

  it('on a timeout keeps the paths already seen and reports the rest as unknown, never as no-history', async () => {
    const stalling = fakeGit('stalling-git-2', STALLING_WALK);
    const result = await lastCommitAtManyViaGit(repo, ['a.ts', 'b.ts'], { gitBinary: stalling, timeoutMs: 300 });
    expect(result.get('a.ts')).toBe(1_700_000_500);
    expect(result.has('b.ts')).toBe(true);
    expect(result.get('b.ts')).toBeUndefined();
  });

  it('answers unknown for every path when git cannot run at all', async () => {
    const missing = join(dir, 'no-such-git');
    const commits = await lastCommitAtManyViaGit(repo, ['a.ts'], { gitBinary: missing });
    const dirty = await isDirtyManyViaGit(repo, ['a.ts'], { gitBinary: missing });
    expect(commits.has('a.ts')).toBe(true);
    expect(commits.get('a.ts')).toBeUndefined();
    expect(dirty.has('a.ts')).toBe(true);
    expect(dirty.get('a.ts')).toBeUndefined();
  });

  it('the module makes no synchronous child_process call', () => {
    const source = readFileSync(new URL('./untouched-paths.ts', import.meta.url), 'utf8');
    const code = stripCommentsAndStrings(source, 'untouched-paths.ts');
    // Positive control: the stripped code still carries the async spawn, so a broken or
    // empty strip cannot pass the negative assertion vacuously.
    expect(code).toMatch(/\bspawn\(/);
    expect(code).not.toMatch(/\b(execFileSync|execSync|spawnSync)\b/);
  });
});
