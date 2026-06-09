/**
 * plan-item claim store — the live, mutually-exclusive, heartbeat-LEASED grip.
 *
 * Plan: plan-item-assignment-claim-liveness-2026-06-04 (Phase 1, D-001..D-004).
 *
 * Low-level lease mechanics ONLY (acquire / heartbeat / release), mirroring the
 * su-lock-store agent_file_locks pattern: a `claim_id` uuid, a TTL'd `expires_ts`,
 * owner-checked heartbeat + release. Mutual exclusion is the PK (one holder per
 * item). Every op routes through the claim AUTHORITY (authority.ts) — local on a
 * single box, an RPC to the authority peer once Track B lands.
 *
 * POLICY (who may claim an assigned vs pooled item; work-group gating) lives one
 * layer up in liveness.ts (`claimPlanItem`). Liveness MODE (availability vs
 * activity) is set at acquire and changes only WHAT renews the lease in
 * `heartbeatClaim`. A lapsed claim is simply one whose `expires_ts <= now()`:
 * `acquireClaim` steals it (so the item returns to its assignee / the pool, D-004);
 * nothing is "moved" on lapse — the durable assignment (assignments.ts) is the
 * anchor a re-claim resolves against.
 *
 * NOT federated. NO RLS (coord-family); org handle + workspace_id filter.
 */
import { getOrgPg } from '@papercusp/db-org';
import { getClaimAuthority } from './claim-authority';

export type LivenessMode = 'availability' | 'activity';
export type HeartbeatKind = 'activity' | 'extend' | 'keepalive';

export interface PlanItemClaim {
  workspaceId: string;
  harnessSlug: string;
  planSlug: string;
  itemId: string;
  claimId: string;
  owner: string;
  ownerLabel: string | null;
  ownerName: string | null;
  intent: string;
  livenessMode: LivenessMode;
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
  planSlug: string;
  itemId: string;
  owner: string;
  ownerLabel?: string | null;
  ownerName?: string | null;
  intent?: string;
  livenessMode?: LivenessMode;
  ttlSec?: number;
}

export type AcquireResult =
  | { ok: true; claim: PlanItemClaim }
  | { ok: false; conflict: PlanItemClaim };

export const DEFAULT_AVAILABILITY_TTL_SEC = 1200; // 20m — LOCAL, session keeps it alive
export const DEFAULT_ACTIVITY_TTL_SEC = 1800; // 30m — SHARED, generous; renewed by a completed turn
export const MAX_TTL_SEC = 7200; // 2h hard cap (an explicit extend for a long op)

/**
 * The authority-RPC op kinds for the three mutating claim ops (D-002). A claim op
 * routed to a REMOTE authority carries one of these `kind`s + a serialisable payload
 * over the peer-RPC transport; the authority re-runs the matching `*Local` fn against
 * ITS store (registered via plan-item-claim-authority-ops.ts). Distinct from
 * su-584a8's `lock.*` kinds — registerAuthorityOp throws on a duplicate kind.
 */
export const PLAN_ITEM_CLAIM_OP_KINDS = {
  acquire: 'plan-item.claim.acquire',
  heartbeat: 'plan-item.claim.heartbeat',
  release: 'plan-item.claim.release',
} as const;

/**
 * Acquire the live claim on a plan item. Atomically takes a FREE item, STEALS an
 * expired (lapsed) claim, or extends the caller's OWN claim; refuses (ok:false) if
 * a live claim is held by another owner. Routed through the claim authority: runs
 * `acquireClaimLocal` here when we are the authority (single box → always), else
 * RPCs the authority peer (which runs `acquireClaimLocal` on its store), else fails
 * open to a local advisory lease (D-004).
 */
export async function acquireClaim(opts: AcquireOpts): Promise<AcquireResult> {
  return getClaimAuthority().route(opts.harnessSlug, {
    local: () => acquireClaimLocal(opts),
    remote: { kind: PLAN_ITEM_CLAIM_OP_KINDS.acquire, payload: opts, decode: (raw) => raw as AcquireResult },
  });
}

/**
 * The LOCAL (un-routed) execution of acquire — the raw SQL against THIS peer's PG.
 * Exported so the authority-op registry can run it on the authority's store on a
 * remote peer's behalf (the receiving side of the RPC); normal callers use
 * `acquireClaim`, which adds authority routing on top.
 */
