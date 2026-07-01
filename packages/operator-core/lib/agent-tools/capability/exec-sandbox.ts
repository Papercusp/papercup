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
 * is restricted. The bwrap argv is unit-tested via an injectable seam; the real
 * bwrap + srt exec paths are validated end-to-end by `exec-sandbox.integration.test.ts`
 * on a bwrap-capable host (it skips where bwrap can't sandbox, e.g. CI). On Ubuntu
 * 24.04 a host needs an AppArmor profile granting `/usr/bin/bwrap` the `userns`
 * permission (`apparmor_restrict_unprivileged_userns=1` otherwise shunts unconfined
 * bwrap into the restrictive `unprivileged_userns` profile → `setting up uid map:
 * Permission denied`); see `/etc/apparmor.d/bwrap` and the agent-insights doc.
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
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir, platform as osPlatform, tmpdir } from 'node:os';
import { join } from 'node:path';
import { FLAGS } from '@papercusp/flags';
import { getFlag } from '@papercusp/flags/server';
import { srtBinOnPath, buildFleetSrtSettings, wrapSpawnWithSrt } from '@papercusp/orchestrator';
import { authSandboxMaskAdditions, authSandboxDenyAllEgressOverride } from '../../auth-config-overrides';

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
  /** Binary to spawn (srt / bwrap, or the original `cmd[0]` when not wrapped). */
  binary: string;
  /** argv for the binary (the wrapper's args + the command, or `cmd.slice(1)`). */
  argv: string[];
  /** true ⇒ wrapped (srt or bwrap). */
  sandboxed: boolean;
  /** Which wrapper ran: 'srt' (fs+credential+egress-allowlist) · 'bwrap'
   *  (fs+credential) · 'raw' (unwrapped). */
  mode: 'srt' | 'bwrap' | 'raw';
  /** Why not sandboxed (for telemetry / log), or null when sandboxed. */
  reason: 'flag-off' | 'bwrap-unavailable' | null;
}

let _bwrapWorksCache: boolean | null = null;

/**
 * True when bwrap is present AND can actually sandbox on this host (cached, like
 * the plugin-loader supervisor's probe). Returns false where the unprivileged
 * userns is restricted (Ubuntu 24.04 without an AppArmor profile granting bwrap
 * the `userns` permission → `setting up uid map: Permission denied`), keeping the
 * exec path fail-open. Tests inject availability via the `bwrapWorks` opt rather
 * than touching this.
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
  /** srt binary path or null. `undefined` ⇒ resolve via `srtBinOnPath()`; tests inject. */
  srtBin?: string | null;
  /** srt settings file path or null. `undefined` ⇒ resolve via the per-cwd memo; tests inject. */
  srtSettingsPath?: string | null;
  /** Add `--unshare-net` (deny ALL egress) on the BWRAP fallback. Defaults from the env knob. */
  denyAllEgress?: boolean;
  /** Operator home dir (defaults to `homedir()`); injected by tests. */
  homeDir?: string;
  /** bwrap binary (default `'bwrap'`); injected by tests. */
  bwrapBinary?: string;
  /** Predicate: does a credential-mask target exist on the host? Defaults to
   *  `existsSync`; injected by tests. A target that does not exist is SKIPPED —
   *  bwrap cannot create a mount point under the read-only `/` bind (EROFS), so
   *  binding a nonexistent path is fail-CLOSED, and a path with no file has no
   *  secret to mask anyway. */
  maskExists?: (abs: string) => boolean;
}

/**
 * Per-cwd memo of the srt settings file (network egress allowlist + credential
 * denyRead, from `buildFleetSrtSettings`). Written once per cwd (the allowlist is
 * stable for the operator's lifetime), 0600, so capability:bash isn't writing a
 * temp file per call. Mirrors the fleet sandbox's cache-root convention.
 */
const _srtSettingsByCwd = new Map<string, string>();

export function capabilitySrtSettingsPathForCwd(cwd: string): string {
  const cached = _srtSettingsByCwd.get(cwd);
  if (cached && existsSync(cached)) return cached;
  const dir = join(tmpdir(), 'papercusp-capability-srt');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `srt-${createHash('sha256').update(cwd).digest('hex').slice(0, 16)}.json`);
  // backend:'omp' ⇒ no model-endpoint domains added (a shell command talks to no
  // model); egress = the package registries/CDNs + localhost (the operator + PG).
  writeFileSync(path, JSON.stringify(buildFleetSrtSettings({ cwd, backend: 'omp' })), { mode: 0o600 });
  _srtSettingsByCwd.set(cwd, path);
  return path;
}

/** Test-only: clear the srt-settings memo. */
export function __resetCapabilitySrtSettings(): void {
  _srtSettingsByCwd.clear();
}

