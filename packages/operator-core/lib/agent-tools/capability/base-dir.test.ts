/**
 * base-dir.test.ts — EI-1754: capability tools must resolve the canonical tree for
 * the superuser context, not the operator's release-deploy cwd.
 *
 * TEETH: projectDir-FIRST — a harness bee's tree always wins, so the integration-root
 * fallback can NEVER override it (even if a bee inherits PAPERCUSP_INTEGRATION_ROOT);
 * the env is consulted ONLY for the projectDir-undefined superuser case.
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, symlinkSync, realpathSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  pickCapabilityBaseDir,
  resolveAgentWorkspaceRoot,
  resolveCapabilityBaseDir,
  resolveCapabilityIntegrationRoot,
  realpathSoft,
} from './base-dir';
import { writeFileSync } from 'node:fs';

describe('EI-1754 — resolveCapabilityBaseDir', () => {
  const orig = process.env.PAPERCUSP_INTEGRATION_ROOT;
  const origCanonical = process.env.PAPERCUSP_CANONICAL_TREE;
  afterEach(() => {
    if (orig === undefined) delete process.env.PAPERCUSP_INTEGRATION_ROOT;
    else process.env.PAPERCUSP_INTEGRATION_ROOT = orig;
    if (origCanonical === undefined) delete process.env.PAPERCUSP_CANONICAL_TREE;
    else process.env.PAPERCUSP_CANONICAL_TREE = origCanonical;
  });

  it('ctx.projectDir WINS — a harness-scoped agent keeps its own tree (env is ignored)', () => {
    process.env.PAPERCUSP_INTEGRATION_ROOT = '/canonical';
    expect(resolveCapabilityBaseDir({ projectDir: '/harness/tree' })).toBe('/harness/tree');
  });

  it('superuser ctx (projectDir undefined) falls back to PAPERCUSP_INTEGRATION_ROOT, NOT process.cwd()', () => {
    delete process.env.PAPERCUSP_CANONICAL_TREE;
    process.env.PAPERCUSP_INTEGRATION_ROOT = '/canonical';
    expect(resolveCapabilityBaseDir({})).toBe('/canonical');
    expect(resolveCapabilityBaseDir({ projectDir: undefined })).toBe('/canonical');
  });

  it('superuser ctx prefers PAPERCUSP_CANONICAL_TREE over a serving mirror', () => {
    process.env.PAPERCUSP_CANONICAL_TREE = '/canonical-edit-tree';
    process.env.PAPERCUSP_INTEGRATION_ROOT = '/papercusp-staging';
    expect(resolveCapabilityBaseDir({})).toBe('/canonical-edit-tree');
    expect(resolveCapabilityBaseDir({ projectDir: undefined })).toBe('/canonical-edit-tree');
  });

  it('no projectDir + no env → process.cwd() (last-resort, unchanged from the old behavior)', () => {
    delete process.env.PAPERCUSP_CANONICAL_TREE;
    delete process.env.PAPERCUSP_INTEGRATION_ROOT;
    expect(resolveCapabilityBaseDir({})).toBe(process.cwd());
  });

  it('empty / whitespace env is treated as unset → process.cwd()', () => {
    process.env.PAPERCUSP_CANONICAL_TREE = '   ';
    process.env.PAPERCUSP_INTEGRATION_ROOT = '   ';
    expect(resolveCapabilityBaseDir({})).toBe(process.cwd());
  });

  it('keeps the exported picker raw while the explicit integration-root helper canonicalizes', () => {
    const root = mkdtempSync(join(tmpdir(), 'papercusp-integration-picker-'));
    const real = join(root, 'papercusp');
    const link = join(root, 'papercup');
    mkdirSync(real);
    symlinkSync(real, link);
    process.env.PAPERCUSP_INTEGRATION_ROOT = link;

    try {
      expect(pickCapabilityBaseDir({})).toBe(link);
      expect(resolveCapabilityIntegrationRoot()).toBe(realpathSync(real));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('EI-5912 — symlink resolution so the exec-sandbox writable-cwd bind matches the real path', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'papercusp-basedir-'));
  });
  afterEach(() => {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it('resolves a symlinked base dir to its REAL path (the papercup→papercusp case)', () => {
    const real = join(root, 'papercusp');
    const link = join(root, 'papercup');
    mkdirSync(real);
    symlinkSync(real, link);
    // node resolves a write UNDER the cwd through the symlink to `real`; the sandbox
    // binds the path we hand it writable, so the base dir MUST be the real path or a
    // write to <cwd>/node_modules/.vite-temp EROFSes under the read-only `/` bind.
    expect(realpathSoft(link)).toBe(realpathSync(real));
    expect(resolveCapabilityBaseDir({ projectDir: link })).toBe(realpathSync(real));
  });

  it('a non-existent base dir is returned unchanged (fail-soft, never throws)', () => {
    const missing = join(root, 'does', 'not', 'exist');
    expect(realpathSoft(missing)).toBe(missing);
    expect(resolveCapabilityBaseDir({ projectDir: missing })).toBe(missing);
  });
});

/**
 * resolveAgentWorkspaceRoot — for tools that run a REPO-ROOT-relative script
 * (testing:run's scripts/test-files.mjs) or resolve a repo-root-relative project
 * (build:typecheck). It must walk UP from the agent's tree, never from the
 * operator's cwd.
 */
