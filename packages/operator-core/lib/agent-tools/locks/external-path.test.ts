import { describe, expect, it } from 'vitest';
import { externalHomePathToLockKey } from './external-path';

describe('externalHomePathToLockKey', () => {
  it('maps a home config file to the hook-compatible reserved key', () => {
    expect(externalHomePathToLockKey('/home/jdoe/.config/mimeapps.list', '/home/jdoe')).toBe(
      '@external/home/.config/mimeapps.list',
    );
  });

  it('rejects relative, outside-home, and home-root paths', () => {
    expect(() => externalHomePathToLockKey('.config/x', '/home/jdoe')).toThrow(/absolute/);
    expect(() => externalHomePathToLockKey('/etc/hosts', '/home/jdoe')).toThrow(/below/);
    expect(() => externalHomePathToLockKey('/home/jdoe', '/home/jdoe')).toThrow(/below/);
  });
});
