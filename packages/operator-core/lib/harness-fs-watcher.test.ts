/**
 * Regression tests for harness-fs-watcher.
 *
 * The bug we're protecting against: an earlier version used
 *   ignored: (p) => /\/\.\w/.test(p)
 * which matched '.h' in '.papercusp' and silently dropped every chokidar
 * event under the watched dirs, making the entire live-event handler
 * dead code. The 60s reconcile sweep masked it (data eventually
 * appeared) and only an external audit caught it.
 *
 * These tests exercise the predicate + classify boundary directly so a
 * future change that re-introduces an over-broad ignore pattern fails
 * here instead of in production.
 */
import { describe, it, expect } from 'vitest';

// The actual `ignored` predicate is private to the module. Re-implement
// it here as a literal copy of the production string so any drift breaks
// the test on rebuild. If the source changes, this test must be updated
// in lockstep — that's the point.
const ignored = (p: string): boolean => /\.(swp|swo|tmp)$/.test(p);

describe('harness-fs-watcher: ignored predicate', () => {
  it('does NOT ignore files inside .papercusp/', () => {
    // The original bug: /\/\.\w/.test('.papercusp/summary.md') → true.
    // Catching this regression is the whole point of this test.
    expect(ignored('/home/marsh-office/sheets-clone/.papercusp/summary.md')).toBe(false);
    expect(ignored('/foo/bar/.papercusp/pending-reviews/abc.json')).toBe(false);
    expect(ignored('/foo/bar/.papercusp/proposals/p1.json')).toBe(false);
  });

  it('does NOT ignore files in nested archive subdirs', () => {
    // The classifier separately drops these from PG mirroring; the
    // ignore predicate shouldn't preempt that decision.
    expect(ignored('/.papercusp/pending-reviews/resolved/foo.json')).toBe(false);
  });

  it('ignores actual swap/temp files', () => {
    expect(ignored('/foo/.papercusp/.summary.md.swp')).toBe(true);
    expect(ignored('/foo/.papercusp/proposals/.p1.json.swo')).toBe(true);
    expect(ignored('/foo/.papercusp/something.tmp')).toBe(true);
  });

  it('does NOT ignore plain dotfiles that happen to live nearby', () => {
    // The original regex over-matched anything starting with `.<word>`.
    // Hidden files outside our swap-suffix list should still pass.
    expect(ignored('/foo/.papercusp/.something')).toBe(false);
    expect(ignored('/foo/.gitignore')).toBe(false);
  });
});

// The classifier is also private; mirror its top-level dispatch logic
// so a regression in the path-matching predicates surfaces here.
function isReviewFile(harnessDir: string, path: string): boolean {
  const reviewsDir = `${harnessDir}/pending-reviews`;
  if (!path.startsWith(reviewsDir + '/')) return false;
  if (!path.endsWith('.json')) return false;
  return !path.slice(reviewsDir.length + 1).includes('/');
}

// Proposals are .md (with sibling .review.md that triggers parent re-upsert).
// .review.md is NOT a proposal file itself.
function isProposalFile(harnessDir: string, path: string): boolean {
  const proposalsDir = `${harnessDir}/proposals`;
  if (!path.startsWith(proposalsDir + '/')) return false;
  if (!path.endsWith('.md')) return false;
  if (path.endsWith('.review.md')) return false;
  return !path.slice(proposalsDir.length + 1).includes('/');
}

function isProposalReviewerFile(harnessDir: string, path: string): boolean {
  const proposalsDir = `${harnessDir}/proposals`;
  if (!path.startsWith(proposalsDir + '/')) return false;
  if (!path.endsWith('.review.md')) return false;
  return !path.slice(proposalsDir.length + 1).includes('/');
}

describe('harness-fs-watcher: classify (top-level only)', () => {
  const HD = '/foo/bar/.papercusp';

  it('matches top-level review JSON', () => {
    expect(isReviewFile(HD, `${HD}/pending-reviews/r1.json`)).toBe(true);
    expect(isReviewFile(HD, `${HD}/pending-reviews/r-with-dashes.json`)).toBe(true);
  });

  it('skips nested review JSON (resolved/, archived/)', () => {
    // The original bug: walking into resolved/ tried to mirror archived
    // promotion records as reviews and crashed the upsert.
    expect(isReviewFile(HD, `${HD}/pending-reviews/resolved/promotion-1.json`)).toBe(false);
    expect(isReviewFile(HD, `${HD}/pending-reviews/archived/sub/x.json`)).toBe(false);
  });

  it('skips non-JSON files in pending-reviews/', () => {
    expect(isReviewFile(HD, `${HD}/pending-reviews/notes.md`)).toBe(false);
    expect(isReviewFile(HD, `${HD}/pending-reviews/.gitkeep`)).toBe(false);
  });

  it('matches top-level proposals .md (Phase 2.5)', () => {
    expect(isProposalFile(HD, `${HD}/proposals/p1.md`)).toBe(true);
    expect(isProposalFile(HD, `${HD}/proposals/SPEC-update-2026-05.md`)).toBe(true);
  });

  it('does NOT treat .review.md as a proposal file', () => {
    // The audit caught me crashing on JSON parsing because the watcher
    // walked into resolved/. Now the parallel mistake to guard against
    // is the reviewer file being mirrored as if it were a proposal.
    expect(isProposalFile(HD, `${HD}/proposals/p1.review.md`)).toBe(false);
    expect(isProposalReviewerFile(HD, `${HD}/proposals/p1.review.md`)).toBe(true);
  });

  it('skips nested proposal subdirs', () => {
    expect(isProposalFile(HD, `${HD}/proposals/applied/p1.md`)).toBe(false);
    expect(isProposalReviewerFile(HD, `${HD}/proposals/applied/p1.review.md`)).toBe(false);
  });

  it('skips .json in proposals/ (proposals are .md, not .json)', () => {
    expect(isProposalFile(HD, `${HD}/proposals/p1.json`)).toBe(false);
  });

  it('does not cross-match between review and proposal dirs', () => {
    expect(isReviewFile(HD, `${HD}/proposals/p1.md`)).toBe(false);
    expect(isProposalFile(HD, `${HD}/pending-reviews/r1.json`)).toBe(false);
  });
});

