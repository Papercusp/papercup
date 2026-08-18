/**
 * work-item-deps-store — read/write the dedicated `work_item_deps` table
 * (work-item-deps-and-readiness-2026-06-22 P-002/P-003) + the acyclicity guard (P-008).
 *
 * This is the NEW backend for the blockersOf() seam (work-item-blocking.ts), replacing
 * coord_links rel='blocks'. Same feature→feature shape as the coord_links reader
 * (feature-blockers-edges.ts) so the seam swap is transparent, but on a dedicated, indexed,
 * single-purpose table. Acyclicity is enforced HERE on write (a CHECK can't see the transitive
 * graph), reusing `detectDependencyCycle`. FK to the unified work_items lands with P-009.
 */
import { getOrgPg } from '@papercusp/db-org';
import { DEFAULT_COORD_WORKSPACE } from '@papercusp/coordination/event-log';
import { featureRef, FEATURE_KIND, isQualifiedFeatureRef } from '../issue-blocks-merge';
import { detectDependencyCycle } from '../feature-deps';

/** The polymorphic endpoints accepted by work_item_deps (issue/feature today). */
export interface WorkItemDepEndpoint {
  kind: string;
  ref: string;
}

export interface WorkItemBlockingEdge {
  blocked_kind: string;
  blocked_ref: string;
  blocker_kind: string;
  blocker_ref: string;
  dep_type: 'blocks';
}

/** The issue-family endpoint kind, the counterpart of FEATURE_KIND for this table. */
const ISSUE_ENDPOINT_KIND = 'issue';

/**
 * P-005 / D-009 — the kind↔ref-FORM invariant, enforced at the ONE write seam.
 *
 * `work_item_deps` endpoints use a ref form determined by their family, and this is
 * deliberate, not an inconsistency to normalize away (D-009, after measuring all 94 rows /
 * 188 endpoint-sides: zero violations, the form is a pure function of the `*_kind` column):
 *
 *   - `feature` → harness-QUALIFIED `<harness>#<feature_id>`, because a feature's identity is
 *     (harness_slug, feature_id); a bare `F-NNN` would mis-attribute a block to the same id in
 *     another project. Gated by `work_item_is_blocked()` + the `work_item_blocked` sidecar.
 *   - `issue`   → BARE `EI-NNN` / `WI-NNN` (issues:link). Gated by `depsBlockedExclusionSql`,
 *     which keys on the bare `feature_id` because the `wir_*` sidecar triggers do not track
 *     issues. Teaching either predicate to match BOTH forms over-gates the feature family —
 *     that is D-007's retraction, and it is why the two forms must stay distinct.
 *
 * WHY A GUARD RATHER THAN A MIGRATION (the P-005 re-scope). Nothing enforced this: both link
 * doors funnel here, but only `linkWorkItem` checked a ref form, only on the `dst`, and only in
 * the feature direction — `linkIssue` mirrored straight through with no check at all. That is
 * the same shape as D-007 itself: a rule applied at one door instead of at the shared seam, so
 * the unchecked door drifts. A form-mismatched edge is not cosmetic — it is INVISIBLE TO BOTH
 * FLOORS (the issue floor looks for the bare ref and misses; the feature floor matches only the
 * qualified form), i.e. a silently inert dependency that looks recorded and gates nothing. A
 * one-time migration could not prevent it, because the next bad write recreates it.
 *
 * ⚠ WHAT THIS DELIBERATELY DOES **NOT** CATCH — do not read it as more coverage than it has.
 * This validates the ref's FORM against the declared `kind`. It cannot validate that the endpoint
 * RESOLVES to a row of that kind, because that needs a database read and this function is pure
 * (its purity is what lets the invariant be tested exhaustively and applied on every write path
 * without an await). A row can therefore satisfy this guard and still be inert: 3 such rows exist
 * live — `offsite-planner-demo#WI-247/248/249` carry `blocked_kind='feature'` with a properly
 * QUALIFIED ref, but the rows they point at are `item_kind='task'` (issue-family), so the issue
 * floor never matches them (it keys on the bare id) and the feature floor never evaluates them
 * (the sidecar triggers are feature-only). That kind↔TARGET-FAMILY check is a separate, DB-backed
 * guard, tracked separately — this one is its necessary but not sufficient half.
 *
 * Throws rather than returning null: `null` already means "self-edge, skip", and overloading it
 * with "malformed, dropped" would make a caller bug SILENT — the exact failure mode this guards.
 * Both callers already restrict to issue|feature, so any other kind is left alone rather than
 * rejected, keeping this a validator of the ratified convention and not a new kind whitelist.
 */
