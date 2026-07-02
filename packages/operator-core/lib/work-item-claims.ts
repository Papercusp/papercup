/**
 * work-item claim store — the live, mutually-exclusive, heartbeat-LEASED grip a Swarm
 * takes when it claim-pulls a ready item off its Hive backlog.
 *
 * Plan: decentralized-dispatch-scaling-2026-06-08 (Phase 1, P-004 / D-002).
 *
 * Low-level lease mechanics ONLY (acquire / heartbeat / release), mirroring the proven
 * plan-item claim store (`plan-items/claims.ts`) + the agent_file_locks lease shape: a
 * `claim_id` uuid, a TTL'd `expires_ts`, owner-checked heartbeat + release. Mutual
 * exclusion is the PK (one holder per work item). Every mutating op routes through the
 * per-HIVE claim AUTHORITY (`work-item-claim-authority.ts`) — local on a single box, an
 * RPC to the Hive's authority peer once the cross-Swarm mesh transport lands. When the
 * authority is unreachable the route fails OPEN to a local advisory lease (D-007 hybrid);
 * `work-item-claim-reconcile.ts` (P-005) resolves any resulting double-claim
 * deterministically on reconvergence.
 *
 * A lapsed claim is simply one whose `expires_ts <= now()`: `acquireClaim` steals it, so
 * a dead/idle Swarm's item returns to the backlog for another Swarm to work-steal (the
 * D-001 cross-Swarm pull). This is the mechanism; the POLICY (priority ordering,
 * open-claim vs assignee — D-008, P-002 needs-human) lives one layer up in the claim_next
 * wiring (P-006/P-010).
 *
 * NOT federated. NO RLS (coord-family); org handle + workspace_id filter.
 */
import { getOrgPg } from '@papercusp/db-org';
import { getWorkItemClaimAuthority } from './work-item-claim-authority';

export interface WorkItemClaim {
  workspaceId: string;
  harnessSlug: string;
  workItemId: string;
  hiveSlug: string | null;
  claimId: string;
  owner: string;
  ownerLabel: string | null;
  holderPubkey: string | null;
  intent: string;
  ttlSec: number;
  acquiredTs: string;
  expiresTs: string;
  lastActivityTs: string;
  /** Derived: the lease has lapsed (reclaimable) as of the read. */
  expired: boolean;
}

export interface AcquireOpts {
  workspaceId: string;
  harnessSlug: string;
  workItemId: string;
  owner: string;
  /** The authority scope (Hive home of the harness). Omit → routes by harnessSlug (single-harness fallback). */
  hiveSlug?: string | null;
  ownerLabel?: string | null;
  /** This Swarm's device pubkey — recorded for the fail-open reconcile (P-005). */
  holderPubkey?: string | null;
  intent?: string;
  ttlSec?: number;
}

export type AcquireResult =
  | { ok: true; claim: WorkItemClaim }
  | {
      ok: false;
      conflict: WorkItemClaim;
      /**
       * Set when the AUTHORITY refused the op on the CALLER's standing rather
       * than on contention (EI-284): the caller's holder pubkey is in the
       * hive's revoked set. The `conflict` is a synthetic zero-claim (no real
       * holder to report). Carried on the wire so a refused swarm can tell
       * "lost the race" from "I am revoked".
       */
      refused?: 'caller_revoked';
    };

export const DEFAULT_WORK_ITEM_TTL_SEC = 1800; // 30m — generous for an LLM work turn; renewed by heartbeat
export const MAX_WORK_ITEM_TTL_SEC = 7200; // 2h hard cap (an explicit extend for a long op)

/**
 * The authority-RPC op kinds for the three mutating claim ops (D-002). A claim op routed
 * to a REMOTE Hive authority carries one of these `kind`s + a serialisable payload over
 * the peer-RPC transport; the authority re-runs the matching `*Local` fn against ITS store
 * (registered via work-item-claim-authority-ops.ts). Distinct from the plan-item
 * `plan-item.claim.*` and file-lock `lock.*` kinds — registerAuthorityOp throws on a dup.
 */
