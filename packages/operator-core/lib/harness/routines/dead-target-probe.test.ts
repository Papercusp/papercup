/**
 * Tests for the dead-target probe (dead-target-routine-reaper-2026-08-30 P-002).
 *
 * The git cases build REAL repositories in `os.tmpdir()` and corrupt them for real, rather than
 * mocking `execFile`. A mock would only prove that this file's regexes match strings this file
 * also wrote — it could not catch the thing most likely to be wrong, which is whether git
 * actually emits text those regexes match. Building the corruption is cheap (one init, one
 * commit, one truncate) and it is the only version of this test that can fail for the right
 * reason.
 *
 * Temp trees live outside the repo checkout deliberately: git-sync sweeps the whole working
 * tree every few minutes, so a deliberately-corrupted fixture created inside it could be
 * committed before the test finishes cleaning up.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync, readdirSync, truncateSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

import {
  existsTriState,
  looksCorrupt,
  looksLikeNoRepo,
  probeGitObjectStore,
  probeTarget,
  resolveTarget,
} from './dead-target-probe';

const made: string[] = [];
function scratch(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), `dead-target-${prefix}-`));
  made.push(d);
  return d;
}
afterAll(() => {
  for (const d of made) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, {
    cwd,
    stdio: 'pipe',
    // WI-41180: bound every sync spawn in the pure lane — it blocks the shared worker's
    // event loop, so vitest cannot time it out and one hang wedges the whole lane.
    timeout: 60_000,
    killSignal: 'SIGKILL',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'probe-test', GIT_AUTHOR_EMAIL: 'probe@test.invalid',
      GIT_COMMITTER_NAME: 'probe-test', GIT_COMMITTER_EMAIL: 'probe@test.invalid',
      GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
    },
  });
}

/** A real one-commit repository with loose (unpacked) objects. */
function healthyRepo(prefix: string): string {
  const d = scratch(prefix);
  git(d, 'init', '--quiet', '-b', 'main');
  writeFileSync(join(d, 'blueprint.yaml'), 'kind: pot\n');
  git(d, 'add', '-A');
  git(d, 'commit', '--quiet', '-m', 'seed');
  return d;
}

describe('existsTriState — false means observed absence, null means could not tell', () => {
  it('true for a path that exists', () => {
    expect(existsTriState(scratch('exists'))).toBe(true);
  });

  it('false for ENOENT', () => {
    expect(existsTriState(join(scratch('enoent'), 'nope', 'still-nope'))).toBe(false);
  });

  it('false for ENOTDIR — a path whose parent is a file', () => {
    const d = scratch('enotdir');
    writeFileSync(join(d, 'afile'), 'x');
    expect(existsTriState(join(d, 'afile', 'under-a-file'))).toBe(false);
  });
});

describe('looksCorrupt / looksLikeNoRepo — the classifier boundary', () => {
  it('matches the real ei669 error text', () => {
    // Verbatim from harness_shared.routines metadata.last_error on ei669-repro-su-b621d.
    expect(looksCorrupt("superproject: commit failed: error: invalid object 100644 d75c463ae71a1031fc95c9 for '.papercusp/blueprint.yaml'")).toBe(true);
  });

  it('matches the other object-store failure phrasings', () => {
    expect(looksCorrupt('fatal: could not get object info for HEAD')).toBe(true);
    expect(looksCorrupt('error: object file .git/objects/ab/cdef is empty')).toBe(true);
    expect(looksCorrupt('fatal: bad object HEAD')).toBe(true);
  });

  it('does NOT treat an absent repository as corruption', () => {
    const noRepo = 'fatal: not a git repository (or any of the parent directories): .git';
    expect(looksCorrupt(noRepo)).toBe(false);
    expect(looksLikeNoRepo(noRepo)).toBe(true);
  });

  it('does NOT treat ordinary git errors as corruption', () => {
    // Over-matching here turns a routine git error into a park — the exact failure mode the
    // whole design is arranged to avoid, so these are asserted individually.
    expect(looksCorrupt("error: pathspec 'nope' did not match any file(s) known to git")).toBe(false);
    expect(looksCorrupt('fatal: your current branch does not have any commits yet')).toBe(false);
    expect(looksCorrupt('error: failed to push some refs')).toBe(false);
    expect(looksCorrupt('')).toBe(false);
    expect(looksCorrupt(null)).toBe(false);
  });
});

