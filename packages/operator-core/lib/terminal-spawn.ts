/**
 * terminal-spawn — shared OS-terminal spawn helper for the operator host.
 *
 * The operator opens OS-native terminals server-side on Linux (the operator
 * sidecar runs in the desktop's GUI session, so a detached spawn here opens a
 * window on the user's display). This module holds the terminal-emulator
 * discovery + spawn that was previously duplicated across `console-launch.ts`
 * and `launch-su.ts`. New launchers (e.g. `launch-pui.ts`) build a `bash -lc`
 * one-liner and hand it to {@link spawnInTerminal}.
 *
 * ⚠ It is NOT the only such spawner, despite what this comment used to claim.
 * `console-spawn.ts` keeps its own LINUX_TERMINALS table, its own findTerminal
 * and its own spawn (it carries extra session-bus / display-override /
 * desktop-detection logic), and it serves the busier callers —
 * `capability:terminal` and every VISIBLE `fleet:launch-on-plan` member. That
 * stale "single home" wording is exactly why the EI-19385011811175105 fix landed
 * here and missed there (EI-19407722209410974). A fix to spawn BEHAVIOUR must be
 * applied to both until they are actually merged; grep the SYMPTOM
 * (`gnome-terminal`) rather than this module's callers.
 *
 * Linux-only — callers gate on `process.platform === 'linux'` and return 501
 * before reaching here on other platforms (mirrors console-launch.ts).
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { standardToolDirs } from './tool-path';
import { createTextCollector } from './child-output';

/**
 * Terminal emulators tried in order, each with the args that run a command in
 * a new window. Kept in sync with the list `console-launch.ts` documents.
 */
export const LINUX_TERMINALS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['gnome-terminal', ['--wait', '--window', '--']],
  ['konsole', ['--new-window', '-e']],
  ['xfce4-terminal', ['--window', '-e']],
  ['alacritty', ['-e']],
  ['kitty', ['--']],
  ['wezterm', ['start', '--always-new-process', '--']],
  ['xterm', ['-e']],
];

/**
 * Is `bin` an executable reachable on PATH (plus the usual install dirs)?
 * Probes PATH + the canonical {@link standardToolDirs} (incl. /opt/homebrew/bin
 * for Apple-Silicon Homebrew, /usr/local/bin, ~/.local/bin) — NOT ~/.cargo/bin.
 * Callers that resolve a cargo-installed binary (pui, zellij) must check
 * `~/.cargo/bin` explicitly (see launch-pui.ts).
 */
export function isOnPath(bin: string): boolean {
  const paths = (process.env.PATH ?? '').split(':');
  paths.push(...standardToolDirs());
  return paths.some((p) => p && existsSync(join(p, bin)));
}

/** A resolved terminal emulator + the args to run a command in a new window. */
export interface ResolvedTerminal {
  bin: string;
  args: string[];
}

/**
 * Resolve the terminal emulator to use: honour `$TERMINAL` if it's on PATH,
 * else fall back through {@link LINUX_TERMINALS}. Returns null if none found.
 */
export function findTerminal(): ResolvedTerminal | null {
  const fromEnv = process.env.TERMINAL;
  if (fromEnv && isOnPath(fromEnv)) {
    return fromEnv === 'gnome-terminal'
      ? { bin: fromEnv, args: ['--wait', '--'] }
      : { bin: fromEnv, args: ['-e'] };
  }
  for (const [bin, args] of LINUX_TERMINALS) {
    if (isOnPath(bin)) return { bin, args: [...args] };
  }
  return null;
}

