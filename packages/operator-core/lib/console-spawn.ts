/**
 * console-spawn.ts — the shared, server-side "open a native terminal window and
 * run a one-liner in it" primitive.
 *
 * This was extracted out of the `/api/agent-mcp/console/launch` route so it can
 * be reused without duplication by:
 *   - the superuser-console launcher route (the global "+" button)  → writeMcpJson:true
 *   - the `capability:terminal` agent tool (run an arbitrary command) → writeMcpJson:false
 *
 * One spawner, two callers. The OS-native new-window logic (Linux terminal
 * cascade, the OSC recolor/retitle prelude, the sentinel-file lifecycle) lives
 * here; each caller supplies a {@link ConsoleEnvelope} (built by
 * `buildConsoleEnvelope`) and decides whether the superuser `.mcp.json` should
 * be displaced into the cwd.
 *
 * Linux + macOS spawn server-side here; Windows does not. On macOS the operator
 * (a child of the desktop .app, in the user's GUI session) opens Terminal/iTerm
 * itself via `open -na` — mirroring the Linux child_process path, so fleet color
 * schemes + the sentinel lifecycle work identically. On Windows the operator runs
 * inside WSL and cannot spawn a Windows GUI terminal, so {@link spawnConsole}
 * returns `code:501` and the desktop shell spawns it Rust-side via the Tauri
 * `console_launch` command (papercusp-desktop/src-tauri/src/native_console.rs).
 *
 * Server-only.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ConsoleEnvelope } from './console-launcher';
import type { ColorScheme } from './console-color-schemes';
import { isWindowsDesktopHost } from './windows-desktop-windows';

// ─── Linux terminal selection ────────────────────────────────────────

const LINUX_TERMINALS: Array<[string, string[]]> = [
  // gnome-terminal is a thin client talking to gnome-terminal-server; without
  // `--wait` the client process exits immediately after creating the window,
  // which makes adv_sessions rows look "ended" even while the real terminal is
  // still open.
  ['gnome-terminal', ['--wait', '--window', '--']],
  ['konsole', ['--new-window', '-e']],
  ['xfce4-terminal', ['--window', '-e']],
  ['alacritty', ['-e']],
  ['kitty', ['--']],
  ['wezterm', ['start', '--always-new-process', '--']],
  ['xterm', ['-e']],
];

function isOnPath(bin: string): boolean {
  const paths = (process.env.PATH ?? '').split(':');
  paths.push('/usr/bin', '/usr/local/bin');
  return paths.some((p) => existsSync(join(p, bin)));
}

// Cache the terminal selection — it's the same on every call (terminal
// binaries don't appear/disappear at runtime), and the existsSync sweep across
// LINUX_TERMINALS was adding noticeable latency to every console launch.
let cachedTerminal: { bin: string; args: string[] } | null | undefined;
export function findLinuxTerminal(): { bin: string; args: string[] } | null {
  if (cachedTerminal !== undefined) return cachedTerminal;
  const fromEnv = process.env.TERMINAL;
  if (fromEnv && isOnPath(fromEnv)) {
    cachedTerminal =
      fromEnv === 'gnome-terminal'
        ? { bin: fromEnv, args: ['--wait', '--'] }
        : { bin: fromEnv, args: ['-e'] };
    return cachedTerminal;
  }
  for (const [bin, args] of LINUX_TERMINALS) {
    if (isOnPath(bin)) {
      cachedTerminal = { bin, args: [...args] };
      return cachedTerminal;
    }
  }
  cachedTerminal = null;
  return cachedTerminal;
}

function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

// ─── Terminal appearance (OSC color/title) ───────────────────────────

export interface AppearanceOpts {
  mode: 'omp' | 'console';
  planSlug: string | null;
  label: string | null;
  advSessionId?: number | null;
  /** A bound fleet color scheme — when set it overrides the per-plan hashed
   *  background and also drives the foreground + cursor colors. */
  scheme?: ColorScheme | null;
}

/**
 * Emit the OSC escape sequences that recolor + retitle the terminal window:
 * foreground (OSC 10), background (OSC 11), window title (OSC 0). Per-plan
 * background is hashed from the plan slug for visual identity; foreground is a
 * fixed light tone for contrast.
 *
 * Why dark backgrounds + light foreground: agent CLIs (omp / claude / codex)
 * emit ANSI bright colors designed for dark terminals — illegible on a light
 * background. Dark saturated backgrounds keep those readable while still
 * letting each plan's terminal be visually distinct at a glance.
 */
