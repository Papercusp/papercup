/** Fleet-execution-health member-productivity, revision 57.
 * Reuses membership/tool/work-item writers and the subject-scoped instrument registry.
 * Current work-item fields are observations at read time, never a historical claim ledger.
 */
import { createHash } from 'node:crypto';
import { canonicalJson } from '@papercusp/hash-chain';
import { getOrgPg } from '@papercusp/db-org';
import type { Sql } from 'postgres';
import type { PlatformInstrument } from '../rubric-instrument-registry';

export const FLEET_PRODUCTIVITY_KEY = 'fleet:member-productivity';
export const FLEET_PRODUCTIVITY_MAX_MEMBERS = 20_000;
export const FLEET_PRODUCTIVITY_QUERY_REF = 'packages/operator-core/lib/fleet/execution-productivity.ts#FLEET_PRODUCTIVITY_SQL';
export const FLEET_CLAIM_HISTORY_QUERY_REF = 'packages/operator-core/lib/fleet/execution-productivity.ts#FLEET_CLAIM_HISTORY_SQL';
export const FLEET_CLAIM_HISTORY_MAX_ITEMS = 50_000;
export const FLEET_CLAIM_HISTORY_MAX_ENTRIES = 1024;
export interface FleetProductivityWindow {
  workspaceId: string;
  harnessSlug: string;
  fleet: string;
  windowStart: string;
  windowEnd: string;
}

/** Revision 57 says closes BETWEEN the start and end (both inclusive), and
 * membership at or before end. Keep those literal boundaries explicit.
 * Membership is EVER-member through the end,
 * including joins before start; leave intervals are intentionally not used.
 * All leaders of record before end are excluded, even if also recorded as members.
 * Seat activity follows the literal method: all workspace tool calls by each owner,
 * including calls in other harnesses. Work-item outcomes are harness-scoped.
 * The bounded result contains one aggregate per owner, never a capped event sample.
 */
export const FLEET_PRODUCTIVITY_SQL = `
WITH membership AS MATERIALIZED (
  SELECT owner_id, bool_or(fleet_role = 'member') AS member,
    bool_or(fleet_role = 'leader') AS leader
    FROM harness_shared.fleet_membership_events
   WHERE workspace_id = $1 AND fleet_slug = $2 AND at <= $4::timestamptz
   GROUP BY owner_id
), members AS MATERIALIZED (
  SELECT owner_id FROM membership WHERE member AND NOT coalesce(leader, false)
), activity AS MATERIALIZED (
  SELECT t.coord_owner_id AS owner_id,
    count(DISTINCT floor(extract(epoch FROM t.invoked_at) / 900))::int AS buckets
    FROM harness_shared.tool_invocations t
   WHERE t.workspace_id = $1 AND t.coord_owner_id IN (SELECT owner_id FROM members)
     AND t.invoked_at >= $3::timestamptz AND t.invoked_at <= $4::timestamptz
   GROUP BY t.coord_owner_id
), closes AS MATERIALIZED (
  SELECT w.terminal_owner AS owner_id, count(*)::int AS closes
    FROM harness_shared.work_items w
   WHERE w.workspace_id = $1 AND w.harness_slug = $5
     AND w.terminal_owner IN (SELECT owner_id FROM members)
     AND w.status IN ('done', 'resolved', 'closed')
     AND w.lane IS DISTINCT FROM 'observation'
     AND w.closed_ts >= extract(epoch FROM $3::timestamptz) * 1000
     AND w.closed_ts <= extract(epoch FROM $4::timestamptz) * 1000
   GROUP BY w.terminal_owner
), held AS MATERIALIZED (
  SELECT w.taken_by AS owner_id, count(*)::int AS held_items,
    sum(extract(epoch FROM ($4::timestamptz - greatest(w.taken_at, $3::timestamptz))) / 3600)::float8 AS held_hours
    FROM harness_shared.work_items w
   WHERE w.workspace_id = $1 AND w.harness_slug = $5
     AND w.taken_by IN (SELECT owner_id FROM members)
     AND w.lane IS DISTINCT FROM 'observation'
     AND coalesce(w.status, '') NOT IN ('done', 'resolved', 'closed', 'dropped', 'passed', 'deprecated')
     AND w.taken_at < $4::timestamptz
   GROUP BY w.taken_by
)
SELECT m.owner_id, coalesce(a.buckets, 0) AS buckets, coalesce(c.closes, 0) AS closes,
  coalesce(h.held_items, 0) AS held_items, coalesce(h.held_hours, 0) AS held_hours
  FROM members m LEFT JOIN activity a USING (owner_id)
  LEFT JOIN closes c USING (owner_id) LEFT JOIN held h USING (owner_id)
 ORDER BY m.owner_id LIMIT $6`;

