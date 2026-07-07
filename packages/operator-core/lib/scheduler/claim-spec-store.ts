/**
 * Per-bee claim-spec store + the get_next service entry point
 * (hybrid-bee-scheduler-work-stealing-2026-06-22 — the spec-handoff layer that makes get_next usable).
 *
 *   setClaimSpec  — the Queen validates (validateClaimSpec) + stores a bee's versioned claim spec
 *                   (mig 372 `bee_claim_specs`), upserting and bumping the revision.
 *   getClaimSpec  — loads a bee's spec; DEFAULT_CLAIM_SPEC when none is set OR a stored spec no
 *                   longer validates (tolerate a stale spec rather than wedge the bee).
 *   getNextForBee — the bee's get_next: load the bee's spec → getNextWorkItem(spec, bee, opts).
 *
 * Keyed by the bee's session/owner id (`beeId` — the identity a tool ctx resolves via actor-identity
 * and the id the Queen addresses a bee by). The store fns take an optional `sql` (dependency-injected
 * for tests); production passes getOrgPg().sql.
 */
import { getOrgPg } from '@papercusp/db-org';
import { DEFAULT_COORD_WORKSPACE } from '@papercusp/coordination/event-log';
import { DEFAULT_CLAIM_SPEC, validateClaimSpec, isIdOnlySelector, type ClaimSpec } from './claim-spec';
import { getNextWorkItem, type GetNextResult } from './get-next';
import type { OrgSql } from '../work-items';

export interface SetClaimSpecResult {
  ok: boolean;
  errors: string[];
  revision?: number;
  /** WI-1564: set when the write is suspicious but not invalid — e.g. a
   *  hive-scoped spec landing under the legacy 'default' workspace partition,
   *  which the federation outbox-drain does not serve (the row strands). */
  warning?: string;
}

/**
 * WI-1564 (LIVE-1 D5 failure): resolve the workspace partition a claim-spec
 * write/read should use from the caller's identity. The bug class: a tool
 * handler that omits `workspaceId` falls back to DEFAULT_COORD_WORKSPACE
 * ('default') — but the federation outbox-drain only serves the BOOTED
 * (workspace, hive) handles, so a hive-scoped row under 'default' NEVER
 * drains/federates (137 rows stranded as of 2026-07-02). Both the writer
 * (scheduler:set_claim_spec) and the reader (scheduler:get_next) MUST resolve
 * through this one helper so write+read+capture always agree on the partition.
 *
 * Returns the ident workspace when concrete; `undefined` (⇒ the store's
 * legacy 'default') for a null/'*'/empty ident — un-scoped callers keep
 * today's local-only behavior rather than guessing a volatile registry
 * default (the EI-1460 strand class).
 */
export function resolveClaimSpecWorkspace(
  identWorkspaceId: string | null | undefined,
): string | undefined {
  const ws = identWorkspaceId?.trim();
  return ws && ws !== '*' ? ws : undefined;
}

