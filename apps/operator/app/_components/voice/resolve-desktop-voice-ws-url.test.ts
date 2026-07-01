/**
 * resolve-desktop-voice-ws-url tests (voice-unified-sentinel-pipeline P-009):
 * the operator-voice client discovers a WALKED bridge port via
 * /api/desktop/voice-config instead of assuming :3076.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  resolveDesktopVoiceWsUrl,
  _resetDesktopVoiceWsUrlCacheForTests,
} from './resolve-desktop-voice-ws-url';
import { DEFAULT_DESKTOP_VOICE_WS_URL } from './desktop-operator-voice-client';

afterEach(() => {
  _resetDesktopVoiceWsUrlCacheForTests();
});

describe('resolveDesktopVoiceWsUrl', () => {
  it('resolves the walked port from /api/desktop/voice-config', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({ port: 3079, path: '/api/desktop/voice' }),
    }));
    await expect(resolveDesktopVoiceWsUrl(fetchImpl)).resolves.toBe(
      'ws://127.0.0.1:3079/api/desktop/voice',
    );
    expect(fetchImpl).toHaveBeenCalledWith('/api/desktop/voice-config');
  });

  it('caches per page load — one config fetch for many connects', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => ({ port: 3080 }) }));
    await resolveDesktopVoiceWsUrl(fetchImpl);
    await resolveDesktopVoiceWsUrl(fetchImpl);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('falls back to the default when the route is unreachable', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    await expect(resolveDesktopVoiceWsUrl(fetchImpl)).resolves.toBe(DEFAULT_DESKTOP_VOICE_WS_URL);
  });

  it('falls back on a malformed config body', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => ({ port: 'nope' }) }));
    await expect(resolveDesktopVoiceWsUrl(fetchImpl)).resolves.toBe(DEFAULT_DESKTOP_VOICE_WS_URL);
  });
});
