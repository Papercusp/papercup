/**
 * Startup validation for the operator-home harness (EI-2224 recurrence guard).
 * 
 * Fail-loud assertion: the configured home harness slug MUST resolve to a 
 * registered project. This catches slug mismatches early (e.g. fire-paths 
 * targeting an unregistered harness after a slug migration) instead of 
 * silently 404ing during dispatch and going dark.
 *
 * Called at operator boot by src/server.ts before any business logic.
 */

import { operatorHomeHarnessSlug } from '../harness/operator-home-harness';
import { resolveProject } from '../harness-core';
import { activeWorkspaceId } from '../workspace-registry';

/**
 * Validate that the configured home harness slug resolves to a registered project.
 * Throws if:
 *  - The slug is unset/empty
 *  - The slug does not resolve in the active workspace (AND not cross-workspace)
 *  - resolveProject() returns null
 *
 * Call this ONCE at operator startup, before any fire-paths fire.
 */
export async function validateHomeHarnessResolution(): Promise<void> {
  const slug = operatorHomeHarnessSlug();
  if (!slug || !slug.trim()) {
    throw new Error(
      'STARTUP VALIDATION FAILED: operatorHomeHarnessSlug() returned an empty slug. ' +
      'Check PAPERCUSP_HIVE_HOME_SLUG env or LEGACY_DEFAULT_HOME_HARNESS fallback.'
    );
  }

  const ws = activeWorkspaceId();
  const proj = await resolveProject(slug, ws);
  if (!proj) {
    throw new Error(
      `STARTUP VALIDATION FAILED: home harness slug '${slug}' does not resolve to a ` +
      `registered project in workspace '${ws}'. This will cause fire-paths (dispatcher, ` +
      `overwatch, routines) to 404 silently and go dark. Verify the harness is registered ` +
      `and PAPERCUSP_HIVE_HOME_SLUG is set correctly, then restart the operator.`
    );
  }
}
