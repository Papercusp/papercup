import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const SOURCE = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');

describe('event bootstrap kernel wiring (D-030)', () => {
  it('installs the control-anchor resolver at the shared event bootstrap seam', () => {
    const reactionInstall = SOURCE.indexOf('setReactionPostInvoke(handleToolInvoked);');
    const kernelInstall = SOURCE.indexOf('installControlAnchorKernelResolver();');
    const preconditionInstall = SOURCE.indexOf('setPreconditionFire(async (req) => {');

    expect(SOURCE).toContain('installControlAnchorKernelResolver');
    expect(reactionInstall).toBeGreaterThanOrEqual(0);
    expect(kernelInstall).toBeGreaterThan(reactionInstall);
    // The control resolver must be installed before any later precondition or
    // reaction dispatch can reach the shared projected dispatcher.
    expect(preconditionInstall).toBeGreaterThan(kernelInstall);
  });

  it('keeps the bootstrap import host-side rather than moving policy into generic tooldef', () => {
    expect(SOURCE).toContain("from '../projected-tool-deps'");
    expect(SOURCE).not.toContain("from '@papercusp/tooldef'");
  });
});

