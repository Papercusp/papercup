/**
 * boot-integrity-preflight.test.ts — the fail-fast guard against an inconsistent
 * release checkout (the 2026-06-25 MODULE_NOT_FOUND crash-loop class). Pins: the
 * manifest is resolve-checked, a missing module is reported (not thrown), and the
 * guard exits with the distinct integrity code + a named log on a broken build but
 * is a no-op on a healthy one.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  preflightCriticalModules,
  runBootIntegrityGuardOrExit,
  diffLockAndTree,
  checkLockTreeDrift,
  CRITICAL_BOOT_MODULES,
  BOOT_INTEGRITY_EXIT_CODE,
  type ModuleResolver,
  type LockTreeDriftCheck,
} from './boot-integrity-preflight';

/** A clean drift result — inject this in tests that aren't exercising drift, so they
 *  don't depend on (or get spuriously failed by) the state of the REAL live tree. */
const cleanDrift = (): LockTreeDriftCheck => ({ ok: true, missing: [], extraneous: [], skipped: false });

/** A resolver that resolves everything EXCEPT the given ids (which throw like Node's
 *  MODULE_NOT_FOUND). */
const resolverMissing = (missing: string[]): ModuleResolver => (id) => {
  if (missing.includes(id)) {
    const e = new Error(`Cannot find module '${id}'\n    at ...`) as Error & { code?: string };
    e.code = 'MODULE_NOT_FOUND';
    throw e;
  }
  return `/fake/node_modules/${id}`;
};
const resolverAllOk: ModuleResolver = (id) => `/fake/node_modules/${id}`;

describe('preflightCriticalModules', () => {
  it('ok=true when every module resolves', () => {
    const r = preflightCriticalModules({ resolve: resolverAllOk });
    expect(r.ok).toBe(true);
    expect(r.missing).toEqual([]);
    expect(r.checked).toEqual([...CRITICAL_BOOT_MODULES]);
  });

  it('reports the missing module(s) without throwing (the 2026-06-25 culprits)', () => {
    const r = preflightCriticalModules({
      resolve: resolverMissing(['@papercusp/plugin-loader', '@modelcontextprotocol/sdk/package.json']),
    });
    expect(r.ok).toBe(false);
    expect(r.missing.map((m) => m.id)).toEqual([
      '@papercusp/plugin-loader',
      '@modelcontextprotocol/sdk/package.json',
    ]);
    // first line of the error is captured for the operator's diagnostic
    expect(r.missing[0].error).toContain('Cannot find module');
  });

  it('honors an injected module list', () => {
    const r = preflightCriticalModules({ modules: ['a', 'b'], resolve: resolverMissing(['b']) });
    expect(r.ok).toBe(false);
    expect(r.checked).toEqual(['a', 'b']);
    expect(r.missing.map((m) => m.id)).toEqual(['b']);
  });
});

