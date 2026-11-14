/** Exact fleet/window communication quantities from fleet-execution-health@57.
 * Reuses the coord writer's origin/audience fields, maintained text categorizer,
 * subject-scoped instrument registry and ledger. Thresholds do not judge intent.
 */
import { createHash } from 'node:crypto';
import { canonicalJson } from '@papercusp/hash-chain';
import { getOrgPg } from '@papercusp/db-org';
import type { Sql } from 'postgres';
import type { PlatformInstrument } from '../rubric-instrument-registry';
import { categorizeCorpus } from '../coord-lifecycle/corpus-categorize';
import { validateFleetProductivityWindow, type FleetProductivityWindow } from './execution-productivity';

export const FLEET_COMMS_KEY = 'fleet:comms-economy';
export const FLEET_COMMS_MAX_ROWS = 20_000;
export const FLEET_COMMS_MAX_BYTES = 32 * 1024 * 1024;
export const FLEET_COMMS_QUERY_REF = 'packages/operator-core/lib/fleet/execution-comms.ts#FLEET_COMMS_SQL';

// The canonical ever-member reader includes the legacy default partition. Keep
// all declared members and the nonleader subset separate, including ended seats.
const ROLES = `WITH roles AS MATERIALIZED (
 SELECT owner_id, bool_or(fleet_role='member') was_member, bool_or(fleet_role='leader') was_leader
 FROM harness_shared.fleet_membership_events
 WHERE workspace_id IN ($1,'default') AND fleet_slug=$2 AND at <= $4::timestamptz
 GROUP BY owner_id
)`;
const MESSAGE_SCOPE = `FROM harness_shared.coord_event_log e
 JOIN roles r ON r.owner_id=e.writer_key AND r.was_member
 WHERE e.workspace_id IN ($1,'default') AND e.surface='messages'
 AND e.ts >= $3::timestamptz AND e.ts < $4::timestamptz`;

export const FLEET_COMMS_SUMMARY_SQL = `${ROLES}
 SELECT (SELECT count(*) FROM roles WHERE was_member)::int members,
 (SELECT count(*) FROM roles WHERE was_member AND NOT was_leader)::int nonleaders,
 (SELECT count(*) ${MESSAGE_SCOPE})::int messages,
 (SELECT coalesce(sum(octet_length(e.body::text)),0) ${MESSAGE_SCOPE})::float8 bytes,
 (SELECT count(*) FROM harness_shared.work_items w
  WHERE w.workspace_id IN ($1,'default')
  AND w.terminal_owner IN (SELECT owner_id FROM roles WHERE was_member AND NOT was_leader)
  AND w.status IN ('done','resolved','closed') AND w.lane IS DISTINCT FROM 'observation'
  AND w.closed_ts BETWEEN extract(epoch FROM $3::timestamptz)*1000
    AND extract(epoch FROM $4::timestamptz)*1000)::int closes`;

export const FLEET_COMMS_SQL = `${ROLES}
 SELECT e.id::text id,e.msg_id,e.writer_key,r.was_leader,
 jsonb_typeof(e.body) envelope_type,e.body->>'kind' kind,e.body->>'auto' auto,
 coalesce(e.body->'fieldProvenance' ? 'expects',false) system_expects,
 e.body->>'summary' summary_text,e.body->>'body' body_text,e.body->>'lifecycle' lifecycle,
 e.body->'audience' audience,e.body->'to' recipients,e.body->>'expects' expects
 ${MESSAGE_SCOPE} ORDER BY e.ts,e.id LIMIT $5`;

export interface FleetCommsRow {
  id: string; msg_id: string | null; writer_key: string; was_leader: boolean;
  envelope_type: string | null; kind: string | null; auto: string | null; system_expects: boolean;
  summary_text: string | null; body_text: string | null; lifecycle: string | null;
  audience: unknown; recipients: unknown; expects: string | null;
}
export interface FleetCommsSourceSummary {
  members: number; nonleaders: number; messages: number; bytes: number; closes: number;
}
export type FleetCommsOrigin = 'member-authored' | 'excluded-auto' | 'excluded-kind' |
  'excluded-system-expects' | 'unknown-envelope' | 'unknown-kind' | 'unqualified-consult-router';

export function fleetCommsOrigin(row: FleetCommsRow): FleetCommsOrigin {
  if (row.envelope_type !== 'object') return 'unknown-envelope';
  if (row.auto === 'true') return 'excluded-auto';
  if (row.kind === null) return 'unknown-kind';
  if (row.kind !== 'message') return 'excluded-kind';
  if (row.system_expects) return 'excluded-system-expects';
  // Older router emissions can borrow the responder's identity without a stamp.
  // Preserve their uncertainty rather than calling them authored prose.
  if (/^(✅ answer|💬 reply) on consult /.test(row.summary_text ?? '')) return 'unqualified-consult-router';
  return 'member-authored';
}

