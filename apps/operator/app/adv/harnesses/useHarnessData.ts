'use client';

// Shared data hooks for the /adv Harness tab panels (Features, Issues,
// Detail). Phase 3 of adv-harness-tab-migration-2026-05-30.
//
// Pattern (mirrors HarnessDashboard's feature subscription): a one-shot
// REST bootstrap + a live Zero overlay.
//   - REST (`/api/harness/<slug>/status`, `/issues-list`) reads the base
//     `harness_features` / issues tables and guarantees initial data even
//     when the consolidated tables (the Zero source) lag.
//   - Zero (`useSyncQuery`) pushes live updates over SSE/IPC and is applied
//     only when it returns a NON-EMPTY array, so an initial empty Zero
//     result never clobbers the REST baseline.
// There is no polling timer — the periodic 5–6s `setInterval` the panels
// shipped with is gone; live freshness comes from Zero.

import { useEffect, useState } from 'react';
import { useSyncQuery } from '@restart/sync';
import type { Issue, IssueSeverity, IssueSource, IssueStatus } from '../../harness/issues/types';

export type FeatureStatus =
  | 'todo'
  | 'in_progress'
  | 'validating'
  | 'passed'
  | 'failing'
  | 'deprecated'
  | 'blocked';

export interface HarnessFeature {
  id: string;
  title: string;
  status: FeatureStatus;
  attempts?: number;
  summary?: string;
  needsReview?: boolean;
  claims?: string[];
  sourcePlanSlug?: string;
  tags?: string[];
}

type RestFeature = {
  id: string;
  title: string;
  status: string;
  attempts?: number;
  summary?: string;
  needs_human_review?: boolean;
  tags?: string[];
};

// Consolidated row exported to Zero (camelCase). claims is a JSON-stringified
// string[]; needs-review may surface under either casing depending on the
// generated row — read both defensively.
type ZeroFeatureRow = {
  featureId: string;
  title: string;
  summary?: string | null;
  status: string;
  attempts?: number | string;
  claims?: string | null;
  sourcePlanSlug?: string | null;
  needsHumanReview?: boolean;
  needs_human_review?: boolean;
  tags?: string[] | string | null;
};

function parseClaims(raw: unknown): string[] | undefined {
  if (!raw) return undefined;
  if (Array.isArray(raw)) return raw.map((s) => String(s));
  if (typeof raw === 'string') {
    try {
      const v = JSON.parse(raw);
      if (Array.isArray(v)) return v.map((s) => String(s));
    } catch {
      /* not JSON — ignore */
    }
  }
  return undefined;
}

