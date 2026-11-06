/**
 * Construct bwrap argv for sandboxing a daemon plugin (Batch I3).
 * Mirrors the Rust runtime's compute.exec slice-3 sandbox model so the
 * audit + posture story is identical across runtimes.
 *
 * v1 caveats (same as Rust slice-3 v1):
 *   - No --unshare-net by default (loopback init requires privileges).
 *   - No --unshare-user (nested-userns environments deny uid_map writes).
 *   - When PAPERCUP_PLUGIN_BWRAP_REQUIRED=1 in CI, the supervisor fails
 *     hard if bwrap can't sandbox. Otherwise it falls back to a plain
 *     spawn with $PATH-pinned env (and logs a warning).
 *
 * Capability inputs:
 *   - readPaths: extra read-only host paths the daemon needs to see
 *     (resolved by manifest cap declarations like fs:read:<path>).
 *   - writePaths: read-write bind mounts.
 *   - shareNet: true when manifest declares net:* caps.
 */

import { posix } from 'node:path';

export interface BwrapBuildOptions {
  workDir: string;
  bwrapBinary?: string; // default 'bwrap'
  readPaths?: string[];
  writePaths?: string[];
  shareNet?: boolean;
  /** Daemon argv (binary first). */
  cmd: string[];
}

export function buildBwrapArgs(opts: BwrapBuildOptions): { binary: string; argv: string[] } {
  const binary = opts.bwrapBinary ?? 'bwrap';
  const argv: string[] = [
    '--ro-bind', '/', '/',
    '--tmpfs', '/tmp',
    '--bind', opts.workDir, '/work',
    '--chdir', '/work',
    '--proc', '/proc',
    '--dev', '/dev',
    '--unshare-pid',
    '--unshare-ipc',
    '--unshare-uts',
    '--unshare-cgroup-try',
    '--die-with-parent',
    '--clearenv',
  ];
  for (const p of opts.readPaths ?? []) {
    argv.push('--ro-bind-try', p, p);
  }
  for (const p of opts.writePaths ?? []) {
    argv.push('--bind-try', p, p);
  }
  // Net + user namespace deliberately omitted — see file header.
  argv.push('--');
  argv.push(...opts.cmd);
  return { binary, argv };
}

/**
 * System directories an interpreter needs to exec and dynamically link.
 * `-try` because merged-/usr hosts make some of these symlinks or absent.
 * `/etc` is deliberately NOT here: node runs without it (measured
 * 2026-10-05), and it holds host identity and config a provider must not see.
 */
export const PROVIDER_SYSTEM_RO_DIRS = ['/usr', '/lib', '/lib64', '/bin', '/sbin'] as const;

export interface ProviderBwrapOptions {
  /** Plugin directory: bound READ-ONLY at its own path and used as cwd. */
  pluginDir: string;
  /**
   * Install prefixes the daemon's interpreter needs (e.g. node's prefix when
   * it lives outside /usr). Bound read-only; a missing one fails the spawn.
   */
  runtimeDirs?: string[];
  bwrapBinary?: string;
  /** Daemon argv (binary first). */
  cmd: string[];
}

/**
 * The provider sandbox profile (D-006): a third-party provider gets no
 * network namespace of its own (`--unshare-net` leaves only an isolated
 * loopback), no host filesystem beyond the system dirs, its runtime and its
 * own read-only plugin dir, a private /tmp, and a scrubbed environment. Every
 * outbound request must go through the host's `host.fetch`.
 *
 * Unlike {@link buildBwrapArgs} there are no caller-supplied read/write paths
 * and no network opt-in: the profile is fixed so a manifest cannot widen it.
 */