/** Reuse the retained-history qualification procedure, without mistaking its
 * candidate set for a complete historical population. The trigger records the
 * SAME {owner, at} shape on claim and release; either starting phase is possible.
 * Bound both rows and history entries before bringing them into the process.
 */
export const FLEET_CLAIM_HISTORY_SQL = `
WITH membership AS MATERIALIZED (
  SELECT owner_id, bool_or(fleet_role = 'member') AS member,
    bool_or(fleet_role = 'leader') AS leader
    FROM harness_shared.fleet_membership_events
   WHERE workspace_id = $1 AND fleet_slug = $2 AND at <= $3::timestamptz
   GROUP BY owner_id
), members AS MATERIALIZED (
  SELECT owner_id FROM membership WHERE member AND NOT coalesce(leader, false)
), candidates AS MATERIALIZED (
  SELECT DISTINCT w.feature_id, w.origin, w.taken_by, w.worked_by_history
    FROM members m CROSS JOIN LATERAL (
      SELECT wi.feature_id, wi.origin, wi.taken_by, wi.worked_by_history
        FROM harness_shared.work_items wi
       WHERE wi.workspace_id = $1 AND wi.harness_slug = $4
         AND wi.lane IS DISTINCT FROM 'observation'
         AND (wi.taken_by = m.owner_id OR
           wi.worked_by_history @> jsonb_build_array(jsonb_build_object('owner', m.owner_id)))
    ) w
   ORDER BY w.feature_id LIMIT $5
)
SELECT feature_id, origin, taken_by,
  CASE WHEN jsonb_typeof(worked_by_history) = 'array'
    THEN jsonb_array_length(worked_by_history) ELSE NULL END AS history_entries,
  CASE WHEN jsonb_typeof(worked_by_history) = 'array'
    THEN jsonb_path_query_array(worked_by_history, '$[0 to 1023]')
    ELSE worked_by_history END AS history
  FROM candidates ORDER BY feature_id`;

export interface FleetClaimHistoryRow {
  feature_id: string;
  origin: string | null;
  taken_by: string | null;
  history_entries: number | null;
  history: unknown;
}
export type FleetClaimHistoryClass = 'remote-history-unqualified' | 'truncated-history-unqualified' |
  'malformed-history-unqualified' | 'nonmonotone-history-unqualified' |
  'no-observed-transition-before-cutoff' | 'current-holder-mismatch-unqualified' |
  'cutoff-phase-ambiguous' | 'retained-history-unheld' | 'retained-history-other-holder' |
  'retained-history-member-held';
export interface FleetClaimHistoryCoverage {
  queryRef: typeof FLEET_CLAIM_HISTORY_QUERY_REF;
  candidateSetComplete: boolean;
  observedCandidates: number;
  classificationCounts: Partial<Record<FleetClaimHistoryClass, number>>;
  examples: Partial<Record<FleetClaimHistoryClass, string[]>>;
  conditionalMemberHeldItems: number;
  conditionalMemberHeldWindowHours: number;
  historicalPopulationVerified: false;
  terminalStateAtCutoffVerified: false;
  qualifiesHistoricalTotal: false;
  limitations: string[];
}

/** Conditional occupancy only: terminal/reopen history and history retention
 * are NOT established by this writer. Even an unambiguous phase is not proof
 * of the complete claimed-but-unclosed population or a lower bound on it.
 */
