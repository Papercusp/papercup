/**
 * Smoke tests for the voice-prefs-client pub/sub.
 *
 * Added 2026-05-14 as the audit-gap-#2 fix: voice-card router needs
 * live updates to cardAnsweringEnabled, not a stale module cache.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { VoicePrefs } from '@papercusp/operator-core/lib/voice-prefs';

import {
  loadVoicePrefsClient,
  setVoicePrefsClient,
  subscribeVoicePrefsClient,
} from './voice-prefs-client';

function makePrefs(overrides: Partial<VoicePrefs> = {}): VoicePrefs {
  return {
    ...loadVoicePrefsClient(),
    ...overrides,
  } as VoicePrefs;
}

describe('voice-prefs-client pub/sub', () => {
  beforeEach(() => {
    setVoicePrefsClient(makePrefs({ cardAnsweringEnabled: true, speakOpenCards: true }));
  });

  it('subscribers fire on setVoicePrefsClient', () => {
    const fn = vi.fn();
    const unsub = subscribeVoicePrefsClient(fn);
    setVoicePrefsClient(makePrefs({ cardAnsweringEnabled: false }));
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn.mock.calls[0][0].cardAnsweringEnabled).toBe(false);
    unsub();
  });

  it('unsubscribe stops further calls', () => {
    const fn = vi.fn();
    const unsub = subscribeVoicePrefsClient(fn);
    unsub();
    setVoicePrefsClient(makePrefs({ cardAnsweringEnabled: false }));
    expect(fn).not.toHaveBeenCalled();
  });

  it('multiple subscribers all receive updates', () => {
    const a = vi.fn();
    const b = vi.fn();
    const ua = subscribeVoicePrefsClient(a);
    const ub = subscribeVoicePrefsClient(b);
    setVoicePrefsClient(makePrefs({ speakOpenCards: false }));
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    ua(); ub();
  });

  it('a throwing subscriber does not block the rest', () => {
    const boom = vi.fn(() => { throw new Error('subscriber error'); });
    const ok = vi.fn();
    const u1 = subscribeVoicePrefsClient(boom);
    const u2 = subscribeVoicePrefsClient(ok);
    setVoicePrefsClient(makePrefs({ cardAnsweringEnabled: false }));
    expect(boom).toHaveBeenCalled();
    expect(ok).toHaveBeenCalled();
    u1(); u2();
  });
});