export const WORK_ITEM_CLAIM_OP_KINDS = {
  acquire: 'work-item.claim.acquire',
  heartbeat: 'work-item.claim.heartbeat',
  release: 'work-item.claim.release',
  releaseForItem: 'work-item.claim.release-for-item',
} as const;

/** The authority scope key for an op: the Hive home if present, else the harness slug. */
function scopeOf(opts: { hiveSlug?: string | null; harnessSlug: string }): string {
  return opts.hiveSlug && opts.hiveSlug.length > 0 ? opts.hiveSlug : opts.harnessSlug;
}

/**
 * Acquire the live claim on a work item. Atomically takes a FREE item, STEALS an expired
 * (lapsed) claim, or extends the caller's OWN claim; refuses (ok:false) if a live claim is
 * held by another owner. Routed through the per-Hive claim authority: runs
 * `acquireClaimLocal` here when we are the authority (single box → always), else RPCs the
 * authority peer, else fails open to a local advisory lease (D-007).
 */
export async function acquireClaim(opts: AcquireOpts): Promise<AcquireResult> {
  return getWorkItemClaimAuthority().route(scopeOf(opts), {
    local: () => acquireClaimLocal(opts),
    remote: { kind: WORK_ITEM_CLAIM_OP_KINDS.acquire, payload: opts, decode: (raw) => raw as AcquireResult },
  });
}

/**
 * The LOCAL (un-routed) execution of acquire — the raw SQL against THIS peer's PG.
 * Exported so the authority-op registry can run it on the authority's store on a remote
 * peer's behalf (the receiving side of the RPC); normal callers use `acquireClaim`.
 */
export async function acquireClaimLocal(opts: AcquireOpts): Promise<AcquireResult> {
  const ttlSec = clampTtl(opts.ttlSec ?? DEFAULT_WORK_ITEM_TTL_SEC);
  const { sql } = getOrgPg();
  const rows = await sql<ClaimDbRow[]>`
    INSERT INTO harness_shared.work_item_claims
      (workspace_id, harness_slug, work_item_id, hive_slug, owner, owner_label, holder_pubkey,
       intent, ttl_sec, acquired_ts, expires_ts, last_activity_ts)
    VALUES
      (${opts.workspaceId}, ${opts.harnessSlug}, ${opts.workItemId}, ${opts.hiveSlug ?? null},
       ${opts.owner}, ${opts.ownerLabel ?? null}, ${opts.holderPubkey ?? null},
       ${opts.intent ?? ''}, ${ttlSec}, clock_timestamp(),
       clock_timestamp() + make_interval(secs => ${ttlSec}), clock_timestamp())
    ON CONFLICT (workspace_id, harness_slug, work_item_id) DO UPDATE SET
      claim_id         = gen_random_uuid(),
      hive_slug        = EXCLUDED.hive_slug,
      owner            = EXCLUDED.owner,
      owner_label      = EXCLUDED.owner_label,
      holder_pubkey    = EXCLUDED.holder_pubkey,
      intent           = EXCLUDED.intent,
      ttl_sec          = EXCLUDED.ttl_sec,
      acquired_ts      = clock_timestamp(),
      expires_ts       = clock_timestamp() + make_interval(secs => ${ttlSec}),
      last_activity_ts = clock_timestamp()
    WHERE harness_shared.work_item_claims.expires_ts <= clock_timestamp()
       OR harness_shared.work_item_claims.owner = EXCLUDED.owner
    RETURNING workspace_id, harness_slug, work_item_id, hive_slug, claim_id, owner,
           owner_label, holder_pubkey, intent, ttl_sec, acquired_ts, expires_ts,
           last_activity_ts, (expires_ts <= clock_timestamp()) AS expired
  `;
  if (rows[0]) return { ok: true, claim: claimFromDb(rows[0]) };
  // Conflict update skipped → a LIVE claim held by another owner. Report it.
  // Use SELECT FOR UPDATE to lock the row during check to prevent concurrent claims
  // on a freed item (race condition: two agents both get null from getClaim(), then both
  // execute INSERT). The lock ensures only one agent can proceed if the row was just released.
  const held = await sql<ClaimDbRow[]>`
    SELECT workspace_id, harness_slug, work_item_id, hive_slug, claim_id, owner,
           owner_label, holder_pubkey, intent, ttl_sec, acquired_ts, expires_ts,
           last_activity_ts, (expires_ts <= clock_timestamp()) AS expired
      FROM harness_shared.work_item_claims
     WHERE workspace_id = ${opts.workspaceId} AND harness_slug = ${opts.harnessSlug}
       AND work_item_id = ${opts.workItemId}
      FOR UPDATE
  `;
  if (held[0]) {
    const claim = claimFromDb(held[0]);
    return { ok: false, conflict: claim };
  }
  // Row doesn't exist (or is about to be inserted by another concurrent transaction that
  // locked it). Attempt to insert atomically. If another agent already inserted while we
  // were acquiring the lock, we'll get 0 rows back and fall through to the final check.
  const retry = await sql<ClaimDbRow[]>`
    INSERT INTO harness_shared.work_item_claims
      (workspace_id, harness_slug, work_item_id, hive_slug, owner, owner_label, holder_pubkey,
       intent, ttl_sec, acquired_ts, expires_ts, last_activity_ts)
    VALUES
      (${opts.workspaceId}, ${opts.harnessSlug}, ${opts.workItemId}, ${opts.hiveSlug ?? null},
       ${opts.owner}, ${opts.ownerLabel ?? null}, ${opts.holderPubkey ?? null},
       ${opts.intent ?? ''}, ${ttlSec}, clock_timestamp(),
       clock_timestamp() + make_interval(secs => ${ttlSec}), clock_timestamp())
    ON CONFLICT (workspace_id, harness_slug, work_item_id) DO NOTHING
    RETURNING workspace_id, harness_slug, work_item_id, hive_slug, claim_id, owner,
           owner_label, holder_pubkey, intent, ttl_sec, acquired_ts, expires_ts,
           last_activity_ts, (expires_ts <= clock_timestamp()) AS expired
  `;
  if (retry[0]) return { ok: true, claim: claimFromDb(retry[0]) };
  const after = await getClaim(opts.workspaceId, opts.harnessSlug, opts.workItemId);
  return after ? { ok: false, conflict: after } : { ok: false, conflict: synthMissing(opts) };
}

