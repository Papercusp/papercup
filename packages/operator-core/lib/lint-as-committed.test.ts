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
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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
  lintAsCommittedChildEnv,
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
  lintAsCommittedChildEnv: (environment?: Record<string, string | undefined>) => Record<string, string | undefined>;
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

describe('isolated clone module identity (EI-24824919200711849)', () => {
  it('marks only the child environment for clone-specific Vite resolution', () => {
    const parent = { NODE_OPTIONS: '--trace-warnings', npm_config_workspaces: 'true', EXAMPLE: 'kept' };
    expect(lintAsCommittedChildEnv(parent)).toEqual({
      NODE_OPTIONS: '--trace-warnings',
      npm_config_workspaces: undefined,
      EXAMPLE: 'kept',
      PAPERCUSP_LINT_AS_COMMITTED_CLONE: '1',
    });
    expect(parent).toEqual({ NODE_OPTIONS: '--trace-warnings', npm_config_workspaces: 'true', EXAMPLE: 'kept' });
  });

  it('normalizes external Astro IDs in clone mode so virtual requests share the compile key', async () => {
    const envKey = 'PAPERCUSP_LINT_AS_COMMITTED_CLONE';
    const before = process.env[envKey];
    const configPath = resolve(repoRoot, 'apps/papercusp-docs/astro.config.mjs');
    const readConfig = async (tag: string) => (await import(`${configPath}?${tag}`)).default as {
      vite?: {
        resolve?: { preserveSymlinks?: boolean };
        plugins?: Array<{
          name: string;
          enforce?: string;
          resolveId?: (id: string, importer?: string) => string | null;
        }>;
      };
    };
    try {
      delete process.env[envKey];
      const normalVite = (await readConfig('normal')).vite;
      expect(normalVite?.resolve?.preserveSymlinks).toBeUndefined();
      expect(normalVite?.plugins?.some(({ name }) => name === 'papercusp-clone-astro-id-normalizer')).toBeFalsy();

      process.env[envKey] = '1';
      const cloneVite = (await readConfig('clone')).vite;
      expect(cloneVite?.resolve?.preserveSymlinks).toBe(false);

      const normalizer = cloneVite?.plugins?.find(({ name }) => name === 'papercusp-clone-astro-id-normalizer');
      expect(normalizer?.enforce).toBe('pre');
      const sharedComponent = realpathSync(resolve(repoRoot, 'node_modules/@astrojs/starlight/components/Page.astro'));
      const virtualStyleId = `${sharedComponent}?astro&type=style&index=0&lang.css`;
      const mainComponentId = normalizer?.resolveId?.(sharedComponent);
      expect(mainComponentId).toBe(sharedComponent);
      const astroUtilsPath = resolve(repoRoot, 'node_modules/astro/dist/vite-plugin-utils/index.js');
      const { normalizeFilename } = await import(astroUtilsPath);
      const cloneAppRoot = resolve(tmpdir(), 'papercusp-lint-as-committed-probe/apps/papercusp-docs');
      const cloneRootUrl = pathToFileURL(`${cloneAppRoot}/`);
      const normalizedVirtualStyleId = normalizer?.resolveId?.(virtualStyleId);
      expect(normalizedVirtualStyleId).toBe(`/@fs${virtualStyleId}`);
      expect(normalizer?.resolveId?.(`/@fs${virtualStyleId}`)).toBe(`/@fs${virtualStyleId}`);
      expect(normalizeFilename(normalizedVirtualStyleId?.split('?', 1)[0] ?? '', cloneRootUrl)).toBe(mainComponentId);

      const sharedRoute = realpathSync(resolve(repoRoot, 'node_modules/@astrojs/starlight/routes/static/404.astro'));
      const sharedCommon = realpathSync(resolve(dirname(sharedRoute), '../common.astro'));
      expect(normalizer?.resolveId?.('../common.astro', `${sharedRoute}?astro&type=page`)).toBe(`/@fs${sharedCommon}?astro&type=page`);
      const relativeSharedRoute = relative(resolve(repoRoot, 'apps/papercusp-docs'), sharedRoute);
      expect(relativeSharedRoute).toContain('../');
      expect(normalizer?.resolveId?.('../common.astro', `${relativeSharedRoute}?astro&type=page`)).toBe(`/@fs${sharedCommon}?astro&type=page`);
      const virtualRouteQuery = '?astro&type=page';
      const noncanonicalFilesystemRoute = `/@fs/${relative(cloneAppRoot, sharedRoute)}${virtualRouteQuery}`;
      expect(noncanonicalFilesystemRoute).toContain('/../');
      expect(normalizer?.resolveId?.(noncanonicalFilesystemRoute)).toBe(`/@fs${sharedRoute}${virtualRouteQuery}`);

      const relativeTraversalRoute = `${relative(resolve(repoRoot, 'apps/papercusp-docs'), sharedRoute)}${virtualRouteQuery}`;
      expect(relativeTraversalRoute).toContain('../');
      const normalizedTraversalRoute = normalizer?.resolveId?.(relativeTraversalRoute);
      expect(normalizedTraversalRoute).toBe(`/@fs${sharedRoute}${virtualRouteQuery}`);
      expect(normalizer?.resolveId?.(normalizedTraversalRoute ?? '')).toBe(`/@fs${sharedRoute}${virtualRouteQuery}`);

      const localComponent = resolve(repoRoot, 'apps/papercusp-docs/src/components/Local.astro');
      expect(normalizer?.resolveId?.(localComponent)).toBeNull();
      expect(normalizer?.resolveId?.(`${localComponent}?raw`)).toBeNull();
    } finally {
      if (before === undefined) delete process.env[envKey];
      else process.env[envKey] = before;
    }
  });
});

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
      expect(req.resolve('leftpad')).toBe(realpathSync(join(shared, 'node_modules', 'leftpad', 'index.js')));
      expect(req.resolve('@papercusp/foo')).toBe(realpathSync(join(clone, 'libs', 'foo', 'index.js')));

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
      const tracked = execFileSync('git', ['ls-files', '-z', '--recurse-submodules', '--', subFile], {
        cwd: workRoot,
        encoding: 'utf8',
        timeout: 30_000,
        killSignal: 'SIGKILL',
      }).split('\0').filter((p) => existsSync(join(workRoot, p)));
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
      // WI-10005625: metadata and ignored runtime exports are prerequisites too.
      const snapshottedMain = run.stdout.match(/main snapshot: ([0-9a-f]{40})/);
      expect(snapshottedMain).not.toBeNull();
      expect(execFileSync('git', ['rev-parse', 'main^{commit}'], { cwd: workRoot, encoding: 'utf8' }).trim()).toBe(snapshottedMain![1]);
      expect(run.stdout).toContain('building pinned runtime exports: @papercusp/sse');
      const requireClone = createRequire(join(workRoot, 'package.json'));
      expect(requireClone('@papercusp/sse').sseResponse).toBeTypeOf('function');
      expect(realpathSync(requireClone.resolve('@papercusp/sse'))).toBe(realpathSync(join(workRoot, 'libs/generic/sse/dist/index.js')));
    } finally {
      rmSync(workRoot, { recursive: true, force: true });
    }
  }, 180_000);
});

