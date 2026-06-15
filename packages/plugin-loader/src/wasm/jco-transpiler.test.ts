/**
 * jco-transpiler.test.ts — the single @bytecodealliance/jco seam (G2b).
 *
 * realJcoTranspiler is the production wiring of the injected Transpiler shape
 * to jco's `transpile()`. The pure, jco-version-resilient logic worth pinning
 * is the DEFENSIVE WRAPPING: the unexpected-API-shape error (no `transpile`
 * export), the per-file write loop with on-demand subdir mkdir, and the
 * missing-entry post-write guard. (The "jco not installed" import-failure
 * branch is pinned separately in jco-transpiler-uninstalled.test.ts, since that
 * needs the dynamic import to throw at module-resolution time.) jco is NOT
 * installed here, so it is mocked via a hoisted controller and node:fs is
 * mocked to capture writes without touching disk.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  // The function the mocked jco's `transpile` export should be (or undefined
  // to simulate a jco whose API shape no longer exports `transpile`).
  transpileFn: undefined as ((...args: unknown[]) => unknown) | undefined,
  writes: [] as Array<{ path: string; bytes: unknown }>,
  mkdirs: [] as Array<{ path: string; opts: unknown }>,
}));

// A stable namespace object whose `transpile` is a live getter — vitest's
// named-export validation sees `transpile` as an own key (so accessing it never
// errors), while its VALUE follows the controller per-test.
vi.mock('@bytecodealliance/jco', () => ({
  get transpile() {
    return h.transpileFn;
  },
}));

vi.mock('node:fs', () => ({
  promises: {
    mkdir: vi.fn(async (path: string, opts: unknown) => {
      h.mkdirs.push({ path, opts });
    }),
    writeFile: vi.fn(async (path: string, bytes: unknown) => {
      h.writes.push({ path, bytes });
    }),
  },
}));

import { realJcoTranspiler } from './jco-transpiler.ts';

beforeEach(() => {
  h.transpileFn = undefined;
  h.writes = [];
  h.mkdirs = [];
});
afterEach(() => vi.clearAllMocks());

const wasm = new Uint8Array([0x00, 0x61, 0x73, 0x6d]);

describe('realJcoTranspiler — failure surfaces', () => {
  it('throws when the jco module has no `transpile` export (API shape changed)', async () => {
    h.transpileFn = undefined; // simulate missing export
    await expect(realJcoTranspiler(wasm, '/out')).rejects.toThrow(
      /API shape unexpected: no `transpile` export/,
    );
  });

  it('throws when jco produces files but none is the expected entry', async () => {
    h.transpileFn = vi.fn(async () => ({
      files: { 'other.js': new Uint8Array([1]), 'transpiled.core.wasm': new Uint8Array([2]) },
    }));
    await expect(realJcoTranspiler(wasm, '/out')).rejects.toThrow(
      /no `transpiled\.js` entry.*other\.js/s,
    );
  });
});

describe('realJcoTranspiler — success path', () => {
  it('calls jco.transpile with the wasm bytes and the async/instantiation opts', async () => {
    const transpile = vi.fn(async () => ({ files: { 'transpiled.js': new Uint8Array([9]) } }));
    h.transpileFn = transpile;
    await realJcoTranspiler(wasm, '/out');
    expect(transpile).toHaveBeenCalledWith(wasm, { name: 'transpiled', instantiation: 'async' });
  });

  it('writes every produced file under the output dir and returns the entry rel path', async () => {
    h.transpileFn = vi.fn(async () => ({
      files: {
        'transpiled.js': new Uint8Array([1]),
        'transpiled.core.wasm': new Uint8Array([2, 3]),
      },
    }));
    const out = await realJcoTranspiler(wasm, '/out');
    expect(out).toEqual({ entryRelPath: 'transpiled.js' });
    const written = h.writes.map((w) => w.path).sort();
    expect(written).toEqual(['/out/transpiled.core.wasm', '/out/transpiled.js']);
  });

  it('mkdirs nested subdirs (interfaces/) before writing files inside them', async () => {
    h.transpileFn = vi.fn(async () => ({
      files: {
        'transpiled.js': new Uint8Array([1]),
        'interfaces/world.d.ts': new Uint8Array([2]),
      },
    }));
    await realJcoTranspiler(wasm, '/out');
    expect(h.mkdirs).toContainEqual({ path: '/out/interfaces', opts: { recursive: true } });
    expect(h.writes.map((w) => w.path)).toContain('/out/interfaces/world.d.ts');
  });

  it('does NOT mkdir for a top-level file (dir === outputDir)', async () => {
    h.transpileFn = vi.fn(async () => ({ files: { 'transpiled.js': new Uint8Array([1]) } }));
    await realJcoTranspiler(wasm, '/out');
    expect(h.mkdirs).toHaveLength(0);
  });
});
