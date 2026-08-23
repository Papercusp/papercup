import { describe, expect, it } from 'vitest';
import {
  redactKeyDirectedSecrets,
  redactSelfIdentifyingSecrets,
  redactSensitiveText,
  redactSensitiveValue,
} from './sensitive-text';

describe('sensitive diagnostic text', () => {
  it('redacts self-identifying provider tokens wherever they appear', () => {
    const token = `sk-${'a'.repeat(24)}`;
    expect(redactSelfIdentifyingSecrets(`run --token ${token}`)).toBe('run --token [redacted]');
  });

  it('redacts opaque values identified only by their key or auth header', () => {
    const input = 'curl --api-key=opaque-value-123 Authorization: Bearer another-opaque-value';
    const output = redactKeyDirectedSecrets(input);
    expect(output).toContain('--api-key=[redacted]');
    expect(output).toContain('Authorization: Bearer [redacted]');
    expect(output).not.toContain('opaque-value');
  });

  it('preserves ordinary diagnostic context while composing both passes', () => {
    const output = redactSensitiveText(`worker.ts API_KEY=${'z'.repeat(24)} --mode verify`);
    expect(output).toBe('worker.ts API_KEY=[redacted] --mode verify');
  });

  it('does not redact prose that merely mentions credential concepts', () => {
    const prose = 'The API key is unavailable, so the task remains stopped.';
    expect(redactSensitiveText(prose)).toBe(prose);
  });

  it('redacts nested secret values while preserving opaque credential references', () => {
    const input = {
      credentialRef: 'google-oauth:workspace',
      accessToken: 'opaque-access-token-value',
      nested: {
        authorization: 'Bearer opaque-bearer-value',
        text: `reply with sk-${'a'.repeat(24)} removed`,
      },
    };
    expect(redactSensitiveValue(input)).toEqual({
      credentialRef: 'google-oauth:workspace',
      accessToken: '[redacted]',
      nested: {
        authorization: '[redacted]',
        text: 'reply with [redacted] removed',
      },
    });
    expect(input.accessToken).toBe('opaque-access-token-value');
  });
});
