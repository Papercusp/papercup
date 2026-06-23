/**
 * substrate-boot-wrapper.test.ts — the LAZY_SUBSTRATE_BOOT reaper gating
 * (P-008 / WI-596). Proves: OFF ⇒ the reaper never starts (byte-identical eager
 * boot); ON ⇒ tracking is enabled + the reaper starts exactly once (idempotent).
 *
 * The SUBSTRATE_SIDECAR path is intentionally not exercised here — it stays dark
 * (P-009 dropped; in-process→sidecar relocation unfinished), so the default
 * (flag OFF) is the only live path.
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
const bootAll = vi.fn(async () => ({
  attempted: 0,
  booted: 0,
  alreadyBooted: 0,
  failed: 0,
  results: [],
}));
vi.mock('./boot-all', () => ({
  bootAllHarnessesForActiveWorkspace: () => bootAll(),
  enableSubstrateEvictionTracking: () => enableTracking(),
  gatherBootedHarnessFacts: () => [],
  evictBootedHarnessEngine: async () => false,
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
});
