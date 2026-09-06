import { describe, expect, it } from 'vitest';
import {
  externalHomePathToLockKey,
  externalPathToLockKey,
  EXTERNAL_RUNTIME_LOCK_PREFIX,
} from './external-path';

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

  it('maps current-user XDG runtime credential files to a distinct reserved key', () => {
    expect(
      externalPathToLockKey(
        '/run/user/1000/papercusp-p029-acceptance.9aTT9e/storage-state.json',
        { home: '/home/jdoe', runtimeDir: '/run/user/1000' },
      ),
    ).toBe(`${EXTERNAL_RUNTIME_LOCK_PREFIX}/papercusp-p029-acceptance.9aTT9e/storage-state.json`);
  });

  it('rejects the runtime root itself and paths under another runtime root', () => {
    const roots = { home: '/home/jdoe', runtimeDir: '/run/user/1000' };
    expect(() => externalPathToLockKey('/run/user/1000', roots)).toThrow(/below/);
    expect(() => externalPathToLockKey('/run/user/1001/state.json', roots)).toThrow(/below/);
  });
});
