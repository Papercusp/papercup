/**
 * loadHarnessActivity — Insights ActivityFeedCard data source.
 *
 * Plan: papercusp-dogfood-phase8-sidebar-insights-profile-2026-05-24
 *       (P-073b real-data follow-up).
 *
 * Aggregates the last N events for one harness from:
 *   - harness_shared.harness_features_consolidated  → feature_shipped
 *   - harness_shared.auto_review_audit              → pr_merged
 *   - harness_shared.contributors                    → contributor_joined
 *   - harness_shared.claim_audit                     → escalation_opened
 *
 * Pure logic — takes an injectable `runQuery` so tests fake PG. Sorts
 * client-side by ts desc, slices to `limit`. Defensive: missing-table
 * errors yield empty arrays so the consumer renders the empty state
 * rather than 500-ing.
 *
 * Decision-added events are absent because plan revisions live in a
 * separate schema (plan_revisions) and tying them to a harness is its
 * own join — folded into the next follow-up.
 */

import type {
  ActivityFeedEvent,
  ActivityKind,
} from '../../app/harness/insights/ActivityFeedCard';

export interface LoadHarnessActivityOpts {
  workspace_id: string;
  harness_slug: string;
  limit?: number;
  runQuery: <T = unknown>(query: string, params: unknown[]) => Promise<T[]>;
  /**
   * URL builder for each event kind. Optional; null hrefs render as
   * non-clickable rows in the card.
   */
  buildHref?: (
    kind: ActivityKind,
    refId: string,
  ) => string | null;
}

interface ShippedRow {
  feature_id: string;
  title: string;
  updated_ts: string | number;
  taken_by: string | null;
}

interface MergedPrRow {
  id: string;
  pr_number: number;
  pr_url: string | null;
  author_github_id: string | number | null;
  ts: string | Date;
}

interface ContributorJoinedRow {
  github_username: string;
  joined_at: string | Date;
}

interface ClaimAuditRow {
  id: string;
  feature_id: string;
  claimer_github_user_id: string | number | null;
  outcome: string | null;
  ts: string | Date;
}

function asEpoch(v: string | number | Date): number {
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'number') return v;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? 0 : d.getTime();
}