/** Queen: validate + store a bee's claim spec (upsert; revision bumps unless the spec carries a higher one). */
export async function setClaimSpec(
  args: {
    beeId: string;
    workspaceId?: string;
    spec: unknown;
    updatedBy?: string;
    /** P-016 (cross-machine-coord-parity): the hive HOME slug this spec federates
     *  under. Set ⇒ the spec rides that hive's peer-log (mig-438 WHEN gate) so a
     *  remote bee's get_next sees it; null/omitted ⇒ operator-scope, local-only
     *  (today's behavior). Resolved by the caller via the same shared-hive scope
     *  rule coord:send uses. */
    hiveSlug?: string | null;
  },
  sqlOverride?: OrgSql,
): Promise<SetClaimSpecResult> {
  const v = validateClaimSpec(args.spec);
  if (!v.ok || !v.spec) return { ok: false, errors: v.errors };
  const ws = args.workspaceId ?? DEFAULT_COORD_WORKSPACE;
  const sql = sqlOverride ?? getOrgPg().sql;
  const hiveSlug = args.hiveSlug ?? null;
  // WI-1564: hive-scoped + 'default' partition = the strand combo. The write
  // still proceeds (fail-soft; local get_next reads under the same default),
  // but LOUDLY — the outbox capture rides ('default', hive), which no booted
  // drain handle serves, so the spec never federates.
  const strandWarning =
    hiveSlug !== null && ws === DEFAULT_COORD_WORKSPACE
      ? `hive-scoped claim spec stored under the '${DEFAULT_COORD_WORKSPACE}' workspace partition — ` +
        `the federation outbox-drain only serves booted (workspace, hive) handles, so this spec will ` +
        `NOT federate to peers (WI-1564). Thread the caller's workspaceId (resolveClaimSpecWorkspace).`
      : undefined;
  // The id-pin tripwire (mig 389): record whether this spec selects on `id` ALONE — a static
  // pin (a fixed wave), as opposed to a property-filtered standing lane. Denormalized so
  // over-reliance is a one-line COUNT, keeping the describe-by-property discipline visible.
  const idOnly = isIdOnlySelector(v.spec);

  // L9 (cross-machine-coord-parity-and-trust-2026-07-01 P-058, audit D-013):
  // TOMBSTONE ON SCOPE-DOWNGRADE. bee_claim_specs is keyed (workspace_id, bee_id)
  // with no hive component, so a plain upsert that RE-HOMES a bee's spec to a
  // different hive scope (H_old → H_new, or H_old → NULL/operator-local) re-homes
  // the LOCAL row but STRANDS the stale row on H_old's peers: the UPDATE capture
  // trigger (mig 438) federates only to the NEW scope, and a downgrade to NULL
  // fails its `NEW.harness_slug IS NOT NULL` gate entirely — so H_old's bees keep
  // reading the dead spec via get_next forever. On a genuine scope change, DELETE
  // the old-scope row FIRST: its DELETE capture trigger (WHEN OLD.harness_slug IS
  // NOT NULL) federates a tombstone to H_old's peers, who then drop the stale row.
  // Then insert fresh under the new scope (revision preserved-and-bumped). The
  // common same-scope path is untouched — still the in-place ON CONFLICT bump.
  // (The audit also suggested widening the PK to include harness_slug; it is
  // redundant here — the (ws,bee_id) PK already makes a cross-scope duplicate
  // impossible and bee_ids are globally unique — and dropping a live federated
  // table's PK is unjustified risk for this LOW item; the tombstone is the real
  // strand fix.)
  const prior = (await sql`
    SELECT harness_slug, revision FROM harness_shared.bee_claim_specs
     WHERE workspace_id = ${ws} AND bee_id = ${args.beeId} LIMIT 1`) as {
    harness_slug: string | null;
    revision: number;
  }[];
  const priorScope = prior[0]?.harness_slug ?? null;
  const scopeChange = priorScope !== null && priorScope !== hiveSlug;

  if (scopeChange) {
    // Atomic: the tombstone (DELETE→old scope) + the re-insert (→new scope) commit
    // together, so a bee never observes a no-spec window mid-re-home.
    const nextRev = Math.max(prior[0]!.revision + 1, v.spec.revision);
    const rows = (await sql.begin(async (tx) => {
      await tx`DELETE FROM harness_shared.bee_claim_specs WHERE workspace_id = ${ws} AND bee_id = ${args.beeId}`;
      return (await tx`
        INSERT INTO harness_shared.bee_claim_specs (workspace_id, bee_id, spec, revision, id_only, updated_by, harness_slug, updated_at)
        VALUES (${ws}, ${args.beeId}, ${JSON.stringify(v.spec)}::text::jsonb, ${nextRev}, ${idOnly}, ${args.updatedBy ?? null}, ${hiveSlug}, now())
        RETURNING revision`) as { revision: number }[];
    })) as unknown as { revision: number }[];
    return { ok: true, errors: [], revision: rows[0]?.revision, ...(strandWarning ? { warning: strandWarning } : {}) };
  }

  const rows = (await sql`
    INSERT INTO harness_shared.bee_claim_specs (workspace_id, bee_id, spec, revision, id_only, updated_by, harness_slug, updated_at)
    VALUES (${ws}, ${args.beeId}, ${JSON.stringify(v.spec)}::text::jsonb, ${v.spec.revision}, ${idOnly}, ${args.updatedBy ?? null}, ${hiveSlug}, now())
    ON CONFLICT (workspace_id, bee_id) DO UPDATE SET
      spec = EXCLUDED.spec,
      revision = GREATEST(harness_shared.bee_claim_specs.revision + 1, EXCLUDED.revision),
      id_only = EXCLUDED.id_only,
      updated_by = EXCLUDED.updated_by,
      harness_slug = EXCLUDED.harness_slug,
      updated_at = now()
    RETURNING revision`) as { revision: number }[];
  return { ok: true, errors: [], revision: rows[0]?.revision, ...(strandWarning ? { warning: strandWarning } : {}) };
}

