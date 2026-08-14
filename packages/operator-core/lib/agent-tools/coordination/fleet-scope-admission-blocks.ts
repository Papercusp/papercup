/**
 * fleet-scope-admission-blocks.ts — the leader-facing READ half of fleet-scope
 * admission (EI-18680302159738037).
 *
 * `fleet-scope-admission.ts` owns the REFUSAL: a member's claim is checked against
 * the fleet claim spec, refused before mutation, and the leader is notified. That
 * notice is an ordinary coord message, and an ordinary coord message is exactly
 * what gets buried — the filing incident measured an inbox at total=11990 with
 * coalesced_dupes=11000, where one action-required row does not survive. This
 * module recovers those refusals so `fleet:leader-brief` — the surface a leader
 * actually reads every wake — can name them.
 *
 * The remedy for an admission block is a claim-spec write only the LEADER can
 * make, so the block is leader-actionable by construction and belongs on the
 * leader's dashboard rather than in their mail.
 *
 * Read-side only: no side table and no second write path. The refusal already
 * stamps `fleetAdmissionBlock` on its envelope (see `notifyFleetScopeRefusal`),
 * so this scans coord_event_log the same way directive-effect-read.ts recovers
 * `expectEffect` stamps — and, like that module, it reads the COORD handle, which
 * is why it lives here beside the other coord readers rather than next to the
 * brief that consumes it.
 */
import { coordSql, coordWorkspaceId, coordHasPgFastPath } from './log';
import type { FleetDependencyEscape } from '../../scheduler/fleet-scope-admission';

/** The coord message category every fleet-scope admission notice is sent under. */
export const FLEET_ADMISSION_BLOCK_CATEGORY = 'fleet-scope-admission';

/** The envelope key `notifyFleetScopeRefusal` stamps its structured payload on. */
export const FLEET_ADMISSION_BLOCK_STAMP = 'fleetAdmissionBlock';

/**
 * How far back a refusal still counts as fleet health.
 *
 * Deliberately shorter than DIRECTIVE_EFFECT_LOOKBACK_MS (3d): a claim spec is
 * re-authored in one call, so a block the leader has already widened past is
 * noise within the hour — and stale rows here would push the brief toward the
 * very "so much output that the signal is buried" failure this exists to fix.
 */
export const FLEET_ADMISSION_BLOCK_LOOKBACK_MS = 24 * 3600 * 1000;

/** Hard cap on envelopes scanned per read, so one refusal loop cannot bloat a brief. */
export const FLEET_ADMISSION_BLOCK_SCAN_CAP = 200;

/** Rows surfaced to the leader after de-duplication. Bounds the brief's own array. */
export const FLEET_ADMISSION_BLOCK_ROW_CAP = 20;

/** One admission block, as the leader needs to act on it. */
export interface FleetAdmissionBlock {
  /** The work-item / plan-item the member was refused. */
  itemId: string | null;
  /** The member that was refused — the agent whose lane is too narrow. */
  member: string | null;
  /** Which spec refused it, and at which revision (the thing the leader edits). */
  specId: string | null;
  specRevision: number | null;
  /** The admission code: fleet_scope_missing | fleet_scope_violation | fleet_winding_down. */
  code: string | null;
  /** The attempted action, e.g. `work_items:claim WI-5891 → su-b0971`. */
  action: string | null;
  /** The refusal's own reason text, clipped. */
  reason: string | null;
  msgId: string;
  atMs: number;
  /** How many times this same (item, member) pair was refused inside the window. */
  occurrences: number;
  /** Typed critical-path escape, present only when this refusal blocks held work. */
  dependencyEscape: FleetDependencyEscape | null;
}

/** The row shape the SQL below selects — one envelope carrying a stamp. */
export interface FleetAdmissionBlockRow {
  msg_id: string;
  /** epoch ms; bigint arrives as a string from postgres-js. */
  ts_ms: string | number;
  stamp: unknown;
}

const clipReason = (value: unknown, max = 240): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
};

const asId = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
};

const asDependencyEscape = (value: unknown): FleetDependencyEscape | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const rec = value as Record<string, unknown>;
  const dependency = rec.dependency as Record<string, unknown> | undefined;
  const routes = Array.isArray(rec.routes) ? rec.routes : [];
  const routeKinds = routes.map((route) =>
    route && typeof route === 'object' && !Array.isArray(route)
      ? (route as Record<string, unknown>).kind
      : null,
  );
  if (
    rec.kind !== 'dependency_escape' ||
    rec.ownershipPreserved !== true ||
    !asId(dependency?.id) ||
    !asId(dependency?.kind) ||
    !asId(rec.member) ||
    !Array.isArray(rec.blockedHeldItemIds) ||
    rec.blockedHeldItemIds.length === 0 ||
    !rec.blockedHeldItemIds.every((id) => Boolean(asId(id))) ||
    !routeKinds.includes('spec_widen') ||
    !routeKinds.includes('outside_lane_placement') ||
    !routeKinds.includes('leader_claim')
  ) return null;
  return value as FleetDependencyEscape;
};

/**
 * PURE: parse a stamped envelope payload into a block.
 *
 * Returns null unless the stamp names BOTH the refused item and the refused
 * member. That pair is the whole actionable content — a row missing either one
 * tells the leader something was refused somewhere, which is strictly worse than
 * silence on a dashboard whose entire purpose is "here is the thing only you can
 * unblock". An envelope from an older sender (before the stamp existed) has no
 * stamp at all and is SKIPPED here rather than prose-parsed out of the body:
 * guessing at the body text would manufacture rows whose itemId is whatever the
 * remedy sentence happened to mention.
 */
