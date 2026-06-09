/**
 * hygiene.ts — the backlog hygiene sweep
 * (learning-system-audit-improvements-2026-06-09 P-014).
 *
 * The capture side outruns the consume side (live: ~150 open, +105 in 3 days),
 * so the open queue accretes near-duplicates and stale minor noise that drown
 * the Learning tab and the triage pass. Two conservative, recallable actions:
 *
 *   - **dup-close** — within a likely-duplicate cluster of OPEN items (the same
 *     normalized-signature/Jaccard matcher dedup uses), keep ONE (highest
 *     severity, then newest) and close the rest with
 *     `decidedReason: 'duplicate of <kept>'`. The kept item carries the friction;
 *     the recall matcher surfaces the closure on any re-capture.
 *   - **age-out** — an OPEN, UNCLAIMED minor/nit item that has sat ≥ `staleDays`
 *     with a NON-recurring signature closes with a durable aged-out reason.
 *     Recurring signatures never age out (active friction), claimed items are
 *     in-flight, and major/critical severities are never auto-aged.
 *
 * Every close records `decidedReason` + advances `ideaLifecycle` through the
 * normal reject route, so hygiene is queue-as-memory, not deletion: a re-capture
 * of the same signature gets "already decided: <reason>" surfaced at capture.
 *
 * `planHygieneSweep` is pure; `runHygieneSweep` is thin PG glue (injectable
 * deps; `dryRun` plans without writing).
 */

import {
  setIssueState,
  commentIssue,
  mergeIssuePayload,
  type EngineerIssue,
} from '../../issues-engineer';
import type { ThreadPostRow } from '@papercusp/coordination/capabilities';
import type { ImprovementCandidate, ImprovementSeverity } from './policy';
import { readImprovementItems } from './read-items';
import { findLikelyDuplicates, signatureRecurrence, dedupSignature } from './digest';
import { initializeIdeaLifecycle, updateIdeaLifecycle } from './lifecycle';

const DAY_MS = 24 * 60 * 60 * 1000;

const SEVERITY_RANK: Record<ImprovementSeverity, number> = { critical: 3, major: 2, minor: 1, nit: 0 };

export interface HygieneAction {
  id: string;
  kind: 'dup-close' | 'age-out';
  reason: string;
  /** For dup-close: the cluster member kept open. */
  keptId?: string;
}

export interface PlanHygieneOpts {
  nowMs?: number;
  /** Age (days) past which an unclaimed minor/nit item with a quiet signature ages out. */
  staleDays?: number;
  maxActions?: number;
}

export const DEFAULT_STALE_DAYS = 30;
export const DEFAULT_MAX_HYGIENE_ACTIONS = 25;

function ageDaysOf(c: ImprovementCandidate, nowMs: number): number {
  const created = c.createdAt ? Date.parse(c.createdAt) : NaN;
  return Number.isFinite(created) ? (nowMs - created) / DAY_MS : 0;
}

