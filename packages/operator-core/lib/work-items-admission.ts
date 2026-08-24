/**
 * G2 admission predicate — the SINGLE source of truth for "is this feature-family
 * work-item auto-runnable without auditor screening?".
 *
 * Plan: shared-hive-trust-admission-2026-06-14 (P-001). Successor to the shipped
 * papercusp-user-protection-gate-2026-05-31, whose gate was enforced ONLY on the
 * feature-frontier read (`dbos/orchestrator-loop.ts` readFrontierFeatures +
 * `@papercusp/orchestrator` state-pg.ts readFeaturesPg). The Hive's fleet/blackboard
 * distribution layer — `claimNextWorkItem`, `claimWorkItem`, `claimReplicaSlotLocal`,
 * `fleet:place_batch` (gatherFrontier) — grew up around that one read and never
 * inherited the predicate, so un-screened REMOTE work was claimable + runnable. This
 * module is that one predicate, applied at EVERY claim/place chokepoint so a future
 * path can't silently re-open the hole.
 *
 * Rule (mirrors `@papercusp/orchestrator` isAutoPickable, D-006 of the predecessor):
 * an item is auto-pickable iff it was authored LOCALLY (origin 'local' or NULL, the
 * pre-G1 back-compat case) OR the auditor ADMITTED it (audit_verdict = 'admit').
 * Remote + un-admitted ⇒ quarantined — fail-safe: it holds even if the auditor lane
 * is unwired/errors/lags. The TRUST-LIST fast-path (a trusted author's
 * verified_author_github_user_id) joins this predicate in Phase 3; the column lands
 * in Phase 2. Until then this is the exact behaviour of the proven frontier gate,
 * brought to every other path.
 */
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from './workspace-registry';

type OrgSql = ReturnType<typeof getOrgPg>['sql'];

/**
 * JS form — filter already-loaded rows (placement-gather, list surfacing). Keep this
 * byte-identical in meaning to {@link autoPickableWhereSql}; the drift-guard test
 * (P-006) asserts both agree with `@papercusp/orchestrator` isAutoPickable.
 */
export function isAutoPickable(
  origin: string | null | undefined,
  auditVerdict: string | null | undefined,
  verifiedAuthorGithubUserId?: number | null,
  trustedGithubUserIds?: ReadonlySet<number>,
  authorPubkey?: string | null,
  ownAuthorPubkeys?: ReadonlySet<string>,
): boolean {
  // Local features always bypass the auditor — origin NULL = local (pre-G1 back-compat).
  if (origin == null || origin === 'local') return true;
  // Remote features are pickable when the auditor has admitted them…
  if (auditVerdict === 'admit') return true;
  // …OR the OWN-NODE fast-path: the row was authored by a substrate-log key this
  // workspace already knows as its own (see ownAuthorWhereSql for why that is sound).
  // A blank/absent pubkey NEVER qualifies — see the guards there.
  if (
    authorPubkey != null &&
    authorPubkey !== '' &&
    ownAuthorPubkeys != null &&
    ownAuthorPubkeys.has(authorPubkey)
  ) {
    return true;
  }
  // …OR the TRUST fast-path (Phase 3 / P-010): a remote+un-admitted item whose
  // VERIFIED author (P-008, never a self-claimed id) is in the owner's LOCAL trust
  // list. The verified id must be present AND in the trusted set — a NULL verified
  // id (unverified / revoked binding / local row) never satisfies it. The caller
  // supplies the workspace's trusted set (it is owner/workspace-scoped — D-004).
  if (
    verifiedAuthorGithubUserId != null &&
    trustedGithubUserIds != null &&
    trustedGithubUserIds.has(verifiedAuthorGithubUserId)
  ) {
    return true;
  }
  return false;
}

