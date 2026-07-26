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
 *
 * EI-18678269428596559 (recurrence guard P-3): the boot caller now calls `enforceActiveRoutines`
 * (below), not this function directly — a violation gets auto-PAUSED, not just logged FATAL on
 * every boot forever. `validateActiveRoutines` itself stays pure-read (unchanged contract, its
 * own tests) so any other read-only caller is unaffected.
 */

import { getOrgPg } from '@papercusp/db-org';
import { resolveProject } from '../harness-core';
import { isReservedHarnesslessRoutineHost } from '../harness/routines/routine-host';
import { activeWorkspaceId } from '../workspace-registry';

export interface RoutineValidationResult {
  ok: boolean;
  activeRoutineCount: number;
  /**
   * Names of every ACTIVE routine this scan found, as `"<name>@<install_slug>"` (WI-5704).
   * The bare `activeRoutineCount` alone can't say WHICH routines are active — during the
   * WI-5672 live-fed-gate triage that made it impossible to tell, without a live psql tap
   * before rig teardown, whether joiner frame B (1 active routine vs owner A's 5) was even
   * missing the hive-member-rekey/epoch-key-reconcile routine. This makes the startup log
   * self-sufficient evidence.
   */
  activeRoutineNames: string[];
  unregisteredHarnesses: Set<string>;
  problematicRoutines: Array<{ installSlug: string; routineName: string; workspaceId: string }>;
}

/**
 * Scan all ACTIVE routines and verify every harness-owned install_slug resolves to a registered
 * project. Reserved synthetic/workspace hosts are intentionally harness-less and follow their
 * system-action fire paths instead.
 * Returns violations in `problematicRoutines` array.
 *
 * This is PURE-read and non-blocking: it reports what's wrong, never modifies state.
 * Callers decide whether to log/escalate based on severity.
 *
 * `opts.silent` suppresses the FATAL console.error even when violations are found — for
 * `enforceActiveRoutines()` below, which does its OWN, more specific logging once it knows
 * what it could/couldn't auto-heal. Every existing caller/test omits `opts`, so default
 * behavior (log FATAL on violation) is unchanged.
 */
export async function validateActiveRoutines(
  workspaceId?: string,
  opts?: { silent?: boolean },
): Promise<RoutineValidationResult> {
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
  const activeRoutineNames: string[] = [];

  // Validate each routine's harness resolves
  for (const routine of activeRoutines) {
    const slug = (routine as any).install_slug;
    const name = (routine as any).name;
    const routineWs = (routine as any).workspace_id;

    activeRoutineNames.push(`${name || '<unnamed>'}@${slug || '<empty>'}`);

    if (!slug || !slug.trim()) {
      // Empty slug is a data integrity error, not a registration error
      problematicRoutines.push({ installSlug: slug || '<empty>', routineName: name, workspaceId: routineWs });
      unregisteredHarnesses.add(slug || '<empty>');
      continue;
    }

    if (isReservedHarnesslessRoutineHost(slug, routineWs)) continue;

    const proj = await resolveProject(slug, routineWs);
    if (!proj) {
      unregisteredHarnesses.add(slug);
      problematicRoutines.push({ installSlug: slug, routineName: name, workspaceId: routineWs });
    }
  }

  const ok = problematicRoutines.length === 0;

  if (!ok && !opts?.silent) {
    // Log a FATAL error so it surfaces in monitoring + pages ops
    console.error(
      `[routine-validation] FATAL: ${problematicRoutines.length} active routine(s) target ` +
      `unregistered harness(es): ${Array.from(unregisteredHarnesses).join(', ')}. ` +
      `Their fire paths may go dark or act on orphaned state. Details: ` +
      JSON.stringify(problematicRoutines),
    );
  }

  return {
    ok,
    activeRoutineCount: activeRoutines.length,
    activeRoutineNames,
    unregisteredHarnesses,
    problematicRoutines,
  };
}

export interface EnforceActiveRoutinesResult extends RoutineValidationResult {
  /** Routines THIS call actually flipped to active=false (won any concurrent race, see below). */
  autoDeactivated: Array<{ installSlug: string; routineName: string }>;
}

