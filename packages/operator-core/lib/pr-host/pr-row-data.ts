/**
 * PrRowData — the per-PR row data contract for the harness PRs tab.
 *
 * Pure type, NO UI. Produced by the backend PRs route
 * (lib/endpoint-route/routes/harness/prs.ts) and consumed by the UI
 * (app/harness/PrRow.tsx / PrsTab.tsx). Relocated out of the `'use client'`
 * PrRow component into core to cut the backend→UI back-edge during the
 * operator-core carve (plan operator-core-headless-serve-2026-06-04, Stage A).
 */
export interface PrRowData {
  remote: string;
  number: number;
  title: string;
  author_login: string;
  author_github_id: number;
  html_url: string;
  state: 'open' | 'merged' | 'closed' | 'gone';
  review_decision: 'none' | 'approved' | 'changes_requested' | 'commented' | 'dismissed';
  /** null = no CI configured; 'success' | 'failure' | 'pending' | etc. */
  check_conclusion: string | null;
  /** Whether this author is in the viewer's trust list. */
  trusted: boolean;
  /** Whether pr_reviewer_role_enabled for this harness. */
  reviewerRoleEnabled: boolean;
  /**
   * The member harness this row came from, set ONLY by the hive-scoped
   * listing (`GET /harness/:slug/prs?scope=hive` — hive-pr-rollup P-005).
   * Review actions for the row must target this slug's routes. Absent on
   * single-harness listings.
   */
  member_slug?: string;
}