export interface HeartbeatResult {
  /** The lease was renewed (expires_ts pushed out). */
  renewed: boolean;
  /** The claim is still held by the caller. */
  held: boolean;
  expiresTs: string | null;
  reason?: string;
}

/** Serialisable heartbeat params — the payload an authority RPC carries (D-002). */
export interface HeartbeatClaimParams {
  workspaceId: string;
  harnessSlug: string;
  workItemId: string;
  hiveSlug?: string | null;
  claimId: string;
  owner: string;
  ttlSecOverride?: number;
  /** The caller's device pubkey, for the authority-side standing gate (EI-284).
   *  Optional: absent → the gate skips (no identity to judge, fail-open). The
   *  heartbeatClaimLocal SQL never reads it — claim_id+owner key the renewal. */
  holderPubkey?: string | null;
}

/**
 * Renew the lease. Owner + claim_id + not-yet-expired are required (a lapsed claim must be
 * re-acquired, not heartbeated back to life). Any heartbeat renews (the Swarm proving the
 * work is still in flight). Routed through the per-Hive claim authority.
 */
export async function heartbeatClaim(p: HeartbeatClaimParams): Promise<HeartbeatResult> {
  return getWorkItemClaimAuthority().route(scopeOf(p), {
    local: () => heartbeatClaimLocal(p),
    remote: { kind: WORK_ITEM_CLAIM_OP_KINDS.heartbeat, payload: p, decode: (raw) => raw as HeartbeatResult },
  });
}