/**
 * Issue-family (bug/change/task) LOCAL-claimability predicate — the issue-family
 * counterpart of {@link isAutoPickable}, but SIMPLER: a federated (origin='remote')
 * issue-family row is owned EXCLUSIVELY by its authoring peer's core (the
 * hyperbee->PG projector writes it under LWW — see EI-7833 / migration 521's
 * engineer_issues_view_dml remote-skip guard, and the hard invariant enforced at
 * work-items.ts's issue-family setWorkItemState: "its authoring peer must
 * claim/resolve it"). Unlike the feature family, there is NO audit-admit /
 * trust-list escape hatch here — a remote issue-family row is never locally
 * claimable, full stop. `origin` NULL (pre-federation back-compat) or 'local' is
 * locally claimable; anything else (today only 'remote') is not.
 *
 * WI-3649: `claimNextIssueWorkItem` (the claim_next/scheduler:get_next self-select),
 * `listWorkItems`'s issue branch (`admissibleOnly`), and `observeWorkItem` must all
 * apply this SAME predicate so "claimable"/"available" means what the actual claim
 * path (`claimIssue`'s view-trigger) will honor — mirroring EI-7841's fix, which
 * closed the identical read/write gap for the feature family only.
 */
export function isIssueLocallyClaimable(origin: string | null | undefined): boolean {
  return origin == null || origin === 'local';
}

/**
 * ADMISSION-GATE state — the second, orthogonal admission axis (plan
 * work-queue-admission-and-bulk-dedup-2026-08-24, owner-directed 2026-08-24).
 *
 * WHY IT LIVES HERE rather than in a new module: this file is already "the SINGLE
 * source of truth for is-this-claimable", and the predecessor's whole lesson (see
 * the header) is that an admission rule defined next to ONE consumer silently fails
 * to reach the others. A parallel gate would repeat that exact mistake.
 *
 * ORTHOGONAL, NOT a replacement: the G2 legs above answer "may we run work authored
 * ELSEWHERE?"; this answers "has this item cleared DUPLICATE screening?". A claim
 * chokepoint must satisfy both.
 *
 * The states, and why NULL means admitted:
 *   NULL         legacy / pre-gate row ⇒ ADMITTED (back-compat, exactly as origin
 *                NULL = local above). Every row predating migration 944 is NULL, and
 *                treating those as pending would quarantine the entire live backlog.
 *   'pending'    born-pending; invisible to claim/place until the promoter judges it.
 *   'admitted'   promoter judged it — duplicate screening only, NEVER merit
 *                (redundancy kappa 0.679 vs merit kappa 0.289; plan charter).
 *   'auto'       filing-time bypass: plan-promoted (already passed plan review) or
 *                critical/security severity (post-hoc review instead).
 *   'unreviewed' FAIL-OPEN auto-promotion — the promoter was dead or lagging past its
 *                deadline. Claimable BY DESIGN: the measured system bottleneck is
 *                distribution (greenlit plans sat six days unclaimed), so a dead
 *                promoter must never silently starve the queue. Tagged so the stats
 *                ledger can alarm on a non-zero steady-state count.
 *
 * FAIL-SAFE DIRECTION IS DELIBERATELY INVERTED relative to the G2 legs. There, an
 * unwired auditor must not admit foreign code, so unknown ⇒ refuse. Here, an unwired
 * promoter must not freeze the queue, so unknown ⇒ admit. Both choose the direction
 * whose failure mode is recoverable: a duplicate that slips through is merged later;
 * a starved queue stops all work and is invisible until someone notices.
 */
export type WorkItemAdmission = 'pending' | 'admitted' | 'auto' | 'unreviewed';

/**
 * The `admission` value a NEW item is born with, or `null` for "don't stamp it"
 * (legacy/pre-gate semantics — {@link isAdmitted} reads NULL as admitted).
 *
 * Deliberately NOT `WorkItemAdmission` at the create seam: a filing path may only
 * ever mint 'pending' (gated) or 'auto' (a filing-time bypass it can justify on the
 * spot). 'admitted' is the PROMOTER's verdict and 'unreviewed' is the fail-open
 * watchdog's — neither is something a writer may claim about itself, so the type
 * refuses it rather than relying on a convention nobody reads.
 */
export type BornAdmission = Extract<WorkItemAdmission, 'pending' | 'auto'>;

export function isAdmitted(admission: string | null | undefined): boolean {
  return admission !== 'pending';
}

