/**
 * Production wiring for the curation loop (plan curator-operator-2026-06-04).
 *
 * Adapts the LANDED coord readers + work_item (hfc) reads into the injectable
 * `FleetReaders` / `CurationDeps` the pure loop consumes. This is the only file
 * coupled to the concrete sources — the loop, salience policy, gather, and state
 * stay source-agnostic + unit-testable.
 *
 * Source map (all read-only; never edits work-items.ts):
 *   escalations  → coord listEscalations({status:'open'})  (severity split in fleet-signals)
 *   blocked      → coord getAllBlockedPlanItems()           (plan-items blocked by open issues)
 *   decisions    → coord handoffs-to-human + hfc needs_human_review / needs_design
 *   completions  → hfc status='done' (recent), provenance via created_by_github_user_id
 *   progress     → coord plan-events (recent, discrete transitions)
 *
 * NOTE (v1): coord readers operate on the coord workspace; hfc reads on the
 * active workspace. On the single-workspace dev box these coincide. The work_item
 * subscribe→inject path (collapse-delegate-into-workitems, in-flight) will make
 * `progress`/`completions` richer once the operator subscribes to its assigned
 * work_items — the gather interface is already shaped for it.
 */
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../workspace-registry';
import { listEscalations } from '../agent-tools/coordination/escalations';
import { listHandoffs } from '../agent-tools/coordination/handoffs';
import { readPlanEvents } from '../agent-tools/coordination/plan-events';
import { getAllBlockedPlanItems } from '../issue-blocks-merge';
import { loadRecentSurfaced, recordSurfaced } from './curation-log';
import { surfaceCuratedMessage } from './curation-surface';
import type {
  FleetReaders,
  RawEscalation,
  RawBlockedItem,
  RawDecision,
  RawCompletion,
  RawProgress,
} from './fleet-signals';
import type { CurationDeps } from './curation-loop';

/** Completions/decisions are only "fresh" within this window (older ones the
 *  curation-log already remembers surfacing, but this bounds the scan). */
const FRESH_WINDOW_MS = 24 * 60 * 60 * 1000;
const COMPLETION_SIGNAL_STATUSES = ['done', 'passed', 'resolved', 'closed'] as const;

async function readEscalations(): Promise<RawEscalation[]> {
  const open = await listEscalations({ status: 'open' });
  return open.map((e) => ({
    msgId: e.msg_id,
    severity: e.severity,
    summary: e.summary ?? '(escalation)',
    from: e.from,
    planSlug: e.plan_slug,
    ts: e.ts,
  }));
}

async function readBlocked(): Promise<RawBlockedItem[]> {
  const blocked = await getAllBlockedPlanItems();
  const out: RawBlockedItem[] = [];
  for (const [ref, issueIds] of blocked) {
    out.push({
      ref,
      title: ref,
      reason: `blocked by ${issueIds.length} open issue${issueIds.length === 1 ? '' : 's'}: ${issueIds.join(', ')}`,
    });
  }
  return out;
}

async function readDecisions(): Promise<RawDecision[]> {
  const out: RawDecision[] = [];

  // (a) Handoffs addressed to the human — needs human pickup.
  const handoffs = await listHandoffs({ status: 'open' });
  for (const h of handoffs) {
    const rec = h.record;
    if (!Array.isArray(rec.to) || !rec.to.includes('human')) continue;
    out.push({
      id: `handoff:${rec.msg_id}`,
      title: rec.summary ?? 'handoff',
      ref: `coord:handoff:${rec.msg_id}`,
      ts: rec.ts,
    });
  }

  // (b) Features flagged needs_human_review / needs_design (design pending).
  const ws = activeWorkspaceId();
  const { sql } = getOrgPg();
  const rows = await sql<
    { harness_slug: string; feature_id: string; title: string | null; needs_design: boolean; updated_ts: string | null }[]
  >`
    SELECT harness_slug, feature_id, title, needs_design, updated_ts::text
      FROM harness_shared.harness_features_consolidated
     WHERE workspace_id = ${ws}
       AND (needs_human_review = true OR (needs_design = true AND design_status = 'pending'))
       AND COALESCE(status, '') <> 'deprecated'
     ORDER BY updated_ts DESC NULLS LAST
     LIMIT 50
  `;
  for (const r of rows) {
    out.push({
      id: `review:${r.harness_slug}#${r.feature_id}`,
      harness: r.harness_slug,
      title: r.title ?? r.feature_id,
      detail: r.needs_design ? 'design review' : 'review',
      workItemId: r.feature_id,
      ref: `wi:${r.harness_slug}#${r.feature_id}`,
      ts: r.updated_ts ? new Date(Number(r.updated_ts)).toISOString() : new Date().toISOString(),
    });
  }
  return out;
}

