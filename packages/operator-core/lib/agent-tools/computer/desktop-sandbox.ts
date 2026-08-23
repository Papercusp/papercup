/**
 * desktop-sandbox.ts — P-010 / D-015: the bubblewrap tier for apps on a leased desktop.
 *
 * WHY THIS IS NOT `buildCapabilitySandboxCommand`. That builder is correctly shaped for a
 * `capability:bash` payload — a writable cwd, build caches, and a private `/tmp`. The last
 * of those is exactly wrong here, because a desktop app reaches BOTH of the things that
 * make it useful through sockets under `/tmp`:
 *
 *   /tmp/.X11-unix/X<n>   the X server
 *   /tmp/dbus-XXXXXXXX    this desktop's accessibility bus (P-007's `unix:tmpdir=/tmp`)
 *
 * So this module reuses that one's PRIMITIVES — the bwrap probe, `scrubExecEnv`, and the
 * credential mask lists — and composes its own mount plan. One probe, one env allowlist,
 * one mask policy; two mount plans, because the payloads genuinely differ.
 *
 * ⚠ THE NON-OBVIOUS PART (D-015, measured — do not "simplify" this away). An X client on
 * Linux can reach its server two ways, and Xvfb listens on both:
 *
 *     @/tmp/.X11-unix/X191   ABSTRACT socket  — lives in the NETWORK namespace
 *      /tmp/.X11-unix/X191   FILESYSTEM socket — lives in the MOUNT namespace
 *
 * Those are different namespaces, so each confinement knob hits a different half and
 * NEITHER ALONE breaks the display. Measured with `xterm -e true` against a real Xvfb:
 *
 *   | --tmpfs /tmp | --unshare-net | X socket re-bound | result |
 *   |--------------|---------------|-------------------|--------|
 *   | yes          | no            | no                | WORKS  |  (abstract socket carries it)
 *   | yes          | YES           | no                | FAILS  |  "Can't open display"
 *   | yes          | YES           | yes, after tmpfs  | WORKS  |
 *   | no           | YES           | (via --ro-bind /) | WORKS  |
 *
 * The trap is that each knob looks individually safe, and the combination — which is
 * precisely what a security-minded default would pick — is the fatal one. The a11y bus has
 * the MIRROR exposure: dbus resolves `unix:tmpdir=/tmp` to a real FILE (measured:
 * `unix:path=/tmp/dbus-85DYQtR2WE`), so it is immune to `--unshare-net` and destroyed by
 * `--tmpfs /tmp`. Losing it is silent — apps still run, `computer:observe` just falls back
 * to pixels, turning P-008's measured 10.48x token win back into screenshot-every-step
 * while every test stays green.
 */
import { homedir } from 'node:os';
import { FLAGS, getFlag } from '@papercusp/flags';
import type { GlTier } from '../../desktop/gl-strategy';
import { capabilityBwrapWorks, credentialMaskArgs, scrubExecEnv } from '../capability/exec-sandbox';

/**
 * Resolve `papercusp-desktop-app-sandbox` at provision time.
 *
 * ON by default (alpha default-on). FAILS OPEN on a flag-IO error — a PostHog hiccup must
 * never stop desktops provisioning, and the builder is itself fail-open, so the worst case
 * is an app that launches exactly as it did before P-010.
 */
export async function desktopAppSandboxEnabled(): Promise<boolean> {
  try {
    return await getFlag(FLAGS.DESKTOP_APP_SANDBOX, 'system');
  } catch {
    return false;
  }
}

/** The X socket directory. Every display's filesystem socket lives here. */
export const X11_SOCKET_DIR = '/tmp/.X11-unix';

/**
 * Env keys a sandboxed desktop app needs that `scrubExecEnv`'s allowlist does NOT carry.
 *
 * These are not secrets and not toolchain config — they are the address of the display and
 * of the a11y bus, i.e. the whole point of the process. Passed as `extraAllow` rather than
 * added to the shared allowlist because they are meaningless outside a desktop payload.
 */
export const DESKTOP_ENV_EXTRA_ALLOW: readonly string[] = Object.freeze([
  'DISPLAY',
  'XAUTHORITY',
  'DBUS_SESSION_BUS_ADDRESS',
  'AT_SPI_BUS_ADDRESS',
]);

export interface DesktopSandboxInput {
  /** The app argv, GL prefix already applied (e.g. `['vglrun','-d','egl0','xterm']`). */
  cmd: readonly string[];
  /** The sandbox display, e.g. `:110`. Used to bind that display's socket. */
  display: string;
  /**
   * Filesystem path of this desktop's a11y bus socket, from `a11yBusSocketPath()`.
   * `null`/omitted ⇒ no bus to carry (a screenshot-only desktop, `accessibility:false`).
   */
  a11yBusPath?: string | null;
  /**
   * GL tier in force for this desktop. `'hardware'` needs `/dev/dri`, which `--dev /dev`
   * would otherwise hide — silently downgrading a GPU desktop to no-GL and undoing P-002.
   */
  glTier?: GlTier;
  /** Home directory to give the app a PRIVATE writable copy of. Defaults to `os.homedir()`. */
  homeDir?: string;
}

export interface DesktopSandboxOpts {
  /** The `papercusp-desktop-app-sandbox` flag, resolved by the caller. */
  enabled: boolean;
  /** Injectable for tests; defaults to the live cached probe. */
  bwrapWorks?: boolean;
  /**
   * Add `--unshare-net`. OPT-IN per D-015 §3: a desktop exists to run real apps, and a
   * silently network-less browser is a worse failure than an un-isolated one. Safe in
   * combination with the mount plan below, which is the point of that ruling.
   */
  denyNetwork?: boolean;
  /**
   * Existence probe for credential-mask targets, injectable so this builder is genuinely
   * PURE given its opts (it defaults to `existsSync`). The masks SKIP absent targets —
   * bwrap cannot create a mount point under a read-only root and aborts the whole command —
   * so without this seam a unit test's assertions would silently depend on which dotfiles
   * happen to exist on the machine running it.
   */
  maskExists?: (abs: string) => boolean;
}

