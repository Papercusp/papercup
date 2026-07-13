/**
 * Recurrence guard for active routines (EI-2224 recurrence guard P-2).
 *
 * Validates that no ACTIVE routine targets an unregistered harness. This catches drift where:
 *  - The harness registry gets cleared/rebuilt
 *  - Fire-paths still reference old harness slugs
 *  - A host restart introduces a slug mismatch
 *
 * When violations are found, logs a FATAL error so it surfaces in monitoring.
 * A production deployment would page on this error class.
 *
 * Called by: the boot sequence (apps/operator/bin/host-bootstrap.ts), beside its two sibling
 * guards — validateHomeHarnessResolution (does the HOME slug resolve?) and
 * validateDeclaredSingletons (do the routines we DECLARED exist at all?).
 *
 * There is NO periodic caller, deliberately. Every drift case above lands at boot or at a
 * registry rebuild, and a resolveProject() per active routine every 30-60s is a real cost for
 * a failure that cannot appear between two ticks. A prior version of this comment claimed a
 * health-check loop called it every 30-60s AND that boot called it. BOTH WERE FALSE — it had
 * ZERO callers for its entire life (EI-10660), and the docstring is what kept anyone from
 * noticing: it retired the very suspicion that would have found the gap. Do not describe a
 * caller here that you have not grepped for.
 */

import { getOrgPg } from '@papercusp/db-org';
import { resolveProject } from '../harness-core';
import { activeWorkspaceId } from '../workspace-registry';

export interface RoutineValidationResult {
  ok: boolean;
  activeRoutineCount: number;
  unregisteredHarnesses: Set<string>;
  problematicRoutines: Array<{ installSlug: string; routineName: string; workspaceId: string }>;
}

/**
 * Scan all ACTIVE routines and verify each one's install_slug resolves to a registered project.
 * Returns violations in `problematicRoutines` array.
 * 
 * This is PURE-read and non-blocking: it reports what's wrong, never modifies state.
 * Callers decide whether to log/escalate based on severity.
 */
export async function validateActiveRoutines(workspaceId?: string): Promise<RoutineValidationResult> {
  const ws = workspaceId ?? activeWorkspaceId();
  const { sql } = getOrgPg();

  // Read all active routines in this workspace
  const activeRoutines = await sql`
    SELECT DISTINCT install_slug, name, workspace_id
    FROM harness_shared.routines
    WHERE active = true AND workspace_id = ${ws}
    ORDER BY install_slug, name
  `;

  const unregisteredHarnesses = new Set<string>();
  const problematicRoutines: Array<{ installSlug: string; routineName: string; workspaceId: string }> = [];

  // Validate each routine's harness resolves
  for (const routine of activeRoutines) {
    const slug = (routine as any).install_slug;
    const name = (routine as any).name;
    const routineWs = (routine as any).workspace_id;

    if (!slug || !slug.trim()) {
      // Empty slug is a data integrity error, not a registration error
      problematicRoutines.push({ installSlug: slug || '<empty>', routineName: name, workspaceId: routineWs });
      unregisteredHarnesses.add(slug || '<empty>');
      continue;
    }

    const proj = await resolveProject(slug, routineWs);
    if (!proj) {
      unregisteredHarnesses.add(slug);
      problematicRoutines.push({ installSlug: slug, routineName: name, workspaceId: routineWs });
    }
  }

  const ok = problematicRoutines.length === 0;

  if (!ok) {
    // Log a FATAL error so it surfaces in monitoring + pages ops
    console.error(
      `[routine-validation] FATAL: ${problematicRoutines.length} active routine(s) target ` +
      `unregistered harness(es): ${Array.from(unregisteredHarnesses).join(', ')}. ` +
      `Fire-paths will 404 and go dark. Details: ` +
      JSON.stringify(problematicRoutines),
    );
  }

  return { ok, activeRoutineCount: activeRoutines.length, unregisteredHarnesses, problematicRoutines };
}