function buildAppearancePrelude(opts: AppearanceOpts): string {
  // A bound fleet scheme wins: it sets bg + fg + cursor. Otherwise fall back to
  // the per-plan hashed background + default light foreground (no cursor OSC).
  const bg = opts.scheme?.bg ?? hashSlugToColor(opts.planSlug, opts.mode);
  const fg = opts.scheme?.fg ?? '#f4f4f5'; // zinc-100 — bright but not pure white (avoids halation on dark bg)
  const title = formatWindowTitle(opts);
  const titleEsc = title.replace(/'/g, "'\\''");
  const lines = [`printf '\\033]10;${fg}\\007'`, `printf '\\033]11;${bg}\\007'`];
  if (opts.scheme?.cursor) lines.push(`printf '\\033]12;${opts.scheme.cursor}\\007'`); // OSC 12 = cursor color
  lines.push(`printf '\\033]0;${titleEsc}\\007'`);
  return lines.join(' && ');
}

/**
 * Deterministic slug → background color from a curated palette of dark,
 * saturated hues. Every color is dark enough that ANSI bright colors remain
 * readable on top. Fixed neutral fallback when planSlug is null.
 */
function hashSlugToColor(planSlug: string | null, mode: 'omp' | 'console'): string {
  if (!planSlug) return mode === 'omp' ? '#0f3a36' : '#1e1b4b';
  const palette = [
    '#1e293b', '#0f172a', '#1e1b4b', '#312e81', '#3b0764',
    '#581c87', '#831843', '#7f1d1d', '#7c2d12', '#78350f',
    '#365314', '#14532d', '#134e4a', '#164e63', '#0c4a6e',
  ];
  let h = 0;
  for (let i = 0; i < planSlug.length; i++) {
    h = ((h << 5) - h + planSlug.charCodeAt(i)) | 0;
  }
  return palette[Math.abs(h) % palette.length]!;
}

export function advSessionTitleTag(id: number | null | undefined): string {
  return id != null ? `[adv:${id}]` : '';
}

function formatWindowTitle(opts: AppearanceOpts): string {
  const tag = opts.mode === 'omp' ? 'OMP' : 'SH';
  const advTag = advSessionTitleTag(opts.advSessionId);
  const name = opts.label?.trim() || opts.planSlug;
  return name ? `${tag}${advTag}: ${name}` : `${tag}${advTag}`;
}

// ─── The launcher one-liner ──────────────────────────────────────────

/**
 * Build the bash one-liner the terminal runs as its first command:
 *   appearance → cd → env exports → sentinel + EXIT-trap → (greeting) → exec shell
 *
 * The `greeting` (for capability:terminal, the user's arbitrary command) is
 * single-quote-escaped and wrapped in a subshell `(...)`, then control hands to
 * an interactive login shell — so the command runs and the window STAYS OPEN.
 * The sentinel file lets the Rust/Tauri side detect when the user's shell exits
 * (the terminal launcher's own pid exits in ~1s, so we fingerprint via the fs).
 */
export function buildConsoleOneliner(
  cwd: string,
  env: Record<string, string>,
  greeting: string,
  appearance: AppearanceOpts,
): string {
  const envExports: string[] = [];
  // Prepend the writable shim dir (psu/ptool, ~/.papercusp/bin) AND the bundled
  // scripts dir to PATH so the in-app terminal can run papercup/psu/ptool. Bin
  // dir first so a user shim wins over a same-named bundled script.
  const pathPrepend = [env.PAPERCUSP_BIN_DIR, env.PAPERCUSP_SCRIPTS_DIR].filter(Boolean) as string[];
  if (pathPrepend.length) {
    envExports.push(`export PATH=${pathPrepend.map((d) => shellEscape(d)).join(':')}:\${PATH}`);
  }
  for (const [k, v] of Object.entries(env)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) continue;
    envExports.push(`export ${k}=${shellEscape(v)}`);
  }
  const escapedCwd = shellEscape(cwd);
  const prelude = [
    buildAppearancePrelude(appearance),
    `cd ${escapedCwd}`,
    ...envExports,
    `touch .papercup-console-active.$`,
    `trap 'rm -f .papercup-console-active.$' EXIT`,
  ].join(' && ');
  // Run the greeting in a subshell, then ALWAYS exec an interactive login shell
  // — `;` (not `&&`) on BOTH sides of the greeting, so a command that exits
  // non-zero still leaves the window open. This matches the Rust/Tauri spawner
  // (native_console.rs build_launcher_oneliner: `… ({greet}) ; exec …`); the old
  // server-side `.join(' && ')` form left an `&& exec` that closed the window
  // when the greeting failed. capability:terminal runs arbitrary commands that
  // may fail, so the user must still see the result.
  return `${prelude} ; (${greeting.replace(/'/g, "'\\''")}) ; exec "\${SHELL:-/bin/bash}" -l`;
}