export function assertDepEndpointRefForm(endpoint: WorkItemDepEndpoint, role: 'blocked' | 'blocker'): void {
  const qualified = isQualifiedFeatureRef(endpoint.ref);
  if (endpoint.kind === FEATURE_KIND && !qualified) {
    throw new Error(
      `work_item_deps ${role} endpoint kind='${FEATURE_KIND}' requires a harness-qualified ref ` +
        `'<harness>#<feature_id>', got '${endpoint.ref}'. A bare ref here is invisible to BOTH ` +
        `blocking floors, so the edge would be silently inert (D-009 / D-007).`,
    );
  }
  if (endpoint.kind === ISSUE_ENDPOINT_KIND && qualified) {
    throw new Error(
      `work_item_deps ${role} endpoint kind='${ISSUE_ENDPOINT_KIND}' requires a BARE ref ` +
        `(e.g. 'EI-123'), got the harness-qualified '${endpoint.ref}'. The issue floor keys on the ` +
        `bare feature_id, so a qualified ref here is silently inert (D-009 / D-007).`,
    );
  }
  // goal endpoints (goal-dag-shared-substrate-2026-08-18 P-001, D-001/D-006): goal ids are
  // bare slug-hex (`ship-paid-app-3f9a1c`, minted by goalId()) and NEVER harness-qualified —
  // `harness_shared.goals` keys on (workspace_id, id), so a qualified ref here would match
  // nothing on the goal read side and mint a silently-inert edge, the same failure shape the
  // two branches above pin for their families. The goal readers/writers live in
  // `@papercusp/agent-mcp/goal-deps`; this seam-level guard exists so a future writer that
  // reaches the table through THIS module's helpers is held to the same convention.
  if (endpoint.kind === GOAL_ENDPOINT_KIND && qualified) {
    throw new Error(
      `work_item_deps ${role} endpoint kind='${GOAL_ENDPOINT_KIND}' requires a bare goal id ` +
        `(e.g. 'ship-paid-app-3f9a1c'), got the harness-qualified '${endpoint.ref}'. Goals key on ` +
        `(workspace_id, id), so a qualified ref is silently inert.`,
    );
  }
}

/**
 * EI-19387076313999646 / D-017 (LINK seam half). `resolveDepEndpoint` below closed this gap for
 * the SYNC seam (`syncWorkItemDepEdges`); the LINK seam (`mirrorWorkItemBlockingEdge`, and by
 * extension every `work_items:link` / `linkIssue` caller) still trusted the DECLARED kind, so
 * `{ kind:'feature', ref:'<harness>#WI-9002' }` for an issue-family WI-9002 passed
 * `assertDepEndpointRefForm` (a pure ref-FORM check that cannot see the target row) and minted a
 * form-valid but INERT edge — invisible to both blocking floors at once.
 *
 * This is that same "decide the kind from the TARGET, not the caller" fix, shaped for a bare
 * endpoint rather than an (harnessSlug, id) pair: a caller-declared target_kind+target_ref
 * carries no harness for the id it might be about to mis-file under, so both `engineer_issues`
 * (issue-family) and `harness_features_consolidated` (feature-family, whose row also carries the
 * harness_slug needed to build a correctly-qualified ref) are checked here.
 *
 * Only 'issue'/'feature' endpoints are resolved — every other coord ObjectRef kind this store's
 * callers pass through (a plan_item, an event key, a topic) is not a work-item at all, so there
 * is no family to disagree with.
 *
 * ABSENT rows (found under NEITHER relation) are left AS DECLARED, same as `resolveDepEndpoint`'s
 * "must remain writable" invariant: an edge naming a not-yet-existing or since-deleted blocker
 * must not become unwritable just because this lookup can't confirm it.
 */