describe('runBootIntegrityGuardOrExit', () => {
  it('a broken build: exits with the integrity code + logs ONE named fatal, never returns', () => {
    const log = vi.fn();
    const exit = vi.fn(() => {
      throw new Error('__exit__'); // emulate process.exit not returning
    }) as unknown as (code: number) => never;
    expect(() =>
      runBootIntegrityGuardOrExit({
        resolve: resolverMissing(['mem0ai', 'hono']),
        driftCheck: cleanDrift,
        log,
        exit,
      }),
    ).toThrow('__exit__');
    expect(exit).toHaveBeenCalledWith(BOOT_INTEGRITY_EXIT_CODE);
    expect(log).toHaveBeenCalledOnce();
    const line = log.mock.calls[0][0] as string;
    expect(line).toContain('[boot-integrity] FATAL');
    expect(line).toContain('mem0ai');
    expect(line).toContain('hono');
    expect(line).toContain('npm ci');
  });

  it('a healthy build: does not exit or log, returns the ok result', () => {
    const log = vi.fn();
    const exit = vi.fn() as unknown as (code: number) => never;
    const r = runBootIntegrityGuardOrExit({ resolve: resolverAllOk, driftCheck: cleanDrift, log, exit });
    expect(r.ok).toBe(true);
    expect(exit).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it('the live manifest resolves in THIS (healthy) tree — guards against a false-positive manifest entry', () => {
    // No injected resolver → uses the real require.resolve against the live node_modules.
    // If this fails, a CRITICAL_BOOT_MODULES entry is mis-specified and would refuse to
    // start a GOOD build. (Resolve forms are exports-map-sensitive; see the manifest note.)
    const r = preflightCriticalModules();
    expect(r.missing).toEqual([]);
    expect(r.ok).toBe(true);
  });

  // EI-18666996942859193: the drift diff is now the PRIMARY signal (sentinel-check still
  // resolves fine here — these pin the drift-only paths).
  it('sentinel resolves fine but drift reports missing packages: still refuses boot', () => {
    const log = vi.fn();
    const exit = vi.fn(() => {
      throw new Error('__exit__');
    }) as unknown as (code: number) => never;
    expect(() =>
      runBootIntegrityGuardOrExit({
        resolve: resolverAllOk,
        driftCheck: () => ({ ok: false, missing: ['ollama', 'groq-sdk'], extraneous: [], skipped: false }),
        log,
        exit,
      }),
    ).toThrow('__exit__');
    expect(exit).toHaveBeenCalledWith(BOOT_INTEGRITY_EXIT_CODE);
    const line = log.mock.calls.find((c) => (c[0] as string).includes('FATAL'))?.[0] as string;
    expect(line).toContain('ollama');
    expect(line).toContain('groq-sdk');
  });

  it('drift reports only extraneous packages: logs a non-fatal warning, does NOT refuse boot', () => {
    const log = vi.fn();
    const exit = vi.fn() as unknown as (code: number) => never;
    const r = runBootIntegrityGuardOrExit({
      resolve: resolverAllOk,
      driftCheck: () => ({ ok: true, missing: [], extraneous: ['left-pad-old'], skipped: false }),
      log,
      exit,
    });
    expect(r.ok).toBe(true);
    expect(exit).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledOnce();
    const line = log.mock.calls[0][0] as string;
    expect(line).toContain('tree-drift');
    expect(line).toContain('left-pad-old');
    expect(line).not.toContain('FATAL');
  });

  it('a skipped drift check (no lockfile found) never refuses boot on its own', () => {
    const log = vi.fn();
    const exit = vi.fn() as unknown as (code: number) => never;
    const r = runBootIntegrityGuardOrExit({
      resolve: resolverAllOk,
      driftCheck: () => ({ ok: true, missing: [], extraneous: [], skipped: true, error: 'package-lock.json not found in any ancestor directory' }),
      log,
      exit,
    });
    expect(r.ok).toBe(true);
    expect(exit).not.toHaveBeenCalled();
    const line = log.mock.calls[0][0] as string;
    expect(line).toContain('tree-drift check skipped');
  });
});

describe('diffLockAndTree', () => {
  const lockOf = (packages: Record<string, { dev?: boolean; optional?: boolean; link?: boolean }>) =>
    JSON.stringify({ packages });

  it('direction A: a plain top-level lock entry absent from node_modules is MISSING', () => {
    const r = diffLockAndTree({
      rootDir: '/repo',
      readFile: () => lockOf({ 'node_modules/ollama': {}, 'node_modules/hono': {} }),
      readDir: () => ['hono'], // ollama absent on disk
      isDirectory: (p) => p === '/repo/node_modules/hono',
    });
    expect(r.missing).toEqual(['ollama']);
    expect(r.ok).toBe(false);
  });

  it('direction A: dev / optional / link entries are SKIPPED even when absent from disk', () => {
    const r = diffLockAndTree({
      rootDir: '/repo',
      readFile: () =>
        lockOf({
          'node_modules/only-dev': { dev: true },
          'node_modules/only-optional': { optional: true },
          'node_modules/workspace-link': { link: true },
        }),
      readDir: () => [],
      isDirectory: () => false,
    });
    expect(r.missing).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it('direction B: an on-disk top-level directory absent from the lock is EXTRANEOUS, and does not affect ok', () => {
    const r = diffLockAndTree({
      rootDir: '/repo',
      readFile: () => lockOf({ 'node_modules/hono': {} }),
      readDir: (p) => (p === '/repo/node_modules' ? ['hono', 'left-pad-old'] : []),
      isDirectory: () => true,
    });
    expect(r.missing).toEqual([]);
    expect(r.extraneous).toEqual(['left-pad-old']);
    expect(r.ok).toBe(true); // extraneous alone never flips ok — it's a future prune, not a present break
  });

  it('scoped packages (@scope/name) are diffed correctly in both directions', () => {
    const r = diffLockAndTree({
      rootDir: '/repo',
      readFile: () => lockOf({ 'node_modules/@azure/identity': {}, 'node_modules/@azure/extraneous-pkg': {} }),
      readDir: (p) => {
        if (p === '/repo/node_modules') return ['@azure'];
        if (p === '/repo/node_modules/@azure') return ['extraneous-pkg']; // 'identity' absent
        return [];
      },
      // only what readDir actually reported as present is a real directory — 'identity'
      // was never listed under @azure, so it must read as absent, not present.
      isDirectory: (p) => p !== '/repo/node_modules/@azure/identity',
    });
    expect(r.missing).toEqual(['@azure/identity']); // full scoped name, same form both directions use
    expect(r.extraneous).toEqual([]); // '@azure/extraneous-pkg' IS in the lock (just misleadingly named)
  });

  it('the WI-5801-class trap: checking direction B alone would give a false all-clear', () => {
    // Direction B (extraneous) reads empty — a partial check would call this "safe".
    // Direction A (missing) catches the real incomplete install. Both must run together.
    const r = diffLockAndTree({
      rootDir: '/repo',
      readFile: () => lockOf({ 'node_modules/ollama': {}, 'node_modules/groq-sdk': {} }),
      readDir: () => [], // node_modules exists but both required packages are absent
      isDirectory: () => false,
    });
    expect(r.extraneous).toEqual([]);
    expect(r.missing).toEqual(['groq-sdk', 'ollama']);
    expect(r.ok).toBe(false);
  });

  it('throws on an unreadable/unparseable lockfile — callers wanting a safe surface use checkLockTreeDrift', () => {
    expect(() =>
      diffLockAndTree({
        rootDir: '/repo',
        readFile: () => {
          throw new Error('ENOENT: no such file or directory');
        },
      }),
    ).toThrow('ENOENT');
  });
});

describe('checkLockTreeDrift', () => {
  it('never throws: a read failure is reported as skipped, not propagated', () => {
    const r = checkLockTreeDrift({
      rootDir: '/repo',
      readFile: () => {
        throw new Error('boom');
      },
    });
    expect(r.skipped).toBe(true);
    expect(r.error).toContain('boom');
    expect(r.ok).toBe(true); // fail-open: "couldn't compute" is never itself a refuse-boot signal
  });

  it('delegates to diffLockAndTree and reports skipped:false on success', () => {
    const r = checkLockTreeDrift({
      rootDir: '/repo',
      readFile: () => JSON.stringify({ packages: { 'node_modules/hono': {} } }),
      readDir: () => ['hono'],
      isDirectory: () => true,
    });
    expect(r.skipped).toBe(false);
    expect(r.ok).toBe(true);
    expect(r.missing).toEqual([]);
  });

  it('the live tree: runs cleanly against the real repo root without throwing (EI-18666996942859193)', () => {
    // No injected deps → walks up from this file to find the real package-lock.json and
    // diffs it against the real node_modules. Runs in well under a second over ~2500
    // packages. We assert it COMPLETES and reports skipped:false (a real lockfile IS
    // findable from this tree) — not `ok:true`, since the live tree's actual drift state
    // at test time is not this test's concern (that's what the boot guard is for).
    const r = checkLockTreeDrift();
    expect(r.skipped).toBe(false);
    expect(Array.isArray(r.missing)).toBe(true);
    expect(Array.isArray(r.extraneous)).toBe(true);
  });
});