// ─── Desktop-env resolution + spawn verification (WI-1886) ───────────
//
// The operator commonly runs HEADLESS (a systemd user service with no DISPLAY /
// DBUS_SESSION_BUS_ADDRESS in its environment). `spawn('gnome-terminal', …)`
// then SUCCEEDS at the fork/exec layer (the binary exists → a pid is assigned),
// the client immediately dies off-screen with "Cannot open display", and the
// tool reported `ok + pid` with ZERO windows — the 2026-07-03 backlog-clearance
// launch lost all 10 member windows exactly this way. Durable fix, now three parts:
//   (a) resolveLinuxDesktopEnv(): when the operator itself has no DISPLAY,
//       resolve the interactive graphical session's env (X socket → DISPLAY,
//       /run/user/<uid>/bus → DBUS, gdm/~ Xauthority) and INJECT it; when no
//       display exists at all, FAIL LOUD before spawning anything.
//   (b) an early-exit probe: after spawning, watch the child briefly — a
//       desktop-terminal client that dies within the probe window (nonzero, or
//       zero under gnome-terminal --wait, whose client lives as long as the
//   (c) EI-8289: prefer the OWNER's REAL logged-in seat (resolved via `who`,
//       socket-file-independent) over a raw `/tmp/.X11-unix` socket scan. A
//       GNOME/XWayland real seat frequently has NO `/tmp/.X11-unix/X<N>` file
//       for its DISPLAY (`-nolisten local`-style setups only expose an abstract
//       socket), while a sandbox/frame Xvfb (leased per-hive/bee, or the
//       hive-frame-desktops pool) ALWAYS creates one. Blind socket-scanning
//       therefore (i) wrongly treats the real seat's already-correct DISPLAY as
//       "stale" (WI-2840's own liveness check) and (ii) then picks a virtual
//       Xvfb display instead — the launch reports "terminals opened" while the
//       owner's real desktop never sees them (EI-8289: 2026-07-06 fleet
//       behavior-probe, `fleet:launch-on-plan` windows landed on Xvfb `:93`
//       instead of the owner's real `:1`). `who`'s TTY column reports the
//       DISPLAY value directly for an X session and needs no socket file, so it
//       is checked FIRST — both before discarding an already-set DISPLAY as
//       stale, and before falling back to the socket scan. The socket scan is
//       now a last resort (no real seat found at all — a genuinely headless
//       box), and a virtual fallback is disclosed via `warnings` /
//       `resolvedVia`, never silent.
//       window) never opened a window → FAIL LOUD with its captured stderr.

/** How long to watch a just-spawned terminal for an early death. A real
 *  interactive window outlives this comfortably; a display-less client dies
 *  well inside it. */
export const EARLY_EXIT_PROBE_MS = 1200;

export interface DesktopEnvResolution {
  /** Extra env to inject into the terminal spawn ({} when the operator's own
   *  env is already desktop-complete). */
  env: Record<string, string>;
  /** False ⇒ no display could be resolved — spawning would ghost. */
  resolved: boolean;
  error: string | null;
  /**
   * WI-2840: non-fatal healing notes — set when an already-present DISPLAY /
   * XAUTHORITY value was found to be STALE (its socket/file no longer exists)
   * and was overridden by a freshly re-resolved one instead of being trusted
   * blindly. Empty when nothing needed healing. Callers should log these
   * loudly: a long-lived process silently carrying a poisoned value is
   * exactly what wedged desktop-terminal spawns until an operator restart
   * (the staging-operator incident this ticket was filed from). Also carries
   * an EI-8289 disclosure note when DISPLAY was resolved via the last-resort
   * socket scan (no real logged-in seat was found) — that display MAY be a
   * virtual/sandbox one rather than the owner's real desktop.
   */
  warnings: string[];
  /**
   * EI-8289: how the resolved DISPLAY was determined — `'operator-env'` (the
   * caller's own env was already correct, whether or not its socket file
   * exists), `'active-seat'` (no usable env DISPLAY; resolved from a REAL
   * logged-in seat via `who`), or `'socket-scan'` (last resort: no real seat
   * detected at all, so a virtual/sandbox display's socket file won by
   * default). `'active-seat'` is preferred over `'socket-scan'` precisely
   * because a sandbox/frame Xvfb always creates a socket file while a real
   * XWayland seat often does not — blind socket-scanning silently favors the
   * wrong one otherwise. `null` when `resolved` is false.
   */
  resolvedVia: 'operator-env' | 'active-seat' | 'socket-scan' | null;
}

