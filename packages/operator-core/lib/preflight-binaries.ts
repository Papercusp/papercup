/**
 * Shared probes for `claude` and `omp` binaries used by both
 * `/api/desktop/preflight` and `/api/desktop/setup-status`. The wizard
 * sidebar status (from setup-status) must agree with the StepAgents
 * card (from preflight) — keep the fallback paths in one place.
 */
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

async function tryProbe(path: string, timeoutMs = 3000): Promise<boolean> {
  try {
    await exec(path, ['--version'], { timeout: timeoutMs });
    return true;
  } catch {
    return false;
  }
}

export async function detectClaude(): Promise<boolean> {
  if (await tryProbe('claude')) return true;
  // Desktop bundle: claude ships under meridian-host/node_modules/.bin.
  const candidates = [
    `${process.cwd()}/meridian-host/node_modules/.bin/claude`,
    `${process.cwd()}/../meridian-host/node_modules/.bin/claude`,
    `${process.env.HOME ?? ''}/.papercusp/runtime/node_modules/.bin/claude`,
    `${process.env.HOME ?? ''}/.claude/bin/claude`,
  ].filter(Boolean);
  for (const path of candidates) {
    if (existsSync(path) && (await tryProbe(path))) return true;
  }
  return false;
}

export async function detectOmp(): Promise<boolean> {
  if (await tryProbe('omp')) return true;
  // GUI app launches on macOS often miss the user's login-shell PATH;
  // also covers Tauri sidecar/bin and common manual install locations.
  const bundledOmp = process.cwd() ? `${process.cwd()}/bin/omp` : '';
  const candidates = [
    bundledOmp,
    `${bundledOmp}.exe`,
    '/usr/local/bin/omp',
    '/opt/homebrew/bin/omp',
    `${process.env.HOME ?? ''}/.cargo/bin/omp`,
    `${process.env.HOME ?? ''}/.local/bin/omp`,
    `${process.env.HOME ?? ''}/.bun/bin/omp`,
    `${process.env.HOME ?? ''}/.papercusp/runtime/node_modules/.bin/omp`,
  ].filter(Boolean);
  for (const path of candidates) {
    if (existsSync(path) && (await tryProbe(path))) return true;
  }
  return false;
}

/**
 * Detect whether Meridian is *installed* (package present), not
 * whether it's currently running. The Setup Wizard treats "installed"
 * as setup-complete — the desktop app spawns the daemon on boot, so a
 * fresh install shows ready without forcing a restart first.
 *
 * `/api/desktop/preflight` keeps its own port-reachability check for
 * "usable right now"; the two endpoints answer different questions.
 */
export function detectMeridianInstalled(): boolean {
  const home = process.env.HOME ?? '';
  const candidates = [
    `${home}/.papercusp/runtime/node_modules/@rynfar/meridian/package.json`,
    `${process.cwd()}/meridian-host/node_modules/@rynfar/meridian/package.json`,
    `${process.cwd()}/../meridian-host/node_modules/@rynfar/meridian/package.json`,
  ].filter(Boolean);
  return candidates.some((p) => existsSync(p));
}
