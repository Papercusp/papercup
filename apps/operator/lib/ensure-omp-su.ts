/**
 * ensure-omp-su.ts — operator-startup helper that drops the omp-su
 * wrapper + its two dependencies (engineer-collaborator playbook +
 * papercusp-coord extension) into the user's home so the /adv
 * "Launch agent" / "Resume" buttons work without the user having to
 * run apps/operator/scripts/install-standalone-mcp.sh by hand.
 *
 * Scope:
 *   - ensure ~/.papercusp/engineer-collaborator.md exists and is fresh
 *   - ensure ~/.papercusp/papercusp-coord.ts exists and is fresh
 *   - ensure ~/.papercusp/superuser-token + su-agent-id exist
 *   - ensure ~/.omp/agent/mcp.json contains `papercusp-su`
 *   - ensure <PATH-dir>/omp-su exists
 *   - ensure OMP-native Hindsight config is enabled
 *
 * Idempotent. Safe to re-run. Logs to stderr; never throws. Unlike the
 * original shell installer, this helper is allowed to heal an incomplete
 * bootstrap on demand from the running operator so /adv OMP launches do
 * not depend on a one-time manual install having happened earlier.
 */

import { existsSync, mkdirSync, copyFileSync, writeFileSync, chmodSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync, execSync } from 'node:child_process';

const OMP_SU_WRAPPER = `#!/usr/bin/env bash
# papercusp engineer-collaborator launcher.
# Managed by the Papercusp operator (lib/ensure-omp-su.ts) — overwriting
# is safe; the operator will rewrite this on next boot.
# Plain \`omp\` is a vanilla coding assistant; this wrapper opts into
# the engineer-collaborator playbook + the papercusp coordination
# extension.
exec omp \\
  --append-system-prompt "\${HOME}/.papercusp/engineer-collaborator.md" \\
  -e "\${HOME}/.papercusp/papercusp-coord.ts" \\
  "$@"
`;

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
function resolveWrapperDir(): string {
  try {
    const ompPath = execSync('command -v omp', { encoding: 'utf8' }).trim();
    if (ompPath) return dirname(ompPath);
  } catch { /* omp not installed yet */ }
  return join(homedir(), '.local', 'bin');
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

function ensureWrapperScript(wrapperPath: string): boolean {
  try {
    if (existsSync(wrapperPath)) return false;
    mkdirSync(dirname(wrapperPath), { recursive: true });
    writeFileSync(wrapperPath, OMP_SU_WRAPPER, { mode: 0o755 });
    return true;
  } catch (e) {
    dlog(`write ${wrapperPath} failed: ${(e as Error).message}`);
    return false;
  }
}

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


let inFlight: Promise<void> | null = null;

export async function ensureOmpSuInstalled(): Promise<void> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    // Only meaningful on Linux right now — omp-su wrapper is bash; the
    // server-side spawn path in console-launch.ts is Linux-only too.
    if (process.platform !== 'linux') return;

    await ensurePapercuspBootstrap();
    ensureOmpHindsightConfig();

    // Skip if everything is already in place — fast path on every reboot.
    const home = homedir();
    const playbookDest = join(home, '.papercusp', 'engineer-collaborator.md');
    const coordDest = join(home, '.papercusp', 'papercusp-coord.ts');
    const wrapperDir = resolveWrapperDir();
    const wrapperPath = join(wrapperDir, 'omp-su');

    if (existsSync(playbookDest) && existsSync(coordDest) && existsSync(wrapperPath)) {
      return;
    }

    const sourceDir = resolveSourceDir();
    if (!sourceDir) {
      dlog('source dir not found; skipping (cwd=' + process.cwd() + ')');
      return;
    }
    const playbookSrc = join(sourceDir, 'prompts', 'papercusp-su-engineer.tools.md');
    const coordSrc = join(sourceDir, 'scripts', 'hooks', 'omp', 'coord-hook.ts');

    if (existsSync(playbookSrc)) {
      if (ensureFileCopy(playbookSrc, playbookDest)) {
        dlog(`installed playbook → ${playbookDest}`);
      }
    } else {
      dlog(`playbook source missing at ${playbookSrc}; skipping`);
    }

    if (existsSync(coordSrc)) {
      if (ensureFileCopy(coordSrc, coordDest)) {
        dlog(`installed coord extension → ${coordDest}`);
      }
    } else {
      dlog(`coord extension source missing at ${coordSrc}; skipping`);
    }

    if (ensureWrapperScript(wrapperPath)) {
      dlog(`installed omp-su wrapper → ${wrapperPath}`);
      if (!isOnPath('omp-su')) {
        dlog(`note: ${wrapperDir} is not on PATH; add it or invoke ${wrapperPath} by full path`);
      }
    }
  })();
  try {
    await inFlight;
  } finally {
    inFlight = null;
  }
}