async function resolveActualDepEndpoint(endpoint: WorkItemDepEndpoint): Promise<WorkItemDepEndpoint> {
  if (endpoint.kind !== ISSUE_ENDPOINT_KIND && endpoint.kind !== FEATURE_KIND) return endpoint;
  const bareId =
    endpoint.kind === FEATURE_KIND && isQualifiedFeatureRef(endpoint.ref)
      ? endpoint.ref.slice(endpoint.ref.indexOf('#') + 1)
      : endpoint.ref;
  const { sql } = getOrgPg();
  const issueRows = await sql<{ one: number }[]>`
    SELECT 1 AS one FROM harness_shared.engineer_issues WHERE issue_id = ${bareId} LIMIT 1`;
  if (issueRows.length > 0) return { kind: ISSUE_ENDPOINT_KIND, ref: bareId };
  const featureRows = await sql<{ harness_slug: string }[]>`
    SELECT harness_slug FROM harness_shared.harness_features_consolidated WHERE feature_id = ${bareId} LIMIT 1`;
  if (featureRows.length > 0) return { kind: FEATURE_KIND, ref: featureRef(featureRows[0]!.harness_slug, bareId) };
  return endpoint;
}

/** Pure coord_links (blocker → blocked) to work_item_deps (blocked → blocker) mapping. */
export function workItemBlockingEdge(
  blocker: WorkItemDepEndpoint,
  blocked: WorkItemDepEndpoint,
): WorkItemBlockingEdge | null {
  if (blocker.kind === blocked.kind && blocker.ref === blocked.ref) return null;
  // AFTER the self-edge check: a self-edge is a legitimate no-op the callers rely on, so it must
  // stay a quiet `null` even if both its endpoints are malformed.
  assertDepEndpointRefForm(blocked, 'blocked');
  assertDepEndpointRefForm(blocker, 'blocker');
  return {
    blocked_kind: blocked.kind,
    blocked_ref: blocked.ref,
    blocker_kind: blocker.kind,
    blocker_ref: blocker.ref,
    dep_type: 'blocks',
  };
}

/**
 * Mirror one coord_links `blocks` edge into the scheduler's readiness store.
 * coord_links uses blocker → blocked orientation; work_item_deps stores the
 * same edge as blocked → blocker. Keeping this conversion here gives every
 * work-item link writer one durable mirror primitive.
 */
export async function mirrorWorkItemBlockingEdge(
  blocker: WorkItemDepEndpoint,
  blocked: WorkItemDepEndpoint,
  opts: { createdBy?: string } = {},
): Promise<void> {
  // EI-19387076313999646: resolve BOTH endpoints against their actual target row's family
  // before writing — closes the link-seam half of D-017 (see resolveActualDepEndpoint above).
  const [resolvedBlocker, resolvedBlocked] = await Promise.all([
    resolveActualDepEndpoint(blocker),
    resolveActualDepEndpoint(blocked),
  ]);
  const edge = workItemBlockingEdge(resolvedBlocker, resolvedBlocked);
  if (!edge) return;
  const { sql } = getOrgPg();
  await sql`
    INSERT INTO harness_shared.work_item_deps
      (workspace_id, blocked_kind, blocked_ref, blocker_kind, blocker_ref, dep_type, created_by)
    VALUES
      (${DEFAULT_COORD_WORKSPACE}, ${edge.blocked_kind}, ${edge.blocked_ref}, ${edge.blocker_kind}, ${edge.blocker_ref}, ${edge.dep_type}, ${opts.createdBy ?? null})
    ON CONFLICT (workspace_id, blocked_kind, blocked_ref, blocker_kind, blocker_ref, dep_type)
    DO NOTHING`;
}

