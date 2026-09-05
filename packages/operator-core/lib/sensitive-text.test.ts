import { describe, expect, it } from 'vitest';
import {
  redactKeyDirectedSecrets,
  redactKnownSecrets,
  redactSelfIdentifyingSecrets,
  redactSensitiveText,
  redactSensitiveValue,
  redactStructuredSensitiveValue,
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

  it('is idempotent when a key-directed value is already redacted', () => {
    const once = redactSensitiveText('token=opaque-value-123');
    expect(redactSensitiveText(once)).toBe(once);
  });

  it('redacts explicitly known opaque bearers without guessing from their shape', () => {
    const token = '8c91f74d2e6a4bbf90f44a71d142d095';
    const input = `python3 - http://127.0.0.1:9071 ${token} owner-id`;
    expect(redactKnownSecrets(input, [token])).toBe(
      'python3 - http://127.0.0.1:9071 [redacted] owner-id',
    );
    expect(redactSensitiveText(input, [token])).not.toContain(token);
  });

  it('ignores missing and short known-secret values', () => {
    expect(redactKnownSecrets('task id abc123 remains visible', [null, '', 'abc123'])).toBe(
      'task id abc123 remains visible',
    );
  });

  it('preserves ordinary diagnostic context while composing both passes', () => {
    const output = redactSensitiveText(`worker.ts API_KEY=${'z'.repeat(24)} --mode verify`);
    expect(output).toBe('worker.ts API_KEY=[redacted] --mode verify');
  });

  it('redacts credential-shaped environment assignments used by provider and database processes', () => {
    const input = [
      'AWS_ACCESS_KEY_ID=opaque-aws-access-key',
      'AWS_SECRET_ACCESS_KEY=opaque-aws-secret-key',
      'DATABASE_URL=postgresql://user:opaque-password@localhost:5432/app',
    ].join(' ');
    const output = redactSensitiveText(input);
    expect(output).toBe([
      'AWS_ACCESS_KEY_ID=[redacted]',
      'AWS_SECRET_ACCESS_KEY=[redacted]',
      'DATABASE_URL=[redacted]',
    ].join(' '));
    expect(output).not.toContain('opaque-');
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

  it('preserves ordinary colon prose inside structured values while redacting real keys', () => {
    const providerToken = `sk-${'q'.repeat(24)}`;
    expect(redactStructuredSensitiveValue({
      title: 'Design token: brand-accent contrast',
      apiKey: 'opaque-api-key-value',
      note: `provider returned ${providerToken}`,
      command: 'curl --token=opaque-command-token',
    })).toEqual({
      title: 'Design token: brand-accent contrast',
      apiKey: '[redacted]',
      note: 'provider returned [redacted]',
      command: 'curl --token=[redacted]',
    });
  });
});