/**
 * SQL form of {@link isAdmitted} — UNQUALIFIED columns, for single-table queries over
 * `harness_features_consolidated` / `work_items`, matching {@link autoPickableWhereSql}.
 *
 * `IS DISTINCT FROM` rather than `<> 'pending' OR IS NULL`: plain `<>` is NULL-false in
 * three-valued logic, which would silently exclude every legacy row — the exact
 * negated-predicate trap the own-author leg's comment warns about.
 */
export function admittedWhereSql(sql: OrgSql) {
  return sql`(admission IS DISTINCT FROM 'pending')`;
}

/**
 * `wi.`-qualified form — compose ONLY into the issue claim/diagnose queries that alias
 * the base table as `wi` (same contract as {@link isIssueLocallyClaimableWhereSql}).
 */
export function admittedWhereSqlWi(sql: OrgSql) {
  return sql`(wi.admission IS DISTINCT FROM 'pending')`;
}

/**
 * SQL form — a composable WHERE fragment for the porsager `sql` instance the caller
 * already holds (so it composes into that query). Columns are UNQUALIFIED — use only
 * in single-table queries over `harness_features_consolidated` (every claim/place
 * chokepoint is one). Pass the caller's own `sql`.
 *
 *   ...WHERE ... AND ${autoPickableWhereSql(sql)}
 */
export function autoPickableWhereSql(sql: OrgSql, workspaceId?: string) {
  // TRUST fast-path (Phase 3 / P-010). The subquery MUST be explicitly scoped to
  // `workspaceId` — NOT left to user_trust_list's RLS — because the admin db
  // handle BYPASSES RLS at some claim chokepoints, so an unscoped subquery would
  // trust-admit a workspace-A feature whose verified author is trusted in
  // workspace B (a cross-workspace trust leak, D-004). `workspaceId` omitted ⇒ the
  // trust leg is dropped entirely (fail-safe: the gate only ever UNDER-admits when
  // the caller can't scope it — never over-admits). verified_author_github_user_id
  // (P-008) is NULL for local / unverified / revoked-binding rows, so only a
  // genuinely-verified trusted author satisfies it.
  const trustLeg = workspaceId
    ? sql` OR (verified_author_github_user_id IS NOT NULL AND verified_author_github_user_id IN (SELECT trusted_github_user_id FROM harness_shared.user_trust_list WHERE workspace_id = ${workspaceId}))`
    : sql``;
  const ownLeg = workspaceId ? sql` OR ${ownAuthorWhereSql(sql, workspaceId)}` : sql``;
  return sql`(origin = 'local' OR origin IS NULL OR audit_verdict = 'admit'${trustLeg}${ownLeg})`;
}

/**
 * OWN-NODE admission leg — the default that makes a single owner's own machines
 * trust each other with no configuration [owner 2026-07-13: "trust our own
 * nodes ... that should be the default. all new papercusp installs should have
 * that behavior without needing to do anything"].
 *
 * WHY THIS EXISTS. `origin` records HOW A ROW ARRIVED, not who wrote it: an item
 * this workspace authored itself, once it round-trips through the 2-machine
 * federation path, comes back projected as origin='remote'. With the auditor lane
 * unbuilt (nothing in production has ever written audit_verdict) and the trust list
 * empty, such a row satisfied NO leg of the gate — so a pot whose whole frontier had
 * federated was quarantined against ITSELF: the Queen surveyed a frontier of zero,
 * correctly placed nothing, and reported success. Silent placement deadlock.
 *
 * WHAT MAKES A KEY "OURS" — and why this is sound rather than a loophole. A row is
 * stamped origin='local' only when OUR OWN core writes it; a peer's row is projected
 * as 'remote'. So "has authored a local-origin row in THIS workspace" is a property a
 * foreign key cannot manufacture from the outside — it is evidence our own substrate
 * log produced that key's writes. It also needs no registry and no setup: a fresh
 * install's first local write enrolls its own key, and a stranger's key never appears.
 *
 * NOT the device-attestation key space. `pot_members.device_attestations[].device_pubkey`
 * is a DIFFERENT key (and base64, where author_pubkey is hex) — it does not identify the
 * substrate log author, so it cannot answer this question.
 *
 * LOAD-BEARING GUARDS:
 *   - workspace-scoped (D-004), for the same admin-handle/RLS-bypass reason as the
 *     trust leg above; `workspaceId` omitted ⇒ the leg is dropped (fail-safe).
 *   - author_pubkey <> '' on BOTH sides. Blank-authored local rows exist (a pre-
 *     federation back-compat case); without this guard '' would enter the own-key set
 *     and admit EVERY remote row that also carries a blank author — turning a scoped
 *     trust decision into an open door.
 * The leg is POSITIVE (an OR arm), so a NULL author_pubkey is falsy in WHERE and simply
 * fails to admit — the three-valued-logic trap only bites a NEGATED predicate.
 */
