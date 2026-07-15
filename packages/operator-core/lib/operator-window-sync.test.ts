// @vitest-environment jsdom
/**
 * operator-window-sync unit tests (multi-window-chat-coherence-2026-07-15).
 * Cross-window mode/sleep mirroring, the app-run lease that keeps the
 * localStorage mirror from leaking across app restarts, and the
 * peer-generating beacon (freshness + self-filtering).
 *
 * Same-window localStorage writes do NOT fire `storage` events (spec), so
 * the listener tests dispatch synthetic StorageEvents — exactly what a peer
 * window's write produces here.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  adoptableSharedState,
  broadcastGenerating,
  clearOperatorMirror,
  installOperatorWindowSync,
  mirrorOperatorMode,
  mirrorOperatorSleep,
  peerGeneratingNow,
} from './operator-window-sync';

const SHARED_KEY = 'papercusp.operatorShared.v1';
const GEN_KEY = 'papercusp.operatorGenerating.v1';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-07-15T00:00:00Z'));
  // Not .clear() — the operator-core jsdom localStorage stub is partial.
  window.localStorage.removeItem(SHARED_KEY);
  window.localStorage.removeItem(GEN_KEY);
});

afterEach(() => {
  vi.useRealTimers();
});

function fireStorage(key: string, newValue: string | null) {
  window.dispatchEvent(new StorageEvent('storage', { key, newValue }));
}

describe('mode/sleep mirror + adoption', () => {
  it('adopts a live peer mode (fresh lease)', () => {
    mirrorOperatorMode('passive');
    expect(adoptableSharedState()).toEqual({ mode: 'passive', sleepUntilMs: 0 });
  });

  it('carries sleepUntilMs alongside the mode', () => {
    mirrorOperatorMode('active');
    mirrorOperatorSleep(1234567);
    expect(adoptableSharedState()).toEqual({ mode: 'active', sleepUntilMs: 1234567 });
  });

  it('never adopts a stale lease (a dead app run must re-seed from prefs)', () => {
    mirrorOperatorMode('passive');
    vi.advanceTimersByTime(61_000); // > LEASE_STALE_MS
    expect(adoptableSharedState()).toBeNull();
  });

  it('never adopts an empty/cleared mirror', () => {
    expect(adoptableSharedState()).toBeNull();
    mirrorOperatorMode('passive');
    clearOperatorMirror();
    expect(adoptableSharedState()).toBeNull();
  });
});

describe('installOperatorWindowSync — storage-event handlers', () => {
  it('routes a peer mode change to onModeFromPeer exactly once per change', () => {
    const onMode = vi.fn();
    const cleanup = installOperatorWindowSync({ onModeFromPeer: onMode });
    // Peer wrote passive: mimic its localStorage write + the storage event.
    mirrorOperatorMode('passive');
    fireStorage(SHARED_KEY, window.localStorage.getItem(SHARED_KEY));
    expect(onMode).toHaveBeenCalledWith('passive');
    // Same value again (e.g. a lease beat) → no duplicate handler call.
    fireStorage(SHARED_KEY, window.localStorage.getItem(SHARED_KEY));
    expect(onMode).toHaveBeenCalledTimes(1);
    cleanup();
  });

  it('routes a peer sleep change to onSleepFromPeer', () => {
    const onSleep = vi.fn();
    const cleanup = installOperatorWindowSync({ onSleepFromPeer: onSleep });
    mirrorOperatorSleep(999);
    fireStorage(SHARED_KEY, window.localStorage.getItem(SHARED_KEY));
    expect(onSleep).toHaveBeenCalledWith(999);
    cleanup();
  });

  it('routes a mirror clear (peer reload-reset, G16) to onMirrorCleared', () => {
    const onCleared = vi.fn();
    const cleanup = installOperatorWindowSync({ onMirrorCleared: onCleared });
    window.localStorage.removeItem(SHARED_KEY);
    fireStorage(SHARED_KEY, null);
    expect(onCleared).toHaveBeenCalledTimes(1);
    cleanup();
  });

  it('stops listening after cleanup', () => {
    const onMode = vi.fn();
    const cleanup = installOperatorWindowSync({ onModeFromPeer: onMode });
    cleanup();
    mirrorOperatorMode('passive');
    fireStorage(SHARED_KEY, window.localStorage.getItem(SHARED_KEY));
    expect(onMode).not.toHaveBeenCalled();
  });
});

describe('generating beacon', () => {
  it('is self-filtered — this window never sees ITS OWN generation as a peer', () => {
    broadcastGenerating(true);
    expect(peerGeneratingNow()).toBe(false);
  });

  it('sees a fresh PEER beacon and ignores a stale one', () => {
    // A peer's beacon = same key, different windowId.
    window.localStorage.setItem(
      GEN_KEY,
      JSON.stringify({ windowId: 'peer-window', active: true, tsMs: Date.now() }),
    );
    expect(peerGeneratingNow()).toBe(true);
    vi.advanceTimersByTime(16_000); // > GEN_FRESH_MS — writer crashed/hung
    expect(peerGeneratingNow()).toBe(false);
  });

  it('notifies onPeerGenerating on beacon flips and clears on expiry', () => {
    const onGen = vi.fn();
    const cleanup = installOperatorWindowSync({ onPeerGenerating: onGen });
    window.localStorage.setItem(
      GEN_KEY,
      JSON.stringify({ windowId: 'peer-window', active: true, tsMs: Date.now() }),
    );
    fireStorage(GEN_KEY, window.localStorage.getItem(GEN_KEY));
    expect(onGen).toHaveBeenLastCalledWith(true);
    // No explicit "off" ever arrives (writer died) — the expiry timer clears it.
    vi.advanceTimersByTime(16_000);
    expect(onGen).toHaveBeenLastCalledWith(false);
    cleanup();
  });
});
