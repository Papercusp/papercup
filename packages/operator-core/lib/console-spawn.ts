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
 * Linux-only at this tier (matches the route's historical boundary): on
 * macOS/Windows the desktop shell spawns the terminal Rust-side via the Tauri
 * `console_launch` command (papercusp-desktop/src-tauri/src/native_console.rs),
 * which a server-side caller cannot reach. {@link spawnConsole} returns a
 * `code:501` error there so a caller can surface an actionable message.
 *
 * Server-only.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';

import type { ConsoleEnvelope } from './console-launcher';
import type { ColorScheme } from './console-color-schemes';

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
   * Displace (back up + write) the envelope's superuser `.mcp.json` into the
   * cwd before spawning. The superuser console wants this so the user's agent
   * auto-discovers the MCP door; capability:terminal (run-a-command) does NOT —
   * it should not surprise the user by rewriting their project's .mcp.json.
   * Default false. A no-op when `envelope.mcpJsonContents` is empty.
   */
  writeMcpJson?: boolean;
}

export type SpawnConsoleResult =
  | { status: 'ok'; pid: number | null; terminal: string; child: ChildProcess }
  | { status: 'error'; error: string; code: number };

/**
 * Open a NEW native terminal window running the envelope's one-liner.
 *
 * Returns the spawned `child` so the caller can attach its own exit watcher /
 * adv-session bookkeeping. The child is already `unref()`'d (it outlives this
 * process). Linux-only — see the module header for the macOS/Windows boundary.
 */
export function spawnConsole(opts: SpawnConsoleOpts): SpawnConsoleResult {
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

  // 2. Platform gate. macOS/Windows go through the Tauri command instead.
  if (process.platform !== 'linux') {
    return {
      status: 'error',
      error: 'server-side spawn only implemented for Linux; use the Tauri path on macOS/Windows',
      code: 501,
    };
  }

  // 3. Pick a terminal emulator.
  const term = findLinuxTerminal();
  if (!term) {
    return {
      status: 'error',
      error:
        'no terminal emulator found. Set $TERMINAL or install gnome-terminal / konsole / alacritty / kitty / wezterm / xterm',
      code: 500,
    };
  }

  // 4. Spawn a new window running the one-liner; detach so closing the
  //    operator doesn't kill the user's terminal.
  const oneliner = buildConsoleOneliner(envelope.cwd, envelope.env, envelope.greetingCmd, {
    mode: opts.appearanceMode ?? 'console',
    planSlug: opts.planSlug ?? null,
    label: opts.label ?? null,
    scheme: opts.scheme ?? null,
  });
  const childArgs = [...term.args, 'bash', '-lc', oneliner];
  try {
    const child = spawn(term.bin, childArgs, {
      detached: true,
      stdio: 'ignore',
      cwd: envelope.cwd,
      env: { ...process.env, ...envelope.env },
    });
    child.unref();
    return { status: 'ok', pid: child.pid ?? null, terminal: term.bin, child };
  } catch (e: any) {
    return { status: 'error', error: `spawn ${term.bin} failed: ${e?.message}`, code: 500 };
  }
}