export async function acquireClaimLocal(opts: AcquireOpts): Promise<AcquireResult> {
  const mode: LivenessMode = opts.livenessMode ?? 'availability';
  const ttlSec = clampTtl(opts.ttlSec ?? (mode === 'activity' ? DEFAULT_ACTIVITY_TTL_SEC : DEFAULT_AVAILABILITY_TTL_SEC));
  const { sql } = getOrgPg();
  const rows = await sql<ClaimDbRow[]>`
    INSERT INTO harness_shared.plan_item_claims
      (workspace_id, harness_slug, plan_slug, item_id, owner, owner_label, owner_name,
       intent, liveness_mode, ttl_sec, acquired_ts, expires_ts, last_activity_ts)
    VALUES
      (${opts.workspaceId}, ${opts.harnessSlug}, ${opts.planSlug}, ${opts.itemId},
       ${opts.owner}, ${opts.ownerLabel ?? null}, ${opts.ownerName ?? null},
       ${opts.intent ?? ''}, ${mode}, ${ttlSec}, clock_timestamp(),
       clock_timestamp() + make_interval(secs => ${ttlSec}), clock_timestamp())
    ON CONFLICT (workspace_id, harness_slug, plan_slug, item_id) DO UPDATE SET
      claim_id         = gen_random_uuid(),
      owner            = EXCLUDED.owner,
      owner_label      = EXCLUDED.owner_label,
      owner_name       = EXCLUDED.owner_name,
      intent           = EXCLUDED.intent,
      liveness_mode    = EXCLUDED.liveness_mode,
      ttl_sec          = EXCLUDED.ttl_sec,
      acquired_ts      = clock_timestamp(),
      expires_ts       = clock_timestamp() + make_interval(secs => ${ttlSec}),
      last_activity_ts = clock_timestamp()
    WHERE harness_shared.plan_item_claims.expires_ts <= clock_timestamp()
       OR harness_shared.plan_item_claims.owner = EXCLUDED.owner
    RETURNING workspace_id, harness_slug, plan_slug, item_id, claim_id, owner,
           owner_label, owner_name, intent, liveness_mode, ttl_sec, acquired_ts, expires_ts,
           last_activity_ts, (expires_ts <= clock_timestamp()) AS expired
  `;
  if (rows[0]) return { ok: true, claim: claimFromDb(rows[0]) };
  // Conflict update skipped → a LIVE claim held by another owner. Report it.
  // Use SELECT FOR UPDATE to lock the row during check to prevent concurrent claims
  // on a freed item (race condition: two agents both get null from getClaim(), then both
  // execute INSERT). The lock ensures only one agent can proceed if the row was just released.
  const held = await sql<ClaimDbRow[]>`
    SELECT workspace_id, harness_slug, plan_slug, item_id, claim_id, owner,
           owner_label, owner_name, intent, liveness_mode, ttl_sec, acquired_ts, expires_ts,
           last_activity_ts, (expires_ts <= clock_timestamp()) AS expired
      FROM harness_shared.plan_item_claims
     WHERE workspace_id = ${opts.workspaceId} AND harness_slug = ${opts.harnessSlug}
       AND plan_slug = ${opts.planSlug} AND item_id = ${opts.itemId}
      FOR UPDATE
  `;
  if (held[0]) return { ok: false, conflict: claimFromDb(held[0]) };
  // Lost a race (the holder released between INSERT and SELECT) — retry once.
  const retry = await sql<ClaimDbRow[]>`
    INSERT INTO harness_shared.plan_item_claims
      (workspace_id, harness_slug, plan_slug, item_id, owner, owner_label, owner_name,
       intent, liveness_mode, ttl_sec, acquired_ts, expires_ts, last_activity_ts)
    VALUES
      (${opts.workspaceId}, ${opts.harnessSlug}, ${opts.planSlug}, ${opts.itemId},
       ${opts.owner}, ${opts.ownerLabel ?? null}, ${opts.ownerName ?? null},
       ${opts.intent ?? ''}, ${mode}, ${ttlSec}, clock_timestamp(),
       clock_timestamp() + make_interval(secs => ${ttlSec}), clock_timestamp())
    ON CONFLICT (workspace_id, harness_slug, plan_slug, item_id) DO NOTHING
    RETURNING workspace_id, harness_slug, plan_slug, item_id, claim_id, owner,
           owner_label, owner_name, intent, liveness_mode, ttl_sec, acquired_ts, expires_ts,
           last_activity_ts, (expires_ts <= clock_timestamp()) AS expired
  `;
  if (retry[0]) return { ok: true, claim: claimFromDb(retry[0]) };
  const after = await getClaim(opts.workspaceId, opts.harnessSlug, opts.planSlug, opts.itemId);
  return after ? { ok: false, conflict: after } : { ok: false, conflict: synthMissing(opts) };
}

