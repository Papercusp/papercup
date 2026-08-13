import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./operator-state-pg', () => ({
  readOperatorState: vi.fn(),
  writeOperatorState: vi.fn(),
}));

import { readOperatorState } from './operator-state-pg';
import { inspectElevenLabsApiKey, isValidElevenLabsApiKey, readElevenLabsKey } from './voice-credentials';

beforeEach(() => vi.clearAllMocks());

describe('inspectElevenLabsApiKey', () => {
  it('accepts a secret key and rejects an API key ID', () => {
    expect(inspectElevenLabsApiKey('sk_live_example')).toEqual({
      configured: true,
      healthy: true,
      error: null,
    });

    const invalid = inspectElevenLabsApiKey('api_key_id_123');
    expect(invalid.configured).toBe(true);
    expect(invalid.healthy).toBe(false);
    expect(invalid.error).toMatch(/begin with sk_/);
    expect(isValidElevenLabsApiKey('api_key_id_123')).toBe(false);
  });

  it('treats blank values as unconfigured', () => {
    expect(inspectElevenLabsApiKey('   ')).toEqual({
      configured: false,
      healthy: false,
      error: null,
    });
    expect(inspectElevenLabsApiKey(null)).toEqual({
      configured: false,
      healthy: false,
      error: null,
    });
  });
});

describe('readElevenLabsKey', () => {
  it('refuses to return a legacy API-key ID to an ordinary outbound caller', async () => {
    vi.mocked(readOperatorState).mockResolvedValue({ elevenlabs: { apiKey: 'api_key_id_123' } });

    expect(await readElevenLabsKey()).toBeNull();
    expect(await readElevenLabsKey({ allowInvalid: true })).toBe('api_key_id_123');
  });

  it('returns a valid secret key through the safe default', async () => {
    vi.mocked(readOperatorState).mockResolvedValue({ elevenlabs: { apiKey: 'sk_live_example' } });
    expect(await readElevenLabsKey()).toBe('sk_live_example');
  });
});
