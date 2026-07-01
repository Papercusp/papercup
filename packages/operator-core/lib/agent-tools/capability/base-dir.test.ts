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
import { resolveCapabilityBaseDir, realpathSoft } from './base-dir';

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