/** POSIX single-quote escape — wrap `s` so the shell sees it as one literal. */
export function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * Env vars that IDENTIFY the terminal (or multiplexer) the OPERATOR ITSELF was
 * started in. A launch's terminal identity is RE-DERIVED, NEVER INHERITED —
 * the same rule launch-su already applies to `PAPERCUSP_OPERATOR_URL`.
 *
 * The one that bites (EI-19385011811175105, owner-reported 2026-08-02): the
 * desktop's operator sidecar is started by `npm run dev` inside a gnome-terminal
 * tab, so its env carries that tab's own
 * `GNOME_TERMINAL_SCREEN=/org/gnome/Terminal/screen/<uuid>`. gnome-terminal reads
 * it as "open the new window RELATIVE TO THIS SCREEN" and asks the factory for it
 * over D-Bus; the originating tab is long gone, so the call fails with
 *
 *     # Error creating terminal: Failed to get screen from object path /org/gnome/Terminal/screen/<uuid>
 *
 * and the client EXITS 0 having opened nothing. Exit code 0 makes the failure
 * invisible to any status check — which is why the stderr capture below exists
 * too. Measured live against the running sidecar's real env: baseline → no
 * window; minus `GNOME_TERMINAL_SCREEN` (or minus `GNOME_TERMINAL_SERVICE`) →
 * window opens. Downstream this rendered as "This session's launch failed — its
 * terminal closed before the session came online. Try launching it again.", advice
 * that could not possibly work because every retry failed identically.
 *
 * The rest are the exact analogues on the other emulators, plus the multiplexer
 * vars — we are opening a BRAND-NEW WINDOW, so a psu that believes it is still
 * inside the operator's tmux/zellij pane is wrong in the same way.
 */
export const TERMINAL_CONTEXT_ENV_KEYS: readonly string[] = [
  // GNOME / VTE
  'GNOME_TERMINAL_SCREEN',
  'GNOME_TERMINAL_SERVICE',
  'VTE_VERSION',
  // KDE
  'KONSOLE_DBUS_SERVICE',
  'KONSOLE_DBUS_SESSION',
  'KONSOLE_DBUS_WINDOW',
  'KONSOLE_PROFILE_NAME',
  // others
  'ALACRITTY_SOCKET',
  'ALACRITTY_WINDOW_ID',
  'WEZTERM_PANE',
  'WEZTERM_UNIX_SOCKET',
  'ITERM_SESSION_ID',
  'TERM_SESSION_ID',
  'TERMINATOR_UUID',
  'TILIX_ID',
  'WINDOWID',
  // multiplexers
  'TMUX',
  'TMUX_PANE',
  'ZELLIJ',
  'ZELLIJ_SESSION_NAME',
  'ZELLIJ_PANE_ID',
  'STY',
];

/** `env` minus {@link TERMINAL_CONTEXT_ENV_KEYS}. Pure — returns a copy. */
export function scrubTerminalContextEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out = { ...env };
  for (const k of TERMINAL_CONTEXT_ENV_KEYS) delete out[k];
  return out;
}

export interface SpawnInTerminalOpts {
  /** Shell one-liner run inside `bash -lc` in the new terminal window. */
  oneliner: string;
  /** Env for the spawned terminal (defaults to the operator host's env). */
  env?: NodeJS.ProcessEnv;
  /** Working directory for the spawned terminal (defaults to the host's cwd). */
  cwd?: string;
  /**
   * Silent-launch-failure detector (EI-18696184925888288): after the OS spawn
   * call returns, wait this many ms then re-check whether the spawned process
   * is still alive. A terminal client can hand off to a long-lived singleton
   * server and exit almost immediately even when NO window ever actually
   * opened (repro'd live: `gnome-terminal --wait` against a headless/offscreen
   * Xvfb display exits right away instead of blocking on the command it was
   * asked to run) — before this check, that produced a confident-looking
   * `{ok:true, terminal, pid}` with no signal that nothing was actually
   * launched. 0 disables the check. Default 400ms.
   */
  livenessCheckDelayMs?: number;
}

export type SpawnInTerminalResult =
  | {
      ok: true;
      terminal: string;
      pid: number | undefined;
      likelyOpened: boolean;
      /**
       * What the emulator printed to stderr before it died, when it died — the
       * ONLY evidence available for a silent failure, since gnome-terminal exits
       * 0 on one (see TERMINAL_CONTEXT_ENV_KEYS). Set only alongside
       * `likelyOpened:false`, so callers can name the cause instead of reporting
       * a bare "the terminal closed".
       */
      stderr?: string;
    }
  | { ok: false; code: 'no_terminal' | 'spawn_failed'; error: string };

export const DEFAULT_LIVENESS_CHECK_DELAY_MS = 400;

/** Max chars of emulator stderr kept — enough for a startup complaint, not a log. */
export const STDERR_CAPTURE_LIMIT = 1000;