export interface HeartbeatResult {
  /** The lease was renewed (expires_ts pushed out). */
  renewed: boolean;
  /** The claim is still held by the caller (even if not renewed — e.g. activity-mode keepalive). */
  held: boolean;
  expiresTs: string | null;
  reason?: string;
}

/** Serialisable heartbeat params — the payload an authority RPC carries (D-002). */
export interface HeartbeatClaimParams {
  workspaceId: string;
  harnessSlug: string;
  planSlug: string;
  itemId: string;
  claimId: string;
  owner: string;
  kind?: HeartbeatKind;
  ttlSecOverride?: number;
}

/**
 * Renew the lease. The MODE governs what renews it (D-003): availability renews on
 * ANY heartbeat (the session proving it is alive); activity renews ONLY on an
 * activity (a completed turn) or an explicit extend — a bare keepalive does NOT, so
 * an idle SHARED claim ages toward lapse. Owner + claim_id + not-yet-expired are
 * required (a lapsed claim must be re-acquired, not heartbeated back to life).
 * Routed through the claim authority (runs `heartbeatClaimLocal` at the authority).
 */
export async function heartbeatClaim(
  workspaceId: string,
  harnessSlug: string,
  planSlug: string,
  itemId: string,
  claimId: string,
  owner: string,
  kind: HeartbeatKind = 'activity',
  ttlSecOverride?: number,
): Promise<HeartbeatResult> {
  const p: HeartbeatClaimParams = { workspaceId, harnessSlug, planSlug, itemId, claimId, owner, kind, ttlSecOverride };
  return getClaimAuthority().route(harnessSlug, {
    local: () => heartbeatClaimLocal(p),
    remote: { kind: PLAN_ITEM_CLAIM_OP_KINDS.heartbeat, payload: p, decode: (raw) => raw as HeartbeatResult },
  });
}

/** The LOCAL (un-routed) heartbeat — raw SQL against THIS peer's PG. See `acquireClaimLocal`. */
export async function heartbeatClaimLocal(p: HeartbeatClaimParams): Promise<HeartbeatResult> {
  const { workspaceId, harnessSlug, planSlug, itemId, claimId, owner, ttlSecOverride } = p;
  const kind: HeartbeatKind = p.kind ?? 'activity';
  const isActivity = kind === 'activity' || kind === 'extend';
  const { sql } = getOrgPg();
  const rows = await sql<{ expires_ts: string }[]>`
    UPDATE harness_shared.plan_item_claims
       SET ttl_sec = ${ttlSecOverride != null ? clampTtl(ttlSecOverride) : sql`ttl_sec`},
           expires_ts = clock_timestamp() + make_interval(secs => ${ttlSecOverride != null ? clampTtl(ttlSecOverride) : sql`ttl_sec`}),
           last_activity_ts = CASE WHEN ${isActivity} THEN clock_timestamp() ELSE last_activity_ts END
     WHERE workspace_id = ${workspaceId} AND harness_slug = ${harnessSlug}
       AND plan_slug = ${planSlug} AND item_id = ${itemId}
       AND claim_id = ${claimId}::uuid AND owner = ${owner}
       AND expires_ts > clock_timestamp()
       AND (liveness_mode = 'availability' OR ${isActivity})
    RETURNING expires_ts
  `;
  if (rows[0]) return { renewed: true, held: true, expiresTs: rows[0].expires_ts };
  // Not renewed — distinguish "still held, activity-mode keepalive (no-op)" from "gone".
  const held = await getClaim(workspaceId, harnessSlug, planSlug, itemId);
  if (held && held.claimId === claimId && held.owner === owner && !held.expired) {
    return {
      renewed: false,
      held: true,
      expiresTs: held.expiresTs,
      reason: 'activity-mode claim not renewed by a keepalive — send an activity/extend heartbeat',
    };
  }
  // A lapsed row still physically exists (acquire steals lazily) — report it
  // as lapsed, not as "held by another owner", so the caller re-acquires
  // instead of chasing a phantom holder.
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
  planSlug: string;
  itemId: string;
  claimId: string;
  owner: string;
}