describe('EI-1754 — resolveAgentWorkspaceRoot', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = realpathSync(mkdtempSync(join(tmpdir(), 'pc-ws-root-')));
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  /** A superproject root: `.git` DIRECTORY + package.json declaring workspaces. */
  function makeRepoRoot(dir: string): string {
    mkdirSync(dir, { recursive: true });
    mkdirSync(join(dir, '.git'));
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ workspaces: ['packages/*'] }));
    return dir;
  }

  it('walks UP from ctx.projectDir to the workspace root — a workspace subdir is not the root', () => {
    const repo = makeRepoRoot(join(tmp, 'repo'));
    const pkg = join(repo, 'packages', 'operator-core');
    mkdirSync(pkg, { recursive: true });
    // The regression this pins: resolveCapabilityBaseDir alone returns `pkg`, and
    // join(pkg,'scripts','test-files.mjs') does not exist — the router never runs.
    expect(resolveAgentWorkspaceRoot({ projectDir: pkg })).toBe(repo);
  });

  it('prefers the canonical edit tree over the serving mirror for a superuser test root', () => {
    const canonical = makeRepoRoot(join(tmp, 'papercusp'));
    const mirror = makeRepoRoot(join(tmp, 'papercusp-staging'));
    const previousCanonical = process.env.PAPERCUSP_CANONICAL_TREE;
    const previousIntegration = process.env.PAPERCUSP_INTEGRATION_ROOT;
    process.env.PAPERCUSP_CANONICAL_TREE = canonical;
    process.env.PAPERCUSP_INTEGRATION_ROOT = mirror;
    try {
      expect(resolveAgentWorkspaceRoot({})).toBe(canonical);
    } finally {
      if (previousCanonical === undefined) delete process.env.PAPERCUSP_CANONICAL_TREE;
      else process.env.PAPERCUSP_CANONICAL_TREE = previousCanonical;
      if (previousIntegration === undefined) delete process.env.PAPERCUSP_INTEGRATION_ROOT;
      else process.env.PAPERCUSP_INTEGRATION_ROOT = previousIntegration;
    }
  });

  it('does NOT stop inside a git SUBMODULE (a submodule carries a .git FILE, not a directory)', () => {
    const repo = makeRepoRoot(join(tmp, 'repo'));
    const sub = join(repo, 'libs', 'submodule');
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, '.git'), 'gitdir: ../../.git/modules/submodule');
    writeFileSync(join(sub, 'package.json'), JSON.stringify({ workspaces: ['x'] }));
    expect(resolveAgentWorkspaceRoot({ projectDir: sub })).toBe(repo);
  });

  it('ignores the operator’s cwd — the agent’s tree decides, even when cwd is another repo', () => {
    const agentRepo = makeRepoRoot(join(tmp, 'staging'));
    makeRepoRoot(join(tmp, 'release'));
    // Whatever the operator's cwd is, projectDir wins and its OWN root is returned.
    expect(resolveAgentWorkspaceRoot({ projectDir: join(agentRepo, 'apps', 'operator') }))
      .not.toBe(join(tmp, 'release'));
  });

  it('fails soft to the base dir when no workspace root marker exists', () => {
    const bare = join(tmp, 'bare');
    mkdirSync(bare, { recursive: true });
    expect(resolveAgentWorkspaceRoot({ projectDir: bare })).toBe(bare);
  });
});

