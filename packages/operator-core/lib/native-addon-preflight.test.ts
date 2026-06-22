/**
 * A1 (infra-fail-fast-build-integrity-2026-06-19) — native-addon preflight.
 * Pure-logic tests via an injected requireFn, plus a real-load smoke against
 * the actually-installed better-sqlite3 (the 2026-06-19 outage addon).
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  DEFAULT_REQUIRED_ADDONS,
  requiredAddonsFromEnv,
  loadAddon,
  checkNativeAddons,
  discoverAddonPackages,
  formatReport,
  shouldSkipAddon,
  runBootAddonPreflight,
} from './native-addon-preflight';

const esmError = (): never => {
  const e = new Error('require() of ESM module not supported') as NodeJS.ErrnoException;
  e.code = 'ERR_REQUIRE_ESM';
  throw e;
};

describe('requiredAddonsFromEnv', () => {
  it('defaults to better-sqlite3', () => {
    expect(requiredAddonsFromEnv({} as NodeJS.ProcessEnv)).toEqual([...DEFAULT_REQUIRED_ADDONS]);
    expect(DEFAULT_REQUIRED_ADDONS).toContain('better-sqlite3');
  });
  it('honors a comma-separated env override (trimmed, empties dropped)', () => {
    const env = { PAPERCUSP_PREFLIGHT_ADDONS: ' better-sqlite3 , zero-sqlite3 ,, ' } as NodeJS.ProcessEnv;
    expect(requiredAddonsFromEnv(env)).toEqual(['better-sqlite3', 'zero-sqlite3']);
  });
});

describe('loadAddon', () => {
  it('ok on a clean require', () => {
    expect(loadAddon('x', () => ({}))).toEqual({ ok: true });
  });
  it('fails (ok:false) on a throw, capturing the message', () => {
    const r = loadAddon('x', () => { throw new Error('Module did not self-register'); });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/self-register/);
  });
  it('is indeterminate (ok:null) on ERR_REQUIRE_ESM — never a gate failure', () => {
    const r = loadAddon('x', esmError);
    expect(r.ok).toBeNull();
  });
});

describe('checkNativeAddons gate', () => {
  it('passes when every required addon loads; advisory failure does not gate', () => {
    const requireFn = (s: string) => {
      if (s === 'flaky-advisory') throw new Error('boom');
      return {};
    };
    const r = checkNativeAddons({
      requireFn,
      required: ['better-sqlite3'],
      advisory: ['flaky-advisory'],
    });
    expect(r.ok).toBe(true);
    expect(r.results.find((x) => x.name === 'flaky-advisory')?.ok).toBe(false);
    expect(r.node).toBe(process.versions.node);
    expect(r.abi).toBe(process.versions.modules);
  });

  it('FAILS when a required addon throws (the ABI-mismatch case)', () => {
    const requireFn = (s: string) => {
      if (s === 'better-sqlite3') {
        const e = new Error('Module did not self-register');
        throw e;
      }
      return {};
    };
    const r = checkNativeAddons({ requireFn, required: ['better-sqlite3'], advisory: [] });
    expect(r.ok).toBe(false);
    expect(formatReport(r)).toMatch(/FAIL — required addon\(s\) did not load: better-sqlite3/);
  });

  it('fails CLOSED when a required addon is indeterminate (ESM)', () => {
    const r = checkNativeAddons({ requireFn: esmError, required: ['better-sqlite3'], advisory: [] });
    expect(r.ok).toBe(false);
  });

  it('skips advisory bare-runtime packages (ok:null) without loading them', () => {
    let loaded: string[] = [];
    const requireFn = (s: string) => { loaded.push(s); return {}; };
    const r = checkNativeAddons({
      requireFn,
      required: ['better-sqlite3'],
      advisory: ['bare-fs', 'sodium-native'],
      skipAdvisory: (n) => shouldSkipAddon(n),
    });
    expect(loaded).toEqual(['better-sqlite3', 'sodium-native']); // bare-fs never attempted
    expect(r.results.find((x) => x.name === 'bare-fs')?.ok).toBeNull();
    expect(r.ok).toBe(true); // skipped advisory never affects the gate
  });

  it('shouldSkipAddon matches bare- prefix incl. scoped, not better-sqlite3', () => {
    expect(shouldSkipAddon('bare-fs')).toBe(true);
    expect(shouldSkipAddon('@some/bare-os')).toBe(true);
    expect(shouldSkipAddon('better-sqlite3')).toBe(false);
    expect(shouldSkipAddon('sodium-native')).toBe(false);
  });

  it('required wins when a name is in both required and advisory (no double-run)', () => {
    const r = checkNativeAddons({
      requireFn: () => ({}),
      required: ['better-sqlite3'],
      advisory: ['better-sqlite3'],
    });
    expect(r.results.filter((x) => x.name === 'better-sqlite3')).toHaveLength(1);
    expect(r.results[0].required).toBe(true);
  });
});

describe('runBootAddonPreflight (A2 boot self-check)', () => {
  const okRequire = () => ({});
  const failRequire = (s: string) => {
    if (s === 'better-sqlite3') throw new Error('Module did not self-register');
    return {};
  };

  it('is silent + does not exit when the required addon loads', () => {
    const logs: string[] = [];
    const exits: number[] = [];
    const r = runBootAddonPreflight({
      requireFn: okRequire,
      log: (m) => logs.push(m),
      exit: (c) => exits.push(c),
      env: {} as NodeJS.ProcessEnv,
    });
    expect(r.ok).toBe(true);
    expect(logs).toEqual([]);
    expect(exits).toEqual([]);
  });

  it('logs LOUDLY but does NOT exit on failure when the fatal flag is off', () => {
    const logs: string[] = [];
    const exits: number[] = [];
    const r = runBootAddonPreflight({
      requireFn: failRequire,
      log: (m) => logs.push(m),
      exit: (c) => exits.push(c),
      env: {} as NodeJS.ProcessEnv,
    });
    expect(r.ok).toBe(false);
    expect(logs.join('\n')).toMatch(/BOOT self-check FAILED/);
    expect(exits).toEqual([]); // safe by default — no crashloop
  });

  it('exits non-zero on failure ONLY when PAPERCUSP_ADDON_PREFLIGHT_FATAL=1', () => {
    const exits: number[] = [];
    runBootAddonPreflight({
      requireFn: failRequire,
      log: () => {},
      exit: (c) => exits.push(c),
      env: { PAPERCUSP_ADDON_PREFLIGHT_FATAL: '1' } as unknown as NodeJS.ProcessEnv,
    });
    expect(exits).toEqual([1]);
  });
});

describe('discovery + real load (integration against installed binaries)', () => {
  const requireFromHere = createRequire(import.meta.url);
  // Hoisted workspace node_modules (operator-core → packages/operator-core → repo root).
  const repoNodeModules = join(import.meta.dirname ?? __dirname, '..', '..', '..', 'node_modules');

  it('discoverAddonPackages finds better-sqlite3 in the workspace node_modules', () => {
    const found = discoverAddonPackages(repoNodeModules);
    expect(found).toContain('better-sqlite3');
  });

  it('better-sqlite3 actually loads under this runtime Node (the outage regression)', () => {
    const r = checkNativeAddons({
      requireFn: (s) => requireFromHere(s),
      required: ['better-sqlite3'],
      advisory: [],
    });
    // If this ever fails, the installed better-sqlite3 binary is broken for the
    // test's Node ABI — exactly the 2026-06-19 outage condition.
    expect(r.ok).toBe(true);
  });
});
