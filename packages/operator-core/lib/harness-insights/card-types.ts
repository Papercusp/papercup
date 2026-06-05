/**
 * Insights-tab card data contracts.
 *
 * Pure types, NO React/UI. These are the data shapes the per-card loaders
 * (this directory) PRODUCE and the §9.0 Insights UI components
 * (app/harness/insights/*) CONSUME. They previously lived inline in the
 * `'use client'` component files, which forced the backend loaders to
 * import from `app/**` (a backend→UI back-edge). Relocated here in core so
 * the dependency points the right way (UI → core) during the operator-core
 * carve (plan operator-core-headless-serve-2026-06-04, Stage A).
 *
 * NOTE: these are the component contracts, distinct from the dogfood
 * data-spine shapes in `../harness/insights-card-types.ts` (which evolved
 * separately). Don't conflate the two.
 */
import type { ClaimStatus } from '../harness/claim-status-types';

// ─── Card 1: Project ─────────────────────────────────────────────

export interface ProjectCardLanguage {
  name: string;
  /** Hex color matching the language. */
  color: string;
  /** Percentage 0-100. Used to size visual weight; not rendered here. */
  percent: number;
}

export interface ProjectCardProps {
  /** Harness slug or display name. */
  name: string;
  /** One-line description, usually from harness config. */
  description: string;
  /** Owner's GitHub login (or display name). */
  ownerDisplayName: string;
  /** Used to render ClaimStatusBadge in the title row. */
  claimStatus: ClaimStatus;
  /** Optional — for status='claimed', the lead claimant login. */
  claimantLogin?: string | null;
  /** Repo license short name (e.g. 'MIT', 'Apache-2.0'). */
  license?: string | null;
  /** Top 3 languages, ordered by percent desc. */
  languages?: ProjectCardLanguage[];
  /** GitHub repo URL. */
  githubUrl: string;
  /** Optional — Discord server URL if §11 is set. */
  discordUrl?: string | null;
  /** GitHub stars (tier-A — verifiable via the GitHub API). */
  stars?: number | null;
  /** GitHub fork count. */
  forks?: number | null;
  /** Open issues on GitHub. */
  openIssues?: number | null;
  /** ISO timestamp of the repo's last push (GitHub `pushed_at`). */
  lastActivityIso?: string | null;
  /** Repo topics (GitHub `topics`), rendered as pills. */
  topics?: string[];
  /** Latest GitHub release (tag + publish date), if any. */
  latestRelease?: {
    tag: string;
    publishedAtIso?: string | null;
    url?: string | null;
  } | null;
}

// ─── Card 2: Activity feed ───────────────────────────────────────

export type ActivityKind =
  | 'feature_shipped'
  | 'pr_merged'
  | 'contributor_joined'
  | 'decision_added'
  | 'escalation_opened';

export interface ActivityFeedEvent {
  id: string;
  kind: ActivityKind;
  /** Short prose, e.g. `'shipped F-DOGFOOD-001'`. */
  text: string;
  /** GitHub login of the actor. */
  actorLogin: string;
  /** Display string, e.g. `'3m ago'`. */
  whenLabel: string;
  /** Click target. Optional — if absent, row is non-clickable. */
  href?: string | null;
  /**
   * Source timestamp (epoch ms). Used by the loader to sort + interleave
   * events across sources (PG + GitHub) recency-correctly, and to dedupe.
   * Not rendered (the card shows `whenLabel`). Optional so older callers
   * that only set `whenLabel` keep working.
   */
  tsEpoch?: number;
  /**
   * Stable dedupe key for cross-source merges. Two events with the same
   * key are the same real-world event surfaced by different sources (e.g.
   * a merged PR seen both via the local `auto_review_audit` ledger and the
   * GitHub API) — the merge keeps one. Optional; events without a key are
   * never deduped against each other.
   */
  dedupKey?: string | null;
}

export interface ActivityFeedCardProps {
  events: ActivityFeedEvent[];
  /** Truncate to N. Default 20. */
  maxRows?: number;
}

// ─── Card 3: People ──────────────────────────────────────────────

export interface PeopleCardPerson {
  github_user_id: number;
  login: string;
  display_name?: string | null;
  avatar_url?: string | null;
  /** Verified binding status — drives the corner badge. */
  binding_status: 'verified' | 'pending' | 'unverified';
  /** Tier-A GitHub commit count (verifiable via the GitHub API). */
  commitCount?: number | null;
}

export interface PeopleCardProps {
  /** All visible contributors. */
  people: PeopleCardPerson[];
  /** Truncate to N avatars; rest become "+N more". Default 12. */
  maxAvatars?: number;
  /** Profile URL builder. Default = `/users/github/${id}`. */
  buildProfileHref?: (person: PeopleCardPerson) => string;
}

// ─── Card 4: Your place ──────────────────────────────────────────

export interface YourPlaceQueueStats {
  queued: number;
  working: number;
  shipped_this_week: number;
}

export interface YourPlaceRoleState {
  pr_reviewer_enabled: boolean;
  is_provisional_owner: boolean;
  is_claimant: boolean;
}

export interface YourPlaceTrustState {
  trusted_authors_count: number;
  trusted_by_count: number;
}

export interface YourPlaceSpendState {
  /** USD this week. */
  spent_usd_this_week: number;
  /** Optional weekly cap; renders as `$x/$y`. */
  cap_usd?: number | null;
}

export interface YourPlaceCardProps {
  queue: YourPlaceQueueStats;
  role: YourPlaceRoleState;
  trust: YourPlaceTrustState;
  spend: YourPlaceSpendState;
}

// ─── Card 5: How it works here ───────────────────────────────────

export type BranchPolicy =
  | 'feature-branch'
  | 'main-fast-forward'
  | 'release-branch';

export interface HowItWorksHereConfig {
  has_orchestrator: boolean;
  pr_reviewer_role_enabled: boolean;
  auto_review: boolean;
  auto_merge: boolean;
  merge_method: 'squash' | 'merge' | 'rebase';
  branch_policy: BranchPolicy;
}

export interface HowItWorksHereCardProps {
  harnessName: string;
  config: HowItWorksHereConfig;
  /** Optional override of the templated intro paragraph. */
  customWelcome?: string | null;
  /**
   * The repo's README markdown (tier-A — fetched from GitHub), rendered
   * read-only below the workflow steps for new-joiner orientation (P-004).
   * Omitted/null → the README section doesn't render.
   */
  readme?: string | null;
}

// ─── Card 6: Spend ───────────────────────────────────────────────

export interface SpendCardProps {
  /** Total spend this week across all contributors on the harness, USD. */
  harnessTotalUsdThisWeek: number;
  /** Viewer's own spend this week, USD. */
  viewerUsdThisWeek: number;
  /** Optional href explaining the proxy-witness deferral plan. */
  proxyWitnessExplainerHref?: string | null;
}

// ─── Aggregate: the full Insights tab contract ───────────────────

export interface InsightsTabProps {
  project: ProjectCardProps;
  activity: ActivityFeedCardProps;
  people: PeopleCardProps;
  yourPlace: YourPlaceCardProps;
  howItWorks: HowItWorksHereCardProps;
  spend: SpendCardProps;
}
