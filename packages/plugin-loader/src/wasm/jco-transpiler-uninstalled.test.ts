/**
 * jco-transpiler-uninstalled.test.ts — the "jco not installed" import branch.
 *
 * Separate file because pinning this branch requires the dynamic import of
 * @bytecodealliance/jco to THROW at module-resolution time (jco is a peerDep
 * that JS-only-plugin deployments don't install). The mock factory throws
 * unconditionally here, so realJcoTranspiler's catch surfaces the actionable
 * "install via pnpm add" error with the underlying cause appended.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@bytecodealliance/jco', () => {
  throw new Error('Cannot find package @bytecodealliance/jco');
});

import { realJcoTranspiler } from './jco-transpiler.ts';

describe('realJcoTranspiler — jco not installed', () => {
  it('throws an install-guidance error with the underlying cause appended', async () => {
    // The dynamic import rejects → realJcoTranspiler's catch surfaces the
    // actionable install message, appending the underlying cause after
    // "Underlying:". (Vitest wraps a throwing mock factory, so the exact
    // underlying text is its wrapper; what we pin is that the catch branch
    // produces the install-guidance error with a cause appended.)
    await expect(realJcoTranspiler(new Uint8Array([0x00, 0x61, 0x73, 0x6d]), '/out')).rejects.toThrow(
      /@bytecodealliance\/jco is not installed.*install via.*Underlying:/s,
    );
  });
});
