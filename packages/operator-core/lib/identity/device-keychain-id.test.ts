/**
 * device-keychain-id tests — the canonical `<github_user_id>:<machine-
 * fingerprint>` device-keypair keychain-id builder (Fix 1).
 */

import { describe, it, expect } from 'vitest';
import { resolveDeviceKeychainId, machineFingerprint } from './device-keychain-id';

describe('machineFingerprint', () => {
  it('joins hostname + username, sanitizing unsafe chars', () => {
    expect(machineFingerprint({ hostname: 'host.local', username: 'al ice' })).toBe(
      'host_local-al_ice',
    );
  });

  it('is deterministic for the same inputs', () => {
    const a = machineFingerprint({ hostname: 'h', username: 'u' });
    const b = machineFingerprint({ hostname: 'h', username: 'u' });
    expect(a).toBe(b);
  });

  it('only contains keychain-safe characters', () => {
    const fp = machineFingerprint({ hostname: 'wëird/Hø$t', username: 'na@me!' });
    expect(fp).toMatch(/^[a-zA-Z0-9_-]+$/);
  });
});

describe('resolveDeviceKeychainId', () => {
  it('builds `<github_user_id>:<machine-fingerprint>`', () => {
    expect(resolveDeviceKeychainId(4242, { hostname: 'box', username: 'alice' })).toBe(
      '4242:box-alice',
    );
  });

  it('is stable across calls for the same user + machine', () => {
    const a = resolveDeviceKeychainId(7, { hostname: 'm', username: 'u' });
    const b = resolveDeviceKeychainId(7, { hostname: 'm', username: 'u' });
    expect(a).toBe(b);
  });

  it('differs per github user id on the same machine (multi-account)', () => {
    const u1 = resolveDeviceKeychainId(1, { hostname: 'm', username: 'u' });
    const u2 = resolveDeviceKeychainId(2, { hostname: 'm', username: 'u' });
    expect(u1).not.toBe(u2);
    expect(u1.split(':')[1]).toBe(u2.split(':')[1]); // same fingerprint
  });

  it('uses the real machine fingerprint when no override is given', () => {
    const id = resolveDeviceKeychainId(99);
    expect(id.startsWith('99:')).toBe(true);
    expect(id.split(':')[1]).toMatch(/^[a-zA-Z0-9_-]+$/);
  });

  it('rejects a non-positive / non-integer github user id', () => {
    expect(() => resolveDeviceKeychainId(0)).toThrow(/positive integer/);
    expect(() => resolveDeviceKeychainId(-3)).toThrow(/positive integer/);
    expect(() => resolveDeviceKeychainId(1.5)).toThrow(/positive integer/);
  });
});
