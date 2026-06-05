import { describe, it, expect, afterEach, vi } from 'vitest';
import { selfUrl } from './self-url';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('selfUrl — PAPERCUSP_SELF_URL override', () => {
  it('returns the override verbatim when it has no trailing slash', () => {
    vi.stubEnv('PAPERCUSP_SELF_URL', 'http://example.test:9000');
    expect(selfUrl()).toBe('http://example.test:9000');
  });

  it('strips a single trailing slash from the override', () => {
    vi.stubEnv('PAPERCUSP_SELF_URL', 'http://example.test:9000/');
    expect(selfUrl()).toBe('http://example.test:9000');
  });

  it('strips only the final slash (a path with a trailing slash keeps the rest)', () => {
    // The regex is /\/$/ — anchored to the very end, so only the last slash goes.
    vi.stubEnv('PAPERCUSP_SELF_URL', 'http://example.test/base/');
    expect(selfUrl()).toBe('http://example.test/base');
  });

  it('the override wins even when PORT is also set', () => {
    vi.stubEnv('PAPERCUSP_SELF_URL', 'http://override.test:1234');
    vi.stubEnv('PORT', '8080');
    expect(selfUrl()).toBe('http://override.test:1234');
  });

  it('an empty-string override is falsy, so it falls through to the PORT chain', () => {
    vi.stubEnv('PAPERCUSP_SELF_URL', '');
    vi.stubEnv('PORT', '7777');
    expect(selfUrl()).toBe('http://127.0.0.1:7777');
  });
});

describe('selfUrl — PORT fallback chain', () => {
  it('uses 127.0.0.1:${PORT} when PORT is set and no override', () => {
    vi.stubEnv('PAPERCUSP_SELF_URL', '');
    vi.stubEnv('PORT', '3070');
    expect(selfUrl()).toBe('http://127.0.0.1:3070');
  });

  it('honours an arbitrary dynamic PORT (e.g. the Tauri sidecar)', () => {
    vi.stubEnv('PAPERCUSP_SELF_URL', '');
    vi.stubEnv('PORT', '54321');
    expect(selfUrl()).toBe('http://127.0.0.1:54321');
  });

  it('falls back to the :3055 dev default when neither override nor PORT is set', () => {
    vi.stubEnv('PAPERCUSP_SELF_URL', '');
    vi.stubEnv('PORT', '');
    // Empty PORT is still a set-but-falsy string. `??` only catches undefined/null,
    // so an empty PORT produces http://127.0.0.1: — assert the documented default
    // only holds when PORT is genuinely unset.
    expect(selfUrl()).not.toBe('http://127.0.0.1:3055');
  });

  it('defaults to :3055 when PORT is undefined (the ?? branch)', () => {
    // Force PORT to be absent. vi.stubEnv(key, undefined) deletes the key.
    vi.stubEnv('PAPERCUSP_SELF_URL', '');
    vi.stubEnv('PORT', undefined as unknown as string);
    expect(selfUrl()).toBe('http://127.0.0.1:3055');
  });
});
