/**
 * Tests for the jco transpile cache. Uses a stub transpiler so the
 * suite doesn't need the real 50MB jco install — production wires
 * it via @bytecodealliance/jco in a single seam (see G2b).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { transpileWasm, type Transpiler } from './transpile';

let scratchRoot: string;
let inputWasm: string;
let cacheRoot: string;

beforeEach(async () => {
  scratchRoot = join(
    tmpdir(),
    `papercusp-transpile-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await fs.mkdir(scratchRoot, { recursive: true });
  inputWasm = join(scratchRoot, 'plugin.wasm');
  cacheRoot = join(scratchRoot, 'cache');
  // Plausible-shaped wasm header so file looks the part. Actual bytes
  // don't matter — the transpiler is a stub.
  await fs.writeFile(inputWasm, Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0xab, 0xcd]));
});

afterEach(async () => {
  await fs.rm(scratchRoot, { recursive: true, force: true });
});

/** Stub transpiler that writes a single ESM file + records call count. */
function stubTranspiler(): Transpiler & { calls: number } {
  const fn = (async (_bytes, outputDir) => {
    fn.calls++;
    await fs.writeFile(
      join(outputDir, 'transpiled.js'),
      "export const init = async () => 'stub';",
    );
    return { entryRelPath: 'transpiled.js' };
  }) as Transpiler & { calls: number };
  fn.calls = 0;
  return fn;
}

describe('transpileWasm', () => {
  it('first call invokes the transpiler + writes cache + marker', async () => {
    const transpiler = stubTranspiler();
    const r = await transpileWasm({ wasmPath: inputWasm, cacheRoot, transpiler });

    expect(transpiler.calls).toBe(1);
    expect(r.wasInvoked).toBe(true);
    expect(r.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(r.cacheDir).toBe(join(cacheRoot, r.hash));
    expect(r.entryPath).toBe(join(r.cacheDir, 'transpiled.js'));
    expect(existsSync(r.entryPath)).toBe(true);
    expect(existsSync(join(r.cacheDir, '.transpile-complete'))).toBe(true);
  });

  it('second call hits cache, does NOT re-invoke transpiler', async () => {
    const transpiler = stubTranspiler();
    await transpileWasm({ wasmPath: inputWasm, cacheRoot, transpiler });
    expect(transpiler.calls).toBe(1);

    const r2 = await transpileWasm({ wasmPath: inputWasm, cacheRoot, transpiler });
    expect(transpiler.calls).toBe(1); // unchanged
    expect(r2.wasInvoked).toBe(false);
    expect(existsSync(r2.entryPath)).toBe(true);
  });

  it('different wasm contents → different cache directories', async () => {
    const transpiler = stubTranspiler();
    const r1 = await transpileWasm({ wasmPath: inputWasm, cacheRoot, transpiler });

    // Mutate the input file (different bytes → different sha).
    await fs.writeFile(inputWasm, Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x99, 0x88]));
    const r2 = await transpileWasm({ wasmPath: inputWasm, cacheRoot, transpiler });

    expect(r1.hash).not.toBe(r2.hash);
    expect(r1.cacheDir).not.toBe(r2.cacheDir);
    expect(transpiler.calls).toBe(2);
  });

  it('corrupt cache (marker exists but entry missing) → re-transpiles', async () => {
    const transpiler = stubTranspiler();
    const r1 = await transpileWasm({ wasmPath: inputWasm, cacheRoot, transpiler });
    expect(transpiler.calls).toBe(1);

    // Simulate corruption: delete the entry file but leave the marker.
    await fs.rm(r1.entryPath);
    expect(existsSync(r1.entryPath)).toBe(false);
    expect(existsSync(join(r1.cacheDir, '.transpile-complete'))).toBe(true);

    const r2 = await transpileWasm({ wasmPath: inputWasm, cacheRoot, transpiler });
    expect(transpiler.calls).toBe(2); // re-invoked
    expect(r2.wasInvoked).toBe(true);
    expect(existsSync(r2.entryPath)).toBe(true);
  });

  it('transpiler error propagates AND cleans up partial cache', async () => {
    const transpiler = (async () => {
      throw new Error('jco exploded');
    }) as Transpiler;

    await expect(
      transpileWasm({ wasmPath: inputWasm, cacheRoot, transpiler }),
    ).rejects.toThrow(/jco exploded/);

    // Cache dir for that hash should NOT exist after a failed transpile.
    const expectedHashedDirs = (
      await fs.readdir(cacheRoot).catch(() => [])
    ).filter((d) => /^[0-9a-f]{64}$/.test(d));
    expect(expectedHashedDirs).toEqual([]);
  });

  it('transpiler returning a non-existent entryRelPath is rejected', async () => {
    const transpiler = (async () => ({
      entryRelPath: 'does-not-exist.js',
    })) as Transpiler;

    await expect(
      transpileWasm({ wasmPath: inputWasm, cacheRoot, transpiler }),
    ).rejects.toThrow(/file not found/);
  });

  it("marker contains the entry's relative path", async () => {
    const transpiler = (async (_bytes, outputDir) => {
      await fs.mkdir(join(outputDir, 'sub'), { recursive: true });
      await fs.writeFile(join(outputDir, 'sub', 'main.js'), 'export {}');
      return { entryRelPath: 'sub/main.js' };
    }) as Transpiler;

    const r = await transpileWasm({ wasmPath: inputWasm, cacheRoot, transpiler });
    expect(r.entryPath).toBe(join(r.cacheDir, 'sub/main.js'));

    const marker = await fs.readFile(
      join(r.cacheDir, '.transpile-complete'),
      'utf8',
    );
    expect(marker.trim()).toBe('sub/main.js');
  });

  it('concurrent calls with same wasm both succeed (one wins the rename)', async () => {
    const transpiler = stubTranspiler();
    const [a, b] = await Promise.all([
      transpileWasm({ wasmPath: inputWasm, cacheRoot, transpiler }),
      transpileWasm({ wasmPath: inputWasm, cacheRoot, transpiler }),
    ]);

    expect(a.cacheDir).toBe(b.cacheDir);
    expect(existsSync(a.entryPath)).toBe(true);
    expect(existsSync(b.entryPath)).toBe(true);
    // Both invocations may have run the transpiler (race window
    // before the cache marker exists); only one wins the rename.
    expect(transpiler.calls).toBeGreaterThanOrEqual(1);
    expect(transpiler.calls).toBeLessThanOrEqual(2);
    // No leftover .tmp-* directories.
    const dirs = await fs.readdir(cacheRoot);
    expect(dirs.some((d) => d.includes('.tmp-'))).toBe(false);
  });
});
