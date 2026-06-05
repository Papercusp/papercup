/**
 * AdvContributorsPanel — Phase-8 P-048 Contributors tab (live /adv shell).
 *
 * One row per harness contributor: avatar + name + @login (→ user profile,
 * P-048b), binding-status badge (P-048a), joined date, tier-A merged-PRs /
 * tier-B features-shipped / tier-C activity badges (P-071), device count
 * (P-048a devices). Sortable by joined / PRs / features / activity (P-048c)
 * via the pure `compareContributors`. Unverified/pending bindings render
 * greyed with ZEROED stats (P-048d) — `statsAggregateForStatus`.
 *
 * Data: `GET /api/harness/:slug/contributors` (the existing P-048 endpoint).
 * NOTE: that endpoint derives tier-A/B from `harness_feature_prs` /
 * `harness_features.shipped_by_github_id`, while the user-profile loader
 * (P-072b) + `load-contributors-tab.ts` use `auto_review_audit` /
 * `harness_features_consolidated.taken_by`. Reconciling the endpoint to the
 * latter (so the tab + profile agree) is a flagged follow-up; this panel
 * applies the P-048d zeroing client-side regardless.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { parseAsInteger, parseAsStringEnum, useQueryState } from 'nuqs';
import type { PanelComponentProps } from '../../harness/dock/panel-registry';
import { BindingStatusBadge, type BindingStatus } from '../../_components/BindingStatusBadge';
import { statsAggregateForStatus } from '@papercusp/operator-core/lib/identity/binding-verifier-types';
import {
  compareContributors,
  type ContributorSortKey,
  type ContributorTabRow,
} from '@papercusp/operator-core/lib/harness-insights/load-contributors-tab';
import {
  USAGE_EVENT_KINDS,
  type UsageEventKind,
  type UsageRollupForContributor,
} from '@papercusp/operator-core/lib/harness/contributor-usage-event-types';
import { useViewer } from './useViewer';

interface ApiRow {
  github_user_id: number;
  github_username: string;
  display_name: string | null;
  avatar_url: string | null;
  joined_at: number;
  binding_status: BindingStatus;
  device_count: number;
  prs_merged: number;
  features_shipped: number;
  activity_events: number;
}

const SORTS: Array<{ key: ContributorSortKey; label: string }> = [
  { key: 'joined', label: 'Joined' },
  { key: 'prs', label: 'PRs ✓' },
  { key: 'features', label: 'Shipped ✓' },
  { key: 'activity', label: 'Activity' },
];

/** Map an API row → the ContributorTabRow shape, applying P-048d zeroing. */
function toTabRow(r: ApiRow): ContributorTabRow {
  const aggregate = statsAggregateForStatus(r.binding_status);
  return {
    github_user_id: r.github_user_id,
    login: r.github_username,
    display_name: r.display_name,
    avatar_url: r.avatar_url,
    binding_status: r.binding_status,
    joined_at: r.joined_at,
    device_count: r.device_count,
    prs_merged: aggregate ? r.prs_merged : 0,
    features_shipped: aggregate ? r.features_shipped : 0,
    activity_events: aggregate ? r.activity_events : 0,
  };
}

function fmtJoined(ms: number): string {
  if (!ms) return '—';
  try {
    return new Date(ms).toLocaleDateString();
  } catch {
    return '—';
  }
}

/** Short per-kind labels for the expanded P-070 activity breakdown. */
const KIND_LABEL: Record<UsageEventKind, string> = {
  feature_authored: 'authored',
  feature_queued: 'queued',
  feature_worked_start: 'started',
  feature_worked_end: 'worked',
  pr_opened: 'PRs',
  decision_added: 'decisions',
  plan_authored: 'plans',
  agent_run_completed: 'runs',
};

type UsageEntry = UsageRollupForContributor | 'loading' | 'error' | undefined;

/** Render the per-kind breakdown for one contributor's expanded activity row.
 *  Zero-count kinds are omitted so the line stays scannable. */
function renderUsageBreakdown(entry: UsageEntry): ReactNode {
  if (entry === undefined || entry === 'loading') {
    return <span className="pc-adv-contributors__usage-loading">Loading activity…</span>;
  }
  if (entry === 'error') {
    return <span className="pc-adv-contributors__usage-empty">Activity unavailable</span>;
  }
  const nonZero = USAGE_EVENT_KINDS.filter((k) => (entry.counts[k] ?? 0) > 0);
  if (nonZero.length === 0) {
    return <span className="pc-adv-contributors__usage-empty">No recorded activity yet</span>;
  }
  return nonZero.map((k) => (
    <span key={k} className="pc-adv-contributors__usage-kind">
      {KIND_LABEL[k]} {entry.counts[k]}
    </span>
  ));
}