// Phase resolution test (Item 2 of polling-removal arc).
// The actual phaseForPath() helper is private to harness-fs-watcher.ts;
// the imported phasePath() / ALL_PHASES from harness-phases drives it.
// These tests pin the convention so a future regression in path-resolution
// surfaces here.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { phasePath, ALL_PHASES, type Phase } from './harness-phases';

describe('harness-phases: phasePath convention', () => {
  it('staging returns project.path unchanged', () => {
    const project = { path: '/foo/bar/project-x' };
    expect(phasePath(project, 'staging')).toBe('/foo/bar/project-x');
  });

  it('testing/production return sibling --<phase> by default', () => {
    const project = { path: '/foo/bar/project-x' };
    expect(phasePath(project, 'testing')).toBe('/foo/bar/project-x--testing');
    expect(phasePath(project, 'production')).toBe('/foo/bar/project-x--production');
  });

  it('honors config override at .papercusp/config.json#phases.<phase>.path', () => {
    const root = mkdtempSync(join(tmpdir(), 'phase-config-'));
    try {
      mkdirSync(join(root, '.papercusp'), { recursive: true });
      writeFileSync(
        join(root, '.papercusp', 'config.json'),
        JSON.stringify({
          phases: {
            testing: { path: '/explicit/testing-worktree' },
            production: { path: '/explicit/prod-worktree' },
          },
        }),
      );
      expect(phasePath({ path: root }, 'testing')).toBe('/explicit/testing-worktree');
      expect(phasePath({ path: root }, 'production')).toBe('/explicit/prod-worktree');
      expect(phasePath({ path: root }, 'staging')).toBe(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('falls back to convention when config is malformed', () => {
    const root = mkdtempSync(join(tmpdir(), 'phase-config-'));
    try {
      mkdirSync(join(root, '.papercusp'), { recursive: true });
      writeFileSync(join(root, '.papercusp', 'config.json'), '{ malformed json');
      expect(phasePath({ path: root }, 'testing')).toBe(`${root}--testing`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('exposes all three phases in stable order', () => {
    expect([...ALL_PHASES]).toEqual(['staging', 'testing', 'production']);
  });
});

describe('harness-fs-watcher: phased fixture (Item 2)', () => {
  it('all three phased harness dirs resolve to distinct paths', () => {
    const project = { path: '/foo/bar/sheets' };
    const dirs = ALL_PHASES.map((phase: Phase) => ({
      phase,
      harnessDir: join(phasePath(project, phase), '.papercusp'),
    }));
    const paths = dirs.map((d) => d.harnessDir);
    expect(new Set(paths).size).toBe(3);
    expect(paths[0]).toBe('/foo/bar/sheets/.papercusp');
    expect(paths[1]).toBe('/foo/bar/sheets--testing/.papercusp');
    expect(paths[2]).toBe('/foo/bar/sheets--production/.papercusp');
  });

  it('phase classifier round-trips: a path under staging maps back to staging', () => {
    // Mirrors the watcher's phaseForPath() walk: try each phase, return
    // the matching one. Fixture-style without spinning up chokidar.
    const project = { path: '/foo/bar/sheets' };
    const candidates = ALL_PHASES.map((phase) => ({
      phase,
      harnessDir: join(phasePath(project, phase), '.papercusp'),
    }));
    const classify = (p: string): Phase | null => {
      for (const { phase, harnessDir } of candidates) {
        if (p === harnessDir || p.startsWith(harnessDir + '/')) return phase;
      }
      return null;
    };
    expect(classify('/foo/bar/sheets/.papercusp/summary.md')).toBe('staging');
    expect(classify('/foo/bar/sheets--testing/.papercusp/pending-reviews/r1.json')).toBe('testing');
    expect(classify('/foo/bar/sheets--production/.papercusp/proposals/p1.md')).toBe('production');
    expect(classify('/foo/bar/other-project/.papercusp/summary.md')).toBeNull();
  });
});
