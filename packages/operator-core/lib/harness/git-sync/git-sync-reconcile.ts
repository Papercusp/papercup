/**
 * git-sync-reconcile — boot-time reconcile/backfill of `system:git-sync`
 * routine rows for hive MEMBER checkouts (git-sync-any-hive-2026-06-12 P-004).
 *
 * Hives created BEFORE the seeding sites existed (B-01's creator-side
 * producers, B-03's join path) — and any member that slipped past them — have
 * registered member clones but no routine row, so they never sync. This sweep
 * walks one workspace's registry and seeds the MISSING rows only:
 *
 *   - Scope: hive MEMBERS only (`projects.filter(p => p.hive_slug)`).
 *     `papercup` itself carries no `hive_slug` — its hand-tuned row is never
 *     even visited. Hive HOMES and joiner-side `remote_hive` VIEWS carry no
 *     `hive_slug` either; member-shaped entries that are still not syncable
 *     (vanished path, cloud deployment, non-repo) are excluded by the spine's
 *     eligibility gate.
 *   - ADD-only: an existing routine row — human-edited `active`/config
 *     included — is NEVER mutated (the spine's `routine_exists` skip, reported
 *     here as `already_seeded`). Flipping active/config is a human/tool
 *     action, not reconciliation.
 *   - Joiner detection: a member whose HOME entry (`projects.find(p =>
 *     p.slug === member.hive_slug)`) carries `remote_hive: true` is a
 *     joiner-side clone ⇒ the spine seeds it ACTIVE (D-008) with push:false
 *     (a local commit+fetch+merge mirror, no push — B-02 semantics); otherwise
 *     creator-side semantics apply.
 *
 * Per-member seeding COMPOSES `seedGitSyncRoutineForMember` (git-sync-routine.ts)
 * — eligibility gate, non-clobber idempotency, probe→decider push, jittered
 * cron, branch from registry coords all live there; this module only owns the
 * walk + the joiner detection. IO is seam-injected (registry load, sql, the
 * spine itself) so the sweep unit-tests without PG — the house pattern
 * (cf. lib/hive-member-repos.ts).
 *
 * The boot trigger (`ensureGitSyncRoutinesReconciledOnce`) follows the
 * `ensureRepoCoordsRevalidatedOnce` posture (harness/revalidate-repo-coords.ts):
 * module-level once-flag + detached fire-and-forget + never throws, called from
 * boot-all's post-boot hygiene block via lazy import — a reconcile failure must
 * never wedge boot, and it adds nothing to cold-start when there are no hives.
 */

import type { Sql } from 'postgres';
import { loadHarnessRegistry, type HarnessRegistry } from '../../harness-registry';
import { seedGitSyncRoutineForMember } from './git-sync-routine';

export interface ReconcileGitSyncOpts {
  /** Owning workspace_id (routines.workspace_id is NOT NULL, no default). */
  workspaceId: string;
  /** Registry snapshot loader (default loadHarnessRegistry) — test seam. */
  loadRegistry?: (workspaceId?: string) => Promise<HarnessRegistry>;
  /** PG handle forwarded to the seeding spine (default: the spine's getOrgPg). */
  sql?: Sql;
  /** The per-member seeding spine (default seedGitSyncRoutineForMember) — test seam. */
  seedMember?: typeof seedGitSyncRoutineForMember;
}

export interface ReconcileGitSyncResult {
  /** Member slugs whose routine row this sweep CREATED. */
  seeded: string[];
  /** Members visited but not seeded: `already_seeded` (row exists — never
   *  clobbered), `ineligible:<reason>` (B-01's verdict), `error:<message>`
   *  (the spine's folded failure). Non-members never appear. */
  skipped: Array<{ slug: string; reason: string }>;
  /** Set when the sweep itself failed before walking members (registry load
   *  blew up). Reported, never thrown. */
  error?: string;
}

/**
 * Idempotent add-only sweep of one workspace's hive members. Never throws:
 * a registry-load failure folds into `result.error`, and per-member failures
 * fold into `skipped` (the spine never throws).
 */