export function parseAdmissionBlockStamp(
  raw: unknown,
  meta: { msgId: string; atMs: number },
): FleetAdmissionBlock | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  const itemId = asId(rec.itemId);
  const member = asId(rec.member);
  if (!itemId || !member) return null;
  if (!Number.isFinite(meta.atMs) || meta.atMs <= 0) return null;
  const revision = typeof rec.specRevision === 'number' && Number.isFinite(rec.specRevision)
    ? rec.specRevision
    : null;
  return {
    itemId,
    member,
    specId: asId(rec.specId),
    specRevision: revision,
    code: asId(rec.code),
    action: clipReason(rec.action, 160),
    reason: clipReason(rec.reason),
    msgId: meta.msgId,
    atMs: meta.atMs,
    occurrences: 1,
    dependencyEscape: asDependencyEscape(rec.dependencyEscape),
  };
}

/**
 * PURE: collapse repeat refusals of the SAME (item, member) pair to one row,
 * newest first, counting the repeats.
 *
 * A refused member retries on its own schedule, so one mis-scoped spec can emit
 * the identical refusal every wake. Collapsing keeps the brief's row list a list
 * of DISTINCT problems, while `occurrences` preserves the signal that actually
 * distinguishes a one-off from a member stuck in a refusal loop — which is the
 * more urgent read, and the one a plain cap would have truncated away.
 */
export function dedupeAdmissionBlocks(
  blocks: readonly FleetAdmissionBlock[],
  cap = FLEET_ADMISSION_BLOCK_ROW_CAP,
): FleetAdmissionBlock[] {
  const byPair = new Map<string, FleetAdmissionBlock>();
  for (const block of blocks) {
    const key = `${block.itemId}\x00${block.member}`;
    const seen = byPair.get(key);
    if (!seen) {
      byPair.set(key, { ...block });
      continue;
    }
    seen.occurrences += 1;
    // Keep the NEWEST row's detail: the spec revision on the latest refusal is
    // the one the leader is about to edit, so an older revision here would send
    // them to re-widen a spec that has already moved on.
    if (block.atMs > seen.atMs) {
      byPair.set(key, { ...block, occurrences: seen.occurrences });
    }
  }
  return [...byPair.values()].sort((a, b) => b.atMs - a.atMs).slice(0, cap);
}

/**
 * Fleet-health read: the distinct admission blocks raised against THIS fleet's
 * spec inside the lookback window.
 *
 * Best-effort like its sibling decorations (fetchDirectiveActuationSummaries /
 * fetchUnansweredDirected): gated on the coord PG fast path, empty array on any
 * failure. A decoration must never be able to fail the brief it decorates — a
 * leader-brief that throws because one advisory read had a bad day is a strictly
 * worse outcome than a leader-brief missing that advisory.
 */
export async function fetchFleetAdmissionBlocks(
  fleetSlug: string,
  opts: { nowMs?: number; lookbackMs?: number; scanCap?: number; rowCap?: number } = {},
): Promise<FleetAdmissionBlock[]> {
  if (!fleetSlug || !coordHasPgFastPath()) return [];
  try {
    const nowMs = opts.nowMs ?? Date.now();
    const sinceMs = nowMs - (opts.lookbackMs ?? FLEET_ADMISSION_BLOCK_LOOKBACK_MS);
    const sql = coordSql();
    const ws = coordWorkspaceId();
    // The durable audience KEY, not the expanded `to`: `@fleet-leader:<slug>` is
    // recorded at send time and survives a leadership change, whereas `to` holds
    // whichever ownerId happened to hold leadership then.
    const audience = `@fleet-leader:${fleetSlug}`;
    const rows = await sql<FleetAdmissionBlockRow[]>`
      SELECT e.body->>'msg_id' AS msg_id,
             (extract(epoch FROM (e.body->>'ts')::timestamptz) * 1000)::bigint AS ts_ms,
             e.body->${FLEET_ADMISSION_BLOCK_STAMP} AS stamp
        FROM harness_shared.coord_event_log e
       WHERE e.workspace_id = ${ws}
         AND e.surface = 'messages'
         AND e.body->>'category' = ${FLEET_ADMISSION_BLOCK_CATEGORY}
         AND e.body ? ${FLEET_ADMISSION_BLOCK_STAMP}
         AND jsonb_typeof(e.body->'audience') = 'array'
         AND e.body->'audience' ? ${audience}
         AND (e.body->>'ts')::timestamptz >= to_timestamp(${sinceMs}::double precision / 1000)
       ORDER BY (e.body->>'ts')::timestamptz DESC
       LIMIT ${opts.scanCap ?? FLEET_ADMISSION_BLOCK_SCAN_CAP}`;
    const parsed: FleetAdmissionBlock[] = [];
    for (const row of rows) {
      const block = parseAdmissionBlockStamp(row.stamp, {
        msgId: String(row.msg_id ?? ''),
        atMs: Number(row.ts_ms),
      });
      if (block) parsed.push(block);
    }
    return dedupeAdmissionBlocks(parsed, opts.rowCap ?? FLEET_ADMISSION_BLOCK_ROW_CAP);
  } catch {
    return [];
  }
}
