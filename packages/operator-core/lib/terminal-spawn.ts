/**
 * terminal-spawn — shared OS-terminal spawn helper for the operator host.
 *
 * The operator opens OS-native terminals server-side on Linux (the operator
 * sidecar runs in the desktop's GUI session, so a detached spawn here opens a
 * window on the user's display). This module is the single home for the
 * terminal-emulator discovery + spawn that was previously duplicated across
 * `console-launch.ts` and `launch-su.ts`. New launchers (e.g. `launch-pui.ts`)
 * build a `bash -lc` one-liner and hand it to {@link spawnInTerminal}.
 *
 * Linux-only — callers gate on `process.platform === 'linux'` and return 501
 * before reaching here on other platforms (mirrors console-launch.ts).
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { standardToolDirs } from './tool-path';

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
  | { ok: true; terminal: string; pid: number | undefined; likelyOpened: boolean }
  | { ok: false; code: 'no_terminal' | 'spawn_failed'; error: string };

export const DEFAULT_LIVENESS_CHECK_DELAY_MS = 400;

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
      stdio: 'ignore',
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
      env: opts.env ?? process.env,
    });
    child.unref();
    const pid = child.pid;
    let likelyOpened = true;
    const delayMs = opts.livenessCheckDelayMs ?? DEFAULT_LIVENESS_CHECK_DELAY_MS;
    if (pid != null && delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      likelyOpened = isProcessAlive(pid);
    }
    return { ok: true, terminal: term.bin, pid, likelyOpened };
  } catch (e: any) {
    return { ok: false, code: 'spawn_failed', error: `spawn ${term.bin} failed: ${e?.message}` };
  }
}
