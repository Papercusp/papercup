/**
 * tool-path — the canonical tool-dir list + PATH composition (EI: macOS
 * Apple-Silicon Homebrew gh/git were unfindable by the dogfood clone because
 * /opt/homebrew/bin was missing from the operator's PATH).
 */
import { describe, it, expect } from 'vitest';
import { standardToolDirs, composeToolPath } from './tool-path';

describe('standardToolDirs', () => {
  it('includes BOTH Homebrew prefixes (Apple-Silicon + Intel) on posix', () => {
    const dirs = standardToolDirs('darwin');
    expect(dirs).toContain('/opt/homebrew/bin'); // the bug: this was missing
    expect(dirs).toContain('/usr/local/bin');
    // Homebrew comes before the system shim so a user's gh/git wins.
    expect(dirs.indexOf('/opt/homebrew/bin')).toBeLessThan(dirs.indexOf('/usr/bin'));
  });

  it('is empty on win32 (PATH managed differently there)', () => {
    expect(standardToolDirs('win32')).toEqual([]);
  });
});

describe('composeToolPath', () => {
  it('GUARANTEES /opt/homebrew/bin even from a minimal launchd PATH (the macOS bug)', () => {
    const launchd = '/usr/bin:/bin:/usr/sbin:/sbin';
    const out = composeToolPath({ currentPath: launchd, platform: 'darwin' });
    expect(out.split(':')).toContain('/opt/homebrew/bin');
    expect(out.split(':')).toContain('/opt/homebrew/sbin');
  });

  it('puts the bundled sidecar bin FIRST, then inherited PATH', () => {
    const out = composeToolPath({
      sidecarBin: '/Applications/Papercusp.app/bin',
      currentPath: '/usr/bin:/bin',
      platform: 'darwin',
    });
    const parts = out.split(':');
    expect(parts[0]).toBe('/Applications/Papercusp.app/bin');
    expect(parts.indexOf('/Applications/Papercusp.app/bin')).toBeLessThan(parts.indexOf('/usr/bin'));
  });

  it('de-duplicates (first occurrence wins, no reordering of existing entries)', () => {
    const out = composeToolPath({ currentPath: '/opt/homebrew/bin:/usr/bin', platform: 'darwin' });
    const parts = out.split(':');
    // /opt/homebrew/bin appears once, at its inherited (first) position.
    expect(parts.filter((p) => p === '/opt/homebrew/bin')).toHaveLength(1);
    expect(parts[0]).toBe('/opt/homebrew/bin');
  });

  it('handles empty/undefined inputs without leading/trailing separators', () => {
    const out = composeToolPath({ platform: 'darwin' });
    expect(out.startsWith(':')).toBe(false);
    expect(out.endsWith(':')).toBe(false);
    expect(out.split(':')).toContain('/opt/homebrew/bin');
  });

  it('uses ; on win32 and injects no posix dirs', () => {
    const out = composeToolPath({ currentPath: 'C:\\Windows', platform: 'win32' });
    expect(out).toBe('C:\\Windows');
    expect(out).not.toContain('/opt/homebrew/bin');
  });
});