export function fleetCommsRoute(row: FleetCommsRow, fleet: string): string {
  // sendMessage expands `to` but retains the original selectors in `audience`.
  const a = Array.isArray(row.audience) && row.audience.length ? row.audience : row.recipients;
  if (!Array.isArray(a) || !a.length || !a.every(x => typeof x === 'string' && x.length)) return 'unknown';
  if (a.includes('*')) return 'global-star';
  if (a.includes(`@fleet:${fleet}`)) return 'this-fleet-selector';
  if (a.some(x => x.startsWith('@fleet:'))) return 'other-fleet-selector';
  if (a.some(x => x.startsWith('@fleet-leader:'))) return 'leader-selector';
  return a.some(x => x.startsWith('@')) ? 'other-selector' : 'directed';
}

function cohort(input: FleetProductivityWindow, rows: readonly FleetCommsRow[], closes: number) {
  const origins: Record<string, number> = {}, routes: Record<string, number> = {}, dispositions: Record<string, number> = {};
  const authored: FleetCommsRow[] = [];
  for (const row of rows) {
    const origin = fleetCommsOrigin(row); origins[origin] = (origins[origin] ?? 0) + 1;
    if (origin !== 'member-authored') continue;
    authored.push(row);
    const route = fleetCommsRoute(row, input.fleet); routes[route] = (routes[route] ?? 0) + 1;
    const disposition = row.expects ?? 'missing'; dispositions[disposition] = (dispositions[disposition] ?? 0) + 1;
  }
  const summaryCounts = new Map<string, number>(), bodyCounts = new Map<string, number>();
  for (const row of authored) {
    if (row.summary_text) summaryCounts.set(row.summary_text, (summaryCounts.get(row.summary_text) ?? 0) + 1);
    if (row.body_text) bodyCounts.set(row.body_text, (bodyCounts.get(row.body_text) ?? 0) + 1);
  }
  const summaries = new Set<string>(), bodies = new Set<string>();
  let beyondFirst = 0, participants = 0;
  const examples: Array<{ id: string; owner: string; summary: string | null }> = [];
  for (const row of authored) {
    const summary = row.summary_text, body = row.body_text;
    if ((summary && summaries.has(summary)) || (body && bodies.has(body))) beyondFirst++;
    if ((summary && summaryCounts.get(summary)! > 1) || (body && bodyCounts.get(body)! > 1)) {
      participants++; if (examples.length < 5) examples.push({ id: row.id, owner: row.writer_key, summary: summary?.slice(0, 240) ?? null });
    }
    if (summary) summaries.add(summary); if (body) bodies.add(body);
  }
  const excluded = Object.entries(origins).filter(([k]) => k.startsWith('excluded-')).reduce((n, [, v]) => n + v, 0);
  return { raw: rows.length, authored: authored.length, excluded, unqualified: rows.length - authored.length - excluded,
    excludedShare: rows.length ? excluded / rows.length : null, origins, routes, dispositions,
    messagesPerTerminalClose: closes ? authored.length / closes : null,
    duplicateBeyondFirst: beyondFirst, duplicateParticipants: participants,
    duplicateBeyondFirstShare: authored.length ? beyondFirst / authored.length : null,
    duplicateParticipantShare: authored.length ? participants / authored.length : null,
    lifecycleHeuristic: categorizeCorpus(authored.map(row => ({ kind: row.kind ?? undefined,
      summary: row.summary_text ?? undefined, body: row.body_text ?? undefined, lifecycle: row.lifecycle ?? undefined }))), examples };
}