export function ownAuthorWhereSql(sql: OrgSql, workspaceId: string) {
  return sql`(author_pubkey IS NOT NULL AND author_pubkey <> '' AND author_pubkey IN (
    SELECT DISTINCT author_pubkey
      FROM harness_shared.harness_features_consolidated
     WHERE workspace_id = ${workspaceId}
       AND (origin = 'local' OR origin IS NULL)
       AND author_pubkey IS NOT NULL
       AND author_pubkey <> ''
  ))`;
}

/**
 * ISSUE-FAMILY own-node leg (work-item-status-full-unify / owner 2026-07-20 "these can't be
 * truly remote"). The FEATURE family already trusts its own nodes via {@link ownAuthorWhereSql}
 * (owner 2026-07-13 "trust our own nodes = the default"); the issue family (isIssueLocallyClaimable)
 * historically hard-refused any origin!='local', with NO escape hatch. But `origin` records HOW a
 * row ARRIVED, not WHO wrote it: a bug THIS box authored, once it round-trips the hyperbee
 * federation, comes back projected origin='remote' — and when the box's substrate node identity
 * drifts (re-provision / device re-key / hive re-join), work authored under the OLD identity is
 * orphaned as un-claimable. This leg admits a remote issue whose author_pubkey is one this
 * workspace has ALSO written locally (evidence OUR substrate log produced it — a foreign key can't
 * manufacture that). Own-keys come from the work_items BASE (ALL families), because a substrate key
 * authors both features and issues; {@link ownAuthorWhereSql}'s harness_features_consolidated
 * source would miss an identity that authored only issues. Columns are `wi.`-qualified — compose
 * ONLY into the issue claim/diagnose queries that alias the base table as `wi`. Same LOAD-BEARING
 * guards as ownAuthorWhereSql: workspace-scoped (D-004), author_pubkey<>'' on BOTH sides.
 */
export function issueOwnAuthorWhereSql(sql: OrgSql, workspaceId: string) {
  return sql`(wi.author_pubkey IS NOT NULL AND wi.author_pubkey <> '' AND wi.author_pubkey IN (
    SELECT own.author_pubkey
      FROM harness_shared.work_items own
     WHERE own.workspace_id = ${workspaceId}
       AND (own.origin = 'local' OR own.origin IS NULL)
       AND own.author_pubkey IS NOT NULL
       AND own.author_pubkey <> ''
  ))`;
}

/**
 * The issue-family locally-claimable SQL floor, own-node aware — the composable counterpart of
 * {@link isIssueLocallyClaimable}. `(origin local/null OR own-node)`; `workspaceId` omitted ⇒ the
 * own-node leg is dropped (fail-safe: only ever UNDER-admits when unscoped). `wi.`-qualified.
 */
export function isIssueLocallyClaimableWhereSql(sql: OrgSql, workspaceId?: string) {
  const ownLeg = workspaceId ? sql` OR ${issueOwnAuthorWhereSql(sql, workspaceId)}` : sql``;
  return sql`(wi.origin IS NULL OR wi.origin = 'local'${ownLeg})`;
}

/**
 * JS counterpart of {@link isIssueLocallyClaimableWhereSql} for a fetched row: local (origin
 * null/'local') OR its author is one of OUR own-node keys (load via {@link loadOwnAuthorPubkeys}).
 * `ownKeys` empty ⇒ degrades to the origin-only check (fail-safe).
 */
