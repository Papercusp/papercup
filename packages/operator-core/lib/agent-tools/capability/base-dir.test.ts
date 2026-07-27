/**
 * base-dir.test.ts — EI-1754: capability tools must resolve the canonical tree for
 * the superuser context, not the operator's release-deploy cwd.
 *
 * TEETH: projectDir-FIRST — a harness bee's tree always wins, so the integration-root
 * fallback can NEVER override it (even if a bee inherits PAPERCUSP_INTEGRATION_ROOT);
 * the env is consulted ONLY for the projectDir-undefined superuser case.
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, symlinkSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveCapabilityBaseDir, realpathSoft, resolveAgentWorkspaceRoot } from './base-dir';
import { writeFileSync } from 'node:fs';

describe('EI-1754 — resolveCapabilityBaseDir', () => {
  const orig = process.env.PAPERCUSP_INTEGRATION_ROOT;
  afterEach(() => {
    if (orig === undefined) delete process.env.PAPERCUSP_INTEGRATION_ROOT;
    else process.env.PAPERCUSP_INTEGRATION_ROOT = orig;
  });

  it('ctx.projectDir WINS — a harness-scoped agent keeps its own tree (env is ignored)', () => {
    process.env.PAPERCUSP_INTEGRATION_ROOT = '/canonical';
    expect(resolveCapabilityBaseDir({ projectDir: '/harness/tree' })).toBe('/harness/tree');
  });

  it('superuser ctx (projectDir undefined) falls back to PAPERCUSP_INTEGRATION_ROOT, NOT process.cwd()', () => {
    process.env.PAPERCUSP_INTEGRATION_ROOT = '/canonical';
    expect(resolveCapabilityBaseDir({})).toBe('/canonical');
    expect(resolveCapabilityBaseDir({ projectDir: undefined })).toBe('/canonical');
  });

  it('no projectDir + no env → process.cwd() (last-resort, unchanged from the old behavior)', () => {
    delete process.env.PAPERCUSP_INTEGRATION_ROOT;
    expect(resolveCapabilityBaseDir({})).toBe(process.cwd());
  });

  it('empty / whitespace env is treated as unset → process.cwd()', () => {
    process.env.PAPERCUSP_INTEGRATION_ROOT = '   ';
    expect(resolveCapabilityBaseDir({})).toBe(process.cwd());
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