export function classifyFleetClaimHistory(row: FleetClaimHistoryRow, input: FleetProductivityWindow,
  members: ReadonlySet<string>): { classification: FleetClaimHistoryClass; windowHours?: number } {
  // Federation projections also stamp namespaced tokens such as
  // remote:engineer-issues. Receiver-local history cannot qualify those rows.
  if (row.origin === 'remote' || row.origin?.startsWith('remote:')) {
    return { classification: 'remote-history-unqualified' };
  }
  if (row.history_entries !== null && row.history_entries > FLEET_CLAIM_HISTORY_MAX_ENTRIES) {
    return { classification: 'truncated-history-unqualified' };
  }
  if (!Array.isArray(row.history) || row.history_entries !== row.history.length) {
    return { classification: 'malformed-history-unqualified' };
  }
  const entries: Array<{ owner: string; at: number }> = [];
  for (const raw of row.history) {
    const e = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
    const owner = typeof e?.owner === 'string' ? e.owner.trim() : '';
    const at = typeof e?.at === 'string' ? Date.parse(e.at) : NaN;
    if (!owner || owner.toLowerCase() === 'unassigned' || !Number.isFinite(at)) {
      return { classification: 'malformed-history-unqualified' };
    }
    if (entries.length && at < entries[entries.length - 1]!.at) {
      return { classification: 'nonmonotone-history-unqualified' };
    }
    entries.push({ owner, at });
  }
  const end = Date.parse(input.windowEnd), start = Date.parse(input.windowStart);
  if (!entries.some(e => e.at <= end)) return { classification: 'no-observed-transition-before-cutoff' };
  const current = row.taken_by?.trim();
  const currentHolder = current && current.toLowerCase() !== 'unassigned' ? current : null;
  const phases = [null, entries[0]!.owner].map(initial => {
    let holder: string | null = initial, claimedAt: number | null = null;
    let cutoffHolder: string | null = null, cutoffAt: number | null = null;
    for (const e of entries) {
      holder = holder === e.owner ? null : e.owner;
      claimedAt = holder === null ? null : e.at;
      if (e.at <= end) { cutoffHolder = holder; cutoffAt = claimedAt; }
    }
    return { holder, cutoffHolder, cutoffAt };
  }).filter(p => p.holder === currentHolder);
  if (!phases.length) return { classification: 'current-holder-mismatch-unqualified' };
  if (new Set(phases.map(p => JSON.stringify([p.cutoffHolder, p.cutoffAt]))).size !== 1) {
    return { classification: 'cutoff-phase-ambiguous' };
  }
  const p = phases[0]!;
  if (p.cutoffHolder === null) return { classification: 'retained-history-unheld' };
  if (!members.has(p.cutoffHolder)) return { classification: 'retained-history-other-holder' };
  return { classification: 'retained-history-member-held',
    windowHours: (end - Math.max(start, p.cutoffAt!)) / 3_600_000 };
}

export function summarizeFleetClaimHistory(input: FleetProductivityWindow, rows: readonly FleetClaimHistoryRow[],
  members: ReadonlySet<string>): FleetClaimHistoryCoverage {
  const result: FleetClaimHistoryCoverage = { queryRef: FLEET_CLAIM_HISTORY_QUERY_REF,
    candidateSetComplete: rows.length <= FLEET_CLAIM_HISTORY_MAX_ITEMS,
    observedCandidates: rows.length, classificationCounts: {}, examples: {},
    conditionalMemberHeldItems: 0, conditionalMemberHeldWindowHours: 0,
    historicalPopulationVerified: false, terminalStateAtCutoffVerified: false, qualifiesHistoricalTotal: false,
    limitations: ['Candidate selection uses current retained rows and history; deleted, reset, missing and creation-time claims are not covered.',
      'The writer does not label claims versus releases. Phase agreement is conditional on retained history and the current holder.',
      'Terminal/reopen state at the cutoff is unverified. Conditional occupancy is neither a historical total nor an unconditional lower bound.'] };
  if (!result.candidateSetComplete) {
    result.limitations.unshift('Candidate sentinel exceeded; no conditional aggregate was computed.');
    return result;
  }
  for (const row of rows) {
    const c = classifyFleetClaimHistory(row, input, members);
    result.classificationCounts[c.classification] = (result.classificationCounts[c.classification] ?? 0) + 1;
    const examples = result.examples[c.classification] ??= [];
    if (examples.length < 3) examples.push(row.feature_id);
    if (c.classification === 'retained-history-member-held') {
      result.conditionalMemberHeldItems++;
      result.conditionalMemberHeldWindowHours += c.windowHours!;
    }
  }
  return result;
}