/**
 * EI-20881501070735530 — the CLASS guard.
 *
 * EI-1754 migrated read / write / edit / inspect / bash to `resolveCapabilityBaseDir`
 * and left `capability:git` and `locks/file-lock-guard` on the raw
 * `ctx.projectDir ?? process.cwd()` fallback. Nothing failed, so the two survivors sat
 * there for months answering out of the :3070 operator's own cwd — the RELEASE checkout,
 * a different worktree pinned to green `main`, under an `apps/operator/` prefix. The
 * symptoms were silent by construction: `git log -- <path>` printed nothing at exit 0
 * (a false absence), and `capability:write`/`edit` took file locks on a key no peer and
 * no PreToolUse hook ever uses (arbitration silently defeated on a shared tree).
 *
 * A one-file fix would leave the next copy of this line free to reappear, so the
 * invariant is enforced over the whole tool tree instead: the fallback lives in exactly
 * one module, and every tool asks that module.
 */
describe('EI-20881501070735530 — the base-dir fallback is not re-implemented per tool', () => {
  /** The defect shape: a tool deciding for itself what "the project dir" means. */
  const RAW_FALLBACK = /projectDir\s*\?\?\s*process\s*\.\s*cwd\s*\(\s*\)/;

  /**
   * Permanent controls. A source-scanning guard fails OPEN — if the pattern stops
   * matching (a refactor to `??=`, an escaping slip, a bad path root) it reports a clean
   * tree forever and nobody finds out. These two make the detector prove it still works
   * on every run: one string it MUST flag, one it MUST NOT.
   */
  const DEFECT_CONTROL = 'const baseDir = ctx.projectDir ?? process.cwd();';
  const FIXED_CONTROL = 'const baseDir = resolveCapabilityBaseDir(ctx);';

  /** base-dir.ts owns the fallback and quotes the old shape in its own EI-1754 history. */
  const EXEMPT = new Set(['base-dir.ts']);

  /**
   * The invariant is about CODE. A fixed site that DOCUMENTS what it used to do — which
   * is how the two survivors are annotated now — must not read as a live offender, or the
   * guard punishes exactly the comment that stops the next person reintroducing it.
   *
   * Deliberately fail-CLOSED where it is imprecise: block comments and whole-line `//`
   * comments are removed, a TRAILING `//` comment after code is not. So the worst case is
   * a noisy false alarm on a pattern quoted at the end of a code line, never a silent miss.
   */
  function stripComments(src: string): string {
    return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
  }

  const agentToolsRoot = fileURLToPath(new URL('..', import.meta.url));

  function sourceFiles(dir: string, acc: string[] = []): string[] {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules' && entry.name !== '__tests__') sourceFiles(full, acc);
        continue;
      }
      if (!entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) continue;
      if (EXEMPT.has(entry.name)) continue;
      acc.push(full);
    }
    return acc;
  }

  it('the detector fires on the defect shape and stays silent on the fixed shape', () => {
    expect(RAW_FALLBACK.test(stripComments(DEFECT_CONTROL))).toBe(true);
    expect(RAW_FALLBACK.test(stripComments(FIXED_CONTROL))).toBe(false);
  });

  it('comment-stripping hides a DOCUMENTED occurrence without hiding a live one', () => {
    expect(RAW_FALLBACK.test(stripComments(`// we used to write ${DEFECT_CONTROL}`))).toBe(false);
    expect(RAW_FALLBACK.test(stripComments(`/**\n * history: ${DEFECT_CONTROL}\n */`))).toBe(false);
    // …and the same file with the defect ALSO present as code is still caught.
    expect(RAW_FALLBACK.test(stripComments(`// history: ${DEFECT_CONTROL}\n${DEFECT_CONTROL}`))).toBe(true);
  });

  it('scans a non-empty set of agent-tool sources (a zero-file scan is a broken probe, not a pass)', () => {
    expect(sourceFiles(agentToolsRoot).length).toBeGreaterThan(20);
  });

  it('no agent-tool source resolves its own base dir with `ctx.projectDir ?? process.cwd()`', () => {
    const offenders = sourceFiles(agentToolsRoot)
      .filter((f) => RAW_FALLBACK.test(stripComments(readFileSync(f, 'utf8'))))
      .map((f) => relative(agentToolsRoot, f));
    expect(
      offenders,
      `These files re-implement the base-dir fallback instead of calling resolveCapabilityBaseDir(ctx). ` +
        `For a superuser ctx (projectDir undefined) that resolves to the :3070 operator's release-checkout ` +
        `cwd, not the tree the agent edits — silently, at exit 0. Import { resolveCapabilityBaseDir } from ` +
        `the capability/base-dir module instead.`,
    ).toEqual([]);
  });
});
