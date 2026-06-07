import { describe, expect, it } from 'vitest';
import { resolveDesktopVoiceWsUrl } from './resolve-voice-ws-url';
import { DEFAULT_DESKTOP_VOICE_WS_URL } from '../video/desktop-video-protocol';

function fakeFetch(body: unknown, ok = true) {
  return async (_url: string) => ({ ok, json: async () => body });
}

describe('resolveDesktopVoiceWsUrl', () => {
  it('builds the WS URL from the runtime-config port + path', async () => {
    const url = await resolveDesktopVoiceWsUrl(fakeFetch({ port: 3079, path: '/api/desktop/voice' }));
    expect(url).toBe('ws://127.0.0.1:3079/api/desktop/voice');
  });

  it('defaults the path when the config omits it', async () => {
    const url = await resolveDesktopVoiceWsUrl(fakeFetch({ port: 3077 }));
    expect(url).toBe('ws://127.0.0.1:3077/api/desktop/voice');
  });

  it('falls back to the default when the bridge has no port yet (null)', async () => {
    const url = await resolveDesktopVoiceWsUrl(fakeFetch({ port: null, path: '/api/desktop/voice' }));
    expect(url).toBe(DEFAULT_DESKTOP_VOICE_WS_URL);
  });

  it('falls back to the default on a non-OK response', async () => {
    const url = await resolveDesktopVoiceWsUrl(fakeFetch(null, false));
    expect(url).toBe(DEFAULT_DESKTOP_VOICE_WS_URL);
  });

  it('falls back to the default when fetch throws (route absent)', async () => {
    const url = await resolveDesktopVoiceWsUrl(async () => {
      throw new Error('ECONNREFUSED');
    });
    expect(url).toBe(DEFAULT_DESKTOP_VOICE_WS_URL);
  });
});