export function useHarnessFeatures(slug: string): {
  features: HarnessFeature[] | null;
  loading: boolean;
  error: string | null;
} {
  const [features, setFeatures] = useState<HarnessFeature[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // One-shot REST bootstrap (no interval). Clears on slug change.
  useEffect(() => {
    if (!slug) {
      setFeatures(null);
      return;
    }
    let cancel = false;
    setFeatures(null);
    setError(null);
    fetch(`/api/harness/${encodeURIComponent(slug)}/status?phase=staging`)
      .then((r) => (r.ok ? (r.json() as Promise<{ features?: RestFeature[] }>) : Promise.reject(new Error(`status ${r.status}`))))
      .then((j) => {
        if (cancel) return;
        const mapped = (j.features ?? []).map(
          (f): HarnessFeature => ({
            id: f.id,
            title: f.title,
            status: f.status as FeatureStatus,
            attempts: f.attempts,
            summary: f.summary,
            needsReview: f.needs_human_review,
            tags: Array.isArray(f.tags) ? f.tags : undefined,
          }),
        );
        // Don't clobber a Zero overlay that already landed for this slug.
        setFeatures((prev) => (prev && prev.length ? prev : mapped));
      })
      .catch((e: Error) => {
        if (!cancel) setError(e.message);
      });
    return () => {
      cancel = true;
    };
  }, [slug]);

  // Live Zero overlay.
  const { data: zeroRows, loading } = useSyncQuery<ZeroFeatureRow>({
    queryName: 'featuresConsolidated.bySlug',
    args: slug ? { harnessSlug: slug } : undefined,
    enabled: !!slug,
  });
  useEffect(() => {
    if (loading || !Array.isArray(zeroRows) || zeroRows.length === 0) return;
    setFeatures(
      zeroRows.map(
        (zf): HarnessFeature => ({
          id: zf.featureId,
          title: zf.title,
          summary: zf.summary ?? undefined,
          status: zf.status as FeatureStatus,
          attempts: Number(zf.attempts) || 0,
          claims: parseClaims(zf.claims),
          sourcePlanSlug: zf.sourcePlanSlug ?? undefined,
          needsReview: zf.needsHumanReview ?? zf.needs_human_review ?? undefined,
          tags: parseClaims(zf.tags),
        }),
      ),
    );
  }, [zeroRows, loading]);

  return { features, loading: features === null && !error, error };
}

// ───────── Issues ─────────

type ZeroIssueRow = {
  issueId: string;
  title: string;
  severity: string;
  source: string;
  status: string;
  foundAt: number | string;
  foundDuring?: string | null;
  repro?: string | null;
  evidence?: string | null;
  suggestedFix?: string | null;
  codePointer?: string | null;
  linkedFeatureId?: string | null;
  attempts?: number | string;
  notes?: unknown;
};

function zeroRowToIssue(r: ZeroIssueRow): Issue {
  const foundAtMs = typeof r.foundAt === 'number' ? r.foundAt : Date.parse(String(r.foundAt));
  return {
    id: r.issueId,
    title: r.title,
    severity: r.severity as IssueSeverity,
    source: r.source as IssueSource,
    status: r.status as IssueStatus,
    foundAt: Number.isFinite(foundAtMs) ? new Date(foundAtMs).toISOString() : '',
    foundDuring: r.foundDuring ?? undefined,
    repro: r.repro ?? undefined,
    evidence: r.evidence ?? undefined,
    suggestedFix: r.suggestedFix ?? undefined,
    codePointer: r.codePointer ?? undefined,
    linkedFeatureId: r.linkedFeatureId ?? undefined,
    attempts: Number(r.attempts) || 0,
    notes: Array.isArray(r.notes) ? (r.notes as Issue['notes']) : [],
  };
}

type RestIssuesResponse = {
  issues?: Issue[];
  pending?: Array<{ title: string }>;
};

export function useHarnessIssues(slug: string): {
  issues: Issue[] | null;
  pendingCount: number;
  loading: boolean;
  error: string | null;
} {
  const [issues, setIssues] = useState<Issue[] | null>(null);
  const [restPending, setRestPending] = useState(0);
  const [error, setError] = useState<string | null>(null);

  // One-shot REST bootstrap.
  useEffect(() => {
    if (!slug) {
      setIssues(null);
      setRestPending(0);
      return;
    }
    let cancel = false;
    setIssues(null);
    setError(null);
    fetch(`/api/harness/${encodeURIComponent(slug)}/issues-list?phase=staging`)
      .then((r) => (r.ok ? (r.json() as Promise<RestIssuesResponse>) : Promise.reject(new Error(`issues-list ${r.status}`))))
      .then((j) => {
        if (cancel) return;
        setIssues((prev) => (prev && prev.length ? prev : j.issues ?? []));
        setRestPending(j.pending?.length ?? 0);
      })
      .catch((e: Error) => {
        if (!cancel) setError(e.message);
      });
    return () => {
      cancel = true;
    };
  }, [slug]);

  // Live Zero overlay for issues.
  const { data: zeroRows, loading } = useSyncQuery<ZeroIssueRow>({
    queryName: 'issuesConsolidated.bySlug',
    args: slug ? { harnessSlug: slug } : undefined,
    enabled: !!slug,
  });
  useEffect(() => {
    if (loading || !Array.isArray(zeroRows) || zeroRows.length === 0) return;
    setIssues(zeroRows.map(zeroRowToIssue));
  }, [zeroRows, loading]);

  // Pending validator findings stream from harness_pending_issues (Zero).
  const { data: pendingRows } = useSyncQuery<{ issueId: string }>({
    queryName: 'harnessPendingIssues.byHarness',
    args: slug ? { harnessSlug: slug, phase: 'staging' } : undefined,
    enabled: !!slug,
  });
  const pendingCount = Array.isArray(pendingRows) ? pendingRows.length : restPending;

  return { issues, pendingCount, loading: issues === null && !error, error };
}
