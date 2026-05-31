/**
 * ensure-omp-su.ts — operator-startup helper that drops the engineer
 * bootstrap files (playbook + papercusp-coord extension + token) into the
 * user's home and registers the papercusp-su MCP in OMP, so the /adv
 * "Launch agent" / "Resume" buttons work without the user having to run
 * apps/operator/scripts/install-standalone-mcp.sh by hand.
 *
 * Scope:
 *   - ensure ~/.papercusp/engineer-collaborator.md exists and is fresh
 *   - ensure ~/.papercusp/papercusp-coord.ts exists and is fresh
 *   - ensure ~/.papercusp/superuser-token + su-agent-id exist
 *   - ensure ~/.omp/agent/mcp.json contains `papercusp-su`
 *   - ensure OMP-native Hindsight config is enabled
 *
 * The omp-su WRAPPER is no longer installed here (psu-only-launch P-050) —
 * psu launches raw omp per-launch (playbook + `-e` coord). This helper still
 * ensures the bootstrap files + MCP registration that psu's raw omp depends
 * on. (The name is kept to avoid churning the boot callers.)
 *
 * Idempotent. Safe to re-run. Logs to stderr; never throws.
 */

import { existsSync, mkdirSync, copyFileSync, chmodSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync, execSync } from 'node:child_process';

function dlog(msg: string): void {
  process.stderr.write(`[ensure-omp-su] ${msg}\n`);
}