export function isIssueLocallyClaimableWithOwn(
  origin: string | null | undefined,
  authorPubkey: string | null | undefined,
  ownKeys: ReadonlySet<string>,
): boolean {
  if (isIssueLocallyClaimable(origin)) return true;
  return !!authorPubkey && authorPubkey !== '' && ownKeys.has(authorPubkey);
}

/**
 * Load this workspace's OWN substrate-log author keys — the JS-gate counterpart of
 * {@link ownAuthorWhereSql}. Workspace-scoped (D-004). Empty set on any read failure
 * (fail-safe: no own-node fast-path rather than over-broad admission).
 *
 * work-item-status-full-unify: derives from the work_items BASE (all families) so it also
 * feeds the issue-family own-node leg ({@link isIssueLocallyClaimableWithOwn}).
 */
export async function loadOwnAuthorPubkeys(workspaceId: string): Promise<Set<string>> {
  const out = new Set<string>();
  if (!workspaceId) return out;
  try {
    const { sql } = getOrgPg();
    const rows = await sql<{ author_pubkey: string }[]>`
      SELECT DISTINCT author_pubkey
        FROM harness_shared.work_items
       WHERE workspace_id = ${workspaceId}
         AND (origin = 'local' OR origin IS NULL)
         AND author_pubkey IS NOT NULL
         AND author_pubkey <> ''`;
    for (const r of rows) if (r.author_pubkey) out.add(r.author_pubkey);
  } catch {
    /* fail-safe — empty set ⇒ own-node fast-path simply doesn't fire */
  }
  return out;
}

/**
 * P-008 (Phase 2) — the PRODUCER side of the trust gate: resolve a federated
 * feature's `author_pubkey` to a github_user_id ONLY via a VERIFIED, non-revoked
 * device attestation in `hive_members` — never a self-claimed id. Returns NULL
 * when the pubkey has no such attestation (the caller stores NULL → the gate
 * conservatively refuses the trust fast-path). The trust DECISION stays at the
 * consumer (isAutoPickable / autoPickableWhereSql, ws-scoped per D-004); this
 * only establishes "who, provably, authored it".
 *
 * Security invariants (contributor-row-types.ts DeviceAttestationEntry +
 * revoked_pubkeys "a verifier MUST refuse any attestation whose pubkey is here"):
 *   - binding_status = 'verified'  (BINDING_STATUSES: verified|pending|unverified)
 *   - author_pubkey ∈ device_attestations (an attested binding exists)
 *   - author_pubkey ∉ revoked_pubkeys (the device wasn't revoked)
 *   - workspace-scoped (hive_members is owner/workspace-keyed); pot_home_slug
 *     narrows further when known. The COALESCE guards keep a member with a NULL
 *     revoked_pubkeys / device_attestations from being wrongly excluded/erroring.
 */
export async function resolveVerifiedAuthorGithubId(
  sql: OrgSql,
  opts: { workspaceId: string; authorPubkey: string | null | undefined; potHomeSlug?: string },
): Promise<number | null> {
  const pubkey = (opts.authorPubkey ?? '').trim();
  if (!pubkey || !opts.workspaceId) return null;
  try {
    const hiveFilter = opts.potHomeSlug ? sql`AND pot_home_slug = ${opts.potHomeSlug}` : sql``;
    const rows = await sql<{ github_user_id: string | number }[]>`
      SELECT github_user_id
        FROM harness_shared.pot_members
       WHERE workspace_id = ${opts.workspaceId}
         ${hiveFilter}
         AND binding_status = 'verified'
         AND NOT (${pubkey} = ANY(COALESCE(revoked_pubkeys, ARRAY[]::text[])))
         AND EXISTS (
           SELECT 1
             FROM jsonb_array_elements(COALESCE(device_attestations, '[]'::jsonb)) a
            WHERE a->>'device_pubkey' = ${pubkey}
         )
       LIMIT 1`;
    if (!rows[0]) return null;
    const raw = rows[0].github_user_id;
    const id = typeof raw === 'string' ? Number(raw) : raw;
    return Number.isFinite(id) ? id : null;
  } catch {
    // Best-effort + FAIL-SAFE: an unreadable/absent hive_members (e.g. a transient
    // error, or a projection running against a partial schema) yields NULL → the
    // trust fast-path simply doesn't fire (the gate conservatively refuses), and
    // the federated-ingest projection loop is never crashed by the optional stamp.
    return null;
  }
}