/** Pure planner. `all` should span all states (recurrence needs resolved history). */
export function planHygieneSweep(all: ImprovementCandidate[], opts: PlanHygieneOpts = {}): HygieneAction[] {
  const nowMs = opts.nowMs ?? Date.now();
  const staleDays = opts.staleDays ?? DEFAULT_STALE_DAYS;
  const maxActions = opts.maxActions ?? DEFAULT_MAX_HYGIENE_ACTIONS;
  if (maxActions <= 0) return [];

  const open = all.filter((c) => (c.state ?? 'open') === 'open');
  const byId = new Map(open.map((c) => [c.id, c]));
  const actions: HygieneAction[] = [];
  const acted = new Set<string>();

  // 1. dup-close — clusters among OPEN items only (resolved members already left).
  // A destructive close needs MORE than Jaccard cluster membership (watchdog-audit
  // P-004: template titles — "Test failing repeatedly: <path>", "Tool <name>
  // erroring repeatedly" — token-collide across DISTINCT signals; the live dry-run
  // 2026-06-09 caught exactly 4 such false pairs). Mergeable sub-groups are:
  //   - same `watchdogKey` (the key asserts one signal identity), or
  //   - keyless items with EXACTLY equal normalized signatures (near-dup Jaccard
  //     alone is not enough to destroy a keyless item).
  // Keyed never merges with keyless, and different keys never merge.
  for (const cluster of findLikelyDuplicates(open)) {
    if (actions.length >= maxActions) break;
    const clusterMembers = cluster.ids.map((id) => byId.get(id)).filter((c): c is ImprovementCandidate => !!c);
    const groups = new Map<string, ImprovementCandidate[]>();
    for (const m of clusterMembers) {
      const groupKey = m.watchdogKey ? `key:${m.watchdogKey}` : `sig:${dedupSignature(m.title)}`;
      const arr = groups.get(groupKey) ?? [];
      arr.push(m);
      groups.set(groupKey, arr);
    }
    for (const members of groups.values()) {
      if (members.length < 2) continue;
      const keep = [...members].sort((a, b) => {
        const sev = SEVERITY_RANK[b.severity ?? 'minor'] - SEVERITY_RANK[a.severity ?? 'minor'];
        if (sev !== 0) return sev;
        return Date.parse(b.createdAt ?? '0') - Date.parse(a.createdAt ?? '0');
      })[0];
      for (const m of members) {
        if (actions.length >= maxActions) break;
        if (m.id === keep.id || acted.has(m.id)) continue;
        if (m.assignee) continue; // claimed = in-flight, never hygiene-close
        acted.add(m.id);
        actions.push({
          id: m.id,
          kind: 'dup-close',
          keptId: keep.id,
          reason: `duplicate of ${keep.id} (hygiene sweep) — the kept item carries this friction`,
        });
      }
    }
  }

  // 2. age-out — quiet, unclaimed, minor/nit, ≥ staleDays old.
  const recurringSigs = new Set(
    signatureRecurrence(all, { nowMs })
      .filter((s) => s.openCount > 1)
      .map((s) => s.signature),
  );
  for (const c of open) {
    if (actions.length >= maxActions) break;
    if (acted.has(c.id)) continue;
    const sev = c.severity ?? 'minor';
    if (sev !== 'minor' && sev !== 'nit') continue;
    if (c.assignee) continue;
    const age = ageDaysOf(c, nowMs);
    if (age < staleDays) continue;
    if (recurringSigs.has(dedupSignature(c.title))) continue; // active friction never ages out
    acted.add(c.id);
    actions.push({
      id: c.id,
      kind: 'age-out',
      reason: `aged out by the hygiene sweep: ${sev} severity, no recurrence pressure in ${Math.round(age)} days — re-capture if it bites again`,
    });
  }

  return actions;
}

export interface HygieneSweepResult {
  scanned: number;
  planned: HygieneAction[];
  dupClosed: number;
  agedOut: number;
  dryRun: boolean;
}

/** Injectable dependency seam (unit tests run without PG). */
export interface HygieneSweepDeps {
  readItems: () => Promise<ImprovementCandidate[]>;
  setIssueState: (id: string, state: 'open' | 'resolved' | 'closed', by?: string) => Promise<EngineerIssue | null>;
  commentIssue: (id: string, body: string, authorId?: string) => Promise<ThreadPostRow | null>;
  mergeIssuePayload: (id: string, patch: Record<string, unknown>) => Promise<EngineerIssue | null>;
}

const defaultDeps: HygieneSweepDeps = {
  readItems: () => readImprovementItems({}),
  setIssueState,
  commentIssue,
  mergeIssuePayload,
};

export async function runHygieneSweep(
  opts: PlanHygieneOpts & { dryRun?: boolean } = {},
  deps: HygieneSweepDeps = defaultDeps,
): Promise<HygieneSweepResult> {
  const all = await deps.readItems();
  const byId = new Map(all.map((c) => [c.id, c]));
  const planned = planHygieneSweep(all, opts);
  const result: HygieneSweepResult = {
    scanned: all.length,
    planned,
    dupClosed: 0,
    agedOut: 0,
    dryRun: opts.dryRun === true,
  };
  if (opts.dryRun) return result;

  for (const a of planned) {
    const current = byId.get(a.id)?.ideaLifecycle ?? initializeIdeaLifecycle();
    // Hygiene closes ride the normal reject route through the state machine —
    // triaged(reject) + decidedReason + closed — so recall works identically.
    const lifecycle =
      current.state === 'open' || current.state === 'recurred' || current.state === 'triaged'
        ? updateIdeaLifecycle(current, 'triaged', { triageDecision: 'reject', triageReason: a.reason })
        : current;
    await deps.mergeIssuePayload(a.id, { ideaLifecycle: lifecycle, decidedReason: a.reason });
    await deps.commentIssue(a.id, `🧹 ${a.reason}`, 'improvement-hygiene');
    await deps.setIssueState(a.id, 'closed', 'improvement-hygiene');
    if (a.kind === 'dup-close') result.dupClosed += 1;
    else result.agedOut += 1;
  }

  if (planned.length > 0) {
    void import('../../sync-sse')
      .then((m) => m.notifySyncInvalidate('learning.improvements'))
      .catch(() => {});
  }
  return result;
}