describe('end-to-end — independent main and pinned runtime prerequisites (WI-10005625)', () => {
  const gitFixture = (cwd: string, args: string[], input?: string) => execFileSync('git', args, {
    cwd, input, encoding: 'utf8', timeout: 30_000, killSignal: 'SIGKILL', stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();

  // Real git history with plumbing: no mocks, install, network, or shared-tree writes.
  function snapshot(root: string, files: Record<string, string>, parent?: string): string {
    for (const [name, content] of Object.entries(files)) {
      mkdirSync(dirname(join(root, name)), { recursive: true });
      writeFileSync(join(root, name), content);
      const blob = gitFixture(root, ['hash-object', '-w', '--stdin'], content);
      gitFixture(root, ['update-index', '--add', '--cacheinfo', '100644', blob, name]);
    }
    const tree = gitFixture(root, ['write-tree']);
    const sha = gitFixture(root, ['-c', 'user.name=Runner fixture', '-c', 'user.email=fixture@example.invalid',
      'commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', 'runner fixture']);
    gitFixture(root, ['update-ref', 'refs/heads/staging', sha]);
    return sha;
  }

  function fixture(build?: string, withMain = true) {
    const root = mkdtempSync(join(tmpdir(), 'lac-prerequisites-'));
    gitFixture(root, ['init', '--quiet', '--initial-branch=staging']);
    const files = {
      '.gitignore': 'node_modules/\nlibs/runtime/dist/\n',
      'package.json': JSON.stringify({ private: true, scripts: { 'lint:probe': 'node probe.cjs' } }),
      'probe.cjs': 'console.log("initial fixture");\n',
      'libs/runtime/package.json': JSON.stringify({ name: '@fixture/runtime', type: 'module',
        exports: { '.': { types: './source.d.ts', import: './source.mjs', require: './dist/index.cjs', default: './dist/index.cjs' } },
        scripts: build === undefined ? {} : { build } }),
      'libs/runtime/source.cjs': 'module.exports = "pinned-source";\n',
      'libs/runtime/build.cjs': "const fs = require('node:fs'); fs.mkdirSync('dist', { recursive: true }); fs.writeFileSync('dist/index.cjs', 'module.exports = ' + JSON.stringify(require('./source.cjs')) + ';\\n');\n",
    };
    const main = snapshot(root, files);
    if (withMain) gitFixture(root, ['update-ref', 'refs/heads/main', main]);
    files['probe.cjs'] = `
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { realpathSync, readFileSync } = require('node:fs');
const { resolve } = require('node:path');
${withMain ? `assert.equal(execFileSync('git', ['rev-parse', 'main^{commit}'], { encoding: 'utf8' }).trim(), ${JSON.stringify(main)});` : "assert.throws(() => execFileSync('git', ['rev-parse', '--verify', 'main^{commit}'], { stdio: 'pipe' }));"}
assert.equal(require('@fixture/runtime'), 'pinned-source');
assert.equal(realpathSync(require.resolve('@fixture/runtime')), realpathSync(resolve('libs/runtime/dist/index.cjs')));
assert.equal(readFileSync('libs/runtime/source.cjs', 'utf8'), 'module.exports = "pinned-source";\\n');
assert.equal(execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { encoding: 'utf8' }), '');
console.log('CLONE_PREREQUISITES_OK');
`;
    const head = snapshot(root, files, main);
    mkdirSync(join(root, 'node_modules/@fixture'), { recursive: true });
    symlinkSync('../../libs/runtime', join(root, 'node_modules/@fixture/runtime'));
    mkdirSync(join(root, 'libs/runtime/dist'), { recursive: true });
    writeFileSync(join(root, 'libs/runtime/dist/index.cjs'), 'module.exports = "shared-stale-dist";\n');
    writeFileSync(join(root, 'libs/runtime/source.cjs'), 'module.exports = "shared-dirty-source";\n');
    return { root, main, head };
  }

  function run(root: string, arbitrary = false) {
    return spawnSync(process.execPath, [scriptPath, 'lint:probe', ...(arbitrary ? ['--any'] : [])], {
      cwd: root, encoding: 'utf8', timeout: 30_000, killSignal: 'SIGKILL',
    });
  }

  it('pins main separately from HEAD and builds require exports from committed source despite dirty shared source/dist', () => {
    const f = fixture('node build.cjs');
    try {
      expect(f.main).not.toBe(f.head);
      const result = run(f.root);
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(result.stdout).toContain(`main snapshot: ${f.main}`);
      expect(result.stdout).toContain('building pinned runtime exports: @fixture/runtime');
      expect(result.stdout).toContain('CLONE_PREREQUISITES_OK');
      expect(readFileSync(join(f.root, 'libs/runtime/source.cjs'), 'utf8')).toContain('shared-dirty-source');
      expect(readFileSync(join(f.root, 'libs/runtime/dist/index.cjs'), 'utf8')).toContain('shared-stale-dist');
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  }, 40_000);

  it('does not fabricate main when the source repository has no main branch', () => {
    const f = fixture('node build.cjs', false);
    try {
      const result = run(f.root);
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(result.stdout).not.toContain('main snapshot:');
      expect(result.stdout).toContain('CLONE_PREREQUISITES_OK');
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  }, 40_000);

  it.each(['string', 'map'])('builds a bin-only package and its companion native assets from the pinned tree (%s)', (shape) => {
    const f = fixture('node build.cjs');
    try {
      snapshot(f.root, {
        'libs/runtime/package.json': JSON.stringify({ name: '@fixture/runtime',
          bin: shape === 'string' ? './dist/cli.cjs' : { fixture: './dist/cli.cjs' },
          scripts: { build: 'node build-native.cjs' } }),
        'libs/runtime/build-native.cjs': `const fs = require('node:fs');
fs.mkdirSync('dist', { recursive: true });
for (const name of ['cli.cjs', 'native-client.cjs', 'native-extension.mjs']) fs.writeFileSync('dist/' + name, 'pinned-native');
`,
        'probe.cjs': `const assert = require('node:assert/strict');
const fs = require('node:fs');
for (const name of ['cli.cjs', 'native-client.cjs', 'native-extension.mjs']) assert.equal(fs.readFileSync('libs/runtime/dist/' + name, 'utf8'), 'pinned-native');
console.log('PINNED_NATIVE_OK');
`,
      }, f.head);
      writeFileSync(join(f.root, 'libs/runtime/build-native.cjs'), 'throw new Error("shared dirty builder");\n');
      const result = run(f.root);
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(result.stdout).toContain('PINNED_NATIVE_OK');
      expect(existsSync(join(f.root, 'libs/runtime/dist/native-client.cjs'))).toBe(false);
      expect(readFileSync(join(f.root, 'libs/runtime/build-native.cjs'), 'utf8')).toContain('shared dirty builder');
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  }, 40_000);

  it.each([0, 7])('prepares declared runtime assets before arbitrary commands and refuses a failing lifecycle (exit %s)', (exitCode) => {
    const f = fixture('node build.cjs');
    try {
      const manifest = JSON.parse(readFileSync(join(f.root, 'libs/runtime/package.json'), 'utf8'));
      manifest.scripts.postinstall = 'node setup-vditor-runtime.cjs';
      snapshot(f.root, {
        '.gitignore': 'node_modules/\nlibs/runtime/dist/\nlibs/runtime/public/\n',
        'libs/runtime/package.json': JSON.stringify(manifest),
        'libs/runtime/setup-vditor-runtime.cjs': `const fs = require('node:fs');
fs.mkdirSync('public', { recursive: true });
fs.writeFileSync('public/mirror.js', require('./source.cjs'));
process.exitCode = ${exitCode};
`,
        'probe.cjs': readFileSync(join(f.root, 'probe.cjs'), 'utf8') + `
assert.equal(readFileSync('libs/runtime/public/mirror.js', 'utf8'), 'pinned-source');
console.log('PINNED_ASSETS_OK');
`,
      }, f.head);
      mkdirSync(join(f.root, 'libs/runtime/public'), { recursive: true });
      writeFileSync(join(f.root, 'libs/runtime/public/mirror.js'), 'shared stale assets');
      writeFileSync(join(f.root, 'libs/runtime/setup-vditor-runtime.cjs'), 'throw new Error("shared dirty setup");\n');
      const result = run(f.root, true);
      expect(result.status, result.stdout + result.stderr).toBe(exitCode === 0 ? 0 : 2);
      expect(result.stdout).toContain('preparing pinned runtime assets: @fixture/runtime');
      if (exitCode === 0) expect(result.stdout).toContain('PINNED_ASSETS_OK');
      else {
        expect(result.stderr).toContain('committed postinstall failed');
        expect(result.stdout).not.toContain('─── lint:probe');
        expect(result.stdout).not.toContain('CLONE_PREREQUISITES_OK');
      }
      expect(readFileSync(join(f.root, 'libs/runtime/public/mirror.js'), 'utf8')).toBe('shared stale assets');
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  }, 40_000);

  it.each([
    { name: 'absent build', build: undefined, reason: 'no committed build script' },
    { name: 'failed build', build: 'node -e "process.exitCode = 7"', reason: 'committed build failed' },
    { name: 'successful build with no output', build: 'node -e "console.log(\'NO_OUTPUT\')"', reason: 'did not emit runtime export' },
    { name: 'build mutating pinned source', build: 'node build.cjs && node -e "require(\'node:fs\').writeFileSync(\'source.cjs\', \'changed\')"', reason: 'committed build changed source' },
  ])('refuses $name before executing the requested detector', ({ build, reason }) => {
    const f = fixture(build);
    try {
      const result = run(f.root);
      expect(result.status, result.stdout + result.stderr).toBe(2);
      expect(result.stderr).toContain(reason);
      expect(result.stdout).not.toContain('─── lint:probe');
      expect(result.stdout).not.toContain('CLONE_PREREQUISITES_OK');
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  }, 40_000);
});

// WI-10005705: extracted ~1.4 GB trees outlived their runs (--keep, process.exit inside the
// try, signal kills) and refilled the root disk. These pin the lifecycle that removes them.
describe('extracted-tree lifecycle (WI-10005705)', () => {
  type Verdict = { remove: boolean; reason: string };
  type Marker = { pid?: number; keep?: boolean; createdAtMs?: number } | null;
  const { classifyWorkRoot, sweepStaleWorkRoots, WORK_ROOT_PREFIX, OWNER_MARKER, KEEP_TTL_MS, MAX_AGE_MS } = mod as {
    classifyWorkRoot: (a: { inUse: boolean; marker: Marker; ownerAlive: boolean; ageMs: number }) => Verdict;
    sweepStaleWorkRoots: (o: {
      root: string;
      nowMs: number;
      cwds: string[] | null;
      isAlive: (pid: number) => boolean;
    }) => { removed: { name: string; reason: string }[]; kept: { name: string; reason: string }[] };
    WORK_ROOT_PREFIX: string;
    OWNER_MARKER: string;
    KEEP_TTL_MS: number;
    MAX_AGE_MS: number;
  };
  const H = 3600_000;

  it('classifies each tree by liveness, keep flag and age', () => {
    const c = (inUse: boolean, marker: Marker, ownerAlive: boolean, ageMs: number) => classifyWorkRoot({ inUse, marker, ownerAlive, ageMs });
    expect(c(true, null, false, MAX_AGE_MS * 10)).toEqual({ remove: false, reason: 'in-use' });
    expect(c(false, { pid: 1, keep: false }, false, 60_000)).toEqual({ remove: true, reason: 'owner-dead' });
    expect(c(false, { pid: 1, keep: false }, true, 60_000)).toEqual({ remove: false, reason: 'owner-alive' });
    expect(c(false, { pid: 1, keep: false }, true, MAX_AGE_MS + 1)).toEqual({ remove: true, reason: 'max-age' });
    expect(c(false, { pid: 1, keep: true }, false, KEEP_TTL_MS - 1)).toEqual({ remove: false, reason: 'keep-young' });
    expect(c(false, { pid: 1, keep: true }, false, KEEP_TTL_MS + 1)).toEqual({ remove: true, reason: 'keep-expired' });
    expect(c(false, null, false, KEEP_TTL_MS - 1)).toEqual({ remove: false, reason: 'unmarked-young' });
    expect(c(false, null, false, KEEP_TTL_MS + 1)).toEqual({ remove: true, reason: 'unmarked-expired' });
    expect(c(false, null, false, Number.NaN)).toEqual({ remove: false, reason: 'age-unknown' });
  });

  it('sweeps only stale trees under the root, never one a live process is inside', () => {
    const root = mkdtempSync(join(tmpdir(), 'lac-sweep-'));
    try {
      const now = Date.now();
      const tree = (name: string, marker: Marker) => {
        const p = join(root, `${WORK_ROOT_PREFIX}${name}`);
        mkdirSync(join(p, '.git'), { recursive: true });
        if (marker) writeFileSync(join(p, OWNER_MARKER), JSON.stringify(marker));
        return p;
      };
      tree('dead-owner', { pid: 101, keep: false, createdAtMs: now - 60_000 });
      tree('live-owner', { pid: 202, keep: false, createdAtMs: now - 60_000 });
      tree('keep-old', { pid: 101, keep: true, createdAtMs: now - KEEP_TTL_MS - H });
      tree('keep-fresh', { pid: 101, keep: true, createdAtMs: now - H });
      const busy = tree('keep-old-busy', { pid: 101, keep: true, createdAtMs: now - MAX_AGE_MS - H });
      mkdirSync(join(root, 'unrelated-dir'));
      const isAlive = (pid: number) => pid === 202;

      const res = sweepStaleWorkRoots({ root, nowMs: now, cwds: [join(busy, 'packages', 'x')], isAlive });
      const names = (rows: { name: string }[]) => rows.map((r) => r.name.slice(WORK_ROOT_PREFIX.length)).sort();
      expect(names(res.removed)).toEqual(['dead-owner', 'keep-old']);
      expect(names(res.kept)).toEqual(['keep-fresh', 'keep-old-busy', 'live-owner']);
      expect(existsSync(join(root, `${WORK_ROOT_PREFIX}dead-owner`))).toBe(false);
      expect(existsSync(busy)).toBe(true);
      expect(existsSync(join(root, 'unrelated-dir'))).toBe(true);

      // Without /proc a tree's idleness is unprovable: only a dead non-keep owner goes.
      tree('dead-owner-2', { pid: 101, keep: false, createdAtMs: now - 60_000 });
      const blind = sweepStaleWorkRoots({ root, nowMs: now + MAX_AGE_MS * 2, cwds: null, isAlive });
      expect(names(blind.removed)).toEqual(['dead-owner-2']);
      expect(existsSync(busy)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('WI-10005934: keeps only the newest MAX_IDLE_KEPT_TREES idle kept trees, never counting a busy one', () => {
    const { MAX_IDLE_KEPT_TREES } = mod as { MAX_IDLE_KEPT_TREES: number };
    expect(MAX_IDLE_KEPT_TREES).toBe(4);
    const root = mkdtempSync(join(tmpdir(), 'lac-cap-'));
    try {
      const now = Date.now();
      const tree = (name: string, ageMs: number) => {
        const p = join(root, `${WORK_ROOT_PREFIX}${name}`);
        mkdirSync(join(p, '.git'), { recursive: true });
        writeFileSync(join(p, OWNER_MARKER), JSON.stringify({ pid: 101, keep: true, createdAtMs: now - ageMs }));
        return p;
      };
      // Six idle young kept trees (all under the TTL) plus the OLDEST one, which is busy.
      for (let i = 1; i <= 6; i++) tree(`idle-${i}h`, i * 0.5 * H);
      const busy = tree('busy-oldest', KEEP_TTL_MS - 60_000);
      const names = (rows: { name: string }[]) => rows.map((r) => r.name.slice(WORK_ROOT_PREFIX.length)).sort();
      const isAlive = () => false;

      // Without /proc nothing is provably idle, so the cap removes nothing.
      const blind = sweepStaleWorkRoots({ root, nowMs: now, cwds: null, isAlive });
      expect(blind.removed).toEqual([]);

      const res = sweepStaleWorkRoots({ root, nowMs: now, cwds: [join(busy, 'apps')], isAlive });
      expect(names(res.removed)).toEqual(['idle-5h', 'idle-6h']);
      expect(res.removed.every((r) => r.reason === 'keep-over-cap')).toBe(true);
      expect(names(res.kept)).toEqual(['busy-oldest', 'idle-1h', 'idle-2h', 'idle-3h', 'idle-4h']);
      expect(res.kept.find((r) => r.name.endsWith('busy-oldest'))?.reason).toBe('in-use');
      expect(existsSync(busy)).toBe(true);
      expect(existsSync(join(root, `${WORK_ROOT_PREFIX}idle-6h`))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