/** The LOCAL (un-routed) heartbeat — raw SQL against THIS peer's PG. See `acquireClaimLocal`. */
export async function heartbeatClaimLocal(p: HeartbeatClaimParams): Promise<HeartbeatResult> {
  const { workspaceId, harnessSlug, workItemId, claimId, owner, ttlSecOverride } = p;
  const { sql } = getOrgPg();
  const rows = await sql<{ expires_ts: string }[]>`
    UPDATE harness_shared.work_item_claims
       SET ttl_sec = ${ttlSecOverride != null ? clampTtl(ttlSecOverride) : sql`ttl_sec`},
           expires_ts = clock_timestamp() + make_interval(secs => ${ttlSecOverride != null ? clampTtl(ttlSecOverride) : sql`ttl_sec`}),
           last_activity_ts = clock_timestamp()
     WHERE workspace_id = ${workspaceId} AND harness_slug = ${harnessSlug}
       AND work_item_id = ${workItemId}
       AND claim_id = ${claimId}::uuid AND owner = ${owner}
       AND expires_ts > clock_timestamp()
    RETURNING expires_ts
  `;
  if (rows[0]) return { renewed: true, held: true, expiresTs: rows[0].expires_ts };
  // Not renewed — distinguish a phantom holder from a lapsed/released claim.
  const held = await getClaim(workspaceId, harnessSlug, workItemId);
  const isOwnLapsed = held != null && held.claimId === claimId && held.owner === owner && held.expired;
  return {
    renewed: false,
    held: false,
    expiresTs: null,
    reason:
      held && !isOwnLapsed
        ? 'claim is held by another owner or under a new claim_id'
        : 'claim has lapsed or was released — re-acquire it',
  };
}

/** Serialisable release params — the payload an authority RPC carries (D-002). */
export interface ReleaseClaimParams {
  workspaceId: string;
  harnessSlug: string;
  workItemId: string;
  hiveSlug?: string | null;
  claimId: string;
  owner: string;
}

/** Release the caller's claim. Owner + claim_id checked. Routed through the per-Hive claim authority. */
export async function releaseClaim(p: ReleaseClaimParams): Promise<boolean> {
  return getWorkItemClaimAuthority().route(scopeOf(p), {
    local: () => releaseClaimLocal(p),
    remote: { kind: WORK_ITEM_CLAIM_OP_KINDS.release, payload: p, decode: (raw) => raw as boolean },
  });
}

/** The LOCAL (un-routed) release — raw SQL against THIS peer's PG. */
export async function releaseClaimLocal(p: ReleaseClaimParams): Promise<boolean> {
  const { workspaceId, harnessSlug, workItemId, claimId, owner } = p;
  const { sql } = getOrgPg();
  const rows = await sql<{ work_item_id: string }[]>`
    DELETE FROM harness_shared.work_item_claims
     WHERE workspace_id = ${workspaceId} AND harness_slug = ${harnessSlug}
       AND work_item_id = ${workItemId}
       AND claim_id = ${claimId}::uuid AND owner = ${owner}
    RETURNING work_item_id
  `;
  return rows.length > 0;
}

/** Serialisable release-for-item params — the payload an authority RPC carries. */
export interface ReleaseClaimForItemParams {
  workspaceId: string;
  harnessSlug: string;
  workItemId: string;
  hiveSlug?: string | null;
  /** The item's CURRENT holder (its `taken_by`/assignee) at release time — NOT
   *  necessarily the exact claimId, since the base work-item release path (voluntary
   *  `work_items:release`, EI-6832) doesn't track the lease's claimId at all. Owner-
   *  scoped (not unconditional) so this can never delete a DIFFERENT claimant's lease
   *  in the rare race where someone else re-claimed the item a moment earlier. */
  owner: string;
}

/**
 * EI-6832: release the LEASE for a work item that is returning to the unclaimed pool
 * via `work_items:release` (voluntary release / reap), NOT via the lease's own
 * claimId-checked `releaseClaim`. Without this, `acquireClaimLocal`/`heartbeatClaimLocal`
 * never touch `work_item_claims` on a base-table release — the item's `taken_by` clears
 * (so it re-enters the visible unclaimed pool) but its PRIOR owner's lease row stays LIVE
 * for up to its TTL (default 30m, max 2h). Any OTHER agent that then self-selects the
 * item via `work_items:claim_next` succeeds at the local `taken_by` UPDATE, then loses the
 * `leaseClaimedWorkItem` arbitration to that stale lease (`acquireClaimLocal`'s
 * `ON CONFLICT ... WHERE expired OR owner = EXCLUDED.owner` — neither holds for a
 * different, not-yet-expired owner) and gets bounced back to the pool — reporting a claim
 * MISS even though `readyUnclaimed > 0`. Confirmed LIVE 2026-07-02 (WI-652: `taken_by`
 * NULL / `status` open, yet a lease for a prior, unrelated owner not expiring for ~14
 * more minutes) — this is a genuine, reproducing instance of the class of symptom
 * EI-6832 reported ("claim_next misses despite readyUnclaimed>0"), not merely a race.
 * Routed through the per-Hive claim authority like every other claim mutation (D-002);
 * owner-scoped (not unconditional) so a genuine race where someone ELSE re-claimed the
 * item a moment earlier is never clobbered. Best-effort: callers (work-items.ts
 * `releaseWorkItem`) never let a failure here block the underlying release.
 */
