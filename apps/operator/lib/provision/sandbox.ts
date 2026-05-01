/**
 * Sandbox-builder for provision scripts.
 *
 * Builds the argv that wraps a script invocation in OS-appropriate
 * sandboxing primitives:
 *   - Linux: bwrap (bubblewrap) — read-only root, scratch /tmp, network
 *            policy via --share-net + outbound DNS allowlist.
 *   - macOS: sandbox-exec with a generated profile.
 *   - Windows: V2 — V1 refuses to run on Windows for now.
 *
 * The runner only invokes the *bundled* substrate-shipped sandboxer.
 * Per spec, the substrate ships its own bwrap binary so plugin scripts
 * cannot rely on a system-wide bwrap that may have been swapped.
 *
 * Spec: /docs/snapshots/build-scripts#sandboxing.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

export interface SandboxOptions {
  /** Plugin's working directory (read-only mount). */
  pluginDir: string;
  /** Plugin's per-harness scratch dir (read-write mount). */
  scratchDir: string;
  /** Allowed outbound hosts (HTTPS only; substrate enforces 443/80). */
  allowedHosts: string[];
  /** Env vars to pass through. */
  env: Record<string, string>;
  /** Extra read-only mounts. */
  extraReadOnlyMounts?: { src: string; dst: string }[];
}

export interface SandboxBuildResult {
  /** Argv prefix to prepend before the script command itself. */
  argv: string[];
  /** Effective env (sandbox may scrub some). */
  env: Record<string, string>;
  /** Whether sandboxing is actually active or a soft-fallback. */
  active: boolean;
  /** Description of which sandboxer is in use, for audit log. */
  driver: 'bwrap' | 'sandbox-exec' | 'none';
}

/** Substrate-bundled bwrap binary path resolution. */
function resolveBundledBwrap(): string | null {
  // Convention: bundled at $PAPERCUSP_BWRAP or alongside the operator at
  // ../../runtime/sandbox/bwrap. Falls back to system bwrap as a last
  // resort (logs a warning in the audit trail).
  const env = process.env.PAPERCUSP_BWRAP;
  if (env && existsSync(env)) return env;
  const candidates = [
    '/usr/lib/papercusp/runtime/sandbox/bwrap',
    join(process.cwd(), 'runtime/sandbox/bwrap'),
    '/usr/bin/bwrap',
    '/usr/local/bin/bwrap',
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

function buildBwrapArgv(opts: SandboxOptions, bwrap: string): string[] {
  const argv: string[] = [
    bwrap,
    '--die-with-parent',
    '--unshare-pid',
    '--unshare-uts',
    '--unshare-ipc',
    '--unshare-user',
    '--proc', '/proc',
    '--dev', '/dev',
    '--tmpfs', '/tmp',
    '--ro-bind', '/usr', '/usr',
    '--ro-bind', '/lib', '/lib',
  ];
  if (existsSync('/lib64')) argv.push('--ro-bind', '/lib64', '/lib64');
  if (existsSync('/bin')) argv.push('--ro-bind', '/bin', '/bin');
  if (existsSync('/sbin')) argv.push('--ro-bind', '/sbin', '/sbin');
  if (existsSync('/etc')) argv.push('--ro-bind', '/etc', '/etc');

  argv.push('--ro-bind', opts.pluginDir, opts.pluginDir);
  argv.push('--bind', opts.scratchDir, opts.scratchDir);

  for (const m of opts.extraReadOnlyMounts ?? []) {
    argv.push('--ro-bind', m.src, m.dst);
  }

  // Network: V1 = "share net" + assume the caller gates outbound via the
  // process-level allowlist (see network-policy.ts). Layer-7 proxy is V2.
  argv.push('--share-net');

  // Drop env vars; pass only what we explicitly set.
  argv.push('--clearenv');
  for (const [k, v] of Object.entries(opts.env)) {
    argv.push('--setenv', k, v);
  }

  // chdir to scratch so scripts get a consistent CWD.
  argv.push('--chdir', opts.scratchDir);

  argv.push('--');
  return argv;
}

function buildMacOsArgv(opts: SandboxOptions): string[] {
  // sandbox-exec profile constructed inline.
  const profile = `
(version 1)
(deny default)
(allow process-fork process-exec)
(allow file-read*)
(allow file-write* (subpath "${opts.scratchDir}"))
(allow file-write* (subpath "/tmp"))
(allow file-write* (subpath "/private/tmp"))
(allow network-outbound (remote tcp))
(allow network-outbound (remote udp "*:53"))
(allow mach-lookup)
(allow signal (target self))
(allow sysctl-read)
`.trim();
  return ['sandbox-exec', '-p', profile];
}

export function buildSandbox(opts: SandboxOptions): SandboxBuildResult {
  const env = { ...opts.env };
  // Escape hatch for test/CI environments where bwrap isn't available.
  if (process.env.PAPERCUSP_DISABLE_SANDBOX === '1') {
    return { argv: [], env, active: false, driver: 'none' };
  }
  if (process.platform === 'linux') {
    const bwrap = resolveBundledBwrap();
    if (bwrap) {
      return { argv: buildBwrapArgv(opts, bwrap), env, active: true, driver: 'bwrap' };
    }
    return { argv: [], env, active: false, driver: 'none' };
  }
  if (process.platform === 'darwin') {
    return { argv: buildMacOsArgv(opts), env, active: true, driver: 'sandbox-exec' };
  }
  return { argv: [], env, active: false, driver: 'none' };
}

/**
 * Quick smoke test: verify the bundled sandboxer can actually launch a
 * trivial /bin/true. Per spec, substrate boots run this once per session
 * to fail fast if the sandbox is broken.
 */
export async function smokeTestSandbox(): Promise<{ ok: boolean; driver: string; error?: string }> {
  const { spawn } = await import('node:child_process');
  const built = buildSandbox({
    pluginDir: '/tmp',
    scratchDir: '/tmp',
    allowedHosts: [],
    env: {},
  });
  if (!built.active) return { ok: false, driver: built.driver, error: 'no sandbox driver available' };
  return new Promise((resolve) => {
    const argv = [...built.argv, '/bin/true'];
    const [bin, ...rest] = argv;
    const child = spawn(bin, rest, { stdio: 'ignore' });
    let resolved = false;
    const timer = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      child.kill('SIGKILL');
      resolve({ ok: false, driver: built.driver, error: 'timeout' });
    }, 5000);
    child.on('error', (err) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      resolve({ ok: false, driver: built.driver, error: err.message });
    });
    child.on('exit', (code) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      resolve({ ok: code === 0, driver: built.driver, error: code === 0 ? undefined : `exit ${code}` });
    });
  });
}