/**
 * The sentinel `bee_id` a FLEET-level claim spec is stored under (fleet-scheduler-
 * hardening-2026-07-03 P-002). Reuses `bee_claim_specs` unchanged — the sentinel can
 * never collide with a real session/owner id (those are `su-<uuid>`/spawn ids) and
 * never claims anything (it is only ever a spec KEY, not a `taken_by`).
 */
export function fleetSpecBeeKey(fleetSlug: string): string {
  return `fleet:${fleetSlug}`;
}

/**
 * Load a bee's claim spec, or DEFAULT_CLAIM_SPEC when none is set / a stored spec is
 * invalid.
 *
 * Fleet inheritance (fleet-scheduler-hardening-2026-07-03 P-002): when the bee has NO
 * per-bee spec, fall back to its FLEET's spec (the `fleet:<slug>` sentinel row) via the
 * durable membership fact (fleet_membership_events — stamped at boot by bootstrap-su,
 * WI-1893). This is what makes a fleet RELAUNCH work without the leader hand-authoring
 * N per-bee specs: fresh ownerIds inherit the lane the moment they join the fleet.
 * Resolution order: bee spec → fleet spec → DEFAULT_CLAIM_SPEC. A per-bee spec always
 * WINS over the fleet spec (the leader's targeted re-steer of one member sticks).
 */
export async function getClaimSpec(
  args: { beeId: string; workspaceId?: string },
  sqlOverride?: OrgSql,
): Promise<ClaimSpec> {
  const ws = args.workspaceId ?? DEFAULT_COORD_WORKSPACE;
  const sql = sqlOverride ?? getOrgPg().sql;
  const rows = (await sql`
    SELECT spec FROM harness_shared.bee_claim_specs
     WHERE workspace_id = ${ws} AND bee_id = ${args.beeId} LIMIT 1`) as { spec: unknown }[];
  if (rows.length > 0) {
    const v = validateClaimSpec(rows[0]!.spec);
    return v.ok && v.spec ? v.spec : DEFAULT_CLAIM_SPEC;
  }
  // No per-bee spec — inherit the fleet's, when the bee belongs to one. Best-effort:
  // any hiccup here degrades to DEFAULT_CLAIM_SPEC (== claim_next ordering), never a
  // wedged bee. NOTE the partition rule (WI-1564): membership facts and spec rows are
  // both read under the SAME caller-resolved workspace (resolveClaimSpecWorkspace).
  try {
    const { latestFleetMembership } = await import('../fleet-membership-store');
    const membership = await latestFleetMembership(ws, args.beeId);
    if (membership?.fleetSlug) {
      const frows = (await sql`
        SELECT spec FROM harness_shared.bee_claim_specs
         WHERE workspace_id = ${ws} AND bee_id = ${fleetSpecBeeKey(membership.fleetSlug)} LIMIT 1`) as {
        spec: unknown;
      }[];
      if (frows.length > 0) {
        const fv = validateClaimSpec(frows[0]!.spec);
        if (fv.ok && fv.spec) return fv.spec;
      }
    }
  } catch {
    /* fall through to the default */
  }
  return DEFAULT_CLAIM_SPEC;
}