export interface FleetProductivityRow {
  owner_id: string;
  buckets: number;
  closes: number;
  held_items: number;
  held_hours: number;
}
export interface FleetProductivityMeasurement {
  input: FleetProductivityWindow;
  queryRef: typeof FLEET_PRODUCTIVITY_QUERY_REF;
  members: Array<{ ownerId: string; activeSeatHours: number; closes: number;
    closesPerActiveSeatHour: number | null; currentHeldItems: number; currentHeldWindowHours: number }>;
  totals: { activeSeatHours: number; closes: number; closesPerActiveSeatHour: number | null;
    medianPerActiveMember: number | null; eligibleZeroCloseOwners: number; zeroCloseOwners: number;
    zeroCloseShare: number | null; currentHeldItems: number; currentHeldWindowHours: number };
  /** The method permits per-owner figures when cross-owner lineage is unresolved. */
  lineage: { basis: 'owner-id'; resolved: false; note: string };
  claimHours: { basis: 'current-held-fields'; historicalWindowEndVerified: false; note: string;
    retainedHistory?: FleetClaimHistoryCoverage };
  unavailableReason?: string;
}

export function validateFleetProductivityWindow(input: FleetProductivityWindow): string | null {
  const start = Date.parse(input.windowStart), end = Date.parse(input.windowEnd);
  if (![input.workspaceId, input.harnessSlug, input.fleet].every(v => v.trim() && v === v.trim() && v !== '*') ||
      !Number.isFinite(start) || !Number.isFinite(end) || start >= end || end > Date.now() ||
      end - start > 7 * 86_400_000) return 'An exact workspace, harness, fleet and completed window of at most seven days are required.';
  return null;
}

export function summarizeFleetProductivity(input: FleetProductivityWindow,
  rows: readonly FleetProductivityRow[]): FleetProductivityMeasurement {
  const result: FleetProductivityMeasurement = { input: { ...input }, queryRef: FLEET_PRODUCTIVITY_QUERY_REF,
    members: [], totals: { activeSeatHours: 0, closes: 0, closesPerActiveSeatHour: null,
      medianPerActiveMember: null, eligibleZeroCloseOwners: 0, zeroCloseOwners: 0, zeroCloseShare: null,
      currentHeldItems: 0, currentHeldWindowHours: 0 },
    lineage: { basis: 'owner-id', resolved: false,
      note: 'Per-owner zero-close share; no cross-owner respawn lineage has been established. Same-owner carry remains one seat.' },
    claimHours: { basis: 'current-held-fields', historicalWindowEndVerified: false,
      note: 'taken_by/taken_at/status are current fields. Hours cover only their overlap with the window; released or changed historical claims are not reconstructed.' } };
  const invalid = validateFleetProductivityWindow(input);
  if (invalid) { result.unavailableReason = invalid; return result; }
  if (rows.length > FLEET_PRODUCTIVITY_MAX_MEMBERS) {
    result.unavailableReason = 'Member result exceeded its sentinel bound; this is not a complete population.';
    return result;
  }
  const owners = new Set<string>();
  for (const row of rows) {
    if (!row.owner_id?.trim() || owners.has(row.owner_id) ||
        ![row.buckets, row.closes, row.held_items].every(n => Number.isSafeInteger(n) && n >= 0) ||
        !Number.isFinite(row.held_hours) || row.held_hours < 0) {
      result.unavailableReason = 'Malformed or duplicate owner aggregate; no population verdict is available.';
      return result;
    }
    owners.add(row.owner_id);
    const hours = row.buckets * 0.25;
    result.members.push({ ownerId: row.owner_id, activeSeatHours: hours, closes: row.closes,
      closesPerActiveSeatHour: hours ? row.closes / hours : null,
      currentHeldItems: row.held_items, currentHeldWindowHours: row.held_hours });
  }
  const t = result.totals;
  for (const member of result.members) {
    t.activeSeatHours += member.activeSeatHours; t.closes += member.closes;
    t.currentHeldItems += member.currentHeldItems; t.currentHeldWindowHours += member.currentHeldWindowHours;
    if (member.activeSeatHours >= 2) { t.eligibleZeroCloseOwners++; if (!member.closes) t.zeroCloseOwners++; }
  }
  t.closesPerActiveSeatHour = t.activeSeatHours ? t.closes / t.activeSeatHours : null;
  t.zeroCloseShare = t.eligibleZeroCloseOwners ? t.zeroCloseOwners / t.eligibleZeroCloseOwners : null;
  const rates = result.members.flatMap(m => m.closesPerActiveSeatHour === null ? [] : [m.closesPerActiveSeatHour]).sort((a, b) => a - b);
  if (rates.length) t.medianPerActiveMember = (rates[Math.floor((rates.length - 1) / 2)]! + rates[Math.floor(rates.length / 2)]!) / 2;
  if (!rows.length) result.unavailableReason = 'No ever-member owners before the window end.';
  else if (result.members.some(m => m.closes > 0 && !m.activeSeatHours)) {
    result.unavailableReason = 'A closing owner has no recorded activity; tool coverage is insufficient for seat-time grading.';
  }
  return result;
}