/** Whether `pid` is still alive right now — a best-effort `kill(pid, 0)` probe
 *  (throws ESRCH-class errors for a dead/foreign-namespace pid, never actually
 *  sends a signal). Exported for reuse/testing. */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve a terminal and spawn it detached, running `bash -lc <oneliner>`.
 * A login shell (`-l`) is used so the user's profile (cargo PATH etc.) is in
 * scope for whatever the one-liner exec's. The child is `unref`'d so it
 * outlives the request.
 *
 * After a successful spawn, briefly re-checks the child's liveness (see
 * `livenessCheckDelayMs` above) and reports it as `likelyOpened` — callers
 * should surface a warning rather than a flat success when it comes back
 * false, since the spawn syscall not throwing is NOT proof a window opened.
 */
export async function spawnInTerminal(opts: SpawnInTerminalOpts): Promise<SpawnInTerminalResult> {
  const term = findTerminal();
  if (!term) {
    return {
      ok: false,
      code: 'no_terminal',
      error:
        'no terminal emulator found. Set $TERMINAL or install gnome-terminal / konsole / alacritty / kitty / wezterm / xterm',
    };
  }
  try {
    const child = spawn(term.bin, [...term.args, 'bash', '-lc', opts.oneliner], {
      detached: true,
      // stderr is PIPED, not ignored: a silent launch failure exits 0 (see
      // TERMINAL_CONTEXT_ENV_KEYS), so the diagnostic line is the only evidence
      // there is, and `stdio:'ignore'` threw it away. stdin/stdout stay ignored —
      // the window owns those.
      stdio: ['ignore', 'ignore', 'pipe'],
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
      env: scrubTerminalContextEnv(opts.env ?? process.env),
    });
    child.unref();
    const pid = child.pid;
    // Bounded: we only ever want the first line or two of a startup complaint,
    // and this buffer must not grow with a window that stays open for hours.
    //
    // Decoded through the shared StringDecoder-backed collector, NOT
    // `String(chunk)` (WI-6728): a multi-byte UTF-8 character split across two
    // 'data' events decodes to replacement characters under String(), silently
    // corrupting the text. That matters more here than almost anywhere else —
    // this capture exists precisely because a silent launch failure exits 0, so
    // the diagnostic line it holds is the ONLY evidence there is, and a
    // corrupted one is indistinguishable from a genuinely odd error message.
    //
    // The cap is enforced by DETACHING once saturated rather than by an `if`
    // guard inside the handler: the collector owns its own accumulation, and
    // detaching is also what stops it growing for a window that then stays open
    // for hours (the same thing the liveness branch below does on success).
    child.stderr?.on('error', () => {});
    const stderrOut = createTextCollector(child.stderr);
    child.stderr?.on('data', () => {
      if (stderrOut.bytes >= STDERR_CAPTURE_LIMIT) {
        child.stderr?.removeAllListeners('data');
        child.stderr?.resume();
      }
    });
    let likelyOpened = true;
    const delayMs = opts.livenessCheckDelayMs ?? DEFAULT_LIVENESS_CHECK_DELAY_MS;
    if (pid != null && delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      likelyOpened = isProcessAlive(pid);
    }
    if (likelyOpened) {
      // The window is up and may live for hours. Stop accumulating, but do NOT
      // destroy the pipe — closing the read end of a LIVE child's stderr risks
      // EPIPE/SIGPIPE in the emulator, which would kill the very window we just
      // opened. Drain it instead and unref so it cannot hold the event loop.
      child.stderr?.removeAllListeners('data');
      child.stderr?.resume();
      (child.stderr as unknown as { unref?: () => void })?.unref?.();
    } else {
      // Dead child ⇒ nothing left to receive a broken pipe, so this is safe.
      child.stderr?.destroy();
    }
    const tail = stderrOut.text().trim().slice(0, STDERR_CAPTURE_LIMIT);
    return {
      ok: true,
      terminal: term.bin,
      pid,
      likelyOpened,
      ...(!likelyOpened && tail ? { stderr: tail } : {}),
    };
  } catch (e: any) {
    return { ok: false, code: 'spawn_failed', error: `spawn ${term.bin} failed: ${e?.message}` };
  }
}