/** The bee's get_next: claim the next work-item per the bee's stored spec (the global floors always apply). */
export async function getNextForBee(args: {
  beeId: string;
  workspaceId?: string;
  harness: string;
  heldPaths?: string[];
  swarmId?: string;
  excludeRedundant?: boolean;
  states?: string[];
  /** WI-2796: caller has/coordinates a live ≥2-machine rig — see crossMachineRigExclusionSql. */
  rigAvailable?: boolean;
  /** SCHEDULER_SPEC_CLAIM kill-switch: when true, ignore the bee's stored spec and use the
   *  DEFAULT ordering (== work_items:claim_next) — a no-breakage degrade. */
  ignoreStoredSpec?: boolean;
}): Promise<(GetNextResult & { specSource: ClaimSpecRecord['source'] }) | null> {
  // EI-8579: resolve via getClaimSpecRecord (not the bare getClaimSpec) so the caller can
  // tell WHICH row answered — a bee with neither a per-bee nor an inherited fleet spec
  // (source:'default') is silently drawing plain oldest-first ordering, which can hand it
  // owner-deferred work (e.g. a paused/de-scoped category) a curated spec would exclude.
  // scheduler:get_next surfaces this as an advisory `warning` so a self-pulling agent with
  // no spec learns to set one, instead of claimHold-parking deferred rows one at a time.
  const record = args.ignoreStoredSpec
    ? { source: 'default' as const, spec: DEFAULT_CLAIM_SPEC }
    : await getClaimSpecRecord({ beeId: args.beeId, workspaceId: args.workspaceId });
  const result = await getNextWorkItem(record.spec, { assignee: args.beeId, heldPaths: args.heldPaths }, {
    harness: args.harness,
    ...(args.swarmId ? { swarmId: args.swarmId } : {}),
    ...(args.excludeRedundant ? { excludeRedundant: true } : {}),
    ...(args.states ? { states: args.states } : {}),
    ...(args.rigAvailable ? { rigAvailable: true } : {}),
  });
  return result ? { ...result, specSource: record.source } : null;
}

/**
 * EI-7678: the READ counterpart to setClaimSpec — a bee's/fleet's claim spec was write-only
 * from the tool surface (verifying a live spec meant grepping source for the zod grammar, or a
 * raw `bee_claim_specs` query). Full record, not just the resolved spec: which row actually
 * answered (a per-bee spec, an inherited fleet spec, or neither ⇒ DEFAULT_CLAIM_SPEC), plus its
 * revision/updatedBy/updatedAt/harnessSlug so a leader can confirm a re-steer actually landed
 * before relying on it.
 */
export interface ClaimSpecRecord {
  /** Which row answered: a per-bee spec always wins; 'fleet' when inherited via membership;
   *  'default' when neither a per-bee nor a fleet spec exists (DEFAULT_CLAIM_SPEC applies). */
  source: 'bee' | 'fleet' | 'default';
  spec: ClaimSpec;
  revision: number | null;
  updatedBy: string | null;
  updatedAt: string | null;
  /** The federation hive scope the row rides (null ⇒ operator-scope/local-only). Absent on 'default'. */
  harnessSlug?: string | null;
  /** Set when `source === 'fleet'`: the fleet slug whose spec this bee inherited. */
  fleetSlug?: string;
}

/**
 * Load the full claim-spec RECORD for a bee (or, via `fleetSpecBeeKey`, a fleet sentinel) —
 * mirrors getClaimSpec's resolution order (bee spec → fleet spec → DEFAULT_CLAIM_SPEC) but
 * returns the row metadata instead of silently collapsing to just the resolved spec, so a
 * caller can tell an explicit override from an inherited or absent one.
 */
