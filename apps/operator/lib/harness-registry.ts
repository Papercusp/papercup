/**
 * Single source of truth for the operator's harness-project registry.
 *
 * Persisted in `harness_shared.harness_registry` (PG, migration 025).
 * Was previously `<workspace-root>/registry.json`; the new home keeps
 * the same per-workspace scoping via the workspace_id PK column.
 *
 * Operator never reads any home-directory JSON registry. PG is the
 * single source of truth; merging in legacy files re-introduces a
 * workspace-leak bug we've already fixed.
 *
 * API converted to async as part of the migration. Callers in async
 * route handlers / page components add `await`; the few sync wrappers
 * become async functions of their own.
 */

import { readOperatorState, writeOperatorState } from './operator-state-pg';

export interface ProjectEntry {
  slug: string;
  path: string;
  harness_kind?: string;
  /** Department slug for harness_kind='department' projects (e.g. "business"). */
  department_slug?: string;
}

export interface HarnessRegistry {
  projects: ProjectEntry[];
}

export async function loadHarnessRegistry(): Promise<HarnessRegistry> {
  const raw = await readOperatorState<HarnessRegistry>('harness_registry');
  return { projects: raw?.projects ?? [] };
}

export async function saveHarnessRegistry(reg: HarnessRegistry): Promise<void> {
  await writeOperatorState('harness_registry', { projects: reg.projects ?? [] });
}
