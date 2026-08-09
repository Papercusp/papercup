import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  classifySourcePath,
  filterInstallSources,
  describeRefusals,
} from './install-source-guard';

/**
 * Paths are DERIVED from os.homedir(), never hardcoded — a literal build-box home in
 * shipped source reds the green-checkpoint identity-lint leg and freezes `main` for the
 * whole fleet, and it is wrong on every machine but one anyway.
 */
const HOME = os.homedir();
const WORKSPACE = path.join(HOME, 'papercupai-workspace');

/**
 * The real canonical source shapes on this fleet. These are POSITIVE CONTROLS and they
 * are the most important assertions in the file.
 *
 * This guard runs on every operator boot, so a false positive here does not fail one
 * feature — it stops all hook installs fleet-wide, which is strictly worse than the
 * bug the guard prevents. Any future widening of the marker set must keep these green.
 */
const CANONICAL_SOURCES = [
  path.join(WORKSPACE, 'papercusp/apps/operator/scripts/hooks/cc'),
  path.join(WORKSPACE, 'papercusp/apps/operator/scripts/hooks/inject'),
  path.join(WORKSPACE, 'papercusp/apps/operator/prompts'),
  path.join(WORKSPACE, 'papercup-release/apps/operator/scripts/hooks/cc'),
  '/Applications/Papercusp.app/Contents/Resources/sidecar/scripts/hooks/cc',
  '/opt/papercusp/sidecar/scripts/hooks/cc',
];

/**
 * A canonical path whose directory NAME merely CONTAINS a marker token. Not home-shaped
 * on purpose: `/home/<name>` literals in shipped source trip the identity lint.
 */
const INNOCENT_TOKEN_PATH = '/srv/gym-probe-fan/papercusp/apps/operator/scripts/hooks/cc';

/** The exact tree shapes that produced the live incident (EI-19956921121874213). */
const GYM_PROBE_SOURCES = [
  path.join(WORKSPACE, '.gym-probe/work/apps/operator/scripts/hooks/cc'),
  path.join(WORKSPACE, '.gym-probe/repro/apps/operator/scripts/hooks/cc'),
  path.join(WORKSPACE, '.gym-probe/substrate/apps/operator/scripts/hooks/cc'),
];

describe('classifySourcePath — positive controls (a false positive here is fleet-wide breakage)', () => {
  it.each(CANONICAL_SOURCES)('accepts the canonical source %s', (p) => {
    expect(classifySourcePath(p)).toEqual({ scratch: false });
  });

  it('accepts a repo-internal directory merely NAMED tmp', () => {
    // `tmp-root` is anchored at the path root precisely so this passes.
    expect(classifySourcePath(path.join(WORKSPACE, 'papercusp/packages/x/tmp/hooks'))).toEqual({
      scratch: false,
    });
  });

  it('accepts a canonical path under a directory whose NAME merely contains a marker token', () => {
    // Segment matching, not substring-over-the-whole-path: an installation unlucky
    // enough to sit under a directory named "gym-probe-fan" must not lose hook installs.
    expect(classifySourcePath(INNOCENT_TOKEN_PATH)).toEqual({ scratch: false });
  });

  it('accepts a path containing a `worktrees` segment NOT under .papercusp', () => {
    expect(
      classifySourcePath(path.join(HOME, 'worktrees/papercusp/apps/operator/prompts')),
    ).toEqual({ scratch: false });
  });
});

describe('classifySourcePath — refusals', () => {
  it.each(GYM_PROBE_SOURCES)('refuses the live incident source %s', (p) => {
    const v = classifySourcePath(p);
    expect(v.scratch).toBe(true);
    if (v.scratch) expect(v.marker).toBe('.gym-probe');
  });

  it('refuses a -simtmp- checkpoint tree', () => {
    const v = classifySourcePath(
      path.join(WORKSPACE, 'papercusp-checkpoint-simtmp-a1b2/apps/operator/prompts'),
    );
    expect(v.scratch).toBe(true);
    if (v.scratch) expect(v.marker).toBe('-simtmp-');
  });

  it('refuses an agent isolation worktree under .papercusp/worktrees', () => {
    const v = classifySourcePath(
      path.join(HOME, '.papercusp/worktrees/migration-x/apps/operator/scripts/hooks/cc'),
    );
    expect(v.scratch).toBe(true);
    if (v.scratch) expect(v.marker).toBe('.papercusp/worktrees');
  });

  it.each(['/tmp/build/apps/operator/prompts', '/private/tmp/x/prompts', '/var/tmp/y/prompts'])(
    'refuses temp root %s',
    (p) => {
      const v = classifySourcePath(p);
      expect(v.scratch).toBe(true);
      if (v.scratch) expect(v.marker).toBe('tmp-root');
    },
  );

  it('normalises before matching, so traversal cannot smuggle a scratch path through', () => {
    const sneaky = path.join(WORKSPACE, 'papercusp/../.gym-probe/work/prompts');
    expect(classifySourcePath(sneaky).scratch).toBe(true);
  });
});

