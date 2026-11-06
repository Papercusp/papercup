/**
 * Tests for buildBwrapArgs — the bubblewrap sandbox argv builder for daemon
 * plugins. Run with: npx vitest run packages/plugin-loader/src/daemon/bwrap-args.test.ts
 */
import { describe, expect, it } from 'vitest';
import { buildBwrapArgs, buildHandlerBwrapArgs, buildProviderBwrapArgs, PROVIDER_SYSTEM_RO_DIRS } from './bwrap-args';

const base = { workDir: '/run/work', cmd: ['/bin/plugin', '--serve'] };

describe('strict handler exact-file mount profile', () => {
  const files = [
    { path: '/runtime/node', fd: 4, executable: true },
    { path: '/runtime/bootstrap.cjs', fd: 5, executable: false },
    { path: '/handler/entry.cjs', fd: 6, executable: false },
  ];
  it('has no host bind or configurable command/environment and requires early seccomp', () => {
    const { binary, argv } = buildHandlerBwrapArgs({ files, bootstrapFilterFd: 3 });
    expect(binary).toBe('/usr/bin/bwrap');
    expect(argv.filter(arg => arg.includes('bind'))).toEqual(Array(3).fill('--ro-bind-data'));
    expect(argv.slice(argv.indexOf('--') + 1)).toEqual([
      '/runtime/node', '--no-global-search-paths', '/runtime/bootstrap.cjs',
    ]);
    expect(argv.slice(argv.indexOf('--seccomp'), argv.indexOf('--') + 1)).toEqual(['--seccomp', '3', '--']);
    for (const flag of ['--unshare-user', '--unshare-net', '--unshare-pid', '--unshare-ipc',
      '--unshare-uts', '--unshare-cgroup', '--disable-userns', '--assert-userns-disabled', '--clearenv']) {
      expect(argv).toContain(flag);
    }
    expect(argv.slice(argv.indexOf('--remount-ro'), argv.indexOf('--remount-ro') + 2)).toEqual(['--remount-ro', '/']);
    expect(argv.flatMap((a, i) => a === '--setenv' ? [[argv[i + 1], argv[i + 2]]] : [])).toEqual([
      ['HOME', '/tmp'], ['PATH', '/runtime'], ['UV_USE_IO_URING', '0'],
    ]);
  });
  it.each(['/proc/self/mem', '/tmp/entry.cjs', '/dev/fd/0', '/etc/passwd', '/runtime/../handler/x',
    '/runtime//x', '/runtime/x/', '/runtime/x\n', '/runtime/x\\y'])(
    'rejects reserved or ambiguous guest path %j', path => {
      expect(() => buildHandlerBwrapArgs({ files: [...files, { path, fd: 7, executable: false }], bootstrapFilterFd: 3 }))
        .toThrow('invalid handler');
    });
  it.each(['filter-collision', 'stdio', 'duplicate-path', 'file-parent', 'missing-bootstrap', 'non-executable-node'])(
    'refuses incomplete or conflicting mounts: %s', defect => {
      const changed = files.map(file => ({ ...file }));
      if (defect === 'filter-collision') changed[0]!.fd = 3;
      if (defect === 'stdio') changed[0]!.fd = 2;
      if (defect === 'duplicate-path') changed.push({ ...changed[0]!, fd: 7 });
      if (defect === 'file-parent') changed.push({ path: '/handler/entry.cjs/x', fd: 7, executable: false });
      if (defect === 'missing-bootstrap') changed.splice(1, 1);
      if (defect === 'non-executable-node') changed[0]!.executable = false;
      expect(() => buildHandlerBwrapArgs({ files: changed, bootstrapFilterFd: 3 })).toThrow('invalid handler');
    });
});

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