export function summarizeFleetComms(input: FleetProductivityWindow, summary: FleetCommsSourceSummary,
  rows: readonly FleetCommsRow[]) {
  let unavailableReason = validateFleetProductivityWindow(input);
  if (!Object.values(summary).every(n => Number.isSafeInteger(n) && n >= 0) || summary.nonleaders > summary.members) {
    unavailableReason = 'Malformed communication source counts.';
  } else if (!summary.members || !summary.nonleaders) unavailableReason = 'No qualified ever-member/nonleader population.';
  else if (summary.messages > FLEET_COMMS_MAX_ROWS || summary.bytes > FLEET_COMMS_MAX_BYTES || rows.length !== summary.messages) {
    unavailableReason = 'Communication corpus exceeded its bound or does not match its snapshot count.';
  } else if (new Set(rows.map(row => row.id)).size !== rows.length || rows.some(row => !row.id || !row.writer_key ||
      typeof row.was_leader !== 'boolean' || typeof row.system_expects !== 'boolean')) {
    unavailableReason = 'Malformed or duplicate physical message identities.';
  }
  // An invalid/truncated corpus must not produce apparently complete subgroup counts.
  const safe = unavailableReason ? [] : rows;
  const cohorts = { allDeclaredMembers: cohort(input, safe, summary.closes),
    nonleaderMembers: cohort(input, safe.filter(row => !row.was_leader), summary.closes) };
  if (!unavailableReason && Object.values(cohorts).some(c => c.unqualified || c.routes.unknown)) {
    unavailableReason = 'Message origin or original audience remains unqualified.';
  }
  return { input: { ...input }, source: { ...summary }, queryRef: FLEET_COMMS_QUERY_REF, cohorts, unavailableReason,
    units: 'messages / terminal disposition; terminal dispositions are not verified fixes',
    closeScope: 'workspace and legacy default, all harnesses, nonleader ever-members; inclusive close bounds',
    messageScope: 'same owner populations, all topics, start-inclusive/end-exclusive message bounds',
    duplicateBasis: 'exact nonempty summary OR body text; both beyond-first and participant shares',
    semanticLimit: 'Lifecycle buckets are heuristic; quantities do not decide whether every message was necessary.' };
}

export function rateFleetComms(m: ReturnType<typeof summarizeFleetComms>) {
  const c = m.cohorts.nonleaderMembers;
  if (m.unavailableReason || c.messagesPerTerminalClose === null || !c.authored) return {
    rating: 'unknown' as const, severityLevels: null, reason: m.unavailableReason ?? 'No authored messages or terminal-close denominator.' };
  const broken = c.messagesPerTerminalClose > 15;
  const degraded = c.messagesPerTerminalClose > 5 || c.duplicateParticipantShare! > 0.1;
  return { rating: broken ? 'broken' as const : degraded ? 'degraded' as const : 'healthy' as const,
    severityLevels: broken ? 2 : degraded ? 1 : 0,
    reason: 'Literal revision57 thresholds on authored messages; participant share is the conservative duplicate fraction.' };
}

export async function measureFleetComms(input: FleetProductivityWindow, db?: Sql) {
  if (validateFleetProductivityWindow(input)) return summarizeFleetComms(input,
    { members: 0, nonleaders: 0, messages: 0, bytes: 0, closes: 0 }, []);
  const sql = db ?? getOrgPg().sql;
  const parameters = [input.workspaceId, input.fleet, input.windowStart, input.windowEnd];
  return sql.begin('isolation level repeatable read read only', async tx => {
    const summaries = await tx.unsafe<FleetCommsSourceSummary[]>(FLEET_COMMS_SUMMARY_SQL, parameters);
    if (summaries.length !== 1) throw new Error('Communication summary did not return exactly one row.');
    const summary = summaries[0]!;
    if (summary.messages > FLEET_COMMS_MAX_ROWS || summary.bytes > FLEET_COMMS_MAX_BYTES) return summarizeFleetComms(input, summary, []);
    const rows = await tx.unsafe<FleetCommsRow[]>(FLEET_COMMS_SQL, [...parameters, FLEET_COMMS_MAX_ROWS + 1]);
    return summarizeFleetComms(input, summary, rows);
  });
}

export function fleetCommsRescore(): NonNullable<PlatformInstrument['rescore']> {
  return { scope: 'subject', windowMs: 7 * 86_400_000, unit: 'count', resolve: async window => {
    if (window.subject?.kind !== 'fleet' || !window.harnessSlug) return { verdict: 'unknown',
      detail: 'Communication measurement requires an exact fleet subject and rubric harness.' };
    const measurement = await measureFleetComms({ ...window, harnessSlug: window.harnessSlug, fleet: window.subject.ref });
    const threshold = rateFleetComms(measurement);
    const hash = createHash('sha256').update(canonicalJson(measurement)).digest('hex');
    return { verdict: threshold.rating === 'unknown' ? 'unknown' : threshold.rating === 'healthy' ? 'pass' : 'fail',
      ...(threshold.severityLevels === null ? {} : { value: threshold.severityLevels }),
      detail: JSON.stringify({ threshold, ...measurement }), evidenceRefs: [FLEET_COMMS_QUERY_REF,
        `${FLEET_COMMS_QUERY_REF}#result-sha256:${hash}`] };
  } };
}
