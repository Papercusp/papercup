import { describe, expect, it } from 'vitest';
import { inspectElevenLabsApiKey, isValidElevenLabsApiKey } from './voice-credentials';

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