/** Extract the `/tmp/.X11-unix/X<N>` socket path a DISPLAY value points at.
 *  Handles `:N`, `:N.M`, and `host:N.M` forms; null when unparseable. */
function socketPathForDisplay(display: string): string | null {
  const m = /:(\d+)(?:\.\d+)?$/.exec(display);
  return m ? `/tmp/.X11-unix/X${m[1]}` : null;
}

/** Injectable fs probes so the resolver is unit-testable without a desktop. */
export interface DesktopEnvProbes {
  existsSync: (p: string) => boolean;
  readdirSync: (p: string) => string[];
  uid: number;
  home: string;
  /**
   * EI-8289: the OWNER's currently logged-in X seat display(s), socket-file
   * INDEPENDENT (resolved via `who`, not `/tmp/.X11-unix`). Optional + defaults
   * to `[]` when omitted (existing callers/tests that predate this probe fall
   * through to the socket scan exactly as before — fully backward compatible).
   * Ascending-sorted; production implementation is best-effort (never throws).
   */
  activeSeatDisplays?: () => string[];
}

/**
 * EI-8289: parse `who`'s TTY column for real X-session displays. An X login
 * reports its DISPLAY value directly there (e.g. `marsh-office :1  2026-07-04
 * … (:1)`), independent of whether `/tmp/.X11-unix/X<N>` exists for it — which
 * it frequently does NOT for a GNOME/XWayland real seat. Plain `who` (not
 * `who -a`) already excludes exited/dead sessions. Best-effort: any failure
 * (no `who` binary, non-Linux, timeout) returns `[]` so callers degrade to the
 * pre-existing socket-scan behavior, never throwing.
 */
function realActiveSeatDisplays(): string[] {
  try {
    const out = execFileSync('who', [], { encoding: 'utf8', timeout: 2000 });
    const displays: string[] = [];
    for (const line of out.split('\n')) {
      const tty = line.trim().split(/\s+/)[1];
      if (tty && /^:\d+$/.test(tty) && !displays.includes(tty)) displays.push(tty);
    }
    return displays.sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
  } catch {
    return [];
  }
}

const realProbes = (): DesktopEnvProbes => ({
  existsSync,
  readdirSync: (p: string) => readdirSync(p),
  uid: process.getuid?.() ?? 1000,
  home: process.env.HOME ?? '/root',
  activeSeatDisplays: realActiveSeatDisplays,
});

/**
 * Resolve the desktop-session env a GUI terminal needs, for an operator that
 * may be running headless. Pure given its probes; exported for unit tests.
 */