/**
 * Load the owner's LOCAL trust list for a workspace as a Set<github_user_id> —
 * the JS-gate (isAutoPickable) counterpart of the SQL trust subquery. WORKSPACE-
 * SCOPED (D-004: the list is owner/workspace-keyed; a remote item must only be
 * trust-admitted against its OWN workspace's list, never cross-workspace). Empty
 * set on any read failure (fail-safe: no trust fast-path rather than over-broad).
 */
export async function loadTrustedGithubUserIds(workspaceId: string): Promise<Set<number>> {
  const out = new Set<number>();
  if (!workspaceId) return out;
  try {
    const { sql } = getOrgPg();
    const rows = await sql<{ trusted_github_user_id: string | number }[]>`
      SELECT trusted_github_user_id FROM harness_shared.user_trust_list
       WHERE workspace_id = ${workspaceId}`;
    for (const r of rows) {
      const raw = r.trusted_github_user_id;
      const id = typeof raw === 'string' ? Number(raw) : raw;
      if (Number.isFinite(id)) out.add(id);
    }
  } catch {
    /* fail-safe — empty set ⇒ trust fast-path simply doesn't fire */
  }
  return out;
}

/**
 * Per-id admission read for paths that don't already SELECT the item's provenance —
 * the replica lane reads `work_item_replicas`, not the consolidated feature row. Reads
 * origin + audit_verdict and applies {@link isAutoPickable}. A missing row returns
 * `false` (fail-safe: a vanished/foreign item never slips through here; the caller's
 * own not-found handling runs first for the legitimate-missing case).
 */
export async function isWorkItemAutoPickable(
  workItemId: string,
  opts: { harness: string; workspaceId?: string },
): Promise<boolean> {
  const { sql } = getOrgPg();
  const ws = opts.workspaceId ?? activeWorkspaceId();
  const rows = await sql<{ origin: string | null; audit_verdict: string | null; verified_author_github_user_id: number | string | null; author_pubkey: string | null }[]>`
    SELECT origin, audit_verdict, verified_author_github_user_id, author_pubkey
      FROM harness_shared.harness_features_consolidated
     WHERE harness_slug = ${opts.harness}
       AND workspace_id = ${ws}
       AND feature_id = ${workItemId}
     LIMIT 1`;
  if (!rows[0]) return false;
  // Local / auditor-admitted fast path (no trust-list read needed).
  if (isAutoPickable(rows[0].origin, rows[0].audit_verdict)) return true;
  // OWN-NODE fast-path: authored by a key this workspace knows as its own. Checked
  // in SQL against the SAME definition ownAuthorWhereSql uses, so this per-id path
  // can't drift from the claim/place chokepoints.
  const pubkey = rows[0].author_pubkey;
  if (pubkey) {
    const own = await sql`
      SELECT 1
        FROM harness_shared.harness_features_consolidated
       WHERE workspace_id = ${ws}
         AND (origin = 'local' OR origin IS NULL)
         AND author_pubkey = ${pubkey}
       LIMIT 1`;
    if (own.length > 0) return true;
  }
  // TRUST fast-path: a remote+un-admitted item whose VERIFIED author is in this
  // workspace's local trust list (explicitly ws-scoped — D-004). NULL verified id
  // (unverified / revoked / local) never qualifies.
  const raw = rows[0].verified_author_github_user_id;
  const verifiedId = raw == null ? null : typeof raw === 'string' ? Number(raw) : raw;
  if (verifiedId == null || !Number.isFinite(verifiedId)) return false;
  const trusted = await sql`
    SELECT 1 FROM harness_shared.user_trust_list
     WHERE workspace_id = ${ws} AND trusted_github_user_id = ${verifiedId} LIMIT 1`;
  return trusted.length > 0;
}
