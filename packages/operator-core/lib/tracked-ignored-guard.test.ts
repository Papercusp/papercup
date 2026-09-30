/**
 * Falsifiability tests for scripts/check-tracked-ignored.mjs (WI-10002095).
 *
 * The guard is the GENERAL form of lint:no-tracked-node-modules (WI-39630) and
 * lint:no-tracked-src-entry-dist (WI-10002064): a tracked path that a REPO-sourced
 * .gitignore rule also matches is inert-ignored, so nothing errors — until churn deletes
 * the file, git-sync hands git an explicit pathspec for an ignored path, git refuses
 * ("use -f"), and that repo's whole sync leg dies every tick. Measured population at the
 * time of filing: 1,969 superproject paths across four classes no class-specific guard saw.
 *
 * TWO traps make this guard easy to write and impossible to trust:
 *
 *  1. The intuitive probe `git ls-files | git check-ignore --stdin` is a TAUTOLOGY —
 *     check-ignore consults the index, where a tracked file is never ignored, so it reports
 *     a clean zero that reads exactly like "no contradictions". The REAL-TEMP-REPO cases
 *     below pin that the guard's own probe (`ls-files -i -c` + `check-ignore --no-index -v`)
 *     actually sees a tracked-and-ignored path, AND that the naive probe does not — so a
 *     future "simplification" to the naive form fails here instead of going quietly blind.
 *  2. After the untrack the real-tree population is EMPTY, so the script passes without
 *     exercising a single offender. These calibration cases are therefore the only thing
 *     standing between "the guard works" and "the guard cannot fail". They build a throwaway
 *     repo under os.tmpdir() — they never mutate the shared tree, so there is no sweep race
 *     and no restore to forget.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  ALLOWLIST,
  discoverRepos,
  findOffenders,
  isRepoSourced,
  listTrackedIgnored,
  parseCheckIgnoreVerbose,
  // @ts-expect-error — .mjs guard script, no type declarations by design (as with sibling guards)
} from '../../../scripts/check-tracked-ignored.mjs';

type Row = { source: string; line: string; pattern: string; path: string };

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

const git = (cwd: string, args: string[], input?: string) =>
  spawnSync('git', args, { cwd, input, encoding: 'utf8' });

describe('parseCheckIgnoreVerbose', () => {
  it('parses NUL-terminated (source, line, pattern, path) tuples', () => {
    const rows = parseCheckIgnoreVerbose(
      ['.gitignore', '3', '*.log', 'a.log', 'sub/.gitignore', '7', 'out/', 'out/x.js', ''].join('\0'),
    );
    expect(rows).toEqual([
      { source: '.gitignore', line: '3', pattern: '*.log', path: 'a.log' },
      { source: 'sub/.gitignore', line: '7', pattern: 'out/', path: 'out/x.js' },
    ]);
  });

  it('returns no rows for empty output — and never a half-row from a truncated tuple', () => {
    expect(parseCheckIgnoreVerbose('')).toEqual([]);
    expect(parseCheckIgnoreVerbose(['.gitignore', '3', '*.log'].join('\0'))).toEqual([]);
  });
});

describe('isRepoSourced — only a RELATIVE .gitignore is a repo opinion', () => {
  it.each([
    ['.gitignore', true],
    ['sub/dir/.gitignore', true],
    ['libs/generic/x/.gitignore', true],
  ])('%s is repo-sourced', (source, expected) => {
    expect(isRepoSourced(source)).toBe(expected);
  });

  it.each([
    // .git/info/exclude is a checkout-specific opinion — the next clone does not share it.
    '.git/info/exclude',
    '../../.git/modules/foo/info/exclude',
    '/abs/path/.git/info/exclude',
    // The user's global excludesFile, including one that happens to be NAMED .gitignore.
    '/home/u/.config/git/ignore',
    '/home/u/.gitignore',
  ])('%s is machine-local, not actionable', (source) => {
    expect(isRepoSourced(source)).toBe(false);
  });
});

describe('findOffenders', () => {
  const row = (path: string): Row => ({ source: '.gitignore', line: '1', pattern: 'x', path });

  it('CALIBRATION: flags a repo that tracks an ignored path', () => {
    const offenders = findOffenders({
      repos: ['.'],
      listOffenders: () => [row('a.log')],
      allowlist: new Set(),
    });
    expect(offenders).toHaveLength(1);
    expect(offenders[0].repo).toBe('.');
    expect(offenders[0].rows.map((r: Row) => r.path)).toEqual(['a.log']);
  });

  it('passes a repo with no offenders, including a null probe result', () => {
    expect(findOffenders({ repos: ['.'], listOffenders: () => [], allowlist: new Set() })).toEqual([]);
    expect(findOffenders({ repos: ['.'], listOffenders: () => null, allowlist: new Set() })).toEqual([]);
  });

  it('spans submodules — each repo is reported under its own name', () => {
    // A submodule carries its own index AND its own ignore rules, so a superproject-only scan
    // certifies a tree whose submodules contradict their own .gitignore.
    const offenders = findOffenders({
      repos: ['.', 'libs/generic/a', 'libs/generic/b'],
      listOffenders: (repo: string) => (repo === '.' ? [] : [row(`${repo}/x.log`)]),
      allowlist: new Set(),
    });
    expect(offenders.map((o: { repo: string }) => o.repo)).toEqual(['libs/generic/a', 'libs/generic/b']);
  });

  it('counts every path so the report cannot understate the blast radius', () => {
    const rows = Array.from({ length: 1969 }, (_, i) => row(`.next/f${i}.js`));
    const offenders = findOffenders({ repos: ['.'], listOffenders: () => rows, allowlist: new Set() });
    expect(offenders[0].rows).toHaveLength(1969);
  });

  it('honors the allowlist, keyed <repo>:<path>', () => {
    const args = { repos: ['.'], listOffenders: () => [row('keep.log'), row('drop.log')] };
    const kept = findOffenders({ ...args, allowlist: new Set(['.:keep.log']) });
    expect(kept[0].rows.map((r: Row) => r.path)).toEqual(['drop.log']);
    expect(findOffenders({ ...args, allowlist: new Set(['.:keep.log', '.:drop.log']) })).toEqual([]);
  });

  it('ships with an EMPTY allowlist — an entry re-arms an inert ignore rule', () => {
    expect([...ALLOWLIST]).toEqual([]);
  });
});

describe('listTrackedIgnored against a REAL throwaway repo', () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'tracked-ignored-guard-'));
    expect(git(dir, ['init', '-q']).status).toBe(0);
    writeFileSync(join(dir, '.gitignore'), '*.tia-repo-rule\nbuild-out/\n');
    // A machine-local rule: .git/info/exclude is never shared by a clone.
    writeFileSync(join(dir, '.git', 'info', 'exclude'), '*.tia-local-rule\n');
    writeFileSync(join(dir, 'keep.txt'), 'ordinary tracked file\n');
    writeFileSync(join(dir, 'a.tia-repo-rule'), 'ignored by a repo rule, forced into the index\n');
    mkdirSync(join(dir, 'build-out'));
    writeFileSync(join(dir, 'build-out', 'bundle.js'), '// generated\n');
    writeFileSync(join(dir, 'b.tia-local-rule'), 'ignored by a machine-local rule only\n');
    // `-f` is precisely how an ignored path becomes tracked.
    expect(git(dir, ['add', '.gitignore', 'keep.txt']).status).toBe(0);
    expect(
      git(dir, ['add', '-f', 'a.tia-repo-rule', 'build-out/bundle.js', 'b.tia-local-rule']).status,
    ).toBe(0);
  });

  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('CALIBRATION: sees a tracked path matched by a repo .gitignore rule', () => {
    const res = listTrackedIgnored(dir);
    const paths = res.offenders.map((r: Row) => r.path).sort();
    expect(paths).toEqual(['a.tia-repo-rule', 'build-out/bundle.js']);
    const byPath = new Map<string, Row>(res.offenders.map((r: Row) => [r.path, r]));
    expect(byPath.get('a.tia-repo-rule')).toMatchObject({ source: '.gitignore', pattern: '*.tia-repo-rule' });
    expect(byPath.get('build-out/bundle.js')).toMatchObject({ source: '.gitignore', pattern: 'build-out/' });
  });

  it('reports a machine-local match APART — it is not an actionable repo contradiction', () => {
    const res = listTrackedIgnored(dir);
    expect(res.machineLocal.map((r: Row) => r.path)).toEqual(['b.tia-local-rule']);
    expect(res.offenders.map((r: Row) => r.path)).not.toContain('b.tia-local-rule');
  });

  it('does not flag an ordinary tracked file', () => {
    const res = listTrackedIgnored(dir);
    const all = [...res.offenders, ...res.machineLocal].map((r: Row) => r.path);
    expect(all).not.toContain('keep.txt');
    expect(all).not.toContain('.gitignore');
  });

  it('INSTRUMENT TRAP: the naive `ls-files | check-ignore` probe is blind to the same repo', () => {
    // If this ever starts returning paths, git changed and the guard can be simplified; until
    // then it pins WHY the guard needs --no-index. The naive probe reads the index, where a
    // tracked file is by definition not ignored, and answers a clean zero.
    const ls = git(dir, ['ls-files', '-z']).stdout;
    const naive = git(dir, ['check-ignore', '-z', '--stdin'], ls);
    expect(naive.stdout).toBe('');
    // …while the guard's own probe, on the SAME repo, finds the contradiction.
    expect(listTrackedIgnored(dir).offenders.length).toBeGreaterThan(0);
  });

  it('a repo whose only contradictions are machine-local has NO offenders', () => {
    const clean = mkdtempSync(join(tmpdir(), 'tracked-ignored-guard-local-'));
    try {
      expect(git(clean, ['init', '-q']).status).toBe(0);
      writeFileSync(join(clean, '.git', 'info', 'exclude'), '*.only-local\n');
      writeFileSync(join(clean, 'x.only-local'), 'x\n');
      expect(git(clean, ['add', '-f', 'x.only-local']).status).toBe(0);
      const res = listTrackedIgnored(clean);
      expect(res.offenders).toEqual([]);
      expect(res.machineLocal).toHaveLength(1);
    } finally {
      rmSync(clean, { recursive: true, force: true });
    }
  });

  it('a repo that tracks nothing ignored reports zero', () => {
    const clean = mkdtempSync(join(tmpdir(), 'tracked-ignored-guard-clean-'));
    try {
      expect(git(clean, ['init', '-q']).status).toBe(0);
      writeFileSync(join(clean, 'only.txt'), 'x\n');
      expect(git(clean, ['add', 'only.txt']).status).toBe(0);
      expect(listTrackedIgnored(clean)).toEqual({ listed: 0, offenders: [], machineLocal: [] });
    } finally {
      rmSync(clean, { recursive: true, force: true });
    }
  });

  it('THROWS on an instrument fault — a dead probe must never read as a clean verdict', () => {
    // A directory that is not a git repo makes `git ls-files` exit non-zero.
    const notARepo = mkdtempSync(join(tmpdir(), 'tracked-ignored-guard-norepo-'));
    try {
      expect(() => listTrackedIgnored(notARepo)).toThrow(/git ls-files failed/);
    } finally {
      rmSync(notARepo, { recursive: true, force: true });
    }
  });
});

describe('check-tracked-ignored against the real tree', () => {
  it('discoverRepos returns the superproject first, then every materialized submodule', () => {
    const repos = discoverRepos(REPO_ROOT);
    expect(repos[0]).toBe('.');
    expect(repos.length).toBeGreaterThan(1);
  });

  it(
    'no tracked path in the superproject or any submodule is matched by a repo .gitignore rule',
    () => {
      // Re-runs the invariant in-suite, so a regression is caught by `test:affected` and not
      // only by the standalone lint leg.
      const out = execFileSync('node', ['scripts/check-tracked-ignored.mjs'], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
      });
      expect(out).toContain('✓ check-tracked-ignored');
    },
    120_000,
  );

  it(
    '--print0 on a clean tree emits NOTHING — it is the pipe-fed fix command, so silence means "nothing to untrack"',
    () => {
      const out = execFileSync('node', ['scripts/check-tracked-ignored.mjs', '--print0'], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
      });
      expect(out).toBe('');
    },
    120_000,
  );
});