function isOnPath(bin: string): boolean {
  try {
    execSync(`command -v ${bin}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function setOmpConfig(key: string, value: string): void {
  if (!isOnPath('omp')) return;
  try {
    execFileSync('omp', ['config', 'set', key, value], { stdio: 'ignore' });
    dlog(`OMP config ${key}=${value}`);
  } catch (e) {
    dlog(`OMP config ${key} failed: ${(e as Error).message}`);
  }
}

function ensureOmpHindsightConfig(): void {
  const hindsightUrl =
    process.env.PAPERCUSP_HINDSIGHT_API_URL ??
    process.env.HINDSIGHT_API_URL ??
    'http://localhost:8888';
  setOmpConfig('memory.backend', 'hindsight');
  setOmpConfig('hindsight.apiUrl', hindsightUrl);
  setOmpConfig('hindsight.scoping', 'per-project-tagged');
  setOmpConfig('hindsight.autoRecall', 'true');
  setOmpConfig('hindsight.autoRetain', 'true');
}

/** Resolve the directory `omp` lives in (so the wrapper lands on the
 *  same PATH); fallback to ~/.local/bin. */
function resolveWrapperDir(home = homedir()): string {
  try {
    const ompPath = execSync('command -v omp', { encoding: 'utf8' }).trim();
    if (ompPath) return dirname(ompPath);
  } catch { /* omp not installed yet */ }
  return join(home, '.local', 'bin');
}

export interface EngineerOmpBootstrapState {
  playbookPath: string;
  coordPath: string;
  /** Path a STALE omp-su wrapper would sit at (the wrapper is retired —
   *  reported only so a leftover can be detected/cleaned). */
  wrapperPath: string;
  playbookPresent: boolean;
  coordPresent: boolean;
  /** True if a leftover omp-su wrapper from a pre-retirement install exists. */
  wrapperPresent: boolean;
}

export function readEngineerOmpBootstrapState(home = homedir()): EngineerOmpBootstrapState {
  const playbookPath = join(home, '.papercusp', 'engineer-collaborator.md');
  const coordPath = join(home, '.papercusp', 'papercusp-coord.ts');
  const wrapperPath = join(resolveWrapperDir(home), 'omp-su');
  return {
    playbookPath,
    coordPath,
    wrapperPath,
    playbookPresent: existsSync(playbookPath),
    coordPresent: existsSync(coordPath),
    wrapperPresent: existsSync(wrapperPath),
  };
}

/** Find the operator's source dir so we can copy the playbook + coord
 *  extension from the repo. In a bundled Tauri app these are shipped
 *  as resources; in dev they're at the repo path. Returns null if
 *  neither location resolves. */
function resolveSourceDir(): string | null {
  // process.cwd() is the operator app dir when started via `npm run
  // dev` or via the sidecar. Walk up looking for scripts/install-
  // standalone-mcp.sh as a sentinel.
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    const sentinel = join(dir, 'scripts', 'install-standalone-mcp.sh');
    if (existsSync(sentinel)) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function ensureFileCopy(srcPath: string, destPath: string, mode = 0o644): boolean {
  try {
    if (existsSync(destPath)) {
      // Skip if dest mtime >= src mtime — don't overwrite a user's
      // post-install local edits.
      try {
        const srcStat = statSync(srcPath);
        const destStat = statSync(destPath);
        if (destStat.mtimeMs >= srcStat.mtimeMs) return false;
      } catch { /* fall through to copy */ }
    }
    mkdirSync(dirname(destPath), { recursive: true });
    copyFileSync(srcPath, destPath);
    chmodSync(destPath, mode);
    return true;
  } catch (e) {
    dlog(`copy ${srcPath} → ${destPath} failed: ${(e as Error).message}`);
    return false;
  }
}

// (ensureWrapperScript removed — omp-su wrapper retired, P-050.)

async function ensurePapercuspBootstrap(): Promise<void> {
  try {
    const { installPapercuspFiles } = await import('./desktop-install/papercusp-files');
    const files = await installPapercuspFiles();
    if (!files.playbookWritten) dlog('phase1 playbook copy skipped or missing source');
    if (!files.extensionWritten) dlog('phase1 coord extension copy skipped or missing source');
  } catch (e) {
    dlog(`phase1 bootstrap failed: ${(e as Error).message}`);
  }

  try {
    const { installOmpIntegration } = await import('./desktop-install/omp-integration');
    const result = await installOmpIntegration();
    if (result.reason === 'phase1_not_run') {
      dlog('OMP integration skipped: phase1 bootstrap artifacts still missing');
    } else if (result.changed) {
      dlog(`OMP integration updated: ${result.actions.join('; ')}`);
    }
  } catch (e) {
    dlog(`OMP integration failed: ${(e as Error).message}`);
  }
}


// Cache the completion of the heavy bootstrap for the process
// lifetime. The original implementation reset `inFlight = null` in a
// `finally` block, defeating the single-flight pattern: every console
// launch re-ran ~5s of work (4× synchronous `omp config set` shellouts
// + file copies). Bootstrap is idempotent at server-startup scope, so
// caching the resolved promise is the right shape.
let completed: Promise<void> | null = null;

export async function ensureOmpSuInstalled(): Promise<void> {
  if (completed) return completed;
  completed = (async () => {
    // Only meaningful on Linux right now — omp-su wrapper is bash; the
    // server-side spawn path in console-launch.ts is Linux-only too.
    if (process.platform !== 'linux') return;

    await ensurePapercuspBootstrap();
    ensureOmpHindsightConfig();

    // Skip if the bootstrap files are already in place — fast path on reboot.
    const { playbookPath: playbookDest, coordPath: coordDest } =
      readEngineerOmpBootstrapState();

    if (existsSync(playbookDest) && existsSync(coordDest)) {
      return;
    }

    const sourceDir = resolveSourceDir();
    if (!sourceDir) {
      dlog('source dir not found; skipping (cwd=' + process.cwd() + ')');
      return;
    }
    // The playbook is written (with the client-tooling overlay SPLICED in
    // at the marker) by installPapercuspFiles() above — the canonical
    // writer. Do NOT raw-copy it here: a raw copy would ship the base with
    // its literal CLIENT-TOOLING-OVERLAY marker and no task/workflow tooling
    // section. If installPapercuspFiles couldn't write it, a missing
    // playbook (logged above) is preferable to a marker-broken one.
    const coordSrc = join(sourceDir, 'scripts', 'hooks', 'omp', 'coord-hook.ts');

    if (existsSync(coordSrc)) {
      if (ensureFileCopy(coordSrc, coordDest)) {
        dlog(`installed coord extension → ${coordDest}`);
      }
    } else {
      dlog(`coord extension source missing at ${coordSrc}; skipping`);
    }
    // The omp-su wrapper is no longer written (P-050) — psu launches raw omp.
  })();
  // Don't release the cache on rejection either — a transient failure
  // shouldn't cause the next launch to re-spend 5s repeating the same
  // failing work; we'd rather fail-fast and let the operator
  // restart-fix it.
  return completed;
}
