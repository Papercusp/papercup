import { describe, expect, it } from 'vitest';
import { externalHomePathToLockKey } from './external-path';

describe('externalHomePathToLockKey', () => {
  it('maps a home config file to the hook-compatible reserved key', () => {
    expect(externalHomePathToLockKey('/home/avi/.config/mimeapps.list', '/home/avi')).toBe(
      '@external/home/.config/mimeapps.list',
    );
  });

  it('rejects relative, outside-home, and home-root paths', () => {
    expect(() => externalHomePathToLockKey('.config/x', '/home/avi')).toThrow(/absolute/);
    expect(() => externalHomePathToLockKey('/etc/hosts', '/home/avi')).toThrow(/below/);
    expect(() => externalHomePathToLockKey('/home/avi', '/home/avi')).toThrow(/below/);
  });
});
