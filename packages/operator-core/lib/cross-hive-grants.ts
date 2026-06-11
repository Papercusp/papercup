/**
 * cross-hive-grants — owner-set capability grants for the cross-Hive boundary
 * (cross-hive-boundary-2026-06-08 P-002; hive-network-surface-2026-06-11 P-004 B-05).
 * Trust between sovereign Hives is per-peer-Hive + revocable, and now DIRECTED:
 *
 *   `in`  — which peer-Hive pubkeys may send which kinds INTO this Hive (admission;
 *           consumed by `admitCrossHiveEnvelope` on the receive path).
 *   `out` — which peer-Hive pubkeys THIS Hive may send which kinds TO (egress policy;
 *           consumed by `admitOutboundCrossHive` on the send path). Default-deny: the
 *           Queen cannot ask / request-work from a peer until the owner grants `out`.
 *
 * Stored as a single `hive_settings` value (federates to ALL of this Hive's Swarms over
 * the Hive peer-log, so every Swarm enforces the same policy) keyed by the Hive's home
 * slug. Absence of a grant is a hard reject in BOTH directions — the boundary is
 * allow-list (default-deny).
 *
 * Wire shape `{ in: { [peer]: kinds[] }, out: { [peer]: kinds[] } }`. BACK-COMPAT: a
 * legacy flat `{ [peer]: kinds[] }` value (written before B-05) reads as INBOUND grants
 * with no outbound — `{ in: <legacy>, out: {} }` — so existing admission policy is
 * unchanged until the owner adds an outbound grant.
 *
 * Written by the owner via `hive:cross_grant { direction }`.
 */
import type { Sql } from 'postgres';
import { getHiveSetting, setHiveSetting } from './hive-settings-store';
import {
  admitOutboundCrossHive,
  type CrossHiveAdmission,
  type CrossHiveGrant,
  type CrossHiveKind,
} from './cross-hive-boundary';

/** The single hive_settings key under which the directed grant map lives. */
export const CROSS_HIVE_GRANTS_KEY = 'xhive-capability-grants';

/** Grant direction: `in` = peers→us (admission); `out` = us→peers (egress). */
export type CrossHiveGrantDirection = 'in' | 'out';

/** Wire shape of one direction: { [peerHivePubkey]: CrossHiveKind[] }. */
type GrantMap = Record<string, CrossHiveKind[]>;

/** The full directed grant map persisted under {@link CROSS_HIVE_GRANTS_KEY}. */
export interface DirectedGrantMap {
  in: GrantMap;
  out: GrantMap;
}

/** Directed view of this Hive's grants as admission-ready arrays. */
export interface DirectedCrossHiveGrants {
  in: CrossHiveGrant[];
  out: CrossHiveGrant[];
}

const KINDS: readonly CrossHiveKind[] = ['ask', 'work-request'];
const isKind = (k: unknown): k is CrossHiveKind => KINDS.includes(k as CrossHiveKind);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** Parse one direction's stored value into a clean grant map (tolerant of junk). */
function toGrantMap(value: unknown): GrantMap {
  if (!isPlainObject(value)) return {};
  const out: GrantMap = {};
  for (const [peer, kinds] of Object.entries(value)) {
    if (Array.isArray(kinds)) {
      const clean = [...new Set(kinds.filter(isKind))];
      if (clean.length > 0) out[peer] = clean;
    }
  }
  return out;
}

/**
 * Parse the stored setting value into a directed grant map. Detects the new directed
 * shape (an object carrying an `in` and/or `out` SUB-MAP) vs the legacy flat inbound
 * shape (an object whose values are kind arrays) and migrates the legacy form to
 * `{ in: <legacy>, out: {} }`. A peer literally named `in`/`out` in a legacy map carries
 * an array value (not a sub-map) so it is never mistaken for the directed shape.
 */
export function toDirectedGrantMap(value: unknown): DirectedGrantMap {
  if (!isPlainObject(value)) return { in: {}, out: {} };
  const hasIn = isPlainObject(value.in);
  const hasOut = isPlainObject(value.out);
  if (hasIn || hasOut) {
    return {
      in: toGrantMap(hasIn ? value.in : {}),
      out: toGrantMap(hasOut ? value.out : {}),
    };
  }
  // Legacy flat shape = INBOUND grants only.
  return { in: toGrantMap(value), out: {} };
}

