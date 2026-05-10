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
 */
export function orchestratorRunBin(): string {
  return join(harnessPackageDir(), '..', 'orchestrator', 'bin', 'run.ts');
}