export async function reconcileGitSyncRoutines(
  opts: ReconcileGitSyncOpts,
): Promise<ReconcileGitSyncResult> {
  const result: ReconcileGitSyncResult = { seeded: [], skipped: [] };
  let projects: HarnessRegistry['projects'];
  try {
    const reg = await (opts.loadRegistry ?? loadHarnessRegistry)(opts.workspaceId);
    projects = reg.projects ?? [];
  } catch (e) {
    result.error = e instanceof Error ? e.message : String(e);
    return result;
  }

  const members = projects.filter((p) => p.hive_slug);
  const seed = opts.seedMember ?? seedGitSyncRoutineForMember;
  for (const member of members) {
    const home = projects.find((p) => p.slug === member.hive_slug);
    const joinerSide = home?.remote_hive === true;
    const outcome = await seed(
      {
        workspaceId: opts.workspaceId,
        installSlug: member.slug,
        entry: member,
        joinerSide,
        // Joiner-side: salt the cron jitter per install — the same member slug
        // exists on N peer boxes on a shared hive (B-03's cronKey, D-004).
        ...(joinerSide ? { cronKey: `${member.slug}:${opts.workspaceId}` } : {}),
      },
      opts.sql ? { sql: opts.sql } : undefined,
    );
    if (outcome.seeded) {
      result.seeded.push(member.slug);
    } else if (outcome.reason === 'routine_exists') {
      result.skipped.push({ slug: member.slug, reason: 'already_seeded' });
    } else if (outcome.reason === 'ineligible') {
      result.skipped.push({ slug: member.slug, reason: `ineligible:${outcome.ineligibleReason}` });
    } else {
      result.skipped.push({ slug: member.slug, reason: `error:${outcome.message}` });
    }
  }
  return result;
}

// ── Once-per-process boot trigger ───────────────────────────────────────────
// The `ensureRepoCoordsRevalidatedOnce` posture (revalidate-repo-coords.ts):
// module-level flag + fire-and-forget; a repeat bootAllHarnessesForActiveWorkspace()
// pass (the retry path) no-ops.

let _reconciledOnce = false;

/**
 * Fire the reconcile sweep once per process for the given workspaces,
 * detached. Synchronous + void: the caller never awaits it, and
 * `reconcileGitSyncRoutines` never throws, so this can NEVER block or fail
 * boot. Quiet at steady state — logs only when rows were seeded or something
 * failed. `seams` is the test seam; the boot site passes nothing.
 */
export function ensureGitSyncRoutinesReconciledOnce(
  workspaceIds: string[],
  seams?: Pick<ReconcileGitSyncOpts, 'loadRegistry' | 'sql' | 'seedMember'>,
): void {
  if (_reconciledOnce) return;
  _reconciledOnce = true;
  void (async () => {
    for (const workspaceId of workspaceIds) {
      const r = await reconcileGitSyncRoutines({ workspaceId, ...seams });
      if (r.error) {
        // eslint-disable-next-line no-console
        console.warn(`[git-sync-reconcile] sweep failed for workspace '${workspaceId}': ${r.error}`);
      } else if (r.seeded.length || r.skipped.some((s) => s.reason.startsWith('error:'))) {
        // eslint-disable-next-line no-console
        console.log(
          `[git-sync-reconcile] boot sweep (${workspaceId}): seeded=[${r.seeded.join(', ')}]` +
            (r.skipped.length
              ? ` skipped=${r.skipped.map((s) => `${s.slug}:${s.reason}`).join(', ')}`
              : ''),
        );
      }
    }
  })().catch((e) => {
    // unreachable (reconcileGitSyncRoutines never throws) — belt and braces
    // eslint-disable-next-line no-console
    console.warn(
      `[git-sync-reconcile] boot sweep crashed: ${e instanceof Error ? e.message : String(e)}`,
    );
  });
}

/** Test seam: drop the once-flag so the next ensure call re-runs. */
export function __resetGitSyncReconcileForTests(): void {
  _reconciledOnce = false;
}