describe('filterInstallSources', () => {
  const SHARED_DEST = HOME;

  it('drops the scratch candidate and keeps the canonical one, preserving order', () => {
    const candidates = [GYM_PROBE_SOURCES[0], CANONICAL_SOURCES[0], CANONICAL_SOURCES[1]];
    const r = filterInstallSources(candidates, { dest: SHARED_DEST });
    expect(r.accepted).toEqual([CANONICAL_SOURCES[0], CANONICAL_SOURCES[1]]);
    expect(r.refused).toHaveLength(1);
    expect(r.refused[0].marker).toBe('.gym-probe');
  });

  it('returns an EMPTY accepted list when every candidate is scratch — never invents a source', () => {
    // The caller must then install NOTHING and log. Leaving the existing files on disk
    // is always safer than overwriting them with sandbox content.
    const r = filterInstallSources(GYM_PROBE_SOURCES, { dest: SHARED_DEST });
    expect(r.accepted).toEqual([]);
    expect(r.refused).toHaveLength(3);
  });

  it('is a no-op when every candidate is canonical (the overwhelmingly common boot)', () => {
    const r = filterInstallSources(CANONICAL_SOURCES, { dest: SHARED_DEST });
    expect(r.accepted).toEqual(CANONICAL_SOURCES);
    expect(r.refused).toEqual([]);
    expect(describeRefusals('cc hooks', r)).toBeNull();
  });

  it('ALLOWS a scratch source when the dest is itself scratch (isolated gym writing into itself)', () => {
    const r = filterInstallSources(GYM_PROBE_SOURCES, {
      dest: path.join(WORKSPACE, '.gym-probe/work/home'),
    });
    expect(r.destIsScratch).toBe(true);
    expect(r.accepted).toEqual(GYM_PROBE_SOURCES);
    // Still reported, so the log says what happened and why.
    expect(r.refused).toHaveLength(3);
    expect(describeRefusals('cc hooks', r)).toContain('ALLOWING');
  });

  it('passes scratch through under the explicit escape hatch, still reporting it', () => {
    const r = filterInstallSources(GYM_PROBE_SOURCES, { dest: SHARED_DEST, allowScratch: true });
    expect(r.accepted).toEqual(GYM_PROBE_SOURCES);
    expect(r.refused).toHaveLength(3);
  });

  it('names the refused candidate and its marker in the log line', () => {
    const r = filterInstallSources([GYM_PROBE_SOURCES[0], CANONICAL_SOURCES[0]], {
      dest: SHARED_DEST,
    });
    const line = describeRefusals('cc hooks', r);
    expect(line).toContain('REFUSED');
    expect(line).toContain('.gym-probe');
    expect(line).toContain(GYM_PROBE_SOURCES[0]);
  });
});

/**
 * FALSIFIABILITY CONTROL (CLAUDE.md "Proving a guard is falsifiable", tier 1).
 *
 * A guard test that has never failed is a guard you have not tested. Rather than
 * mutating the real module to prove these assertions can fail — which on this shared
 * tree risks git-sync committing the mutant — a deliberately broken classifier lives
 * here PERMANENTLY as a control.
 *
 * `brokenClassify` is the most plausible wrong implementation of this guard: naive
 * substring matching over the whole path instead of segment matching. It is exactly
 * what someone "simplifying" this module would reach for.
 */
function brokenClassify(candidate: string): { scratch: boolean } {
  return { scratch: candidate.includes('gym-probe') };
}

describe('falsifiability control — a naive substring guard must FAIL these assertions', () => {
  it('the broken classifier false-positives on a canonical path, where the real one does not', () => {
    const innocent = INNOCENT_TOKEN_PATH;
    // The control is wrong...
    expect(brokenClassify(innocent).scratch).toBe(true);
    // ...and the real implementation is right. If these two ever agree, the guard has
    // regressed to substring matching and the positive controls above are load-bearing.
    expect(classifySourcePath(innocent).scratch).toBe(false);
  });

  it('the broken classifier misses the non-gym markers the real one catches', () => {
    const simtmp = path.join(WORKSPACE, 'papercusp-checkpoint-simtmp-a1b2/apps/operator/prompts');
    expect(brokenClassify(simtmp).scratch).toBe(false);
    expect(classifySourcePath(simtmp).scratch).toBe(true);
  });

  it('calibration: the real classifier still catches what the broken one catches', () => {
    // Without this, the two tests above would also pass if classifySourcePath were
    // hard-wired to return { scratch: false } for everything.
    expect(brokenClassify(GYM_PROBE_SOURCES[0]).scratch).toBe(true);
    expect(classifySourcePath(GYM_PROBE_SOURCES[0]).scratch).toBe(true);
  });
});

describe('platform assumption', () => {
  it('is written for POSIX separators, which is what this guard runs under', () => {
    // Documented rather than asserted-away: the installer targets macOS/Linux and WSL.
    expect(path.sep).toBe('/');
  });
});