export function resolveLinuxDesktopEnv(
  baseEnv: Record<string, string | undefined> = process.env,
  probes: DesktopEnvProbes = realProbes(),
): DesktopEnvResolution {
  const env: Record<string, string> = {};
  const warnings: string[] = [];
  let resolvedVia: 'operator-env' | 'active-seat' | 'socket-scan' = 'operator-env';

  // DISPLAY: trust the operator's own value — but ONLY after checking its X
  // socket still exists (WI-2840). A long-lived process (e.g. a systemd-
  // managed staging operator up for days) can carry a DISPLAY set at process
  // start whose X session has since ended (server restart, logout, socket
  // renumbered) — the value being SET is not evidence it is still LIVE.
  // Trusting it blindly is exactly what silently poisoned spawns until the
  // operator was restarted. If the socket is gone, treat it as unset and
  // re-resolve — EI-8289: but a missing socket file is ALSO what a real
  // GNOME/XWayland seat looks like (it's socket-file-less, not dead), so
  // before discarding an already-set DISPLAY, check whether `who` still
  // reports it as a currently logged-in seat and trust it if so.
  let haveDisplay = Boolean(baseEnv.DISPLAY);
  if (haveDisplay) {
    const socketPath = socketPathForDisplay(baseEnv.DISPLAY!);
    if (socketPath && !probes.existsSync(socketPath)) {
      const activeSeats = probes.activeSeatDisplays?.() ?? [];
      if (activeSeats.includes(baseEnv.DISPLAY!)) {
        // Genuinely live real seat, just socket-file-less (EI-8289) — trust it.
      } else {
        warnings.push(
          `stale DISPLAY=${baseEnv.DISPLAY} — no X socket at ${socketPath} and it is not a ` +
            'currently logged-in seat (who); re-resolving instead of trusting the inherited ' +
            'value (WI-2840/EI-8289)',
        );
        haveDisplay = false;
      }
    }
  }
  if (!haveDisplay) {
    // EI-8289: prefer the OWNER's real active login seat (who) over a blind
    // /tmp/.X11-unix socket scan. A sandbox/frame Xvfb (leased per hive/bee, or
    // the hive-frame-desktops pool) ALWAYS creates a socket file; a real
    // XWayland seat frequently does NOT — so scanning sockets alone silently
    // prefers the virtual display over the owner's real one. Only fall back to
    // the socket scan when no real seat is detected at all.
    const activeSeats = probes.activeSeatDisplays?.() ?? [];
    if (activeSeats.length > 0) {
      env.DISPLAY = activeSeats[0]!;
      resolvedVia = 'active-seat';
    } else {
      let sockets: string[] = [];
      try {
        sockets = probes
          .readdirSync('/tmp/.X11-unix')
          .filter((n) => /^X\d+$/.test(n))
          .sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
      } catch {
        sockets = [];
      }
      if (sockets.length === 0) {
        return {
          env: {},
          resolved: false,
          error:
            (warnings.length ? `${warnings.join('; ')}; and ` : '') +
            'no X display: the operator has no DISPLAY and no X socket exists under /tmp/.X11-unix — ' +
            'a desktop terminal cannot open on this host (headless?). Launch from a desktop session, ' +
            'or run the command yourself in a terminal on the machine with the display. (WI-1886)',
          warnings,
          resolvedVia: null,
        };
      }
      env.DISPLAY = `:${sockets[0]!.slice(1)}`;
      resolvedVia = 'socket-scan';
      warnings.push(
        `no active login seat detected (who) — falling back to a raw X11 socket scan, which ` +
          `found DISPLAY=${env.DISPLAY}; this MAY be a virtual/sandbox display rather than the ` +
          'owner\'s real desktop (EI-8289). Verify who is actually watching if terminals opened ' +
          'this way are reported invisible.',
      );
    }
  }

  const runtimeDir = `/run/user/${probes.uid}`;
  if (!baseEnv.DBUS_SESSION_BUS_ADDRESS && probes.existsSync(`${runtimeDir}/bus`)) {
    env.DBUS_SESSION_BUS_ADDRESS = `unix:path=${runtimeDir}/bus`;
  }
  if (!baseEnv.XDG_RUNTIME_DIR && probes.existsSync(runtimeDir)) {
    env.XDG_RUNTIME_DIR = runtimeDir;
  }

  // XAUTHORITY: same validate-before-trust — a set-but-vanished cookie file
  // (WI-2840) is treated as unset and re-resolved from the usual candidates.
  let haveXauth = Boolean(baseEnv.XAUTHORITY);
  if (haveXauth && !probes.existsSync(baseEnv.XAUTHORITY!)) {
    warnings.push(
      `stale XAUTHORITY=${baseEnv.XAUTHORITY} — file no longer exists; ` +
        're-resolving instead of trusting the inherited value (WI-2840)',
    );
    haveXauth = false;
  }
  if (!haveXauth) {
    const candidates = [`${runtimeDir}/gdm/Xauthority`, `${probes.home}/.Xauthority`];
    const found = candidates.find((p) => probes.existsSync(p));
    if (found) env.XAUTHORITY = found;
  }
  return { env, resolved: true, error: null, warnings, resolvedVia };
}

/**
 * Classify a terminal child's early exit (within {@link EARLY_EXIT_PROBE_MS}).
 * Pure; exported for unit tests.
 *
 * - nonzero exit / signal death ⇒ ALWAYS a failure (the client refused to run —
 *   classically "Cannot open display" / a dbus connect failure).
 * - zero exit ⇒ a failure ONLY under `--wait` semantics (gnome-terminal --wait
 *   keeps the client alive for the WINDOW's lifetime, so an instant clean exit
 *   means no window survived). Other emulators' clients may legitimately exit 0
 *   fast (konsole reusing an existing app instance) — not a failure signal.
 */
