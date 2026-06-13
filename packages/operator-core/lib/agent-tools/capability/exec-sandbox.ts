/**
 * Capability-exec OS sandbox (agent-capability-confinement-2026-06-13 P-022 / D-008).
 *
 * The `capability:bash` / `capability:git` defineTools spawn real subprocesses in
 * the OPERATOR (Hono host) process — OUTSIDE the per-spawn agent OS sandbox
 * (claude-code's bwrap + socat) that contains a fleet agent's NATIVE Bash. So
 * routing the fleet off native Bash onto `capability:bash` (the B-18 cutover) would
 * move execution from a sandboxed context to an unsandboxed one. This module
 * re-applies an OS sandbox to that operator-side exec path: bwrap filesystem +
 * credential containment, with an optional deny-all-egress network lock.
 *
 * GATED + FAIL-OPEN. The wrap engages only when (a) the `papercusp-capability-exec-sandbox`
 * flag is ON and (b) bwrap actually works on this host. Otherwise the command runs
 * RAW (today's behavior) — so this can never break a host whose unprivileged userns
 * is restricted (e.g. this dev box: bwrap is present but `setting up uid map:
 * Permission denied`). The bwrap argv is unit-tested via an injectable seam;
 * end-to-end validation is gated on a bwrap-capable host (the owner's arming step).
 *
 * SCOPE (honest): this restores FILESYSTEM + CREDENTIAL containment (the larger
 * blast radius) plus a deny-all-egress lever. DOMAIN-ALLOWLIST egress parity with
 * claude's socat proxy (a sandboxed `npm install` reaches the registry but nothing
 * else) is NOT here — it needs a per-subprocess netns + proxy, the same v1 caveat
 * the daemon bwrap path carries. Tracked as a follow-up; until it lands, arming the
 * exec-sandbox trades claude's socat egress-allowlist for bwrap fs/credential
 * containment (+ the optional deny-all egress lock).
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir, platform as osPlatform } from 'node:os';
import { join } from 'node:path';
import { FLAGS } from '@papercusp/flags';
import { getFlag } from '@papercusp/flags/server';

/**
 * Credential dirs masked (tmpfs mounted over them, so they read empty) inside the
 * sandbox. Mirrors the fleet sandbox's `FLEET_SANDBOX_DENY_READ` (orchestrator
 * `invoke.ts`) — kept in step by `exec-sandbox.test.ts`. Home-relative; resolved
 * against the operator process home. (claude's sandbox hides these via `denyRead`;
 * bwrap has no per-path read-deny, so a tmpfs overlay is the equivalent.)
 */
export const CAPABILITY_SANDBOX_MASK_DIRS: readonly string[] = [
  '.ssh',
  '.aws',
  '.gnupg',
  '.config/gcloud',
  '.papercusp',
  '.npmrc',
];

/**
 * Home-relative entries in {@link CAPABILITY_SANDBOX_MASK_DIRS} that are FILES, not
 * directories. `--tmpfs DEST` needs DEST to be a directory mount point, so a file
 * credential (`~/.npmrc` holds npm auth tokens) is masked with `--ro-bind /dev/null`
 * instead — otherwise the tmpfs mount no-ops and the secret stays readable.
 */
const CAPABILITY_SANDBOX_MASK_FILES: ReadonlySet<string> = new Set(['.npmrc']);

export interface CapabilitySandboxDecision {
  /** Binary to spawn (bwrap, or the original `cmd[0]` when not wrapped). */
  binary: string;
  /** argv for the binary (bwrap args + `--` + cmd, or `cmd.slice(1)`). */
  argv: string[];
  /** true ⇒ wrapped in bwrap. */
  sandboxed: boolean;
  /** Why not sandboxed (for telemetry / log), or null when sandboxed. */
  reason: 'flag-off' | 'bwrap-unavailable' | null;
}

let _bwrapWorksCache: boolean | null = null;

/**
 * True when bwrap is present AND can actually sandbox on this host (cached, like
 * the plugin-loader supervisor's probe). The dev box returns false (unprivileged
 * userns is AppArmor-restricted: `setting up uid map: Permission denied`). Tests
 * inject availability via the `bwrapWorks` opt rather than touching this.
 */
export function capabilityBwrapWorks(): boolean {
  if (_bwrapWorksCache !== null) return _bwrapWorksCache;
  if (osPlatform() !== 'linux' || !existsSync('/usr/bin/bwrap')) {
    _bwrapWorksCache = false;
    return false;
  }
  try {
    const r = spawnSync(
      '/usr/bin/bwrap',
      ['--ro-bind', '/', '/', '--proc', '/proc', '--dev', '/dev', '--die-with-parent', '/bin/true'],
      { stdio: 'ignore', timeout: 5_000 },
    );
    _bwrapWorksCache = r.status === 0;
  } catch {
    _bwrapWorksCache = false;
  }
  return _bwrapWorksCache;
}

