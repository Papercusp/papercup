import { describe, expect, it } from 'vitest';
import { collectIdentityValues, scanIdentityLeaks } from './content-identity.js';

describe('content identity scanner', () => {
  it('harvests identity-bearing JSON fields and catches copied prose', () => {
    const value = { launchSettings: { defaults: { account: 'publisher-handle-42' } } };
    const known = collectIdentityValues(value);
    expect(known).toEqual(['publisher-handle-42']);
    expect(scanIdentityLeaks('duty: notify publisher-handle-42', { knownIdentityValues: known, osUser: null })).toEqual([
      { kind: 'identity-value', value: 'publisher-handle-42', occurrences: 1 },
    ]);
  });

  it('detects host-shaped identities and secret shapes without Node APIs', () => {
    const homePath = ['', 'home', 'machine-user', 'file'].join('/');
    const hits = scanIdentityLeaks(
      `path ${homePath} and email@example.com and su-12345678-1234-1234-1234-123456789abc`,
      { osUser: null },
    );
    expect(hits.map((hit) => hit.kind)).toEqual(['home-path', 'agent-session-id', 'email']);
  });

  it('compiles and detects key-directed secrets', () => {
    expect(scanIdentityLeaks('api_key: abcdefghijklmnop', { osUser: null })).toEqual([
      { kind: 'secret', value: '[secret-shaped value detected by sensitive-text]', occurrences: 1 },
    ]);
  });
});