export function classifyEarlyExit(
  termArgs: string[],
  code: number | null,
  signal: string | null,
): { failed: boolean; why: string | null } {
  if (signal) return { failed: true, why: `killed by ${signal}` };
  if (code !== null && code !== 0) return { failed: true, why: `exit code ${code}` };
  if (code === 0 && termArgs.includes('--wait')) {
    return { failed: true, why: 'exited 0 instantly under --wait (no window survived)' };
  }
  return { failed: false, why: null };
}

/** Watch a spawned child for an early exit; resolves null when it outlives the probe. */
function watchEarlyExit(
  child: ChildProcess,
  probeMs: number,
): Promise<{ code: number | null; signal: string | null } | null> {
  return new Promise((resolvePromise) => {
    const timer = setTimeout(() => {
      child.removeListener('exit', onExit);
      resolvePromise(null);
    }, probeMs);
    timer.unref?.();
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      clearTimeout(timer);
      resolvePromise({ code, signal });
    };
    child.once('exit', onExit);
  });
}

// ─── The spawn primitive ─────────────────────────────────────────────

export interface SpawnConsoleOpts {
  /** Envelope from `buildConsoleEnvelope` (cwd, env, greetingCmd, mcpJson…). */
  envelope: ConsoleEnvelope;
  /** Plan slug used for the per-plan window color + adv-session grouping. */
  planSlug?: string | null;
  /** Display label for the window title / adv-sessions list. */
  label?: string | null;
  /** Window-color/title mode. Default 'console'. */
  appearanceMode?: 'omp' | 'console';
  /** A bound fleet color scheme — overrides the per-plan hash for this window. */
  scheme?: ColorScheme | null;
  /**
   * WI-3114: injectable desktop-env probes for the Linux path, threaded to
   * resolveLinuxDesktopEnv. Tests MUST pass fakes — the default (real) probes
   * read the live /tmp/.X11-unix, so a test that stubs DISPLAY without
   * controlling the socket check flakes with the box's X state (the WI-2840
   * stale-DISPLAY warn tripped vitest-fail-on-console when the /tmp wipe
   * removed X99). Production callers omit it.
   */
  desktopEnvProbes?: DesktopEnvProbes;
  /**
   * Displace (back up + write) the envelope's superuser `.mcp.json` into the
   * cwd before spawning. The superuser console wants this so the user's agent
   * auto-discovers the MCP door; capability:terminal (run-a-command) does NOT —
   * it should not surprise the user by rewriting their project's .mcp.json.
   * Default false. A no-op when `envelope.mcpJsonContents` is empty.
   */
  writeMcpJson?: boolean;
}

export type SpawnConsoleResult =
  | {
      status: 'ok';
      pid: number | null;
      terminal: string;
      child: ChildProcess;
      /**
       * EI-8289: the DISPLAY the window actually opened on (Linux only; null on
       * macOS, which has no X DISPLAY concept). Callers (capability:terminal,
       * fleet:launch-on-plan) MUST surface this — a window reported as "opened"
       * on a virtual/sandbox display the owner isn't watching is a silent
       * failure of the "visible desktop terminal" contract otherwise.
       */
      display: string | null;
      /**
       * EI-8289: how `display` was resolved — 'operator-env'/'active-seat' are
       * the owner's real desktop; 'socket-scan' means NO real logged-in seat
       * was found and a raw X11 socket won by default, which MAY be a
       * virtual/sandbox display (a leased Xvfb) rather than the owner's real
       * one. null on macOS. Callers should flag 'socket-scan' loudly.
       */
      desktopEnvResolvedVia: 'operator-env' | 'active-seat' | 'socket-scan' | null;
    }
  | { status: 'error'; error: string; code: number };

/**
 * Open a NEW native terminal window running the envelope's one-liner.
 *
 * Returns the spawned `child` so the caller can attach its own exit watcher /
 * adv-session bookkeeping. The child is already `unref()`'d (it outlives this
 * process). Linux-only — see the module header for the macOS/Windows boundary.
 *
 * ASYNC since WI-1886: the Linux path now resolves missing desktop env before
 * spawning and watches the child for {@link EARLY_EXIT_PROBE_MS} — an
 * `ok + pid` return now actually means a window survived the probe, never a
 * client that died off-screen.
 */