/** `PAPERCUSP_CAPABILITY_SANDBOX_DENY_ALL_EGRESS=1` → `--unshare-net` (no network). */
export function capabilitySandboxDenyAllEgress(): boolean {
  const v = (process.env.PAPERCUSP_CAPABILITY_SANDBOX_DENY_ALL_EGRESS ?? '').trim().toLowerCase();
  const envDeny = v === '1' || v === 'true' || v === 'on';
  // P-019: the runtime exec_sandbox:set_policy override can only FORCE deny (tighten-only) — it can
  // never re-open egress the env locked down.
  return envDeny || authSandboxDenyAllEgressOverride() === true;
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
    mode: 'raw',
    reason,
  });
  if (!opts.enabled) return raw('flag-off');
  // srt and our bwrap both rest on bubblewrap; if bwrap can't sandbox here, srt
  // can't either, so fail OPEN to raw (never a wrapper that errors at runtime).
  const works = opts.bwrapWorks ?? capabilityBwrapWorks();
  if (!works) return raw('bwrap-unavailable');

  // PREFER srt (P-033): it adds DOMAIN-ALLOWLIST egress (its socat proxy) on top of
  // the fs + credential containment — full parity with native Bash's fleet sandbox,
  // reusing the validated buildFleetSrtSettings allowlist. Only when srt is absent
  // do we fall back to the bwrap-only path (fs + credential, no domain egress).
  const srtBin = opts.srtBin !== undefined ? opts.srtBin : srtBinOnPath();
  if (srtBin) {
    const settingsPath =
      opts.srtSettingsPath !== undefined ? opts.srtSettingsPath : capabilitySrtSettingsPathForCwd(input.cwd);
    if (settingsPath) {
      const w = wrapSpawnWithSrt(input.cmd[0]!, input.cmd.slice(1), {
        enabled: true,
        backend: 'omp', // a shell command talks to no model — backend only selects model-domains (none for omp)
        srtBin,
        settingsPath,
      });
      return { binary: w.command, argv: w.argv, sandboxed: true, mode: 'srt', reason: null };
    }
  }

  const home = opts.homeDir ?? homedir();
  const denyAllEgress = opts.denyAllEgress ?? capabilitySandboxDenyAllEgress();
  const bwrap = opts.bwrapBinary ?? 'bwrap';
  const maskExists = opts.maskExists ?? existsSync;
  const argv: string[] = [
    // Read-only view of the whole host fs (builds/tools must READ it)…
    '--ro-bind', '/', '/',
    // …then carve out the writable surfaces. ORDER MATTERS: `--tmpfs /tmp` (a fresh
    // writable /tmp) must come BEFORE the cwd bind. When the cwd is itself under /tmp
    // (e.g. TMPDIR=/tmp/pcv → a mkdtemp working dir), a `--tmpfs /tmp` applied AFTER
    // the cwd bind mounts an empty tmpfs OVER it, so the bind vanishes and `--chdir`
    // fails ("Can't chdir … No such file or directory"). Binding the cwd on TOP of
    // the tmpfs makes bwrap create the mount point inside the writable tmpfs, so the
    // real cwd survives at its path and `--chdir` succeeds.
    '--tmpfs', '/tmp',
    '--bind', input.cwd, input.cwd,
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
  //
  // SKIP a target that does not exist on the host. bwrap cannot create a mount
  // point under the read-only `/` bind — `Can't mkdir …: Read-only file system`
  // for a missing `--tmpfs` dir, `Can't create file at …` for a missing
  // `--ro-bind /dev/null` file — which aborts the WHOLE command (fail-CLOSED),
  // not just the mask. A path that does not exist has no secret to hide anyway,
  // and the read-only home means the sandboxed command cannot create one mid-run,
  // so skipping is safe. (WI-608: without this, a host merely lacking
  // `~/.config/gcloud` broke every capability:bash on the bwrap-fallback path.)
  // P-019: union any runtime add-only mask dirs (exec_sandbox:set_policy) over the baked set —
  // tighten-only (extra masks; the baked set is never removable). Additions are dirs ⇒ tmpfs.
  for (const d of [...CAPABILITY_SANDBOX_MASK_DIRS, ...authSandboxMaskAdditions()]) {
    const abs = join(home, d);
    if (!maskExists(abs)) continue;
    if (CAPABILITY_SANDBOX_MASK_FILES.has(d)) argv.push('--ro-bind', '/dev/null', abs);
    else argv.push('--tmpfs', abs);
  }
  if (denyAllEgress) argv.push('--unshare-net');
  // No `--clearenv`: a capability:bash build/test needs the caller's env (PATH,
  // HOME, npm/cargo config); the caller passes the same env to the bwrap spawn and
  // bwrap forwards it. Containment is filesystem-level (above), not env-stripping.
  argv.push('--', ...input.cmd);
  return { binary: bwrap, argv, sandboxed: true, mode: 'bwrap', reason: null };
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
