/**
 * tool-path — the ONE canonical list of directories where the user's CLI tools
 * (git, gh, kopia, claude/codex/omp, …) actually live, plus helpers to guarantee
 * they're on a spawned process's PATH.
 *
 * WHY THIS EXISTS (found 2026-06-25 via an owner Mac-VM "Papercusp setup failed"):
 * a packaged macOS GUI app is launched by launchd with a MINIMAL PATH
 * (`/usr/bin:/bin:/usr/sbin:/sbin`) — it does NOT inherit the user's shell PATH.
 * On Apple-Silicon Macs, Homebrew installs to **`/opt/homebrew/bin`**, which is
 * on NEITHER the launchd PATH nor the old hand-written lists in serve.ts /
 * terminal-spawn.ts. So the dogfood `git clone` (whose git credential helper is
 * `gh`) could not find `gh`/`git` → it failed to authenticate the private repo
 * → the wizard showed a generic "Setting up Papercusp workspace failed". Worse,
 * the DETECTION sites (preflight, agent-auth-detect) already probe
 * `/opt/homebrew/bin`, so the app reported "gh is installed" while the EXECUTION
 * PATH couldn't run it — a maddening "reauth doesn't help" loop.
 *
 * Keep every tool-dir list in the codebase sourced from STANDARD_TOOL_DIRS so
 * detection and execution can never drift apart again.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Standard directories user CLI tools live in, in PATH-priority order. Includes
 * BOTH Homebrew prefixes: `/opt/homebrew` (Apple Silicon) and `/usr/local`
 * (Intel macOS + common Linux), plus the system dirs and `~/.local/bin`. Dirs
 * that don't exist on a given platform are simply inert in PATH — harmless.
 */
export function standardToolDirs(platform: NodeJS.Platform = process.platform): string[] {
  // Order: Homebrew first (so a user's gh/git wins over a stale system shim),
  // then system dirs, then the user-local bin.
  const dirs = [
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/local/sbin',
    '/usr/local/bin',
    '/usr/sbin',
    '/usr/bin',
    '/sbin',
    '/bin',
    join(homedir(), '.local', 'bin'),
  ];
  // Windows manages PATH entirely differently; callers gate on platform, but be
  // defensive and return an empty list so we never inject POSIX dirs there.
  return platform === 'win32' ? [] : dirs;
}

/**
 * Compose the PATH a spawned subprocess should see: an optional bundled
 * sidecar-bin dir FIRST (so shipped binaries win), then the inherited PATH, then
 * the standard tool dirs guaranteed present. De-duplicated, first occurrence
 * wins (so we never reorder what's already there — we only APPEND what's
 * missing). Pure — no env reads — so it is trivially testable.
 */
export function composeToolPath(opts: {
  sidecarBin?: string | undefined;
  currentPath?: string | undefined;
  platform?: NodeJS.Platform;
} = {}): string {
  const platform = opts.platform ?? process.platform;
  const sep = platform === 'win32' ? ';' : ':';
  const parts = [opts.sidecarBin ?? '', opts.currentPath ?? '', ...standardToolDirs(platform)]
    .flatMap((p) => p.split(sep))
    .filter(Boolean);
  return [...new Set(parts)].join(sep);
}

/**
 * Idempotently ensure the standard tool dirs are on `process.env.PATH` for the
 * CURRENT process (and thus every child it spawns). No-op on Windows. Call once,
 * early, in any entrypoint that spawns user CLI tools. Returns the resulting PATH.
 */
export function ensureToolPathEnv(): string {
  if (process.platform === 'win32') return process.env.PATH ?? '';
  const next = composeToolPath({
    sidecarBin: process.env.PAPERCUSP_SIDECAR_BIN,
    currentPath: process.env.PATH,
  });
  process.env.PATH = next;
  return next;
}