/**
 * `validateActiveRoutines()` + ENFORCEMENT (EI-18678269428596559 recurrence guard P-3): an
 * active routine whose install_slug no longer resolves gets PAUSED (active=false), not just
 * narrated forever. The validator alone was a detector with no fixer — "may go dark or act
 * on orphaned state" logged FATAL on every boot for as long as the harness stayed deleted,
 * changing nothing, which is a detector failure as much as a data failure (a live incident:
 * an unregistered harness's own `git-sync` and `green-checkpoint` singleton copies kept
 * FIRING against orphaned state for hours before this existed).
 *
 * There is deliberately no single "delete a harness" code path this hooks into — the routine
 * table has no hard FK to the harness registry (same cross-machine-tolerant design as
 * `hive-settings-store.ts`), and in practice harnesses have gone orphaned via ad-hoc/manual
 * registry edits, not one audited deletion function. Running this at every boot (in place of
 * the bare validator) IS the cascade: whatever mechanism orphaned the harness, the very next
 * boot pauses its dangling routines instead of re-detecting the same drift forever.
 *
 * Concurrency (the "~15 identical FATAL lines in the same second, one per operator worker
 * process" duplicate-emission complaint): every worker boots independently and calls this
 * independently — there is no shared coordinator. Rather than add a distributed lock, the
 * `UPDATE … WHERE active = true` predicate is what naturally serializes them: under READ
 * COMMITTED, whichever process commits first wins; every later process re-evaluates the
 * predicate against the now-updated row and affects 0 rows, so only the winner logs
 * anything. And because the base query only ever selects `active = true` rows, once a row
 * is paused, NO future boot (by any process) re-selects it at all — the FATAL simply stops
 * recurring instead of needing to be silenced.
 *
 * A blank/empty install_slug is never auto-healed — that is a data-integrity bug in the row
 * itself (not "a harness got deleted", the drift class this guard targets), so it keeps
 * logging FATAL every time until a human fixes the row directly.
 */
export async function enforceActiveRoutines(workspaceId?: string): Promise<EnforceActiveRoutinesResult> {
  const ws = workspaceId ?? activeWorkspaceId();
  const result = await validateActiveRoutines(ws, { silent: true });
  const autoDeactivated: Array<{ installSlug: string; routineName: string }> = [];
  const stillProblematic: Array<{ installSlug: string; routineName: string; workspaceId: string }> = [];

  if (result.problematicRoutines.length > 0) {
    const { sql } = getOrgPg();
    for (const r of result.problematicRoutines) {
      if (!r.installSlug || r.installSlug === '<empty>') {
        stillProblematic.push(r);
        continue;
      }
      let updatedRows: Array<{ name: string }>;
      try {
        updatedRows = await sql<Array<{ name: string }>>`
          UPDATE harness_shared.routines
             SET active = false,
                 metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
                   'pause', jsonb_build_object(
                     'reason', 'auto-deactivated: install_slug targets an unregistered harness (routine-validation recurrence guard, EI-18678269428596559)',
                     'pausedBy', 'routine-validation:enforce',
                     'pausedAtMs', ${Date.now()}
                   )
                 ),
                 updated_at = now()
           WHERE workspace_id = ${r.workspaceId} AND install_slug = ${r.installSlug}
             AND name = ${r.routineName} AND active = true
          RETURNING name
        `;
      } catch (e) {
        console.error(
          `[routine-validation] auto-deactivate FAILED for ${r.installSlug}/${r.routineName}: ` +
          `${e instanceof Error ? e.message : e}`,
        );
        stillProblematic.push(r);
        continue;
      }
      if (updatedRows.length > 0) {
        autoDeactivated.push({ installSlug: r.installSlug, routineName: r.routineName });
      }
      // 0 rows ⇒ a concurrent process already flipped it (or it's gone) — nothing to log.
    }
  }

  if (autoDeactivated.length > 0) {
    console.error(
      `[routine-validation] AUTO-DEACTIVATED ${autoDeactivated.length} active routine(s) that ` +
      `targeted unregistered harness(es) (${Array.from(result.unregisteredHarnesses).join(', ')}): ` +
      `${JSON.stringify(autoDeactivated)}. Paused, not deleted — reactivate via routines:set once ` +
      `the harness is re-registered (or the slug was a typo). See EI-18678269428596559.`,
    );
  }
  if (stillProblematic.length > 0) {
    console.error(
      `[routine-validation] FATAL: ${stillProblematic.length} active routine(s) target unregistered ` +
      `harness(es) and could NOT be auto-deactivated (a blank install_slug is a data-integrity bug in ` +
      `the row itself, not harness drift — fix the row directly): ${JSON.stringify(stillProblematic)}`,
    );
  }

  return { ...result, autoDeactivated };
}