async function readCompletions(): Promise<RawCompletion[]> {
  const ws = activeWorkspaceId();
  const cutoff = Date.now() - FRESH_WINDOW_MS;
  const { sql } = getOrgPg();
  const rows = await sql<
    { harness_slug: string; feature_id: string; title: string | null; created_by_github_user_id: string | null; updated_ts: string | null }[]
  >`
    SELECT harness_slug, feature_id, title, created_by_github_user_id::text, updated_ts::text
      FROM harness_shared.work_items
     WHERE workspace_id = ${ws}
       AND status = ANY(${[...COMPLETION_SIGNAL_STATUSES]}::text[])
       AND terminal_owner IS NOT NULL AND terminal_owner <> ''
       AND terminal_completion_ref IS NOT NULL AND terminal_completion_ref <> ''
       AND updated_ts IS NOT NULL
       AND updated_ts > ${cutoff}
     ORDER BY updated_ts DESC
     LIMIT 50
  `;
  return rows.map((r) => ({
    workItemId: `${r.harness_slug}#${r.feature_id}`,
    harness: r.harness_slug,
    title: r.title ?? r.feature_id,
    // Completion-integrity gate (WI-1403/WI-1405): only evidence-backed terminal
    // rows count as "work landed" here. The human-provenance heuristic still rides
    // created_by_github_user_id on the unified row.
    userRequested: r.created_by_github_user_id != null,
    ref: `wi:${r.harness_slug}#${r.feature_id}`,
    ts: r.updated_ts ? new Date(Number(r.updated_ts)).toISOString() : new Date().toISOString(),
  }));
}

async function readProgress(): Promise<RawProgress[]> {
  // Recent discrete plan transitions — the routine batch. Plan-event envelopes
  // carry kind='plan_event'; the specific type is the `event` field, filtered
  // server-side. Most-recent rotation file only; window-filtered + capped so the
  // digest never floods.
  const cutoff = Date.now() - FRESH_WINDOW_MS;
  const events = await readPlanEvents({ events: ['item_status_changed'], filesBack: 1 });
  const out: RawProgress[] = [];
  for (const e of events) {
    const ts = typeof e.ts === 'string' ? e.ts : new Date().toISOString();
    const t = Date.parse(ts);
    if (Number.isFinite(t) && t < cutoff) continue;
    const summary = typeof e.summary === 'string' ? e.summary : 'plan update';
    const planSlug = typeof e.plan_slug === 'string' ? e.plan_slug : undefined;
    out.push({
      id: `plan-event:${e.msg_id}`,
      title: summary,
      ref: planSlug ? `plan:${planSlug}` : undefined,
      ts,
    });
  }
  return out.slice(0, 25);
}

/** The production source bag. */
export function buildFleetReaders(): FleetReaders {
  return {
    escalations: readEscalations,
    blocked: readBlocked,
    decisions: readDecisions,
    completions: readCompletions,
    progress: readProgress,
  };
}

/** The full deps for `runCurationTick` in production. */
export function buildCurationDeps(): CurationDeps {
  return {
    readers: buildFleetReaders(),
    loadSurfaced: (windowMs) => loadRecentSurfaced(windowMs),
    recordSurfaced: (entries, policyVersion) => recordSurfaced(entries, policyVersion),
    surface: (text) => surfaceCuratedMessage(text),
  };
}
