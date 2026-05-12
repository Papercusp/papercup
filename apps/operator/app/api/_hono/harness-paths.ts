import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Resolves the autonomous-harness package root.
 *
 * In dev: falls back to `~/autonomous-harness` (symlinked to
 * `libs/papercusp/packages/harness/` in this repo).
 *
 * In the desktop bundle: Tauri's main.rs sets `PAPERCUSP_HARNESS_DIR`
 * to the bundled `<resource-dir>/sidecar/harness` so the orchestrator
 * finds run.sh + prompts + templates without any user setup.
 */
export function harnessPackageDir(): string {
  const fromEnv = process.env.PAPERCUSP_HARNESS_DIR;
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  return join(homedir(), 'autonomous-harness');
}

export function harnessPath(...segments: string[]): string {
  return join(harnessPackageDir(), ...segments);
}

/**
 * Absolute path to the TypeScript orchestrator entry point
 * (`@papercusp/orchestrator/bin/run.ts`). Sibling of the harness package.
 *
 * Used by spawn sites that previously invoked `bash run.sh` for the
 * full main loop. The bash run.sh remains as a function library for
 * sites that source individual helpers (e.g. invokeScoperBackground)
 * but is no longer the canonical iteration driver.
 *
 * IMPORTANT: `path.join('..')` collapses syntactically — NOT via the
 * filesystem. When harnessPackageDir() is a symlink (default dev:
 * ~/autonomous-harness → .../libs/papercusp/packages/harness), a naive
 * `join(base, '..')` walks up from the SYMLINK NAME's parent
 * (`~/orchestrator/bin/run.ts`), not the symlink target's. We resolve
 * the real path first so '..' correctly lands on `.../packages/`.
 */
export function orchestratorRunBin(): string {
  const base = harnessPackageDir();
  let real: string;
  try {
    real = realpathSync(base);
  } catch {
    // Symlink missing or path doesn't exist — fall back to the unresolved
    // path. The caller's existsSync check will surface the real problem.
    real = base;
  }
  return join(real, '..', 'orchestrator', 'bin', 'run.ts');
}