/** Remove the scheduler-readiness mirror for one coord_links `blocks` edge. */
export async function removeMirroredWorkItemBlockingEdge(
  blocker: WorkItemDepEndpoint,
  blocked: WorkItemDepEndpoint,
): Promise<void> {
  // Same resolution as the write path (EI-19387076313999646): an unlink call passing the
  // ORIGINAL (possibly mis-declared) kind+ref must still find the CORRECTED row that was
  // actually inserted, or the edge becomes un-removable through this door.
  const [resolvedBlocker, resolvedBlocked] = await Promise.all([
    resolveActualDepEndpoint(blocker),
    resolveActualDepEndpoint(blocked),
  ]);
  const { sql } = getOrgPg();
  await sql`
    DELETE FROM harness_shared.work_item_deps
     WHERE workspace_id = ${DEFAULT_COORD_WORKSPACE}
       AND blocked_kind = ${resolvedBlocked.kind}
       AND blocked_ref = ${resolvedBlocked.ref}
       AND blocker_kind = ${resolvedBlocker.kind}
       AND blocker_ref = ${resolvedBlocker.ref}
       AND dep_type = 'blocks'`;
}

/** blocked feature_id → blocker feature_ids (within `harnessSlug`, prefix-stripped). Pure read. */
export async function getWorkItemDepBlockers(harnessSlug: string): Promise<Map<string, string[]>> {
  const { sql } = getOrgPg();
  const prefix = `${harnessSlug}#`;
  const rows = await sql<{ blocked_ref: string; blocker_ref: string }[]>`
    SELECT blocked_ref, blocker_ref
      FROM harness_shared.work_item_deps
     WHERE workspace_id = ${DEFAULT_COORD_WORKSPACE}
       AND dep_type = 'blocks'
       AND blocked_kind = ${FEATURE_KIND}
       AND blocker_kind = ${FEATURE_KIND}
       AND blocked_ref LIKE ${prefix + '%'}`;
  const out = new Map<string, string[]>();
  for (const r of rows) {
    if (!r.blocked_ref.startsWith(prefix) || !r.blocker_ref.startsWith(prefix)) continue;
    const blocked = r.blocked_ref.slice(prefix.length);
    const blocker = r.blocker_ref.slice(prefix.length);
    const arr = out.get(blocked) ?? [];
    if (!arr.includes(blocker)) arr.push(blocker);
    out.set(blocked, arr);
  }
  return out;
}

/**
 * Acyclicity guard (P-008): would REPLACING `blocked`'s blocker set with `newBlockers` create a
 * dependency cycle? Pure (reuses detectDependencyCycle). Replace-semantics matches the writer
 * (delete + insert the blocked item's edges); self-edges are dropped (the no-self-block invariant).
 */
export function wouldCreateCycle(
  current: ReadonlyMap<string, readonly string[]>,
  blocked: string,
  newBlockers: readonly string[],
): boolean {
  const edges = new Map<string, string[]>();
  for (const [k, v] of current) if (k !== blocked) edges.set(k, [...v]);
  edges.set(blocked, Array.from(new Set(newBlockers.filter((b) => b !== blocked))));
  return detectDependencyCycle(edges).hasCycle;
}

