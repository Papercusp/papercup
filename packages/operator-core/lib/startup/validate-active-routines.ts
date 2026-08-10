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
  /**
   * ACTIVE `system:<action>` routines with NO registered handler (EI-19367772473246483).
   * Their fire path reaches `getSystemAction(action)`, finds nothing, logs
   * `no handler registered … skipping` and does nothing — every tick, forever — while this
   * validator reported "startup validation passed — N active routine(s) resolve" and NAMED
   * the dead routine in that list, because it only ever checked that `install_slug` resolves.
   *
   * Deliberately a SEPARATE bucket from `problematicRoutines`: that one is auto-PAUSED by
   * `enforceActiveRoutines`, which is the wrong remedy here. The row is correct; the missing
   * piece is a side-effect `import './<name>-action'` in `register-system-actions.ts`. Pausing
   * would destroy the evidence and silently drop the routine — turning a loud, fixable bug
   * into the exact invisible no-op this field exists to expose.
   */
  unregisteredSystemActions: Array<{
    installSlug: string;
    routineName: string;
    action: string;
    workspaceId: string;
  }>;
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

  // Read all active routines in this workspace. `target_role` + the two loop-fire columns
  // are needed by the unregistered-system-action check below, which must mirror the fire
  // path's dispatch precedence exactly (see `findUnregisteredSystemActions`).
  const activeRoutines = await sql`
    SELECT DISTINCT install_slug, name, workspace_id, target_role,
                    reschedule_interval_sec, target_owner_id
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

  const unregisteredSystemActions = await findUnregisteredSystemActions(activeRoutines);

  const ok = problematicRoutines.length === 0 && unregisteredSystemActions.length === 0;

  if (unregisteredSystemActions.length > 0 && !opts?.silent) {
    console.error(formatUnregisteredSystemActions(unregisteredSystemActions));
  }

  if (problematicRoutines.length > 0 && !opts?.silent) {
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
    unregisteredSystemActions,
  };
}

/**
 * Which ACTIVE routines would hit `no handler registered … skipping` on their next fire
 * (EI-19367772473246483).
 *
 * MIRRORS THE FIRE PATH'S DISPATCH PRECEDENCE, and must keep doing so — this is the whole
 * correctness argument. `routines-workflow.ts` dispatches:
 *
 *   if (rescheduleIntervalSec != null && targetOwnerId)  -> fireLoopWake(), handled INLINE
 *   else if (targetRole.startsWith('system:'))           -> getSystemAction() registry lookup
 *
 * So an engine loop (`loop-su-<uuid>`, `target_role = 'system:loop-wake'`) never reaches the
 * registry and correctly has no handler registered for it. Checking `system:%` alone would
 * flag every one of them: measured on this workspace, 36 of 155 active `system:%` routines are
 * inline loop fires, so the naive form would have reported 36 false positives — against a
 * guard whose sibling auto-PAUSES what it flags. Verified against live data: with the loop
 * exemption, an EMPTY registry flags 119 routines and 0 of the 36 loop rows.
 *
 * Fail-soft: the registry is populated by a side-effect import of ~100 action modules. If that
 * import throws, we report NO violations rather than guess — a false "handler missing" here is
 * far more damaging than a missed one, since it is the signal a human acts on.
 */
async function findUnregisteredSystemActions(
  activeRoutines: readonly unknown[],
): Promise<Array<{ installSlug: string; routineName: string; action: string; workspaceId: string }>> {
  let getSystemAction: (name: string) => unknown;
  try {
    // Side-effect import: populates the registry. The boot sequence does NOT otherwise import
    // it (only `dbos/routines-workflow.ts` does), so without this the check would see an empty
    // registry and flag everything. Idempotent + module-cached, so a repeat call is free.
    await import('../harness/routines/register-system-actions');
    ({ getSystemAction } = await import('../harness/routines/system-actions'));
  } catch (e) {
    console.warn(
      '[routine-validation] system-action registry import failed — skipping the ' +
        `unregistered-handler check (reporting none): ${e instanceof Error ? e.message : e}`,
    );
    return [];
  }

  const SYSTEM_PREFIX = 'system:';
  const missing: Array<{ installSlug: string; routineName: string; action: string; workspaceId: string }> = [];
  for (const raw of activeRoutines) {
    const r = raw as {
      install_slug?: string;
      name?: string;
      workspace_id?: string;
      target_role?: string | null;
      reschedule_interval_sec?: number | null;
      target_owner_id?: string | null;
    };
    const targetRole = r.target_role ?? '';
    if (!targetRole.startsWith(SYSTEM_PREFIX)) continue;
    // Inline loop fire — takes precedence over system dispatch, needs no registered handler.
    if (r.reschedule_interval_sec != null && r.target_owner_id) continue;

    const action = targetRole.slice(SYSTEM_PREFIX.length);
    if (getSystemAction(action)) continue;
    missing.push({
      installSlug: r.install_slug || '<empty>',
      routineName: r.name || '<unnamed>',
      action,
      workspaceId: r.workspace_id || '<empty>',
    });
  }
  return missing;
}

/** The operator-facing message for a dead system-action routine — names the exact one-line fix. */
function formatUnregisteredSystemActions(
  missing: ReadonlyArray<{ installSlug: string; routineName: string; action: string }>,
): string {
  const names = [...new Set(missing.map((m) => m.action))];
  return (
    `[routine-validation] FATAL: ${missing.length} ACTIVE routine(s) target a system action with ` +
    `NO REGISTERED HANDLER: ${names.map((n) => `system:${n}`).join(', ')}. Each fire logs ` +
    `"no handler registered … skipping" and does NOTHING — the routine is silently dead, at its ` +
    `full cadence, indefinitely. Almost always a missing side-effect import in ` +
    `packages/operator-core/lib/harness/routines/register-system-actions.ts — add ` +
    `${names.map((n) => `import './${n}-action';`).join(' ')} (verify the filename). NOT ` +
    `auto-paused: the routine row is correct, the code is what is missing. ` +
    `Details: ${JSON.stringify(missing)}`
  );
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
/**
 * The auto-deactivate UPDATE, extracted behind a `sql` seam for ONE reason: so the
 * recurrence guard can PREPARE the PRODUCTION statement against real Postgres instead
 * of a hand-copied duplicate that drifts away from it. Do not inline this back.
 *
 * WI-37757: the uncast version of this statement could not PREPARE at all
 * ('could not determine data type of parameter $N'), which meant this function's
 * entire self-silencing design — documented at length in the header comment above —
 * had never once worked in production. The unit tests mock `sql`, so a statement that
 * fails at PREPARE time is invisible to them BY CONSTRUCTION; only a real-Postgres
 * test can see it. That is the whole justification for this seam.
 */
export async function pauseUnregisteredRoutine(
  sql: ReturnType<typeof getOrgPg>['sql'],
  r: { workspaceId: string; installSlug: string; routineName: string },
): Promise<Array<{ name: string }>> {
  return await sql<Array<{ name: string }>>`
    UPDATE harness_shared.routines
       SET active = false,
           metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
             'pause', jsonb_build_object(
               'reason', 'auto-deactivated: install_slug targets an unregistered harness (routine-validation recurrence guard, EI-18678269428596559)',
               'pausedBy', 'routine-validation:enforce',
               -- WI-37757 — THE ::bigint CAST IS LOAD-BEARING, do not remove it.
               -- jsonb_build_object takes "any" arguments, so Postgres cannot infer a
               -- type for a bare parameter here; uncast, the statement fails to PREPARE
               -- and takes the whole UPDATE down with it. Measured live 2026-08-10:
               -- 3 routine rows still active, never paused since the guard shipped,
               -- re-logging FATAL on every boot of every worker.
               'pausedAtMs', ${Date.now()}::bigint
             )
           ),
           updated_at = now()
     WHERE workspace_id = ${r.workspaceId} AND install_slug = ${r.installSlug}
       AND name = ${r.routineName} AND active = true
    RETURNING name
  `;
}

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
        updatedRows = await pauseUnregisteredRoutine(sql, r);
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
  // EI-19367772473246483: this path passes `silent: true`, so the validator's own report is
  // suppressed and must be re-emitted here — otherwise the boot caller (which only logs on
  // `ok`) prints NOTHING and the dead routine stays invisible, which is the bug itself.
  // Deliberately NOT auto-healed: unlike an unregistered harness, there is no DB flip that
  // fixes a missing import, and pausing the row would erase the only evidence.
  if (result.unregisteredSystemActions.length > 0) {
    console.error(formatUnregisteredSystemActions(result.unregisteredSystemActions));
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