/** Release the caller's claim. Owner + claim_id checked. Returns whether a row was freed.
 *  Routed through the claim authority (runs `releaseClaimLocal` at the authority). */
export async function releaseClaim(
  workspaceId: string,
  harnessSlug: string,
  planSlug: string,
  itemId: string,
  claimId: string,
  owner: string,
): Promise<boolean> {
  const p: ReleaseClaimParams = { workspaceId, harnessSlug, planSlug, itemId, claimId, owner };
  return getClaimAuthority().route(harnessSlug, {
    local: () => releaseClaimLocal(p),
    remote: { kind: PLAN_ITEM_CLAIM_OP_KINDS.release, payload: p, decode: (raw) => raw as boolean },
  });
}

/** The LOCAL (un-routed) release — raw SQL against THIS peer's PG. See `acquireClaimLocal`. */
export async function releaseClaimLocal(p: ReleaseClaimParams): Promise<boolean> {
  const { workspaceId, harnessSlug, planSlug, itemId, claimId, owner } = p;
  const { sql } = getOrgPg();
  const rows = await sql<{ item_id: string }[]>`
    DELETE FROM harness_shared.plan_item_claims
     WHERE workspace_id = ${workspaceId} AND harness_slug = ${harnessSlug}
       AND plan_slug = ${planSlug} AND item_id = ${itemId}
       AND claim_id = ${claimId}::uuid AND owner = ${owner}
    RETURNING item_id
  `;
  return rows.length > 0;
}

/** Release every claim held by a session owner (session-end cleanup). Returns count. */
export async function releaseAllClaimsForOwner(workspaceId: string, owner: string): Promise<number> {
  const { sql } = getOrgPg();
  const rows = await sql<{ item_id: string }[]>`
    DELETE FROM harness_shared.plan_item_claims
     WHERE workspace_id = ${workspaceId} AND owner = ${owner}
    RETURNING item_id
  `;
  return rows.length;
}

/**
 * Renew (push the lease out on) every NON-EXPIRED ACTIVITY-mode claim an owner holds
 * in a workspace — the D-003 per-turn auto-renewal driven by the activity bridge: an
 * owner that is completing turns (reporting activity) is alive + working, so its
 * SHARED-harness activity claims stay; an owner that goes idle (no turns) lets them
 * lapse so others can pull. AVAILABILITY-mode claims are untouched (they renew on any
 * heartbeat and only lapse when the session dies). An ALREADY-EXPIRED claim is NOT
 * resurrected (`expires_ts > now()` guard — a lapsed claim must be re-acquired). We
 * renew all of the owner's activity claims rather than one item: an agent producing
 * turns is active in (at most) the one harness it's working, so this is the owner's
 * live working set; the per-item attribution the activity stream lacks is not needed.
 * Returns the renewed item ids.
 *
 * Local (not authority-routed): on a single box the authority is self, so the renewal
 * runs on the same store the claim lives in. Cross-machine the renewal would route to
 * the authority alongside acquire/heartbeat — that whole live-mesh path is hardware-
 * gated (distributed-coordination-shared-harness-2026-06-04), so the local renewal is
 * correct for the testable single-box reality.
 */
export async function renewOwnerActivityClaims(workspaceId: string, owner: string): Promise<string[]> {
  const { sql } = getOrgPg();
  const rows = await sql<{ item_id: string }[]>`
    UPDATE harness_shared.plan_item_claims
       SET expires_ts = clock_timestamp() + make_interval(secs => ttl_sec),
           last_activity_ts = clock_timestamp()
     WHERE workspace_id = ${workspaceId} AND owner = ${owner}
       AND liveness_mode = 'activity'
       AND expires_ts > clock_timestamp()
    RETURNING item_id
  `;
  return rows.map((r) => r.item_id);
}

