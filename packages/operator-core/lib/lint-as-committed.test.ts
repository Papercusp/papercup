/**
 * Tests for the as-committed lint runner (scripts/lint-as-committed.mjs,
 * EI-18672078222841101).
 *
 * WHAT IS ACTUALLY WORTH TESTING HERE
 * The tool exists because `npm run lint:x` silently answers a different question than
 * the release gate asks, and returns a confident green either way. So the load-bearing
 * property is NOT "it runs a lint" — it is that this tool CANNOT ITSELF report a green
 * for a lint it did not actually run. Every path where a lint is not executed
 * (absent at the ref, the run itself errored) must be a FAILURE, never a skip.
 *
 * If a future edit ever turns `missing` or `error` into a skip, this tool becomes the
 * very bug it was built to remove — a fast, confident, wrong green — so those are the
 * negative controls below, not the happy path.
 *
 * The end-to-end behaviour (extract a tree, symlink node_modules, spawn npm) is
 * deliberately NOT unit-tested: mocking it would assert the mock. It is verified by
 * running the real thing against this repo.
 *
 * ONE EXCEPTION TO THAT (EI-21033860565861795): the submodule-materialisation step
 * below IS run end-to-end, against a real spawn of the CLI, because the bug it
 * regresses is exactly the kind a mock cannot see — `git clone --no-checkout` +
 * `checkout --detach` leaves a submodule (this repo has 30+, e.g. `libs/papercusp`)
 * as an EMPTY gitlink directory, and a lint that resolves an import through one
 * fabricated a TS2307 that the committed code does not actually have. Asserting the
 * extracted tree's submodule file byte-matches the COMMITTED content is the only way
 * to prove the fix; a unit test over `parseGitmodules` alone would prove the parser
 * works and say nothing about whether the tree it feeds actually gets materialised.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const scriptPath = resolve(here, '../../../scripts/lint-as-committed.mjs');
const repoRoot = resolve(here, '../../..');

const mod = await import(scriptPath);
const {
  parseArgs,
  detectorPathsFromCommand,
  parseGitmodules,
  planLinkExcludes,
  cloneWorkspaceTarget,
  linkNodeModulesShadow,
  owningSubmodule,
  showAtRef,
  summarize,
  isDirectCliInvocation,
} = mod as {
  cloneWorkspaceTarget: (realTarget: unknown, repoRoot: unknown, workRoot: unknown) => string | null;
  linkNodeModulesShadow: (
    sharedNm: string,
    cloneNm: string,
    repoRoot: string,
    workRoot: string,
  ) => { entries: number; remapped: number; fallback: number };
  owningSubmodule: (path: string, submodulePaths: unknown) => string | null;
  showAtRef: (repoRoot: string, ref: string, path: string) => string | null;
  parseArgs: (argv: string[]) => {
    help: boolean;
    scripts: string[];
    forward: string[];
    ref: string;
    keep: boolean;
    any: boolean;
    unknown: string[];
    nonLint?: string[];
    selfRecursive?: string[];
    forwardAmbiguous?: boolean;
  };
  detectorPathsFromCommand: (command: unknown) => string[];
  parseGitmodules: (text: unknown) => { name: string; path: string; url: string | null }[];
  planLinkExcludes: (linkedPaths: unknown, submodulePaths: unknown) => Record<string, string[]>;
  summarize:(results: { script: string; status: string; note?: string }[]) => {
    exitCode: number;
    failedCount: number;
    lines: string[];
  };
  isDirectCliInvocation: (entryPath?: string) => boolean;
};

describe('parseArgs', () => {
  it('collects positional script names and defaults the ref to HEAD', () => {
    const a = parseArgs(['lint:no-owner-name-tags', 'lint:no-box-identity']);
    expect(a.scripts).toEqual(['lint:no-owner-name-tags', 'lint:no-box-identity']);
    expect(a.ref).toBe('HEAD');
    expect(a.keep).toBe(false);
  });

  it('parses --ref, --keep and --any', () => {
    const a = parseArgs(['lint:tsc', '--ref=origin/staging', '--keep', '--any']);
    expect(a.ref).toBe('origin/staging');
    expect(a.keep).toBe(true);
    expect(a.any).toBe(true);
    expect(a.scripts).toEqual(['lint:tsc']);
  });

  it('flags a non-lint script for refusal — the blast-radius guard', () => {
    // Running an arbitrary npm script inside an extracted tree with symlinked
    // node_modules is a fine place for a read-only scanner and a bad place for a
    // build/migrate/deploy. The guard makes that an explicit choice, not a typo.
    const a = parseArgs(['db:migrate']);
    expect(a.nonLint).toEqual(['db:migrate']);
  });

  it('--any waives the non-lint refusal', () => {
    const a = parseArgs(['db:migrate', '--any']);
    expect(a.nonLint).toEqual([]);
  });

  it('flags self-recursion — the runner matches its own lint:* prefix', () => {
    // Found empirically: sweeping every lint:* through this tool picks up the runner
    // itself, whose inner no-arg run exits 2 on its usage guard and reports as
    // "FAIL — exit 2", indistinguishable from a real violation at the ref.
    const a = parseArgs(['lint:as-committed']) as { selfRecursive: string[] };
    expect(a.selfRecursive).toEqual(['lint:as-committed']);
  });

  it('does not flag ordinary lints as self-recursive', () => {
    const a = parseArgs(['lint:no-owner-name-tags', 'lint:mdx']) as { selfRecursive: string[] };
    expect(a.selfRecursive).toEqual([]);
  });

  it('separates unknown flags from script names so a typo cannot become a script name', () => {
    const a = parseArgs(['lint:mdx', '--ref']); // --ref without '=' is not a ref
    expect(a.unknown).toEqual(['--ref']);
    expect(a.scripts).toEqual(['lint:mdx']);
    expect(a.ref).toBe('HEAD');
  });

  // ── `--` forwarding: what makes a TEST runnable as committed ──

  it('forwards everything after a bare -- to the script, verbatim', () => {
    // The motivating case: `test:file` takes operands, so without forwarding there is
    // no way to ask "does this test pass AT THE COMMIT" rather than "in my dirty tree".
    const a = parseArgs(['test:file', '--any', '--', 'packages/x/lib/a.test.ts']);
    expect(a.scripts).toEqual(['test:file']);
    expect(a.forward).toEqual(['packages/x/lib/a.test.ts']);
    expect(a.any).toBe(true);
  });

  it('stops interpreting its OWN flags after the separator', () => {
    // `--keep` and `--ref=` past the separator belong to the inner script; swallowing
    // them here would silently change which commit is tested while appearing to
    // configure the inner run.
    const a = parseArgs(['test:file', '--any', '--ref=origin/staging', '--', 'a.test.ts', '--keep', '--ref=nope']);
    expect(a.ref).toBe('origin/staging');
    expect(a.keep).toBe(false);
    expect(a.forward).toEqual(['a.test.ts', '--keep', '--ref=nope']);
  });

  it('defaults forward to empty when no separator is present', () => {
    expect(parseArgs(['lint:mdx']).forward).toEqual([]);
  });

  it('REFUSES to forward one operand list to several scripts', () => {
    // Guessing here fails silently: both scripts run, one against operands meant for
    // the other, and the summary reports on whatever came back.
    const a = parseArgs(['lint:a', 'lint:b', '--', 'x.test.ts']);
    expect(a.forwardAmbiguous).toBe(true);
  });

  it('does not flag ambiguity for a single script, or when nothing is forwarded', () => {
    expect(parseArgs(['test:file', '--any', '--', 'x.test.ts']).forwardAmbiguous).toBe(false);
    expect(parseArgs(['lint:a', 'lint:b']).forwardAmbiguous).toBe(false);
  });

  it('--help returns an empty forward list rather than an undefined one', () => {
    // The early return is a separate code path from the main loop; an undefined
    // `forward` there would throw on `.length` at the ambiguity guard.
    expect(parseArgs(['--help']).forward).toEqual([]);
  });
});

describe('detectorPathsFromCommand', () => {
  it('extracts a plain node script path', () => {
    expect(detectorPathsFromCommand('node scripts/check-no-owner-name-tags.mjs')).toEqual([
      'scripts/check-no-owner-name-tags.mjs',
    ]);
  });

  it('extracts a nested app-local script path run via tsx', () => {
    expect(detectorPathsFromCommand('node apps/operator/scripts/check-vitest-mock-paths.mjs')).toEqual([
      'apps/operator/scripts/check-vitest-mock-paths.mjs',
    ]);
  });

  it('extracts every file in a multi-file command', () => {
    const cmd =
      'node scripts/test-files.mjs apps/operator/app/_lints/design-primitives.test.ts apps/operator/app/_lints/css-tokens.test.ts';
    expect(detectorPathsFromCommand(cmd)).toEqual([
      'scripts/test-files.mjs',
      'apps/operator/app/_lints/design-primitives.test.ts',
      'apps/operator/app/_lints/css-tokens.test.ts',
    ]);
  });

  it('ignores bare binaries, which this tool cannot version against a git ref', () => {
    // knip/vitest come from node_modules, which is symlinked, not archived. Claiming
    // to have versioned them would be a lie the header explicitly refuses to tell.
    expect(detectorPathsFromCommand('knip --no-config-hints')).toEqual([]);
  });

  it('does not duplicate a path repeated in one command', () => {
    expect(detectorPathsFromCommand('node scripts/a.mjs && node scripts/a.mjs')).toEqual(['scripts/a.mjs']);
  });

  it('is total on a non-string command', () => {
    expect(detectorPathsFromCommand(undefined)).toEqual([]);
    expect(detectorPathsFromCommand(null)).toEqual([]);
  });
});

describe('parseGitmodules (EI-21033860565861795 — the submodule-blindness bug)', () => {
  it('extracts name/path/url from a real .gitmodules stanza', () => {
    const text = [
      '[submodule "libs/papercusp"]',
      '\tpath = libs/papercusp',
      '\turl = git@github.com:Papercusp/papercusp.git',
    ].join('\n');
    expect(parseGitmodules(text)).toEqual([
      { name: 'libs/papercusp', path: 'libs/papercusp', url: 'git@github.com:Papercusp/papercusp.git' },
    ]);
  });

  it('handles a submodule name that differs from its path — the config key is the NAME', () => {
    // Real case in this repo: [submodule "libs/git-graph"] lives at
    // libs/generic/git-graph. `submodule.<name>.url` must be keyed on the name, not
    // the path, or the local-checkout override silently targets nothing.
    const text = ['[submodule "libs/git-graph"]', '\tpath = libs/generic/git-graph', '\turl = git@github.com:Papercusp/git-graph.git'].join(
      '\n',
    );
    expect(parseGitmodules(text)).toEqual([
      { name: 'libs/git-graph', path: 'libs/generic/git-graph', url: 'git@github.com:Papercusp/git-graph.git' },
    ]);
  });

  it('parses several stanzas in one file', () => {
    const text = [
      '[submodule "a"]',
      '\tpath = libs/a',
      '\turl = git@github.com:x/a.git',
      '[submodule "b"]',
      '\tpath = libs/b',
      '\turl = git@github.com:x/b.git',
    ].join('\n');
    expect(parseGitmodules(text)).toEqual([
      { name: 'a', path: 'libs/a', url: 'git@github.com:x/a.git' },
      { name: 'b', path: 'libs/b', url: 'git@github.com:x/b.git' },
    ]);
  });

  it('drops a stanza with no `path =` line — git itself ignores those', () => {
    const text = ['[submodule "no-path"]', '\turl = git@github.com:x/y.git'].join('\n');
    expect(parseGitmodules(text)).toEqual([]);
  });

  it('is total: empty string, non-string, and a file with no submodules all yield []', () => {
    expect(parseGitmodules('')).toEqual([]);
    expect(parseGitmodules(undefined)).toEqual([]);
    expect(parseGitmodules(null)).toEqual([]);
    expect(parseGitmodules('# just a comment\n')).toEqual([]);
  });

  it("this repo's OWN committed .gitmodules parses to a nonempty list that includes libs/papercusp", () => {
    // Not a golden-file test of the whole registry (that would break on every
    // legitimate submodule add/remove) — just proof the parser reads THIS repo's
    // real format, and finds the exact submodule the filed bug's repro depends on.
    const text = readFileSync(join(repoRoot, '.gitmodules'), 'utf8');
    const parsed = parseGitmodules(text);
    expect(parsed.length).toBeGreaterThan(0);
    expect(parsed.find((s) => s.path === 'libs/papercusp')).toBeTruthy();
  });
});

describe('planLinkExcludes (WI-10004898 — linked node_modules made every extracted tree dirty)', () => {
  it('routes a top-level link to the superproject exclude, anchored', () => {
    expect(planLinkExcludes(['node_modules', 'packages/operator-core/node_modules'], [])).toEqual({
      '': ['/node_modules', '/packages/operator-core/node_modules'],
    });
  });

  it('routes a link inside a submodule to THAT submodule, relative to its root', () => {
    expect(planLinkExcludes(['libs/papercusp/node_modules', 'node_modules'], ['libs/papercusp'])).toEqual({
      'libs/papercusp': ['/node_modules'],
      '': ['/node_modules'],
    });
  });

  it('picks the DEEPEST containing submodule, and never matches a sibling that merely shares a prefix', () => {
    const plan = planLinkExcludes(
      ['libs/papercusp/libs/db/node_modules', 'libs/papercusp-extra/node_modules'],
      ['libs/papercusp', 'libs/papercusp/libs/db'],
    );
    expect(plan).toEqual({
      'libs/papercusp/libs/db': ['/node_modules'],
      '': ['/libs/papercusp-extra/node_modules'],
    });
  });

  it('is total on junk input', () => {
    expect(planLinkExcludes(undefined, undefined)).toEqual({});
    expect(planLinkExcludes(['', 42, 'node_modules'], [null, ''])).toEqual({ '': ['/node_modules'] });
  });
});

describe('cloneWorkspaceTarget (EI-24790229053787032 — workspace links must resolve into the extracted tree)', () => {
  it('maps a workspace package inside the shared checkout to the same path in the extracted tree', () => {
    expect(cloneWorkspaceTarget('/r/shared/libs/generic/search', '/r/shared', '/tmp/clone')).toBe(
      '/tmp/clone/libs/generic/search',
    );
  });

  it('leaves anything that is not a workspace package alone', () => {
    // a real dependency living in a node_modules
    expect(cloneWorkspaceTarget('/r/shared/node_modules/.pnpm/x', '/r/shared', '/tmp/clone')).toBeNull();
    // outside the checkout, including a sibling that merely shares the prefix
    expect(cloneWorkspaceTarget('/r/elsewhere/pkg', '/r/shared', '/tmp/clone')).toBeNull();
    expect(cloneWorkspaceTarget('/r/shared-other/pkg', '/r/shared', '/tmp/clone')).toBeNull();
    // the checkout root itself
    expect(cloneWorkspaceTarget('/r/shared', '/r/shared', '/tmp/clone')).toBeNull();
  });

  it('is total on junk input', () => {
    expect(cloneWorkspaceTarget(undefined, '/r', '/c')).toBeNull();
    expect(cloneWorkspaceTarget('/r/a', '', '/c')).toBeNull();
    expect(cloneWorkspaceTarget('/r/a', '/r', 42)).toBeNull();
  });
});

describe('linkNodeModulesShadow (EI-24790229053787032 — a whole-directory link ran the SHARED tree)', () => {
  function writePkg(dir: string, marker: string): void {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'p', main: 'index.js' }));
    writeFileSync(join(dir, 'index.js'), `module.exports = ${JSON.stringify(marker)};\n`);
  }

  function fixture(): { root: string; shared: string; clone: string } {
    const root = mkdtempSync(join(tmpdir(), 'lac-shadow-'));
    const shared = join(root, 'shared');
    const clone = join(root, 'clone');
    // shared checkout: two workspace packages, one real dependency
    writePkg(join(shared, 'libs', 'foo'), 'shared-foo');
    writePkg(join(shared, 'libs', 'gone'), 'shared-gone');
    writePkg(join(shared, 'node_modules', 'leftpad'), 'leftpad');
    mkdirSync(join(shared, 'node_modules', '@papercusp'), { recursive: true });
    symlinkSync('../../libs/foo', join(shared, 'node_modules', '@papercusp', 'foo'));
    symlinkSync('../../libs/gone', join(shared, 'node_modules', '@papercusp', 'gone'));
    // extracted tree: has its own (committed) foo, lacks gone (an uninitialised submodule)
    writePkg(join(clone, 'libs', 'foo'), 'clone-foo');
    mkdirSync(join(clone, 'app'), { recursive: true });
    return { root, shared, clone };
  }

  it('resolves a workspace package to the extracted tree copy, everything else to the shared install', () => {
    const { root, shared, clone } = fixture();
    try {
      const stats = linkNodeModulesShadow(join(shared, 'node_modules'), join(clone, 'node_modules'), shared, clone);
      expect(stats).toEqual({ entries: 3, remapped: 1, fallback: 1 });
      expect(lstatSync(join(clone, 'node_modules')).isSymbolicLink()).toBe(false);

      // The failure this guards is a RUNTIME resolution, so assert what require() actually loads.
      const req = createRequire(join(clone, 'app', 'x.js'));
      expect(req('@papercusp/foo')).toBe('clone-foo');
      expect(realpathSync(req.resolve('@papercusp/foo'))).toBe(realpathSync(join(clone, 'libs', 'foo', 'index.js')));
      // absent in the extracted tree: falls back to the shared package (counted above, not silent)
      expect(req('@papercusp/gone')).toBe('shared-gone');
      // a real dependency is linked, never copied or installed
      expect(lstatSync(join(clone, 'node_modules', 'leftpad')).isSymbolicLink()).toBe(true);
      expect(req('leftpad')).toBe('leftpad');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('control: the previous whole-directory link loads the SHARED copy (the bug)', () => {
    const { root, shared, clone } = fixture();
    try {
      symlinkSync(join(shared, 'node_modules'), join(clone, 'node_modules'), 'dir');
      expect(createRequire(join(clone, 'app', 'x.js'))('@papercusp/foo')).toBe('shared-foo');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('showAtRef (WI-10004908 — submodule test operands were refused as absent at the ref)', () => {
  const gitOut = (cwd: string, args: string[]) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 30_000, killSignal: 'SIGKILL' });

  it('owningSubmodule picks the deepest containing submodule and ignores prefix-sharing siblings', () => {
    const subs = ['libs/papercusp', 'libs/papercusp/libs/db'];
    expect(owningSubmodule('libs/papercusp/libs/db/sql/1.sql', subs)).toBe('libs/papercusp/libs/db');
    expect(owningSubmodule('libs/papercusp/README.md', subs)).toBe('libs/papercusp');
    expect(owningSubmodule('libs/papercusp-extra/x.ts', subs)).toBeNull();
    expect(owningSubmodule('package.json', undefined)).toBeNull();
  });

  it('reads a superproject path exactly as git show does', () => {
    expect(showAtRef(repoRoot, 'HEAD', 'package.json')).toBe(gitOut(repoRoot, ['show', 'HEAD:package.json']));
  });

  it('reads a path INSIDE a submodule from the submodule at the pinned commit, not null', () => {
    const subRoot = 'libs/papercusp';
    const subRelFile = 'libs/db/src/connection.ts';
    // Calibration: the instrument this fix replaces really is blind here, so a pass below
    // cannot be the old code path answering by accident.
    expect(() => gitOut(repoRoot, ['show', `HEAD:${subRoot}/${subRelFile}`])).toThrow();
    const pin = gitOut(repoRoot, ['rev-parse', `HEAD:${subRoot}`]).trim();
    const committed = gitOut(join(repoRoot, subRoot), ['show', `${pin}:${subRelFile}`]);
    expect(committed.length).toBeGreaterThan(0);
    expect(showAtRef(repoRoot, 'HEAD', `${subRoot}/${subRelFile}`)).toBe(committed);
  });

  it('still answers null for a path absent at the ref, inside or outside a submodule', () => {
    expect(showAtRef(repoRoot, 'HEAD', 'no-such-dir/definitely-absent-WI-10004908.ts')).toBeNull();
    expect(showAtRef(repoRoot, 'HEAD', 'libs/papercusp/no-such-dir/definitely-absent-WI-10004908.ts')).toBeNull();
  });
});

describe('summarize — fail-closed', () => {
  it('exits 0 only when every lint actually passed', () => {
    const s = summarize([
      { script: 'lint:a', status: 'pass' },
      { script: 'lint:b', status: 'pass' },
    ]);
    expect(s.exitCode).toBe(0);
    expect(s.failedCount).toBe(0);
  });

  it('exits nonzero on a genuine lint failure', () => {
    const s = summarize([
      { script: 'lint:a', status: 'pass' },
      { script: 'lint:b', status: 'fail', note: 'exit 1' },
    ]);
    expect(s.exitCode).toBe(1);
    expect(s.failedCount).toBe(1);
  });

  // ── the two negative controls this file exists for ──

  it('NEGATIVE CONTROL: a script absent at the ref FAILS — it must never read as a skip', () => {
    // "It only exists in your working tree" is the exact finding worth surfacing. If
    // this ever returned 0, the tool would print green for a lint the gate cannot run.
    const s = summarize([{ script: 'lint:only-local', status: 'missing', note: 'not in package.json at abc1234' }]);
    expect(s.exitCode).toBe(1);
    expect(s.failedCount).toBe(1);
    expect(s.lines[0]).toContain('MISSING@REF');
  });

  it('NEGATIVE CONTROL: a run that errored FAILS — an un-run lint is not a passing lint', () => {
    const s = summarize([{ script: 'lint:a', status: 'error', note: 'spawn npm ENOENT' }]);
    expect(s.exitCode).toBe(1);
    expect(s.lines[0]).toContain('ERROR');
  });

  it('one missing lint poisons an otherwise-green batch', () => {
    const s = summarize([
      { script: 'lint:a', status: 'pass' },
      { script: 'lint:b', status: 'missing' },
      { script: 'lint:c', status: 'pass' },
    ]);
    expect(s.exitCode).toBe(1);
    expect(s.failedCount).toBe(1);
  });

  it('an empty result set is not a green — nothing ran, so nothing was verified', () => {
    // Guarded deliberately: summarize([]) returning exitCode 0 is only safe because the
    // CLI refuses an empty script list up front (exit 2). This pins the pairing so a
    // future edit that drops that refusal cannot silently produce "All 0 lint(s) pass".
    expect(parseArgs([]).scripts).toEqual([]);
    expect(summarize([]).failedCount).toBe(0);
  });
});

describe('isDirectCliInvocation', () => {
  it('is false when imported (as this test does) so an import never extracts a tree', () => {
    expect(isDirectCliInvocation('/usr/bin/vitest')).toBe(false);
    expect(isDirectCliInvocation(undefined)).toBe(false);
  });

  it('is true for a direct CLI run', () => {
    expect(isDirectCliInvocation('/repo/scripts/lint-as-committed.mjs')).toBe(true);
    expect(isDirectCliInvocation('scripts/lint-as-committed.mjs')).toBe(true);
  });

  it('does not match a lookalike basename', () => {
    // The boundary is a path separator (or string start), not a bare suffix — so a
    // file whose name merely ENDS with the script name is not the script.
    expect(isDirectCliInvocation('/repo/scripts/lint-as-committed.mjs.bak')).toBe(false);
    expect(isDirectCliInvocation('/repo/scripts/not-lint-as-committed.mjs')).toBe(false);
  });
});

describe('the npm script is registered', () => {
  it('package.json exposes lint:as-committed pointing at this script', () => {
    const require_ = createRequire(import.meta.url);
    const pkg = require_(resolve(here, '../../../package.json')) as { scripts: Record<string, string> };
    expect(pkg.scripts['lint:as-committed']).toBe('node scripts/lint-as-committed.mjs');
  });
});

describe('end-to-end — submodule content is materialised, not silently empty (EI-21033860565861795)', () => {
  // WI-40086's exact repro: an isolated-tree run fabricated TS2307 for
  // `libs/papercusp/libs/db/src/connection` because `git clone --no-checkout` +
  // `checkout --detach` leaves a submodule as an EMPTY gitlink directory — the real
  // checkpoint writer, and current-tree lint, both resolve the module fine. This is
  // deliberately NOT unit-tested against a mock (see the file header): the bug lives
  // in the extraction mechanism itself, so the only faithful regression is running
  // the real CLI against this real, submodule-carrying repo and reading back what it
  // actually materialised.
  it('extracts REAL, committed content for a git-submodule path, not an empty gitlink dir', () => {
    const subRoot = 'libs/papercusp';
    const subRelFile = 'libs/db/src/connection.ts';
    const subFile = `${subRoot}/${subRelFile}`;
    // Sanity first: if this checkout itself doesn't have the submodule (or the file
    // the bug's repro depends on), the assertions below would pass for the wrong
    // reason — every path missing, not just the extracted one.
    expect(existsSync(join(repoRoot, subRoot, '.git'))).toBe(true);
    expect(existsSync(join(repoRoot, subFile))).toBe(true);
    // The submodule's pinned commit, resolved from the SUPERPROJECT's tree (a gitlink
    // resolves like a blob entry, to the commit sha it points at) — and the committed
    // content itself, read from the SUBMODULE's OWN repository at that pin. A single
    // `git show <ref>:<path>` from repoRoot cannot do this in one step: git does not
    // recurse a pathspec across a submodule boundary, which is exactly why this whole
    // fix (and this test) has to treat the submodule as a second repository.
    const pin = execFileSync('git', ['rev-parse', `HEAD:${subRoot}`], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 30_000,
      killSignal: 'SIGKILL',
    }).trim();
    const committed = execFileSync('git', ['show', `${pin}:${subRelFile}`], {
      cwd: join(repoRoot, subRoot),
      encoding: 'utf8',
      timeout: 30_000,
      killSignal: 'SIGKILL',
    });

    // NOTE: no leading `--` here. `npm run lint:as-committed -- lint:x` works because
    // NPM's own `--` is consumed by npm itself before the script sees argv; invoking
    // the script directly (as this test does) must pass the script name bare, or this
    // tool's OWN `--` forwarding logic swallows it as an (empty) script list.
    //
    // The chosen lint is deliberately NOT asserted to PASS: this test's job is to
    // prove submodule content was materialised, not to pin the pass/fail state of an
    // unrelated lint. `run.status` distinguishes a genuine lint finding (exit 1, via
    // `summarize()`) from a setup/environment failure in THIS tool (exit 2) — only
    // the latter would mean the fix regressed.
    // The real extraction initialises every submodule, so its cost tracks host load, not
    // this test's subject: 11–44s normally, >60s at load ~130 on the gate (WI-10004340).
    const run = spawnSync('node', [scriptPath, 'lint:no-owner-name-tags', '--keep'], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 150_000,
      killSignal: 'SIGKILL',
    });
    expect(run.status).not.toBe(2);
    // Proof the new step actually engaged, not just that nothing crashed — a future
    // edit that silently skips submodule init would still reach this lint fine (it
    // never touches libs/papercusp), so this line is load-bearing, not decorative.
    expect(run.stdout).toMatch(/initialised \d+ submodule\(s\) from local checkouts/);

    const kept = run.stdout.match(/--keep: extracted tree left at (\S+)/);
    expect(kept).not.toBeNull();
    const workRoot = kept![1];
    try {
      const extracted = readFileSync(join(workRoot, subFile), 'utf8');
      expect(extracted.length).toBeGreaterThan(0);
      // Not just "some content" — the COMMITTED content: `--ref` defaults to HEAD, so
      // this must byte-match what's pinned there (`committed`, resolved above), the
      // exact bytes the release gate itself would see. That equality is the whole
      // point of this tool.
      expect(extracted).toBe(committed);
      // Populating a standalone clone is not enough: the parent repository must mark
      // the submodule active or recursive Git scanners silently omit its real files.
      const tracked = execFileSync('git', ['ls-files', '-z', '--recurse-submodules'], {
        cwd: workRoot,
        encoding: 'utf8',
        timeout: 30_000,
        killSignal: 'SIGKILL',
      }).split('\0');
      expect(tracked).toContain(subFile);
      // WI-10004898: the extracted tree must be CLEAN to the same `git status` the test-run
      // reporter samples for worktree_dirty, or no run inside it can ever be current proof.
      // The linked node_modules are what dirtied it, so first prove the links exist (a tree
      // with nothing linked would be trivially clean and this assertion vacuous).
      expect(run.stdout).toMatch(/linked [1-9]\d* node_modules dir\(s\)/);
      const status = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], {
        cwd: workRoot,
        encoding: 'utf8',
        timeout: 60_000,
        killSignal: 'SIGKILL',
      });
      expect(status).toBe('');
    } finally {
      rmSync(workRoot, { recursive: true, force: true });
    }
  }, 180_000);
});
