/**
 * base-dir.test.ts — EI-1754: capability tools must resolve the canonical tree for
 * the superuser context, not the operator's release-deploy cwd.
 *
 * TEETH: projectDir-FIRST — a harness bee's tree always wins, so the integration-root
 * fallback can NEVER override it (even if a bee inherits PAPERCUSP_INTEGRATION_ROOT);
 * the env is consulted ONLY for the projectDir-undefined superuser case.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { resolveCapabilityBaseDir } from './base-dir';

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
