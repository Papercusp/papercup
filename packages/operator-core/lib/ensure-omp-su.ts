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
import { join, dirname, delimiter } from 'node:path';
import { execFileSync } from 'node:child_process';

function dlog(msg: string): void {
  process.stderr.write(`[ensure-omp-su] ${msg}\n`);
}

/** Pure-Node PATH resolution (audit P-080): no shell, so a hostile/odd
 *  `bin` value can never be interpreted as shell syntax. */
function resolveOnPath(bin: string): string | null {
  const dirs = (process.env.PATH ?? '').split(delimiter);
  const exts =
    process.platform === 'win32'
      ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';')
      : [''];
  for (const dir of dirs) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = join(dir, bin + ext);
      try {
        if (statSync(candidate).isFile()) return candidate;
      } catch {
        /* keep scanning */
      }
    }
  }
  return null;
}

function isOnPath(bin: string): boolean {
  return resolveOnPath(bin) !== null;
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

/** Disable the `eval` shell builtin for omp-su AGENT sessions (ornith Iter-6,
 *  2026-07-04 / WI-2382). `eval` (python/js code-exec) is a REAL omp builtin — NOT the
 *  "hallucinated tool" psu-launcher's weak-model-tool-tier comment long claimed. A weak
 *  local model (ornith IQ3_M) reflexively reaches for `eval` to "call" MCP tools as code
 *  and then DOOM-LOOPS on it: sessions 10234/10239 called it 56-80× despite the
 *  coord-hook block AND an escalating copy-pasteable steer — message-based fixes cannot
 *  break the reflex. Removing the tool from the surface does: with eval.py/eval.js off,
 *  omp stops presenting the tool, so the model is forced onto tools:invoke / Bash (which
 *  it wields fine — session 10241 claimed + verified normally the moment eval was gone).
 *  omp-su is ALWAYS an agent (never a human typing as themselves), so disabling it here
 *  is correct; a human who wants `eval` can re-enable per-session (`omp config set eval.py
 *  true`) or use a different profile. */
function ensureOmpAgentToolTierConfig(): void {
  setOmpConfig('eval.py', 'false');
  setOmpConfig('eval.js', 'false');
}

/** Resolve the directory `omp` lives in (so the wrapper lands on the
 *  same PATH); fallback to ~/.local/bin. */
function resolveWrapperDir(home = homedir()): string {
  const ompPath = resolveOnPath('omp');
  if (ompPath) return dirname(ompPath);
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

  // Register claude's user-level papercusp-su MCP too (the claude sibling of
  // the omp merge above) so a `psu → claude` session has its tools. No-ops
  // cleanly when ~/.claude.json is absent (claude never launched).
  try {
    const { installClaudeIntegration } = await import('./desktop-install/claude-integration');
    const c = await installClaudeIntegration();
    if (c.changed) dlog('claude MCP integration registered papercusp-su in ~/.claude.json');
    else if (c.reason && c.reason !== 'claude_not_initialized') dlog(`claude MCP integration: ${c.reason}`);
  } catch (e) {
    dlog(`claude MCP integration failed: ${(e as Error).message}`);
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
    // NOTE (windows-desktop-feature-parity-2026-07-02 P-025 audit): on a
    // Windows desktop install the operator sidecar is ALWAYS launched via
    // `wsl.exe --exec node ...` (papercusp-desktop/src-tauri/src/main.rs
    // make_sidecar_command), so this process's `process.platform` reports
    // 'linux' there too — this guard does NOT skip Windows; the bootstrap
    // below already runs (and, per static analysis, is expected to work)
    // on Windows via WSL. It's macOS ('darwin') this guard actually skips.
    if (process.platform !== 'linux') return;

    await ensurePapercuspBootstrap();
    ensureOmpHindsightConfig();
    ensureOmpAgentToolTierConfig();

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