function mapToGrants(map: GrantMap): CrossHiveGrant[] {
  return Object.entries(map).map(([peerHivePubkey, allowedKinds]) => ({ peerHivePubkey, allowedKinds }));
}

async function loadDirectedMap(workspaceId: string, hiveHomeSlug: string, sql?: Sql): Promise<DirectedGrantMap> {
  const rec = await getHiveSetting(workspaceId, hiveHomeSlug, CROSS_HIVE_GRANTS_KEY, sql);
  return toDirectedGrantMap(rec?.value);
}

/**
 * Load this Hive's INBOUND cross-Hive grants (the boundary's admission policy).
 * Unchanged contract: the receive path (`receiveCrossHive` → `admitCrossHiveEnvelope`)
 * consumes exactly these.
 */
export async function loadCrossHiveGrants(
  workspaceId: string,
  hiveHomeSlug: string,
  sql?: Sql,
): Promise<CrossHiveGrant[]> {
  return mapToGrants((await loadDirectedMap(workspaceId, hiveHomeSlug, sql)).in);
}

/**
 * Load this Hive's OUTBOUND cross-Hive grants (the send-path egress policy). Consumed by
 * `admitOutboundCrossHive` before a request (ask | work-request) is signed + sent.
 */
export async function loadOutboundCrossHiveGrants(
  workspaceId: string,
  hiveHomeSlug: string,
  sql?: Sql,
): Promise<CrossHiveGrant[]> {
  return mapToGrants((await loadDirectedMap(workspaceId, hiveHomeSlug, sql)).out);
}

/** Load both directions in one read (for `hive:cross_grant list` + the Network board). */
export async function loadDirectedCrossHiveGrants(
  workspaceId: string,
  hiveHomeSlug: string,
  sql?: Sql,
): Promise<DirectedCrossHiveGrants> {
  const directed = await loadDirectedMap(workspaceId, hiveHomeSlug, sql);
  return { in: mapToGrants(directed.in), out: mapToGrants(directed.out) };
}

/**
 * Grant (upsert) a peer-Hive the named kinds in the given direction. Empty kinds is
 * equivalent to a revoke of that peer in that direction. The OTHER direction is
 * preserved untouched.
 */
export async function setCrossHiveGrant(
  workspaceId: string,
  hiveHomeSlug: string,
  peerHivePubkey: string,
  allowedKinds: readonly CrossHiveKind[],
  direction: CrossHiveGrantDirection,
  sql?: Sql,
): Promise<void> {
  const directed = await loadDirectedMap(workspaceId, hiveHomeSlug, sql);
  const map = directed[direction];
  const clean = [...new Set(allowedKinds.filter(isKind))];
  if (clean.length === 0) delete map[peerHivePubkey];
  else map[peerHivePubkey] = clean;
  await setHiveSetting(
    { workspaceId, hiveHomeSlug, settingKey: CROSS_HIVE_GRANTS_KEY, value: directed },
    sql,
  );
}

/** Revoke a peer-Hive's grant in the given direction (idempotent). */
export async function revokeCrossHiveGrant(
  workspaceId: string,
  hiveHomeSlug: string,
  peerHivePubkey: string,
  direction: CrossHiveGrantDirection,
  sql?: Sql,
): Promise<void> {
  const directed = await loadDirectedMap(workspaceId, hiveHomeSlug, sql);
  if (!(peerHivePubkey in directed[direction])) return;
  delete directed[direction][peerHivePubkey];
  await setHiveSetting(
    { workspaceId, hiveHomeSlug, settingKey: CROSS_HIVE_GRANTS_KEY, value: directed },
    sql,
  );
}

/**
 * Load this Hive's outbound grants and decide whether an outbound request to `toHivePubkey`
 * of `kind` is permitted. The convenience the front-door tools (`hive:ask` /
 * `hive:request_work`) call before composing a send — non-throwing, returns the admission
 * verdict + a reason to surface. Default-deny: an unknown peer is rejected.
 */
export async function assertOutboundGrant(
  workspaceId: string,
  hiveHomeSlug: string,
  toHivePubkey: string,
  kind: CrossHiveKind,
  sql?: Sql,
): Promise<CrossHiveAdmission> {
  const grants = await loadOutboundCrossHiveGrants(workspaceId, hiveHomeSlug, sql);
  return admitOutboundCrossHive({ toHivePubkey, kind }, { grants });
}