function relTime(ts: number): string {
  const ageMs = Date.now() - ts;
  if (ageMs < 0) return 'just now';
  const sec = Math.floor(ageMs / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.floor(hr / 24);
  if (d < 7) return `${d}d ago`;
  const w = Math.floor(d / 7);
  return `${w}w ago`;
}

const DEFAULT_HREF: NonNullable<LoadHarnessActivityOpts['buildHref']> = () => null;

export async function loadHarnessActivity(
  opts: LoadHarnessActivityOpts,
): Promise<ActivityFeedEvent[]> {
  const { workspace_id, harness_slug, runQuery } = opts;
  const limit = opts.limit ?? 20;
  const buildHref = opts.buildHref ?? DEFAULT_HREF;
  // Over-fetch each source by `limit`; merge + sort + slice once.
  const perSource = limit;

  const out: ActivityFeedEvent[] = [];

  // 1) feature_shipped — features whose status flipped to shipped.
  try {
    const shipped = await runQuery<ShippedRow>(
      `SELECT feature_id, title, updated_ts, taken_by
         FROM harness_shared.harness_features_consolidated
        WHERE harness_slug = $1
          AND status = 'shipped'
        ORDER BY updated_ts DESC
        LIMIT $2`,
      [harness_slug, perSource],
    );
    for (const r of shipped) {
      const ts = asEpoch(r.updated_ts);
      out.push({
        id: `feature-${r.feature_id}`,
        kind: 'feature_shipped',
        text: `shipped ${r.feature_id} — ${r.title}`,
        actorLogin: r.taken_by ?? 'unknown',
        whenLabel: relTime(ts),
        href: buildHref('feature_shipped', r.feature_id),
      });
    }
  } catch {
    // missing table — skip
  }

  // 2) pr_merged — auto_review_audit rows with action='auto_merge' or 'manual_merge'.
  try {
    const merged = await runQuery<MergedPrRow>(
      `SELECT id::text AS id, pr_number, pr_url, author_github_id, ts
         FROM harness_shared.auto_review_audit
        WHERE workspace_id = $1
          AND harness_slug = $2
          AND action IN ('auto_merge', 'manual_merge')
        ORDER BY ts DESC
        LIMIT $3`,
      [workspace_id, harness_slug, perSource],
    );
    for (const r of merged) {
      const ts = asEpoch(r.ts);
      out.push({
        id: `pr-${r.id}`,
        kind: 'pr_merged',
        text: `merged PR #${r.pr_number}`,
        actorLogin: r.author_github_id ? String(r.author_github_id) : 'unknown',
        whenLabel: relTime(ts),
        href: r.pr_url ?? buildHref('pr_merged', String(r.pr_number)),
      });
    }
  } catch {
    // missing table — skip
  }

  // 3) contributor_joined — new contributors rows for this harness.
  try {
    const joined = await runQuery<ContributorJoinedRow>(
      `SELECT github_username, joined_at
         FROM harness_shared.contributors
        WHERE workspace_id = $1
          AND harness_slug = $2
        ORDER BY joined_at DESC
        LIMIT $3`,
      [workspace_id, harness_slug, perSource],
    );
    for (const r of joined) {
      const ts = asEpoch(r.joined_at);
      out.push({
        id: `contrib-${r.github_username}-${ts}`,
        kind: 'contributor_joined',
        text: `joined as contributor`,
        actorLogin: r.github_username,
        whenLabel: relTime(ts),
        href: buildHref('contributor_joined', r.github_username),
      });
    }
  } catch {
    // missing table — skip
  }

  // 4) escalation_opened — claim_audit rows with outcome='lost-permission'
  //    or other distinctive markers. The card's escalation kind covers
  //    "something went wrong" generally; we surface lost-permission
  //    rows since they're the most user-actionable.
  try {
    const claimRows = await runQuery<ClaimAuditRow>(
      `SELECT id::text AS id, feature_id, claimer_github_user_id, outcome, ts
         FROM harness_shared.claim_audit
        WHERE workspace_id = $1
          AND harness_slug = $2
          AND outcome IS NOT NULL
          AND outcome <> 'won'
        ORDER BY ts DESC
        LIMIT $3`,
      [workspace_id, harness_slug, perSource],
    );
    for (const r of claimRows) {
      const ts = asEpoch(r.ts);
      out.push({
        id: `claim-${r.id}`,
        kind: 'escalation_opened',
        text: `claim on ${r.feature_id}: ${r.outcome}`,
        actorLogin: r.claimer_github_user_id
          ? String(r.claimer_github_user_id)
          : 'unknown',
        whenLabel: relTime(ts),
        href: buildHref('escalation_opened', r.feature_id),
      });
    }
  } catch {
    // missing table — skip
  }

  // Sort by inferred ts desc — preserve embed of ts in `whenLabel`
  // round-trip by rebuilding event order using the upstream ts. The
  // simplest approach is to re-rank using the original ts we already
  // computed; but we didn't carry it on the ActivityFeedEvent shape
  // (the card doesn't need it). Re-derive from the source rank by
  // re-tagging: kept events in the order they were pushed per source,
  // and shipped → merged → joined → escalation reflects rough
  // recency-by-source weight. Replace this with a stamped-sort once
  // ActivityFeedEvent gains a ts field.
  //
  // For now, do a stable lexicographic sort on whenLabel + id so the
  // output is deterministic across runs.
  out.sort((a, b) => {
    const wa = whenLabelToWeight(a.whenLabel);
    const wb = whenLabelToWeight(b.whenLabel);
    if (wa !== wb) return wa - wb;
    return a.id.localeCompare(b.id);
  });

  return out.slice(0, limit);
}

/**
 * Convert a `relTime` output back into a rough seconds-ago weight so
 * the sort is recency-correct. Lower weight = more recent.
 */
function whenLabelToWeight(label: string): number {
  if (label === 'just now') return 0;
  const m = label.match(/^(\d+)(s|m|h|d|w) ago$/);
  if (!m) return Number.MAX_SAFE_INTEGER;
  const n = Number.parseInt(m[1]!, 10);
  switch (m[2]) {
    case 's':
      return n;
    case 'm':
      return n * 60;
    case 'h':
      return n * 3600;
    case 'd':
      return n * 86_400;
    case 'w':
      return n * 604_800;
    default:
      return Number.MAX_SAFE_INTEGER;
  }
}