export async function spawnConsole(opts: SpawnConsoleOpts): Promise<SpawnConsoleResult> {
  const { envelope } = opts;

  // 1. Optional .mcp.json displacement (backup the user's, write ours).
  if ((opts.writeMcpJson ?? false) && envelope.mcpJsonContents) {
    try {
      const mcpPath = join(envelope.cwd, '.mcp.json');
      if (existsSync(mcpPath)) {
        const bak = join(envelope.cwd, '.mcp.json.papercusp.bak');
        if (!existsSync(bak)) renameSync(mcpPath, bak);
      }
      writeFileSync(mcpPath, envelope.mcpJsonContents);
    } catch (e: any) {
      return { status: 'error', error: `write .mcp.json: ${e?.message}`, code: 500 };
    }
  }

  // 2. Build the one-liner once (appearance/OSC colors + cd + env + sentinel +
  //    greeting + exec login shell). Same shape on every OS.
  const oneliner = buildConsoleOneliner(envelope.cwd, envelope.env, envelope.greetingCmd, {
    mode: opts.appearanceMode ?? 'console',
    planSlug: opts.planSlug ?? null,
    label: opts.label ?? null,
    scheme: opts.scheme ?? null,
  });

  // 3. macOS: the operator is a child of the desktop .app in the user's GUI
  //    session, so it can open a Terminal window itself — mirroring the Linux
  //    child_process path (no webview/Tauri round-trip). Fleet color schemes
  //    work here for free because the OSC prelude is already in the one-liner.
  if (process.platform === 'darwin') {
    return spawnMacConsole(envelope, oneliner);
  }

  // 4. Windows has no server-side path: the operator runs inside the WSL2 distro,
  //    so `process.platform` is 'linux' (NOT 'win32') — the ONLY reliable Windows
  //    signal is isWindowsDesktopHost() (WSL2 /proc/version check). A window the
  //    WSL operator spawns lands in Session 0 (invisible to the interactive
  //    desktop, per D-002); so on Windows we MUST defer to the desktop shell's
  //    Tauri `console_launch` command (spawn_windows_wsl_new_window, which spawns
  //    the Session-1 wt.exe titled `Papercup — <id>`). Return 501 so the renderer
  //    falls through to that path. WI-1882: without the isWindowsDesktopHost()
  //    clause this fell into the Linux cascade below and died with "no terminal
  //    emulator found" because process.platform==='linux' in WSL.
  if (process.platform !== 'linux' || isWindowsDesktopHost()) {
    return {
      status: 'error',
      error:
        'server-side spawn implemented for Linux + macOS; Windows (WSL2 operator) uses the Tauri console_launch path',
      code: 501,
    };
  }

  // 5. Linux: pick a terminal emulator from the cascade.
  const term = findLinuxTerminal();
  if (!term) {
    return {
      status: 'error',
      error:
        'no terminal emulator found. Set $TERMINAL or install gnome-terminal / konsole / alacritty / kitty / wezterm / xterm',
      code: 500,
    };
  }

  // 6. WI-1886(a): the operator often runs headless (systemd user service) —
  //    resolve the interactive session's desktop env and inject it; with no
  //    display resolvable, fail LOUD before spawning a client that would ghost.
  const desktop = resolveLinuxDesktopEnv(process.env, opts.desktopEnvProbes);
  if (!desktop.resolved) {
    return { status: 'error', error: desktop.error ?? 'no X display (WI-1886)', code: 412 };
  }
  if (desktop.warnings.length > 0) {
    // WI-2840: healed a stale inherited DISPLAY/XAUTHORITY — this is exactly
    // the "long-lived process env poisoned" symptom the ticket was filed
    // from. Log loudly (visible in the systemd journal for a service-managed
    // operator) so a recurrence has a named cause instead of a silent wedge.
    console.warn(`[console-spawn] ${desktop.warnings.join('; ')}`);
  }

  // 7. Spawn a new window running the one-liner; detach so closing the
  //    operator doesn't kill the user's terminal. Stderr goes to a temp FILE
  //    (not a pipe: no backpressure/EPIPE risk on a long-lived window) so the
  //    early-exit probe can surface the client's actual complaint.
  const childArgs = [...term.args, 'bash', '-lc', oneliner];
  const stderrPath = join(tmpdir(), `papercup-console-stderr-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}.log`);
  let stderrFd: number | null = null;
  try {
    stderrFd = openSync(stderrPath, 'w');
  } catch {
    stderrFd = null;
  }
  try {
    const child = spawn(term.bin, childArgs, {
      detached: true,
      stdio: ['ignore', 'ignore', stderrFd ?? 'ignore'],
      cwd: envelope.cwd,
      env: { ...process.env, ...desktop.env, ...envelope.env },
    });
    child.unref();
    if (stderrFd != null) {
      closeSync(stderrFd); // the child holds its own dup
      stderrFd = null;
    }

    // WI-1886(b): a client that dies inside the probe window never opened a
    // window — report the failure (with its stderr) instead of ok+pid.
    const earlyExit = await watchEarlyExit(child, EARLY_EXIT_PROBE_MS);
    let stderrText = '';
    try {
      stderrText = readFileSync(stderrPath, 'utf8').trim().slice(0, 800);
    } catch {
      stderrText = '';
    }
    if (earlyExit) {
      const verdict = classifyEarlyExit(term.args, earlyExit.code, earlyExit.signal);
      if (verdict.failed) {
        try {
          unlinkSync(stderrPath);
        } catch { /* best-effort */ }
        return {
          status: 'error',
          error:
            `${term.bin} died ${verdict.why} within ${EARLY_EXIT_PROBE_MS}ms — no window opened` +
            `${stderrText ? `: ${stderrText}` : ''} (WI-1886: was the operator headless / display unreachable?)`,
          code: 502,
        };
      }
    }
    try {
      unlinkSync(stderrPath); // window survived (fd stays valid for the child on Linux)
    } catch { /* best-effort */ }
    // EI-8289: report the DISPLAY the window actually opened on (its own env
    // if it already had one, else whatever we resolved/injected) so a virtual-
    // placement window is disclosed to the caller, never silent.
    return {
      status: 'ok',
      pid: child.pid ?? null,
      terminal: term.bin,
      child,
      display: desktop.env.DISPLAY ?? process.env.DISPLAY ?? null,
      desktopEnvResolvedVia: desktop.resolvedVia,
    };
  } catch (e: any) {
    if (stderrFd != null) {
      try {
        closeSync(stderrFd);
      } catch { /* already closed */ }
    }
    try {
      unlinkSync(stderrPath);
    } catch { /* best-effort */ }
    return { status: 'error', error: `spawn ${term.bin} failed: ${e?.message}`, code: 500 };
  }
}

