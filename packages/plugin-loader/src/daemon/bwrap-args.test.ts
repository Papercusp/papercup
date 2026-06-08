/**
 * Tests for buildBwrapArgs — the bubblewrap sandbox argv builder for daemon
 * plugins. Run with: npx vitest run packages/plugin-loader/src/daemon/bwrap-args.test.ts
 */
import { describe, expect, it } from 'vitest';
import { buildBwrapArgs } from './bwrap-args';

const base = { workDir: '/run/work', cmd: ['/bin/plugin', '--serve'] };

describe('buildBwrapArgs', () => {
  it('defaults the binary to "bwrap" and honors an override', () => {
    expect(buildBwrapArgs(base).binary).toBe('bwrap');
    expect(buildBwrapArgs({ ...base, bwrapBinary: '/usr/bin/bwrap' }).binary).toBe('/usr/bin/bwrap');
  });

  it('emits the fixed hardening flags', () => {
    const { argv } = buildBwrapArgs(base);
    for (const flag of [
      '--unshare-pid', '--unshare-ipc', '--unshare-uts', '--unshare-cgroup-try',
      '--die-with-parent', '--clearenv', '--proc', '--dev',
    ]) {
      expect(argv).toContain(flag);
    }
  });

  it('binds the workDir to /work and chdirs there', () => {
    const { argv } = buildBwrapArgs(base);
    const i = argv.indexOf('--bind');
    expect(argv.slice(i, i + 3)).toEqual(['--bind', '/run/work', '/work']);
    const c = argv.indexOf('--chdir');
    expect(argv.slice(c, c + 2)).toEqual(['--chdir', '/work']);
  });

  it('adds read-only binds for readPaths and rw binds for writePaths', () => {
    const { argv } = buildBwrapArgs({ ...base, readPaths: ['/etc/ssl'], writePaths: ['/var/data'] });
    const joined = argv.join(' ');
    expect(joined).toContain('--ro-bind-try /etc/ssl /etc/ssl');
    expect(joined).toContain('--bind-try /var/data /var/data');
  });

  it('appends the command after a "--" separator, last', () => {
    const { argv } = buildBwrapArgs(base);
    const sep = argv.indexOf('--');
    expect(sep).toBeGreaterThan(0);
    expect(argv.slice(sep + 1)).toEqual(['/bin/plugin', '--serve']);
    // The command is the tail — nothing after it.
    expect(argv[argv.length - 1]).toBe('--serve');
  });

  it('omits net/user namespace flags by default (v1 caveat)', () => {
    const { argv } = buildBwrapArgs({ ...base, shareNet: false });
    expect(argv).not.toContain('--unshare-net');
    expect(argv).not.toContain('--unshare-user');
  });
});