/**
 * Resolve ONE work-item id to the endpoint form its own family requires (EI-19325959789634791).
 *
 * This is the DB-backed other half of `assertDepEndpointRefForm`. That guard is pure, so it can
 * only check ref FORM against a DECLARED kind; it cannot tell that the declared kind disagrees
 * with the row the ref points at. Deciding the kind from the TARGET closes exactly that gap —
 * the mismatch stops being expressible rather than merely being detected.
 *
 * The mapping is the one both floors already use, and it must stay that way or the edge is
 * invisible to both:
 *   - feature  → harness-QUALIFIED `<harness>#<id>`, gated by work_item_is_blocked() + the
 *                work_item_blocked sidecar.
 *   - issue    → BARE `<id>`, gated by depsBlockedExclusionSql, which keys on the bare
 *                feature_id because the wir_* sidecar triggers do not track issues.
 *
 * ABSENT rows resolve to FEATURE, preserving the prior behavior: an edge naming a blocker with
 * no row must still be writable (an absent blocker never deadlocks — see the claim-readiness
 * suite's "ABSENT blocker ref does NOT block" cases), and feature is the form those tests pin.
 */
async function resolveDepEndpoint(
  tx: { <T extends readonly unknown[]>(strings: TemplateStringsArray, ...args: never[]): Promise<T> },
  harnessSlug: string,
  id: string,
): Promise<WorkItemDepEndpoint> {
  // Resolved against `engineer_issues` — the SAME relation the issue floor's blocker leg
  // (unsatisfiedBlockerSql: `bi.issue_id = d.blocker_ref`) consults, and matched the same way,
  // on the bare id with no harness qualifier. Asking the floor's own relation is the point: a
  // family lookup that disagrees with the floor would just relocate this bug. Deliberately NOT
  // scoped by workspace_id — family is a property of the item, not of the tenant reading it,
  // and scoping here would resolve the same item differently per caller.
  const rows = await tx<{ one: number }[]>`
    SELECT 1 AS one FROM harness_shared.engineer_issues
     WHERE issue_id = ${id as never} LIMIT 1`;
  // Only a row that positively identifies as issue-family takes the bare form. Unknown/absent
  // stays feature — see the header: absent blockers must remain writable.
  return rows.length > 0
    ? { kind: ISSUE_ENDPOINT_KIND, ref: id }
    : { kind: FEATURE_KIND, ref: featureRef(harnessSlug, id) };
}

/**
 * Set ONE work-item's `blocks` edges in work_item_deps to exactly `blockedBy` (delete + insert),
 * rejecting any set that would introduce a cycle (P-008). Transactional + idempotent. Mirrors
 * syncFeatureBlockEdges (coord_links) so the dual-write / cutover (P-003) is a 1:1 swap.
 *
 * ⚠ EI-19325959789634791 / D-017 — endpoint kind is resolved from the TARGET ROW'S FAMILY, not
 * assumed to be `feature`. It was assumed for a long time, and the assumption held only because
 * the sole caller (promotion) feeds items it just MINTED, which are always feature-family.
 * P-009's backfill widened the input to the whole `implements` plane — which includes
 * convertPlanItem-created issue-family items — and every edge it wrote for one of those was
 * SILENTLY INERT: written with kind='feature' + a qualified ref, while the issue floor matches a
 * BARE ref, and the feature floor never evaluates an issue row at all. 6 such rows landed live,
 * 3 on genuinely-open items with non-terminal blockers, while every counter reported success.
 *
 * The DELETE deliberately clears BOTH endpoint forms for the blocked side, not just the one this
 * call is about to write. That is what makes the repair self-healing: re-running over an item
 * whose edges were written under the old feature-only assumption removes the inert rows instead
 * of leaving them behind next to the correct ones.
 */