/**
 * macOS spawner — mirrors native_console.rs `spawn_macos_new_window`: write a
 * one-shot, self-deleting `.command` file (chmod 755) and `open -na <term>` it.
 * `open -na` forces a FRESH app instance ⇒ a new window every time (Terminal's
 * AppleScript do-script would reuse the frontmost window). iTerm wins when
 * installed, else Terminal.app. The `.command` execs the same login-shell
 * one-liner the Linux path runs, so colors/env/sentinel behave identically.
 */
function spawnMacConsole(envelope: ConsoleEnvelope, oneliner: string): SpawnConsoleResult {
  try {
    const inv = macConsoleInvocation(oneliner, {
      tmpDir: process.env.TMPDIR || '/tmp',
      nowMs: Date.now(),
      pid: process.pid,
      hasITerm: existsSync('/Applications/iTerm.app'),
    });
    writeFileSync(inv.file, inv.content, { mode: 0o755 });
    const child = spawn('open', inv.openArgs, {
      detached: true,
      stdio: 'ignore',
      cwd: envelope.cwd,
      env: { ...process.env, ...envelope.env },
    });
    child.unref();
    // macOS has no X DISPLAY concept — display/desktopEnvResolvedVia are always
    // null here (the EI-8289 disclosure only applies to the Linux X11 path).
    return { status: 'ok', pid: child.pid ?? null, terminal: inv.term, child, display: null, desktopEnvResolvedVia: null };
  } catch (e: any) {
    return { status: 'error', error: `open Terminal failed: ${e?.message}`, code: 500 };
  }
}

/**
 * Pure builder for the macOS `open` invocation — the one-shot `.command` path,
 * its contents (self-deleting; execs the login-shell one-liner), the chosen
 * terminal app, and the `open` argv. Side-effect-free so it can be unit-tested
 * without spawning. Exported for tests.
 */
export function macConsoleInvocation(
  oneliner: string,
  opts: { tmpDir: string; nowMs: number; pid: number; hasITerm: boolean },
): { file: string; content: string; term: string; openArgs: string[] } {
  const term = opts.hasITerm ? 'iTerm.app' : 'Terminal.app';
  const file = join(opts.tmpDir, `papercup-console-${opts.pid}-${opts.nowMs}.command`);
  // `rm -f "$0"` self-deletes the launcher before exec so /tmp doesn't accrete
  // one-shot files; exec replaces the process with our login-shell one-liner.
  const content = `#!/bin/bash\nrm -f "$0"\nexec bash -lc ${shellEscape(oneliner)}\n`;
  return { file, content, term, openArgs: ['-na', term, file] };
}
