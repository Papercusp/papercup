/**
 * substrate-boot-wrapper.test.ts — the LAZY_SUBSTRATE_BOOT reaper gating
 * (P-008 / WI-596). Proves: OFF ⇒ the reaper never starts (byte-identical eager
 * boot); ON ⇒ tracking is enabled + the reaper starts exactly once (idempotent).
 *
 * Also proves the dark SUBSTRATE_SIDECAR path now boots via remote handles when
 * enabled, while preserving the in-process fallback on startup failure.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = { lazyOn: false, sidecarOn: false };

vi.mock('@papercusp/flags/server', () => ({
  getFlag: async (key: string) => {
    if (key.includes('lazy-substrate-boot')) return h.lazyOn;
    if (key.includes('substrate-sidecar')) return h.sidecarOn;
    return false;
  },
  onFlagChange: () => {},
}));
vi.mock('./flag-distinct-id', () => ({ systemDistinctId: () => 'system' }));

const enableTracking = vi.fn();
const bootAll = vi.fn(async (opts?: { bootHarness?: (o: any) => Promise<any>; skipSendSideWiring?: boolean }) => {
  if (opts?.bootHarness) {
    await opts.bootHarness({
      workspaceRoot: '/tmp/ws',
      workspaceId: 'ws',
      harnessSlug: 'h',
      swarmBinding: null,
    });
  }
  return {
    attempted: opts?.bootHarness ? 1 : 0,
    booted: opts?.bootHarness ? 1 : 0,
    alreadyBooted: 0,
    failed: 0,
    results: opts?.bootHarness ? [{ workspaceId: 'ws', harnessSlug: 'h', state: 'booted' as const }] : [],
  };
});
vi.mock('./boot-all', () => ({
  bootAllHarnessesForActiveWorkspace: (opts?: unknown) => bootAll(opts as Parameters<typeof bootAll>[0]),
  enableSubstrateEvictionTracking: () => enableTracking(),
  gatherBootedHarnessFacts: () => [],
  evictBootedHarnessEngine: async () => false,
}));

const spawnSidecar = vi.fn(async () => {});
const registerShutdown = vi.fn();
vi.mock('./substrate-sidecar-spawn', () => ({
  spawnSubstrateSidecar: () => spawnSidecar(),
  registerSidecarShutdownHooks: () => registerShutdown(),
}));

const ipcCalls: Array<{ method: string; params?: unknown }> = [];
const ipcClient = {
  async call<T>(method: string, params?: unknown): Promise<T> {
    ipcCalls.push({ method, params });
    if (method === 'sidecar:healthz') return { status: 'ready' } as T;
    if (method === 'substrate:bootHarness') {
      return { storeId: 'store-1', ownLogKey: 'a'.repeat(64), ownLogLength: 0 } as T;
    }
    return undefined as T;
  },
};
vi.mock('./substrate-ipc-client', () => ({
  getSubstrateIpcClient: () => ipcClient,
}));

const startReaper = vi.fn(() => ({ stop: vi.fn(), tickOnce: vi.fn(async () => []) }));
vi.mock('./substrate-eviction-reaper', () => ({
  startSubstrateEvictionReaper: () => startReaper(),
}));

import {
  bootSubstrateWithFallback,
  maybeStartSubstrateEvictionReaper,
  stopSubstrateEvictionReaper,
} from './substrate-boot-wrapper';

beforeEach(() => {
  h.lazyOn = false;
  h.sidecarOn = false;
  enableTracking.mockClear();
  bootAll.mockClear();
  spawnSidecar.mockClear();
  registerShutdown.mockClear();
  ipcCalls.length = 0;
  startReaper.mockClear();
  stopSubstrateEvictionReaper(); // reset the module singleton between tests
});
afterEach(() => {
  stopSubstrateEvictionReaper();
});

describe('LAZY_SUBSTRATE_BOOT reaper gating', () => {
  it('does NOT start the reaper when the flag is OFF', async () => {
    h.lazyOn = false;
    const started = await maybeStartSubstrateEvictionReaper();
    expect(started).toBe(false);
    expect(startReaper).not.toHaveBeenCalled();
    expect(enableTracking).not.toHaveBeenCalled();
  });

  it('starts the reaper + enables tracking when the flag is ON', async () => {
    h.lazyOn = true;
    const started = await maybeStartSubstrateEvictionReaper();
    expect(started).toBe(true);
    expect(enableTracking).toHaveBeenCalledOnce();
    expect(startReaper).toHaveBeenCalledOnce();
  });

  it('is idempotent — a second call does not start a second reaper', async () => {
    h.lazyOn = true;
    await maybeStartSubstrateEvictionReaper();
    await maybeStartSubstrateEvictionReaper();
    expect(startReaper).toHaveBeenCalledOnce();
  });
});

describe('bootSubstrateWithFallback', () => {
  it('OFF: boots in-process, no sidecar, no reaper', async () => {
    const r = await bootSubstrateWithFallback();
    expect(bootAll).toHaveBeenCalledOnce();
    expect(r.usedSidecar).toBe(false);
    expect(r.evictionReaperStarted).toBe(false);
    expect(startReaper).not.toHaveBeenCalled();
  });

  it('lazy ON: boots in-process AND starts the reaper', async () => {
    h.lazyOn = true;
    const r = await bootSubstrateWithFallback();
    expect(bootAll).toHaveBeenCalledOnce();
    expect(r.usedSidecar).toBe(false);
    expect(r.evictionReaperStarted).toBe(true);
    expect(startReaper).toHaveBeenCalledOnce();
  });

  it('sidecar ON: spawns sidecar and boots harnesses through remote handle factory', async () => {
    h.sidecarOn = true;
    const r = await bootSubstrateWithFallback();
    expect(spawnSidecar).toHaveBeenCalledOnce();
    expect(registerShutdown).toHaveBeenCalledOnce();
    expect(bootAll).toHaveBeenCalledWith(expect.objectContaining({ skipSendSideWiring: true }));
    expect(ipcCalls.map((c) => c.method)).toEqual(['sidecar:healthz', 'substrate:bootHarness']);
    expect(r.usedSidecar).toBe(true);
    expect(r.booted).toBe(1);
  });

  it('sidecar startup failure falls back to in-process boot', async () => {
    h.sidecarOn = true;
    spawnSidecar.mockRejectedValueOnce(new Error('spawn failed'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const r = await bootSubstrateWithFallback();
      expect(r.usedSidecar).toBe(false);
      expect(bootAll).toHaveBeenCalledWith(undefined);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('sidecar spawn failed'),
        'spawn failed',
      );
    } finally {
      warnSpy.mockRestore();
    }
  });
});