/** The numeric result counts nested severity thresholds crossed: 0 healthy,
 * 1 degraded, 2 broken. It is explicitly a classification count, not throughput.
 * Full criterion acceptance also needs the unresolved historical claim-hour subcheck.
 */
export function rateFleetProductivity(m: FleetProductivityMeasurement) {
  const t = m.totals;
  if (m.unavailableReason || t.closes < 5 || t.closesPerActiveSeatHour === null) return {
    rating: 'unknown' as const, reason: m.unavailableReason ?? 'Fewer than five member closes or no measured seat-time.', severityLevels: null };
  const broken = t.closesPerActiveSeatHour < 0.1 || (t.zeroCloseShare !== null && t.zeroCloseShare > 0.5);
  const degraded = t.closesPerActiveSeatHour < 0.25 || (t.zeroCloseShare !== null && t.zeroCloseShare > 0.3);
  return { rating: broken ? 'broken' as const : degraded ? 'degraded' as const : 'healthy' as const,
    severityLevels: broken ? 2 : degraded ? 1 : 0,
    reason: 'Provisional revision-57 thresholds; zero-close share is explicitly per owner, not resolved cross-owner lineage.' };
}

export async function measureFleetProductivity(input: FleetProductivityWindow, db?: Sql) {
  const invalid = validateFleetProductivityWindow(input);
  if (invalid) return summarizeFleetProductivity(input, []);
  const sql = db ?? getOrgPg().sql;
  const rows = await sql.unsafe<FleetProductivityRow[]>(FLEET_PRODUCTIVITY_SQL,
    [input.workspaceId, input.fleet, input.windowStart, input.windowEnd, input.harnessSlug, FLEET_PRODUCTIVITY_MAX_MEMBERS + 1]);
  const measurement = summarizeFleetProductivity(input, rows);
  if (measurement.unavailableReason) return measurement;
  const history = await sql.unsafe<FleetClaimHistoryRow[]>(FLEET_CLAIM_HISTORY_SQL,
    [input.workspaceId, input.fleet, input.windowEnd, input.harnessSlug, FLEET_CLAIM_HISTORY_MAX_ITEMS + 1]);
  measurement.claimHours.retainedHistory = summarizeFleetClaimHistory(input, history,
    new Set(measurement.members.map(m => m.ownerId)));
  return measurement;
}

export function fleetProductivityRescore(): NonNullable<PlatformInstrument['rescore']> {
  return { scope: 'subject', windowMs: 7 * 86_400_000, unit: 'count', resolve: async window => {
    if (window.subject?.kind !== 'fleet' || !window.harnessSlug) return { verdict: 'unknown',
      detail: 'Fleet productivity requires an exact fleet subject and rubric harness.' };
    const measurement = await measureFleetProductivity({ ...window, harnessSlug: window.harnessSlug, fleet: window.subject.ref });
    const throughput = rateFleetProductivity(measurement);
    const resultHash = createHash('sha256').update(canonicalJson(measurement)).digest('hex');
    // Do not convert a measured throughput tier into a full method pass while the
    // separate claimed-but-unclosed historical subcheck is still unqualified.
    return { verdict: 'unknown', detail: JSON.stringify({ throughput, totals: measurement.totals,
      unavailableReason: measurement.unavailableReason, lineage: measurement.lineage, claimHours: measurement.claimHours,
      missingSubchecks: ['historical claimed-but-unclosed item-hours'], sample: measurement.members.slice(0, 5) }),
      evidenceRefs: [FLEET_PRODUCTIVITY_QUERY_REF, FLEET_CLAIM_HISTORY_QUERY_REF,
        `${FLEET_PRODUCTIVITY_QUERY_REF}#result-sha256:${resultHash}`] };
  } };
}