export async function releaseClaimForItem(opts: ReleaseClaimForItemParams): Promise<boolean> {
  return getWorkItemClaimAuthority().route(scopeOf(opts), {
    local: () => releaseClaimForItemLocal(opts),
    remote: { kind: WORK_ITEM_CLAIM_OP_KINDS.releaseForItem, payload: opts, decode: (raw) => raw as boolean },
  });
}

/** The LOCAL (un-routed) release-for-item — raw SQL against THIS peer's PG. See {@link releaseClaimForItem}. */
export async function releaseClaimForItemLocal(p: ReleaseClaimForItemParams): Promise<boolean> {
  const { workspaceId, harnessSlug, workItemId, owner } = p;
  const { sql } = getOrgPg();
  const rows = await sql<{ work_item_id: string }[]>`
    DELETE FROM harness_shared.work_item_claims
     WHERE workspace_id = ${workspaceId} AND harness_slug = ${harnessSlug}
       AND work_item_id = ${workItemId} AND owner = ${owner}
    RETURNING work_item_id
  `;
  return rows.length > 0;
}

/** Release every claim held by a session owner (session-end cleanup). Returns count. Local-only. */
export async function releaseAllClaimsForOwner(workspaceId: string, owner: string): Promise<number> {
  const { sql } = getOrgPg();
  const rows = await sql<{ work_item_id: string }[]>`
    DELETE FROM harness_shared.work_item_claims
     WHERE workspace_id = ${workspaceId} AND owner = ${owner}
    RETURNING work_item_id
  `;
  return rows.length;
}

/** The current claim on a work item (with derived `expired`), or null. */
export async function getClaim(
  workspaceId: string,
  harnessSlug: string,
  workItemId: string,
): Promise<WorkItemClaim | null> {
  const { sql } = getOrgPg();
  const rows = await sql<ClaimDbRow[]>`
    SELECT workspace_id, harness_slug, work_item_id, hive_slug, claim_id, owner,
             owner_label, holder_pubkey, intent, ttl_sec, acquired_ts, expires_ts,
             last_activity_ts, (expires_ts <= clock_timestamp()) AS expired
      FROM harness_shared.work_item_claims
     WHERE workspace_id = ${workspaceId} AND harness_slug = ${harnessSlug} AND work_item_id = ${workItemId}
  `;
  return rows[0] ? claimFromDb(rows[0]) : null;
}

/**
 * The owner's most-recently-active LIVE claim — its current lane. A cheap single-row
 * read for the edit-attribution join (deterministic-commit-workitem-attribution P-001):
 * at file-lock grant time we map the lock holder → the work-item it's working. NULL when
 * the agent holds no live claim (an honest unattributed edit, D-003). Claims are keyed by
 * owner (cf. releaseAllClaimsForOwner); an agent with several claims attributes to the
 * most-recently-active one (D-003 accepts the coarseness).
 */
export async function getActiveClaimForOwner(
  workspaceId: string,
  owner: string,
): Promise<WorkItemClaim | null> {
  const { sql } = getOrgPg();
  const rows = await sql<ClaimDbRow[]>`
    SELECT workspace_id, harness_slug, work_item_id, hive_slug, claim_id, owner,
             owner_label, holder_pubkey, intent, ttl_sec, acquired_ts, expires_ts,
             last_activity_ts, (expires_ts <= clock_timestamp()) AS expired
      FROM harness_shared.work_item_claims
     WHERE workspace_id = ${workspaceId} AND owner = ${owner}
       AND expires_ts > clock_timestamp()
     ORDER BY last_activity_ts DESC
     LIMIT 1
  `;
  return rows[0] ? claimFromDb(rows[0]) : null;
}

