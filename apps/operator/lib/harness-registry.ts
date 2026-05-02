/**
 * Single source of truth for the operator's harness-project registry.
 *
 * The registry lives at `<workspace-root>/registry.json` (per-workspace,
 * via {@link papercuspPath}). New workspaces start empty; that's the
 * point. Callers must NEVER read or write `~/.restart-harness-projects.json`
 * directly — that legacy global file is the CLI's concern alone (the CLI
 * mirrors writes there for transition compat; the operator ignores it).
 *
 * Anyone tempted to merge "the legacy file" into the result is creating
 * the workspace-leak bug we just fixed; resist.
 */

import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { papercuspPath } from '@/lib/papercusp-root';

export interface ProjectEntry {
  slug: string;
  path: string;
  harness_kind?: string;
}

export interface HarnessRegistry {
  projects: ProjectEntry[];
}

function registryPath(): string {
  return papercuspPath('registry.json');
}

export function loadHarnessRegistry(): HarnessRegistry {
  const path = registryPath();
  if (!existsSync(path)) return { projects: [] };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as HarnessRegistry;
    return { projects: parsed.projects ?? [] };
  } catch {
    return { projects: [] };
  }
}

export async function saveHarnessRegistry(reg: HarnessRegistry): Promise<void> {
  const path = registryPath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(reg, null, 2));
}