describe('buildProviderBwrapArgs (D-006 provider profile, P-002)', () => {
  const prov = { pluginDir: '/home/u/.papercusp/plugins/acme', cmd: ['node', 'provider.js'] };
  /** Every `[flag, src, dst]` triple for a bind flag. */
  const binds = (argv: string[], flag: string) =>
    argv.flatMap((a, i) => (a === flag ? [[argv[i + 1], argv[i + 2]]] : []));

  it('unshares the network namespace and every other isolatable namespace', () => {
    const { argv } = buildProviderBwrapArgs(prov);
    for (const flag of [
      '--unshare-net', '--unshare-pid', '--unshare-ipc', '--unshare-uts', '--unshare-cgroup-try',
      '--new-session', '--die-with-parent',
    ]) {
      expect(argv).toContain(flag);
    }
  });

  it('never binds the host root and never exposes /etc or a writable bind', () => {
    const { argv } = buildProviderBwrapArgs({ ...prov, runtimeDirs: ['/opt/node'] });
    const allBinds = [
      ...binds(argv, '--ro-bind'),
      ...binds(argv, '--ro-bind-try'),
      ...binds(argv, '--bind'),
      ...binds(argv, '--bind-try'),
    ];
    expect(allBinds.map(([src]) => src)).not.toContain('/');
    expect(allBinds.some(([src]) => src === '/etc' || src?.startsWith('/etc/'))).toBe(false);
    expect(binds(argv, '--bind')).toEqual([]);
    expect(binds(argv, '--bind-try')).toEqual([]);
  });

  it('binds exactly the system dirs, the runtime dirs and the plugin dir, all read-only', () => {
    const { argv } = buildProviderBwrapArgs({ ...prov, runtimeDirs: ['/opt/node'] });
    expect(binds(argv, '--ro-bind-try')).toEqual(PROVIDER_SYSTEM_RO_DIRS.map((d) => [d, d]));
    expect(binds(argv, '--ro-bind')).toEqual([
      ['/opt/node', '/opt/node'],
      [prov.pluginDir, prov.pluginDir],
    ]);
    const c = argv.indexOf('--chdir');
    expect(argv.slice(c, c + 2)).toEqual(['--chdir', prov.pluginDir]);
  });

  it('mounts the private /tmp BEFORE the plugin and runtime binds so a plugin dir under /tmp is not shadowed', () => {
    const { argv } = buildProviderBwrapArgs({ ...prov, pluginDir: '/tmp/plug', runtimeDirs: ['/tmp/rt'] });
    const tmpfs = argv.indexOf('--tmpfs');
    expect(argv[tmpfs + 1]).toBe('/tmp');
    expect(tmpfs).toBeLessThan(argv.indexOf('/tmp/plug'));
    expect(tmpfs).toBeLessThan(argv.indexOf('/tmp/rt'));
  });

  // WI-10006742: `--dev /dev` came AFTER the plugin bind, so a plugin dir under
  // /dev/shm (the test TMPDIR guard's fallback) was covered by the fresh /dev
  // and `--chdir` failed. Every fresh mount must precede every bind.
  it('mounts /proc and /dev BEFORE the plugin and runtime binds so a plugin dir under /dev/shm is not shadowed', () => {
    const { argv } = buildProviderBwrapArgs({ ...prov, pluginDir: '/dev/shm/pcv/plug', runtimeDirs: ['/dev/shm/pcv/rt'] });
    const firstBind = Math.min(argv.indexOf('/dev/shm/pcv/plug'), argv.indexOf('/dev/shm/pcv/rt'));
    for (const [flag, target] of [['--proc', '/proc'], ['--dev', '/dev'], ['--tmpfs', '/tmp']] as const) {
      const i = argv.indexOf(flag);
      expect(argv[i + 1]).toBe(target);
      expect(i).toBeLessThan(firstBind);
    }
    expect(argv.lastIndexOf('--proc')).toBe(argv.indexOf('--proc'));
    expect(argv.lastIndexOf('--dev')).toBe(argv.indexOf('--dev'));
  });

  it('clears the environment and sets only PATH and HOME', () => {
    const { argv } = buildProviderBwrapArgs(prov);
    expect(argv).toContain('--clearenv');
    const setenvs = argv.flatMap((a, i) => (a === '--setenv' ? [[argv[i + 1], argv[i + 2]]] : []));
    expect(setenvs).toEqual([
      ['PATH', '/usr/bin:/bin'],
      ['HOME', '/tmp'],
    ]);
    expect(argv.indexOf('--clearenv')).toBeLessThan(argv.indexOf('--setenv'));
  });

  it('puts the command last after "--" and honors a bwrap binary override', () => {
    const { argv, binary } = buildProviderBwrapArgs({ ...prov, bwrapBinary: '/usr/bin/bwrap' });
    expect(binary).toBe('/usr/bin/bwrap');
    expect(buildProviderBwrapArgs(prov).binary).toBe('bwrap');
    const sep = argv.indexOf('--');
    expect(argv.slice(sep + 1)).toEqual(['node', 'provider.js']);
  });
});
