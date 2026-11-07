import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const admission = vi.hoisted(() => ({ beforeWrite: (_path: string): void => {} }));
vi.mock('../../../scripts/lib/fs-mutex.mjs', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../scripts/lib/fs-mutex.mjs')>();
  const fs = await import('node:fs/promises');
  return {
    ...original,
    withFsMutex: (name: string, fn: Parameters<typeof original.withFsMutex>[1],
      options: Parameters<typeof original.withFsMutex>[2]) => original.withFsMutex(name, fn, {
      ...options,
      io: {
        ...options?.io,
        writeFile: async (...args: Parameters<typeof fs.writeFile>) => {
          admission.beforeWrite(String(args[0]));
          return fs.writeFile(...args);
        },
      },
    }),
  };
});

import { compileDeclarationsIncrementally } from '../../../scripts/lib/declaration-compiler.mts';

const roots: string[] = [];
afterEach(() => {
  admission.beforeWrite = () => {};
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'papercusp-declaration-budget-'));
  roots.push(root);
  const config = join(root, 'tsconfig.json');
  writeFileSync(config, JSON.stringify({
    compilerOptions: {
      allowJs: true, checkJs: true, declaration: true, emitDeclarationOnly: true,
      rootDir: '.', outDir: '.', types: [], skipLibCheck: true,
      module: 'esnext', moduleResolution: 'bundler', target: 'es2022',
    },
    files: ['input.mjs'],
  }));
  writeFileSync(join(root, 'input.mjs'), 'export const answer = 42;\n');
  const out = join(root, 'out');
  mkdirSync(out);
  const cacheRoot = join(root, 'cache');
  return { root, config, out, cacheRoot };
}

// Advance only the deadline clock at a real mutex I/O boundary. No sleep, fake
// filesystem, or alternate locking implementation can make this control pass.
function clock() {
  const now = Date.now.bind(Date);
  const elapsed = { ms: 0 };
  vi.spyOn(Date, 'now').mockImplementation(() => now() + elapsed.ms);
  return elapsed;
}

function delayAdmission(elapsed: { ms: number }, ms: number) {
  let advanced = false;
  admission.beforeWrite = (path) => {
    if (!advanced && path.endsWith('.ticket/owner.json')) {
      elapsed.ms += ms;
      advanced = true;
    }
  };
}

describe('declaration compiler slice deadline', () => {
  it('admits uncontended setup taking over one second within the existing compiler slice', async () => {
    const { root, config, out, cacheRoot } = fixture();
    delayAdmission(clock(), 1_500);
    await compileDeclarationsIncrementally(root, config, out, { cacheRoot });
    expect(readFileSync(join(out, 'input.d.mts'), 'utf8')).toContain('answer: 42');
    expect(readdirSync(join(cacheRoot, 'locks')).filter((name) => name.endsWith('.lock'))).toEqual([]);
  }, 60_000);

  it('enforces the slice deadline even when a caller supplies a cancellation token', async () => {
    const { root, config, out, cacheRoot } = fixture();
    const elapsed = clock();
    const callerCancellation = { isCancellationRequested: () => false, throwIfCancellationRequested() {} };
    await expect(compileDeclarationsIncrementally(root, config, out, {
      cacheRoot, budgetMs: 5_000, cancellationToken: callerCancellation,
      onProgress: () => { elapsed.ms += 5_001; },
    })).rejects.toThrow('slice incomplete');
    expect(existsSync(join(out, 'input.d.mts'))).toBe(false);
    const key = readdirSync(cacheRoot).find((name) => name !== 'locks')!;
    expect(existsSync(join(cacheRoot, key, 'compiler.tsbuildinfo'))).toBe(true);
  }, 60_000);

  it('times out exhausted admission with subphase evidence and leaves no output or held lock', async () => {
    const { root, config, out, cacheRoot } = fixture();
    delayAdmission(clock(), 45_001);
    await expect(compileDeclarationsIncrementally(root, config, out, { cacheRoot, budgetMs: 1_000 }))
      .rejects.toMatchObject({
        code: 'ETIMEDOUT',
        admissionSubphaseTimingsMs: expect.objectContaining({ 'ticket-owner-write': expect.any(Number) }),
      });
    expect(existsSync(join(out, 'input.d.mts'))).toBe(false);
    expect(readdirSync(cacheRoot)).toEqual(['locks']);
    expect(readdirSync(join(cacheRoot, 'locks')).filter((name) => name.endsWith('.lock'))).toEqual([]);
  }, 60_000);
});
