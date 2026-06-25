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
  CRITICAL_BOOT_MODULES,
  BOOT_INTEGRITY_EXIT_CODE,
  type ModuleResolver,
} from './boot-integrity-preflight';

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
    const r = runBootIntegrityGuardOrExit({ resolve: resolverAllOk, log, exit });
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
});