/** Test-only: reset the cached bwrap-availability probe. */
export function __resetCapabilityBwrapCache(): void {
  _bwrapWorksCache = null;
}

export interface BuildSandboxInput {
  /** binary + argv, e.g. `['bash','-c',command]` or `['git','status','--porcelain']`. */
  cmd: string[];
  /** Writable working dir — bound rw at its real path, and the sandbox `--chdir`. */
  cwd: string;
}

export interface BuildSandboxOpts {
  /** The resolved `papercusp-capability-exec-sandbox` flag. */
  enabled: boolean;
  /** Whether bwrap works (defaults to `capabilityBwrapWorks()`); injected by tests. */
  bwrapWorks?: boolean;
  /** Add `--unshare-net` (deny ALL egress). Defaults from the env knob. */
  denyAllEgress?: boolean;
  /** Operator home dir (defaults to `homedir()`); injected by tests. */
  homeDir?: string;
  /** bwrap binary (default `'bwrap'`); injected by tests. */
  bwrapBinary?: string;
}

/** `PAPERCUSP_CAPABILITY_SANDBOX_DENY_ALL_EGRESS=1` → `--unshare-net` (no network). */
export function capabilitySandboxDenyAllEgress(): boolean {
  const v = (process.env.PAPERCUSP_CAPABILITY_SANDBOX_DENY_ALL_EGRESS ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on';
}

/**
 * Decide how to spawn a capability subprocess. PURE given its opts (bwrap
 * availability + flag + knobs are inputs), so the full argv is unit-testable
 * without a live bwrap. FAIL-OPEN: not-enabled or bwrap-unavailable ⇒ run raw.
 */
export function buildCapabilitySandboxCommand(
  input: BuildSandboxInput,
  opts: BuildSandboxOpts,
): CapabilitySandboxDecision {
  const raw = (reason: CapabilitySandboxDecision['reason']): CapabilitySandboxDecision => ({
    binary: input.cmd[0]!,
    argv: input.cmd.slice(1),
    sandboxed: false,
    reason,
  });
  if (!opts.enabled) return raw('flag-off');
  const works = opts.bwrapWorks ?? capabilityBwrapWorks();
  if (!works) return raw('bwrap-unavailable');

  const home = opts.homeDir ?? homedir();
  const denyAllEgress = opts.denyAllEgress ?? capabilitySandboxDenyAllEgress();
  const bwrap = opts.bwrapBinary ?? 'bwrap';
  const argv: string[] = [
    // Read-only view of the whole host fs (builds/tools must READ it)…
    '--ro-bind', '/', '/',
    // …then carve out the writable surfaces: the project cwd (real path) + /tmp.
    '--bind', input.cwd, input.cwd,
    '--tmpfs', '/tmp',
    '--proc', '/proc',
    '--dev', '/dev',
    '--unshare-pid',
    '--unshare-ipc',
    '--unshare-uts',
    '--unshare-cgroup-try',
    '--die-with-parent',
    '--chdir', input.cwd,
  ];
  // Mask credential paths. Applied AFTER the ro-bind of `/`, so the overlay wins.
  // Dirs read empty via a tmpfs overlay; file credentials (e.g. ~/.npmrc) read
  // empty via `--ro-bind /dev/null` (a tmpfs needs a DIRECTORY mount point, so a
  // tmpfs over a file no-ops and would leave the secret readable).
  for (const d of CAPABILITY_SANDBOX_MASK_DIRS) {
    const abs = join(home, d);
    if (CAPABILITY_SANDBOX_MASK_FILES.has(d)) argv.push('--ro-bind', '/dev/null', abs);
    else argv.push('--tmpfs', abs);
  }
  if (denyAllEgress) argv.push('--unshare-net');
  // No `--clearenv`: a capability:bash build/test needs the caller's env (PATH,
  // HOME, npm/cargo config); the caller passes the same env to the bwrap spawn and
  // bwrap forwards it. Containment is filesystem-level (above), not env-stripping.
  argv.push('--', ...input.cmd);
  return { binary: bwrap, argv, sandboxed: true, reason: null };
}

/**
 * Resolve the `papercusp-capability-exec-sandbox` flag at spawn time. DEFAULT-OFF
 * and FAIL-OPEN: a flag-IO error resolves to OFF (run raw) so a PostHog hiccup can
 * never make capability exec start failing — the owner's flip is the only thing
 * that arms it. Call once per tool invocation in the handler (async flag IO), then
 * pass the boolean into the sync `buildCapabilitySandboxCommand`.
 */
export async function capabilityExecSandboxEnabled(): Promise<boolean> {
  try {
    return await getFlag(FLAGS.CAPABILITY_EXEC_SANDBOX, 'system');
  } catch {
    return false;
  }
}
