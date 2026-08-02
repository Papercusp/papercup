/**
 * flag-change-listener.test.ts — recurrence guard for WI-6793 (cross-process
 * runtime flag propagation).
 *
 * THE BUG THIS PINS: publishFlagChange is in-process only, so a `flags:set` in
 * one process never reached sticky onFlagChange subscribers in another —
 * bg-host held workspace-brain-scope's pre-flip keying latch for 17+ minutes
 * after WORKSPACE_COORDINATION flipped ON, writing legacy '@singleton' scout
 * ticks. The listener must (1) bust the override read-cache BEFORE (2)
 * re-emitting the change — in that order, or a re-resolving latch re-reads the
 * ≤TTL-stale map and re-latches the OLD value.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const readOperatorState = vi.fn();
const writeOperatorState = vi.fn();

vi.mock('./operator-state-pg', () => ({
  readOperatorState: (...a: unknown[]) => readOperatorState(...a),
  writeOperatorState: (...a: unknown[]) => writeOperatorState(...a),
}));
vi.mock('./workspace-registry', () => ({ activeWorkspaceId: () => 'ws-under-test' }));

import { initFlagOverrideStore, getFlag, onFlagChange } from '@papercusp/flags/server';
import { FLAGS } from '@papercusp/flags';
import { installFlagOverrideStore } from './flag-override-store';
import {
  ensureFlagChangeListener,
  handleFlagChangePayload,
  _resetFlagChangeListenerForTests,
} from './flag-change-listener';
import { FLAG_CHANGE_CHANNEL } from './flag-override-store';

describe('handleFlagChangePayload', () => {
  let unsub: (() => void) | null = null;

  beforeEach(() => {
    readOperatorState.mockReset();
    writeOperatorState.mockReset();
    initFlagOverrideStore(null);
  });
  afterEach(() => {
    unsub?.();
    unsub = null;
    initFlagOverrideStore(null);
  });

  it('re-emits the parsed key to local onFlagChange subscribers', () => {
    const seen: Array<string | null> = [];
    unsub = onFlagChange((key) => seen.push(key));
    handleFlagChangePayload(JSON.stringify({ workspaceId: 'other-ws', key: 'some-flag' }));
    expect(seen).toEqual(['some-flag']);
  });

  it('an unparseable payload emits null (invalidate everything) instead of being dropped', () => {
    const seen: Array<string | null> = [];
    unsub = onFlagChange((key) => seen.push(key));
    handleFlagChangePayload('not json at all');
    expect(seen).toEqual([null]);
  });

  it('busts the override read-cache so a subscriber re-resolving on the event reads the STORE, not the stale map', async () => {
    // Prime the cache with the pre-flip value…
    readOperatorState.mockResolvedValue({ [FLAGS.CODEX_GATEWAY_OAUTH_PROXY]: false });
    installFlagOverrideStore();
    await expect(getFlag(FLAGS.CODEX_GATEWAY_OAUTH_PROXY, 'system')).resolves.toBe(false);
    const loadsBefore = readOperatorState.mock.calls.length;

    // …the peer process flips it; our LISTEN handler fires…
    readOperatorState.mockResolvedValue({ [FLAGS.CODEX_GATEWAY_OAUTH_PROXY]: true });
    handleFlagChangePayload(JSON.stringify({ workspaceId: 'ws-under-test', key: FLAGS.CODEX_GATEWAY_OAUTH_PROXY }));

    // …and the very next read re-consults the store (no TTL wait) and sees the flip.
    await expect(getFlag(FLAGS.CODEX_GATEWAY_OAUTH_PROXY, 'system')).resolves.toBe(true);
    expect(readOperatorState.mock.calls.length).toBeGreaterThan(loadsBefore);
  });
});

describe('ensureFlagChangeListener', () => {
  beforeEach(() => _resetFlagChangeListenerForTests());
  afterEach(() => _resetFlagChangeListenerForTests());

  it('subscribes to the shared channel and is idempotent (one LISTEN per process)', async () => {
    const listen = vi.fn(async (_channel: string, _cb: (p: string) => void) => () => {});
    await expect(ensureFlagChangeListener({ listen })).resolves.toBe(true);
    await expect(ensureFlagChangeListener({ listen })).resolves.toBe(true);
    expect(listen).toHaveBeenCalledTimes(1);
    expect(listen).toHaveBeenCalledWith(FLAG_CHANGE_CHANNEL, expect.any(Function));
  });

  it('retries a failed LISTEN, then fails soft and re-arms the latch for a later caller', async () => {
    const listen = vi.fn(async () => {
      throw new Error('pg not up yet');
    });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(ensureFlagChangeListener({ listen, attempts: 2, delayMs: 1 })).resolves.toBe(false);
      expect(listen).toHaveBeenCalledTimes(2);
      // Exhaustion cleared the latch: a later call starts over instead of returning the cached false.
      const ok = vi.fn(async (_c: string, _cb: (p: string) => void) => () => {});
      await expect(ensureFlagChangeListener({ listen: ok })).resolves.toBe(true);
      expect(ok).toHaveBeenCalledTimes(1);
    } finally {
      errSpy.mockRestore();
    }
  });
});