/** All live (non-lapsed) claims for a Hive — the "what's already taken" view the backlog reads. */
export async function listLiveClaimsForHive(workspaceId: string, hiveSlug: string): Promise<WorkItemClaim[]> {
  const { sql } = getOrgPg();
  const rows = await sql<ClaimDbRow[]>`
    SELECT workspace_id, harness_slug, work_item_id, hive_slug, claim_id, owner,
             owner_label, holder_pubkey, intent, ttl_sec, acquired_ts, expires_ts,
             last_activity_ts, (expires_ts <= clock_timestamp()) AS expired
      FROM harness_shared.work_item_claims
     WHERE workspace_id = ${workspaceId} AND hive_slug = ${hiveSlug}
       AND expires_ts > clock_timestamp()
     ORDER BY work_item_id
  `;
  return rows.map(claimFromDb);
}

/** Delete lapsed claims (a GC convenience — acquire already steals them lazily). Returns count. */
export async function sweepLapsedClaims(workspaceId: string, harnessSlug?: string): Promise<number> {
  const { sql } = getOrgPg();
  const rows = await sql<{ work_item_id: string }[]>`
    DELETE FROM harness_shared.work_item_claims
     WHERE workspace_id = ${workspaceId}
       AND ${harnessSlug ? sql`harness_slug = ${harnessSlug}` : sql`TRUE`}
       AND expires_ts <= clock_timestamp()
    RETURNING work_item_id
  `;
  return rows.length;
}

function clampTtl(n: number): number {
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_WORK_ITEM_TTL_SEC;
  return Math.min(Math.floor(n), MAX_WORK_ITEM_TTL_SEC);
}

interface ClaimDbRow {
  workspace_id: string;
  harness_slug: string;
  work_item_id: string;
  hive_slug: string | null;
  claim_id: string;
  owner: string;
  owner_label: string | null;
  holder_pubkey: string | null;
  intent: string;
  ttl_sec: number;
  acquired_ts: string;
  expires_ts: string;
  last_activity_ts: string;
  expired: boolean;
}
function claimFromDb(r: ClaimDbRow): WorkItemClaim {
  return {
    workspaceId: r.workspace_id,
    harnessSlug: r.harness_slug,
    workItemId: r.work_item_id,
    hiveSlug: r.hive_slug,
    claimId: r.claim_id,
    owner: r.owner,
    ownerLabel: r.owner_label,
    holderPubkey: r.holder_pubkey,
    intent: r.intent,
    ttlSec: Number(r.ttl_sec),
    acquiredTs: r.acquired_ts,
    expiresTs: r.expires_ts,
    lastActivityTs: r.last_activity_ts,
    expired: Boolean(r.expired),
  };
}
function synthMissing(opts: AcquireOpts): WorkItemClaim {
  const now = new Date().toISOString();
  return {
    workspaceId: opts.workspaceId,
    harnessSlug: opts.harnessSlug,
    workItemId: opts.workItemId,
    hiveSlug: opts.hiveSlug ?? null,
    claimId: '00000000-0000-0000-0000-000000000000',
    owner: 'unknown',
    ownerLabel: null,
    holderPubkey: null,
    intent: '',
    ttlSec: 0,
    acquiredTs: now,
    expiresTs: now,
    lastActivityTs: now,
    expired: true,
  };
}

/**
 * The standing-refusal result the authority-side op handlers return when the
 * CALLER's hive standing fails (EI-284 — revoked swarm claiming over RPC).
 * Rides the normal ok:false path (consumers already treat any !ok as "no
 * lease"), with a synthetic conflict (there is no real holder to report) and
 * the machine-readable `refused` marker.
 */
export function refusedAcquire(opts: AcquireOpts): AcquireResult {
  return { ok: false, conflict: { ...synthMissing(opts), intent: 'refused: caller revoked' }, refused: 'caller_revoked' };
}