describe('probeGitObjectStore — against real repositories', () => {
  it('reports readable for a healthy repo', async () => {
    const r = await probeGitObjectStore(healthyRepo('healthy'));
    expect(r.state).toBe('readable');
    expect(r.error).toBeNull();
  });

  it('reports absent for a directory with no .git', async () => {
    const r = await probeGitObjectStore(scratch('bare-dir'));
    expect(r.state).toBe('absent');
  });

  it('reports corrupt for a repo whose commit object is unreadable', async () => {
    // The real shape of the ei669 failure: the object file is present in the store but its
    // contents cannot be read. Truncating a loose object reproduces it without any mocking.
    const d = healthyRepo('corrupt');
    const objRoot = join(d, '.git', 'objects');
    let truncated = 0;
    for (const bucket of readdirSync(objRoot)) {
      if (!/^[0-9a-f]{2}$/.test(bucket)) continue;
      for (const f of readdirSync(join(objRoot, bucket))) {
        const p = join(objRoot, bucket, f);
        // Git writes loose objects read-only (0444), so they must be made writable before
        // they can be corrupted — the object store is mildly tamper-resistant by design.
        chmodSync(p, 0o600);
        truncateSync(p, 0);
        truncated++;
      }
    }
    expect(truncated).toBeGreaterThan(0); // calibration: we actually corrupted something

    const r = await probeGitObjectStore(d);
    expect(r.state).toBe('corrupt');
    expect(r.error).toBeTruthy();
  });

  it('does NOT report corrupt for a freshly-init repo with an unborn HEAD', async () => {
    // `rev-parse --verify HEAD` exits non-zero here, and a naive "non-zero implies corrupt"
    // would park a brand-new, perfectly healthy pot.
    const d = scratch('unborn');
    git(d, 'init', '--quiet', '-b', 'main');
    const r = await probeGitObjectStore(d);
    expect(r.state).not.toBe('corrupt');
  });

  it('reports unknown, never corrupt, when the git call times out', async () => {
    // A tiny budget against REAL git is a race, not a timeout: on a loaded box the timer can
    // fire only after git has already exited, so execFile reports success and the probe says
    // `readable` (gate red at repairHead 69b1f61f, 2026-10-02). A git that cannot finish makes
    // the timeout the only possible outcome, so this asserts the classification, not the race.
    const repo = healthyRepo('timeout');
    // Calibration: with real git the same repo is readable, so `unknown` below is the timeout.
    expect((await probeGitObjectStore(repo)).state).toBe('readable');

    const bin = scratch('slow-git-bin');
    writeFileSync(join(bin, 'git'), '#!/bin/sh\nexec sleep 30\n');
    chmodSync(join(bin, 'git'), 0o755);
    const prevPath = process.env.PATH;
    process.env.PATH = `${bin}${delimiter}${prevPath ?? ''}`;
    try {
      const r = await probeGitObjectStore(repo, 200);
      expect(r.state).toBe('unknown');
      expect(r.error).toMatch(/timed out after 200ms/);
    } finally {
      process.env.PATH = prevPath;
    }
  });
});

describe('resolveTarget — never claims a resolution it did not get', () => {
  it('does not resolve a slug that cannot exist, and says which kind of not-resolved it is', async () => {
    const r = await resolveTarget('definitely-not-a-registered-install-slug-8f2c1a', 'papercusp-workspace');
    expect(r.kind).not.toBe('resolved');
    // Whichever it is, it must be one of the two non-committal kinds — never a silent
    // fabrication, and never collapsed into a single falsy "no path".
    expect(['unresolvable', 'read-failed']).toContain(r.kind);
  });
});

describe('probeTarget — never throws, and never over-reports absence', () => {
  it('returns a non-committal probe for an unresolvable slug rather than throwing', async () => {
    const p = await probeTarget('definitely-not-a-registered-install-slug-8f2c1a', 'papercusp-workspace');
    expect(p.installSlug).toBe('definitely-not-a-registered-install-slug-8f2c1a');
    expect(p.resolution.kind).not.toBe('resolved');
    // Crucially: it must NOT claim the root is absent. It never looked at a root.
    expect(p.rootExists).toBeUndefined();
  });
});
