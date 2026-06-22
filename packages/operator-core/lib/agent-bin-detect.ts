/**
 * Detect absolute paths of the coding-agent CLIs on the host.
 *
 * Used by the agent-config route (UI) and the setup-wizard pty route
 * (so PTY children get an absolute path — the Tauri pty spawn does NOT
 * inherit the parent process env, so a bare `claude` / `omp` resolves
 * to nothing in /usr/bin:/bin).
 */
import { spawnSync } from 'node:child_process';

export interface DetectedBinaries {
  claude: string | null;
  codex: string | null;
  omp: string | null;
  pi: string | null;
}

function which(bin: string): string | null {
  const r = spawnSync('which', [bin], { encoding: 'utf8' });
  return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : null;
}

export function detectBinaries(): DetectedBinaries {
  return { claude: which('claude'), codex: which('codex'), omp: which('omp'), pi: which('pi') };
}
