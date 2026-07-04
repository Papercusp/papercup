/**
 * Detect absolute paths of the coding-agent CLIs on the host.
 *
 * Used by the agent-config route (UI) and the setup-wizard pty route
 * (so PTY children get an absolute path — the Tauri pty spawn does NOT
 * inherit the parent process env, so a bare `claude` / `omp` resolves
 * to nothing in /usr/bin:/bin).
 */
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

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

async function whichAsync(bin: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('which', [bin]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/** Synchronous detection — 4 back-to-back `which` spawns. Kept for callers that
 *  are already sync (agent-config UI, setup-wizard pty route). */
export function detectBinaries(): DetectedBinaries {
  return { claude: which('claude'), codex: which('codex'), omp: which('omp'), pi: which('pi') };
}

/** Parallel async detection: the 4 `which` lookups run CONCURRENTLY instead of
 *  serially (the sync path blocks on 4 back-to-back spawnSync — a measurable chunk
 *  of the tutorial-script endpoint's first-paint latency). */
export async function detectBinariesAsync(): Promise<DetectedBinaries> {
  const [claude, codex, omp, pi] = await Promise.all([
    whichAsync('claude'),
    whichAsync('codex'),
    whichAsync('omp'),
    whichAsync('pi'),
  ]);
  return { claude, codex, omp, pi };
}

/** Short-TTL process memo for hot read paths (the tutorial-script endpoint
 *  re-detects on every launch). The setup-wizard's fresh-detection polling keeps
 *  using the uncached `detectBinaries`/`detectBinariesAsync`, so the TTL is a
 *  safety net, not a correctness contract. */
let binCache: { at: number; bins: DetectedBinaries } | null = null;
export async function detectBinariesCached(ttlMs = 30_000): Promise<DetectedBinaries> {
  const now = Date.now();
  if (binCache && now - binCache.at < ttlMs) return binCache.bins;
  const bins = await detectBinariesAsync();
  binCache = { at: now, bins };
  return bins;
}