export function buildProviderBwrapArgs(opts: ProviderBwrapOptions): { binary: string; argv: string[] } {
  const binary = opts.bwrapBinary ?? 'bwrap';
  const argv: string[] = [];
  for (const dir of PROVIDER_SYSTEM_RO_DIRS) argv.push('--ro-bind-try', dir, dir);
  // Every fresh mount (/proc, /dev, the private /tmp) goes BEFORE the plugin
  // and runtime binds. bwrap applies operations in order, so a later fresh
  // mount covers any bind already made under it. A plugin dir under /tmp, or
  // under /dev/shm (where the test TMPDIR guard falls back when /tmp is short
  // of headroom), was otherwise shadowed: `--chdir` then failed and the
  // provider was refused as if the host could not sandbox at all (WI-10006742).
  argv.push('--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp');
  for (const dir of opts.runtimeDirs ?? []) argv.push('--ro-bind', dir, dir);
  argv.push(
    '--ro-bind', opts.pluginDir, opts.pluginDir,
    '--chdir', opts.pluginDir,
    '--unshare-net',
    '--unshare-pid',
    '--unshare-ipc',
    '--unshare-uts',
    '--unshare-cgroup-try',
    '--new-session',
    '--die-with-parent',
    '--clearenv',
    '--setenv', 'PATH', '/usr/bin:/bin',
    '--setenv', 'HOME', '/tmp',
    '--',
    ...opts.cmd,
  );
  return { binary, argv };
}

export interface HandlerBwrapOptions {
  /** CHILD descriptor numbers, explicitly mapped by the trusted supervisor. */
  files: ReadonlyArray<{ path: string; fd: number; executable: boolean }>;
  /** A sealed createHandlerBootstrapFilter descriptor mapped into the child. */
  bootstrapFilterFd: number;
}

/**
 * Strict handler mount profile: no host path, directory bind, caller command,
 * environment extension or permissive fallback. The trusted supervisor owes
 * sealed file descriptors and the independently measured runtime closure.
 * The fixed bootstrap owes the final TSYNC restrictions BEFORE handler import.
 * This argv builder alone is not an established handler execution boundary.
 */
export function buildHandlerBwrapArgs(opts: HandlerBwrapOptions): { binary: string; argv: string[] } {
  const fail = () => { throw new Error('invalid handler runtime-file profile'); };
  const descriptor = (fd: number) => Number.isSafeInteger(fd) && fd >= 3;
  if (!descriptor(opts.bootstrapFilterFd) || !opts.files.length || opts.files.length > 1024) fail();
  const paths = new Map<string, boolean>();
  const descriptors = new Set([opts.bootstrapFilterFd]);
  for (const file of opts.files) {
    if (!descriptor(file.fd) || descriptors.has(file.fd) || typeof file.executable !== 'boolean'
      || typeof file.path !== 'string' || /[\\\x00-\x1f\x7f]/.test(file.path)
      || posix.normalize(file.path) !== file.path
      || !/^\/(?:runtime|handler|lib|lib64|usr\/lib)\/.+/.test(file.path)
      || file.path.endsWith('/') || paths.has(file.path)) fail();
    paths.set(file.path, file.executable);
    descriptors.add(file.fd);
  }
  for (const path of paths.keys()) {
    let parent = posix.dirname(path);
    while (parent !== '/') {
      if (paths.has(parent)) fail();
      parent = posix.dirname(parent);
    }
  }
  if (paths.get('/runtime/node') !== true || !paths.has('/runtime/bootstrap.cjs')
    || !paths.has('/handler/entry.cjs')) fail();

  const argv = [
    '--unshare-user', '--unshare-net', '--unshare-pid', '--unshare-ipc',
    '--unshare-uts', '--unshare-cgroup', '--disable-userns', '--assert-userns-disabled',
    '--cap-drop', 'ALL', '--new-session', '--die-with-parent',
    '--clearenv', '--setenv', 'HOME', '/tmp', '--setenv', 'PATH', '/runtime',
    '--setenv', 'UV_USE_IO_URING', '0',
    '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp',
    '--dir', '/runtime', '--dir', '/handler',
  ];
  for (const file of opts.files) {
    argv.push('--perms', file.executable ? '0555' : '0444', '--ro-bind-data', String(file.fd), file.path);
  }
  argv.push('--remount-ro', '/', '--chdir', '/handler',
    '--seccomp', String(opts.bootstrapFilterFd), '--',
    '/runtime/node', '--no-global-search-paths', '/runtime/bootstrap.cjs');
  return { binary: '/usr/bin/bwrap', argv };
}