export default function AdvContributorsPanel({ params, api }: PanelComponentProps) {
  const slug = (params.harnessSlug as string) || (params.slug as string) || '';
  const [rows, setRows] = useState<ContributorTabRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sort, setSort] = useQueryState(
    'csort',
    parseAsStringEnum<ContributorSortKey>(SORTS.map((s) => s.key)).withDefault('joined'),
  );
  // P-070: which contributor's per-kind activity breakdown is expanded (URL-backed
  // per the nuqs default), + a small id→rollup cache fetched from /contributor-usage.
  const [expandedId, setExpandedId] = useQueryState('cusage', parseAsInteger);
  const [usageById, setUsageById] = useState<Record<number, UsageEntry>>({});
  const { isMe } = useViewer();

  useEffect(() => {
    if (expandedId == null || !slug) return;
    const id = expandedId;
    let cancelled = false;
    setUsageById((m) => (m[id] ? m : { ...m, [id]: 'loading' }));
    (async () => {
      try {
        const res = await fetch(
          `/api/harness/${encodeURIComponent(slug)}/contributor-usage?github_user_id=${id}`,
          { cache: 'no-store' },
        );
        const body = (await res.json().catch(() => ({}))) as { rollup?: UsageRollupForContributor };
        if (!cancelled) setUsageById((m) => ({ ...m, [id]: body.rollup ?? 'error' }));
      } catch {
        if (!cancelled) setUsageById((m) => ({ ...m, [id]: 'error' }));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [expandedId, slug]);

  useEffect(() => {
    if (!slug) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/harness/${encodeURIComponent(slug)}/contributors`, { cache: 'no-store' });
        if (!res.ok) {
          if (!cancelled) setError(`HTTP ${res.status}`);
          return;
        }
        const body = (await res.json().catch(() => ({}))) as { contributors?: ApiRow[] };
        if (cancelled) return;
        setRows((body.contributors ?? []).map(toTabRow));
        setError(null);
      } catch (e) {
        if (!cancelled) setError(String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [slug]);

  useEffect(() => {
    if (rows) api.setTitle(`Contributors · ${slug} (${rows.length})`);
  }, [rows, slug, api]);

  const sorted = useMemo(
    () => (rows ? [...rows].sort((a, b) => compareContributors(a, b, sort)) : []),
    [rows, sort],
  );

  if (!slug) return <div className="pc-adv-empty">No harness selected.</div>;
  if (error) return <div className="pc-adv-empty">Contributors unavailable: {error}</div>;
  if (rows === null) return <div className="pc-adv-empty">Loading contributors…</div>;
  if (rows.length === 0) return <div className="pc-adv-empty">No contributors yet.</div>;

  return (
    <div className="pc-adv-contributors">
      <div className="pc-adv-contributors__sortbar" role="tablist" aria-label="Sort contributors">
        {SORTS.map((s) => (
          <button
            key={s.key}
            type="button"
            role="tab"
            aria-selected={sort === s.key}
            className={sort === s.key ? 'is-active' : undefined}
            onClick={() => void setSort(s.key)}
          >
            {s.label}
          </button>
        ))}
      </div>
      <ul className="pc-adv-contributors__list">
        {sorted.map((c) => {
          const greyed = !statsAggregateForStatus(c.binding_status);
          return (
            <li
              key={c.github_user_id}
              className="pc-adv-contributors__row"
              style={greyed ? { opacity: 0.55 } : undefined}
            >
              <a
                className="pc-adv-contributors__who"
                href={`/users/github/${c.github_user_id}`}
                title={`View ${c.login}'s profile`}
              >
                {c.avatar_url && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={c.avatar_url} alt="" width={22} height={22} className="pc-adv-contributors__avatar" />
                )}
                <span className="pc-adv-contributors__name">
                  {c.display_name || c.login}
                  <span className="pc-adv-contributors__login">@{c.login}</span>
                  {isMe(c.github_user_id) && <span className="pc-adv-contributors__you"> (you)</span>}
                </span>
              </a>
              <BindingStatusBadge status={c.binding_status} />
              <span className="pc-adv-contributors__tiers" aria-label="activity by trust tier">
                <span title="Tier-A merged PRs">✓{c.prs_merged} PR</span>
                <span title="Tier-B features shipped">✓{c.features_shipped} shipped</span>
                <button
                  type="button"
                  className="pc-adv-contributors__activity"
                  title="Tier-C activity events — click for the per-kind breakdown"
                  aria-expanded={expandedId === c.github_user_id}
                  onClick={() =>
                    void setExpandedId(expandedId === c.github_user_id ? null : c.github_user_id)
                  }
                >
                  {c.activity_events} act
                </button>
              </span>
              <span className="pc-adv-contributors__joined" title="Joined">{fmtJoined(c.joined_at)}</span>
              {c.device_count > 0 && (
                <span className="pc-adv-contributors__devices" title="Bound devices">
                  {c.device_count} {c.device_count === 1 ? 'device' : 'devices'}
                </span>
              )}
              {expandedId === c.github_user_id && (
                <div
                  className="pc-adv-contributors__usage"
                  role="region"
                  aria-label={`${c.login} activity breakdown`}
                >
                  {renderUsageBreakdown(usageById[c.github_user_id])}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
