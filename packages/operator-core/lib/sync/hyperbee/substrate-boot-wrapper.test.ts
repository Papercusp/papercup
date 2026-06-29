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
const setBootDefaults = vi.fn();
vi.mock('./boot-all', () => ({
  bootAllHarnessesForActiveWorkspace: (opts?: unknown) => bootAll(opts as Parameters<typeof bootAll>[0]),
  enableSubstrateEvictionTracking: () => enableTracking(),
  gatherBootedHarnessFacts: () => [],
  evictBootedHarnessEngine: async () => false,
  setSubstrateBootDefaults: (o: unknown) => setBootDefaults(o),
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

const startKeepalive = vi.fn(() => ({ stop: vi.fn(async () => {}) }));
vi.mock('./substrate-outbox-keepalive', () => ({
  startSubstrateOutboxKeepalive: () => startKeepalive(),
}));

const mockOrgPg = vi.fn(() => ({ sql: { listen: vi.fn(async () => ({ unlisten: vi.fn(async () => {}) })) } }));
vi.mock('@papercusp/db-org', () => ({
  getOrgPg: () => mockOrgPg(),
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
  startKeepalive.mockClear();
  mockOrgPg.mockClear();
  setBootDefaults.mockClear();
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
    // The process-global boot defaults are CLEARED so standalone bootSingleHarness/
    // rekeyHarness boot in-process + wire the drain in-process (the default path).
    expect(setBootDefaults).toHaveBeenCalledWith({ bootHarness: null, skipSendSideWiring: false });
    expect(r.usedSidecar).toBe(false);
    expect(r.evictionReaperStarted).toBe(false);
    expect(startReaper).not.toHaveBeenCalled();
    // Keepalive rides the same flag gate — OFF ⇒ never started (byte-identical).
    expect(r.outboxKeepaliveStarted).toBe(false);
    expect(startKeepalive).not.toHaveBeenCalled();
  });

  it('lazy ON: boots in-process AND starts the reaper + outbox keepalive', async () => {
    h.lazyOn = true;
    const r = await bootSubstrateWithFallback();
    expect(bootAll).toHaveBeenCalledOnce();
    expect(r.usedSidecar).toBe(false);
    expect(r.evictionReaperStarted).toBe(true);
    expect(startReaper).toHaveBeenCalledOnce();
    // AC#2 wiring: the re-boot-on-NOTIFY keepalive starts alongside the reaper.
    expect(r.outboxKeepaliveStarted).toBe(true);
    expect(startKeepalive).toHaveBeenCalledOnce();
  });

  it('sidecar ON: spawns sidecar and boots harnesses through remote handle factory', async () => {
    h.sidecarOn = true;
    const r = await bootSubstrateWithFallback();
    expect(spawnSidecar).toHaveBeenCalledOnce();
    expect(registerShutdown).toHaveBeenCalledOnce();
    expect(bootAll).toHaveBeenCalledWith(expect.objectContaining({ skipSendSideWiring: true }));
    // THE FIX: the sidecar boot config is registered PROCESS-GLOBALLY so EVERY
    // standalone boot route (owner publishCreatedHive, joiner joinHiveAsView /
    // join-shared-harness) routes through the sidecar too — not just this sweep.
    expect(setBootDefaults).toHaveBeenCalledWith(
      expect.objectContaining({ bootHarness: expect.any(Function), skipSendSideWiring: true }),
    );
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
      // Sidecar unavailable → defaults cleared so standalone boots stay in-process.
      expect(setBootDefaults).toHaveBeenLastCalledWith({ bootHarness: null, skipSendSideWiring: false });
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