export interface DesktopSandboxDecision {
  binary: string;
  argv: string[];
  sandboxed: boolean;
  reason: 'flag-off' | 'bwrap-unavailable' | 'sandboxed';
}

/**
 * Parse the filesystem socket path out of a D-Bus address.
 *
 * Returns `null` for an ABSTRACT address (`unix:abstract=...`) rather than a path, because
 * an abstract socket has no path to bind and is unreachable from a new network namespace —
 * so `null` here is the honest "there is nothing I can carry", not a parse failure. Our own
 * bus is filesystem-backed (`unix:tmpdir=/tmp` ⇒ `unix:path=`), but a caller may hand us an
 * externally-provisioned address, and silently treating an abstract one as absent is what
 * keeps the caller's `--unshare-net` decision honest.
 */
export function a11yBusSocketPath(address: string | null | undefined): string | null {
  if (!address) return null;
  for (const part of address.split(',')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const key = part.slice(0, eq).replace(/^unix:/, '').trim();
    const value = part.slice(eq + 1).trim();
    if (key === 'path' && value) return value;
  }
  return null;
}

/**
 * The env a sandboxed desktop app runs with: the operator's ambient env SCRUBBED of
 * credentials, with the desktop's own deliberate additions layered back on top.
 *
 * The layering order is the D-011 ruling applied one level down. `overlays` — the DISPLAY,
 * the a11y bus address, the GL strategy's vars — were computed by the desktop layer on
 * purpose; scrubbing them would delete the payload's whole reason for existing. So they are
 * applied AFTER the scrub, never subjected to it.
 */
export function desktopSandboxEnv(
  base: Record<string, string | undefined>,
  overlays: Record<string, string> = {},
): Record<string, string> {
  return { ...scrubExecEnv(base, DESKTOP_ENV_EXTRA_ALLOW), ...overlays };
}

/**
 * Build the bwrap invocation for one desktop app. PURE given its opts, so the whole mount
 * plan is unit-assertable without a live bwrap.
 *
 * FAIL-OPEN, matching the capability sandbox: flag off or bwrap unavailable ⇒ run the app
 * raw. A desktop that refuses to start is a worse outcome than one that starts unconfined,
 * and the caller records which happened.
 */
export function buildDesktopSandboxCommand(
  input: DesktopSandboxInput,
  opts: DesktopSandboxOpts,
): DesktopSandboxDecision {
  const raw = (reason: 'flag-off' | 'bwrap-unavailable'): DesktopSandboxDecision => ({
    binary: input.cmd[0]!,
    argv: input.cmd.slice(1),
    sandboxed: false,
    reason,
  });
  if (!opts.enabled) return raw('flag-off');
  if (!(opts.bwrapWorks ?? capabilityBwrapWorks())) return raw('bwrap-unavailable');

  const home = input.homeDir ?? homedir();
  const argv: string[] = [
    // Read-only host root: the app can READ the system it needs to run and write nowhere.
    '--ro-bind', '/', '/',

    // A private /tmp. ⚠ ORDER IS LOAD-BEARING (D-015): every bind that must survive has to
    // come AFTER this, because a --tmpfs applied later mounts an empty fs OVER the bind.
    // `buildCapabilitySandboxCommand` documents the same hazard for its cwd.
    '--tmpfs', '/tmp',

    // …now carve the two sockets back in. The X socket dir read-only (a client only
    // connects); the bus socket read-write, because a D-Bus client writes to its socket.
    '--ro-bind', X11_SOCKET_DIR, X11_SOCKET_DIR,
    ...(input.a11yBusPath ? ['--bind', input.a11yBusPath, input.a11yBusPath] : []),

    // A private writable HOME. This is most of the FS containment worth having: it is where
    // an app would otherwise scribble on the operator user's real dotfiles, and a tmpfs
    // makes the desktop genuinely disposable.
    '--tmpfs', home,

    '--proc', '/proc',
    '--dev', '/dev',
  ];

  // `--dev /dev` builds a MINIMAL /dev with no /dev/dri, which would silently drop a
  // hardware-GL desktop to software and undo P-002. Bind the render nodes back for the one
  // tier that needs them — and only that tier, so a software desktop gets no GPU handle.
  if (input.glTier === 'hardware') argv.push('--dev-bind-try', '/dev/dri', '/dev/dri');

  argv.push('--unshare-pid', '--unshare-ipc', '--unshare-uts', '--unshare-cgroup-try');
  if (opts.denyNetwork) argv.push('--unshare-net');

  // Credential masking via the SHARED emitter, so the file-vs-dir distinction, the
  // skip-absent rule, and P-019's runtime mask additions cannot drift between the two
  // sandboxes. These paths sit under the private HOME tmpfs already, but the masks are
  // applied anyway: that tmpfs is a consequence of how we chose to give the app a writable
  // home, and a later change to that choice must not silently un-mask ~/.ssh.
  argv.push(...credentialMaskArgs(home, opts.maskExists));

  // NO `--die-with-parent`. A desktop app is long-lived and deliberately outlives the call
  // that launched it; EI-16635 is the recorded case of that flag killing exactly this shape
  // of process. Lifetime is the task ledger's job — the app is enrolled as a child of the
  // Xvfb task, so `killTask(taskId, { includeSubtree: true })` reaps it.
  argv.push('--', ...input.cmd);

  return { binary: 'bwrap', argv, sandboxed: true, reason: 'sandboxed' };
}