export async function getClaimSpecRecord(
  args: { beeId: string; workspaceId?: string },
  sqlOverride?: OrgSql,
): Promise<ClaimSpecRecord> {
  const ws = args.workspaceId ?? DEFAULT_COORD_WORKSPACE;
  const sql = sqlOverride ?? getOrgPg().sql;
  const rows = (await sql`
    SELECT spec, revision, updated_by, updated_at, harness_slug
      FROM harness_shared.bee_claim_specs
     WHERE workspace_id = ${ws} AND bee_id = ${args.beeId} LIMIT 1`) as Array<{
    spec: unknown;
    revision: number;
    updated_by: string | null;
    updated_at: string;
    harness_slug: string | null;
  }>;
  if (rows.length > 0) {
    const row = rows[0]!;
    const v = validateClaimSpec(row.spec);
    return {
      source: 'bee',
      spec: v.ok && v.spec ? v.spec : DEFAULT_CLAIM_SPEC,
      revision: row.revision,
      updatedBy: row.updated_by,
      updatedAt: row.updated_at,
      harnessSlug: row.harness_slug,
    };
  }
  // No per-bee row — try the fleet the bee belongs to (same inheritance getClaimSpec applies).
  try {
    const { latestFleetMembership } = await import('../fleet-membership-store');
    const membership = await latestFleetMembership(ws, args.beeId);
    if (membership?.fleetSlug) {
      const frows = (await sql`
        SELECT spec, revision, updated_by, updated_at, harness_slug
          FROM harness_shared.bee_claim_specs
         WHERE workspace_id = ${ws} AND bee_id = ${fleetSpecBeeKey(membership.fleetSlug)} LIMIT 1`) as Array<{
        spec: unknown;
        revision: number;
        updated_by: string | null;
        updated_at: string;
        harness_slug: string | null;
      }>;
      if (frows.length > 0) {
        const frow = frows[0]!;
        const fv = validateClaimSpec(frow.spec);
        if (fv.ok && fv.spec) {
          return {
            source: 'fleet',
            spec: fv.spec,
            revision: frow.revision,
            updatedBy: frow.updated_by,
            updatedAt: frow.updated_at,
            harnessSlug: frow.harness_slug,
            fleetSlug: membership.fleetSlug,
          };
        }
      }
    }
  } catch {
    /* fall through to the default */
  }
  return { source: 'default', spec: DEFAULT_CLAIM_SPEC, revision: null, updatedBy: null, updatedAt: null };
}

/** The claim-spec head (specId@revision) a bee is running under — the live-execution view's
 *  per-run spec column (P-001). */
export interface ClaimSpecHead {
  specId: string;
  revision: number;
}

/**
 * Batch-load the running spec HEAD (specId@revision) for a set of bees, keyed by beeId — the
 * spec-join behind the live-execution view (P-001, {@link import('./bee-runs').listBeeRuns}).
 * A bee with no stored spec is ABSENT from the map (⇒ DEFAULT ordering / no Queen-authored
 * spec). `bee_id` is globally unique (it is the claim's `taken_by`), so this joins by `bee_id`
 * regardless of workspace by default; pass `workspaceId` to scope. When a bee somehow has rows
 * in multiple workspaces, the highest revision wins.
 */
export async function getClaimSpecHeadsForBees(
  beeIds: string[],
  workspaceId?: string,
  sqlOverride?: OrgSql,
): Promise<Map<string, ClaimSpecHead>> {
  const map = new Map<string, ClaimSpecHead>();
  if (beeIds.length === 0) return map;
  const sql = sqlOverride ?? getOrgPg().sql;
  const rows = (await sql`
    SELECT DISTINCT ON (bee_id) bee_id, spec->>'specId' AS spec_id, revision
      FROM harness_shared.bee_claim_specs
     WHERE bee_id = ANY(${beeIds})
       ${workspaceId ? sql`AND workspace_id = ${workspaceId}` : sql``}
     ORDER BY bee_id, revision DESC`) as Array<{ bee_id: string; spec_id: string | null; revision: number }>;
  for (const r of rows) {
    if (r.spec_id) map.set(r.bee_id, { specId: r.spec_id, revision: Number(r.revision) });
  }
  return map;
}