export async function syncWorkItemDepEdges(
  harnessSlug: string,
  featureId: string,
  blockedBy: readonly string[],
  opts: { enforceAcyclicity?: boolean } = {},
): Promise<void> {
  // Acyclicity is enforced for DIRECT writes (default). The transitional dual-write from
  // syncFeatureBlockEdges passes enforceAcyclicity:false — coord_links already accepted the set,
  // so the mirror must not throw (it would break the authoritative write during the cutover).
  if (opts.enforceAcyclicity ?? true) {
    const current = await getWorkItemDepBlockers(harnessSlug);
    if (wouldCreateCycle(current, featureId, blockedBy)) {
      throw new Error(
        `work_item_deps: setting blocked_by for ${harnessSlug}#${featureId} would create a dependency cycle`,
      );
    }
  }
  const { sql } = getOrgPg();
  const qualifiedBlockedRef = featureRef(harnessSlug, featureId);
  await sql.begin(async (tx) => {
    // SERIALIZE concurrent replaces OF THE SAME BLOCKED ITEM (P-011).
    //
    // This function's contract is REPLACE — "set this item's blocks edges to EXACTLY
    // blockedBy" — and delete-then-insert does not deliver that under concurrency. At
    // READ COMMITTED, two overlapping calls each run their DELETE against a snapshot that
    // does not yet contain the other's uncommitted INSERT, so both delete nothing and take
    // NO row locks (there are no rows yet to lock — it is a phantom, not a lost update).
    // Both INSERTs then land on different unique keys and both commit, leaving the UNION
    // of two intents: a blocker set no writer asked for. Reproduced 3/3 in
    // dependency-concurrency.integration.test.ts before this lock existed.
    //
    // The damaging direction is REMOVAL: a sync that drops a blocker races one that keeps
    // it, the drop is lost, and the stale edge withholds the item forever — INV-05's
    // "work silently stalls and no error is raised anywhere", arriving with every counter
    // reporting success.
    //
    // A transaction-scoped advisory lock keyed on the BLOCKED item is the narrowest fix:
    // it is released automatically on commit/rollback, different items hash to different
    // keys so unrelated writers never contend, and exactly one lock is taken per
    // transaction so no lock-ordering deadlock is possible. Raising the isolation level
    // instead would push serialization failures onto every caller of a writer that is
    // deliberately fire-and-forget.
    await tx`SELECT pg_advisory_xact_lock(hashtext(${`wid:${DEFAULT_COORD_WORKSPACE}:${qualifiedBlockedRef}` as never}))`;

    const blocked = await resolveDepEndpoint(tx as never, harnessSlug, featureId);
    // Clear BOTH endpoint forms for this blocked item, not just the one we are about to write:
    // rows minted under the old feature-only assumption are otherwise left behind, inert, beside
    // the correct ones. This is what makes a re-run repair rather than merely append.
    await tx`
      DELETE FROM harness_shared.work_item_deps
       WHERE workspace_id = ${DEFAULT_COORD_WORKSPACE} AND dep_type = 'blocks'
         AND (
           (blocked_kind = ${FEATURE_KIND} AND blocked_ref = ${qualifiedBlockedRef})
           OR (blocked_kind = ${ISSUE_ENDPOINT_KIND} AND blocked_ref = ${featureId})
         )`;
    for (const b of blockedBy) {
      const blocker = await resolveDepEndpoint(tx as never, harnessSlug, b);
      if (blocker.kind === blocked.kind && blocker.ref === blocked.ref) continue; // no self-block
      // Route through the shared pure guard so the kind↔ref-FORM invariant is enforced on this
      // write path too. It previously bypassed it entirely: syncWorkItemDepEdges hand-rolled its
      // INSERT while only the two link doors funnelled through workItemBlockingEdge, so the
      // "ONE write seam" the P-005 guard documents was in fact two, and this was the unguarded one.
      const edge = workItemBlockingEdge(blocker, blocked);
      if (!edge) continue;
      await tx`
        INSERT INTO harness_shared.work_item_deps
          (workspace_id, blocked_kind, blocked_ref, blocker_kind, blocker_ref, dep_type)
        VALUES (${DEFAULT_COORD_WORKSPACE}, ${edge.blocked_kind}, ${edge.blocked_ref}, ${edge.blocker_kind}, ${edge.blocker_ref}, 'blocks')
        ON CONFLICT DO NOTHING`;
    }
  });
}