/** The current claim on an item (with derived `expired`), or null. */
export async function getClaim(
  workspaceId: string,
  harnessSlug: string,
  planSlug: string,
  itemId: string,
): Promise<PlanItemClaim | null> {
  const { sql } = getOrgPg();
  const rows = await sql<ClaimDbRow[]>`
    SELECT workspace_id, harness_slug, plan_slug, item_id, claim_id, owner,
             owner_label, owner_name, intent, liveness_mode, ttl_sec, acquired_ts, expires_ts,
             last_activity_ts, (expires_ts <= clock_timestamp()) AS expired FROM harness_shared.plan_item_claims
     WHERE workspace_id = ${workspaceId} AND harness_slug = ${harnessSlug}
       AND plan_slug = ${planSlug} AND item_id = ${itemId}
  `;
  return rows[0] ? claimFromDb(rows[0]) : null;
}

/** All claims for a plan (with derived `expired`), for the merged view. */
export async function listClaimsForPlan(
  workspaceId: string,
  harnessSlug: string,
  planSlug: string,
): Promise<PlanItemClaim[]> {
  const { sql } = getOrgPg();
  const rows = await sql<ClaimDbRow[]>`
    SELECT workspace_id, harness_slug, plan_slug, item_id, claim_id, owner,
             owner_label, owner_name, intent, liveness_mode, ttl_sec, acquired_ts, expires_ts,
             last_activity_ts, (expires_ts <= clock_timestamp()) AS expired FROM harness_shared.plan_item_claims
     WHERE workspace_id = ${workspaceId} AND harness_slug = ${harnessSlug} AND plan_slug = ${planSlug}
     ORDER BY item_id
  `;
  return rows.map(claimFromDb);
}

/** Delete lapsed claims (a GC convenience — acquire already steals them lazily). Returns count. */
export async function sweepLapsedClaims(workspaceId: string, harnessSlug?: string): Promise<number> {
  const { sql } = getOrgPg();
  const rows = await sql<{ item_id: string }[]>`
    DELETE FROM harness_shared.plan_item_claims
     WHERE workspace_id = ${workspaceId}
       AND ${harnessSlug ? sql`harness_slug = ${harnessSlug}` : sql`TRUE`}
       AND expires_ts <= clock_timestamp()
    RETURNING item_id
  `;
  return rows.length;
}

function clampTtl(n: number): number {
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_AVAILABILITY_TTL_SEC;
  return Math.min(Math.floor(n), MAX_TTL_SEC);
}

interface ClaimDbRow {
  workspace_id: string;
  harness_slug: string;
  plan_slug: string;
  item_id: string;
  claim_id: string;
  owner: string;
  owner_label: string | null;
  owner_name: string | null;
  intent: string;
  liveness_mode: string;
  ttl_sec: number;
  acquired_ts: string;
  expires_ts: string;
  last_activity_ts: string;
  expired: boolean;
}
function claimFromDb(r: ClaimDbRow): PlanItemClaim {
  return {
    workspaceId: r.workspace_id,
    harnessSlug: r.harness_slug,
    planSlug: r.plan_slug,
    itemId: r.item_id,
    claimId: r.claim_id,
    owner: r.owner,
    ownerLabel: r.owner_label,
    ownerName: r.owner_name,
    intent: r.intent,
    livenessMode: (r.liveness_mode as LivenessMode) ?? 'availability',
    ttlSec: Number(r.ttl_sec),
    acquiredTs: r.acquired_ts,
    expiresTs: r.expires_ts,
    lastActivityTs: r.last_activity_ts,
    expired: Boolean(r.expired),
  };
}
function synthMissing(opts: AcquireOpts): PlanItemClaim {
  const now = new Date().toISOString();
  return {
    workspaceId: opts.workspaceId,
    harnessSlug: opts.harnessSlug,
    planSlug: opts.planSlug,
    itemId: opts.itemId,
    claimId: '00000000-0000-0000-0000-000000000000',
    owner: 'unknown',
    ownerLabel: null,
    ownerName: null,
    intent: '',
    livenessMode: 'availability',
    ttlSec: 0,
    acquiredTs: now,
    expiresTs: now,
    lastActivityTs: now,
    expired: true,
  };
}
