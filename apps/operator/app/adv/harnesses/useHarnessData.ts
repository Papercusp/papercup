'use client';

// Shared data hooks for the /adv Harness tab panels (Features, Issues,
// Detail). Phase 3 of adv-harness-tab-migration-2026-05-30.
//
// Durable harness rows have one owner: the root @papercusp/sync cache. Older
// versions kept one-shot REST bootstraps beside the live queries and ignored
// empty sync results. That made deletion/last-row transitions impossible to
// represent and let a late REST response resurrect stale rows. Empty arrays
// are authoritative here; mutations may patch local state optimistically, then
// the pushed named-query result reconciles it.

import { useCallback, useEffect, useState } from 'react';
import { useSyncQuery } from '@papercusp/sync';
import { useWorkspaceId } from '@/lib/use-workspace-id';
import type { Issue, IssueSeverity, IssueSource, IssueStatus } from '@papercusp/operator-core/lib/harness/issue-types';

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
  /**
   * github_user_ids actively working this feature (v5 §0.5 working_users;
   * `current_worker = workingUsers[0]` per D-016). Maintained by the
   * feature_working_set Hyperbee→PG projection (Phase 8 P-038) and carried
   * here via the consolidated SSE overlay. Empty/undefined = nobody working.
   */
  workingUsers?: number[];
}

// Consolidated sync row (camelCase). claims is a JSON-stringified
// string[]; needs-review may surface under either casing depending on the
// generated row — read both defensively.
type SyncFeatureRow = {
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
  // BIGINT[] working_users; postgres-js / the SSE serializer may hand it back
  // as number[], string[], or a "{1,2}" array literal — normalize defensively.
  workingUsers?: Array<number | string> | string | null;
  working_users?: Array<number | string> | string | null;
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

// working_users is a BIGINT[] — depending on the transport it arrives as
// number[], string[], a JSON array string, or a Postgres array literal
// ("{1,2}"). Normalize to a number[] of positive ids; empty → undefined.
export function parseWorkingUsers(raw: unknown): number[] | undefined {
  if (raw == null) return undefined;
  let arr: unknown[];
  if (Array.isArray(raw)) {
    arr = raw;
  } else if (typeof raw === 'string') {
    const s = raw.trim();
    if (!s || s === '{}' || s === '[]') return undefined;
    if (s.startsWith('{') && s.endsWith('}')) {
      // Postgres array literal: {1,2,3}
      arr = s.slice(1, -1).split(',');
    } else {
      try {
        const v = JSON.parse(s);
        arr = Array.isArray(v) ? v : [];
      } catch {
        return undefined;
      }
    }
  } else {
    return undefined;
  }
  const ids = arr
    .map((v) => (typeof v === 'number' ? v : Number.parseInt(String(v).trim(), 10)))
    .filter((n) => Number.isInteger(n) && n > 0);
  return ids.length > 0 ? ids : undefined;
}

export function useHarnessFeatures(slug: string): {
  features: HarnessFeature[] | null;
  loading: boolean;
  error: string | null;
  patchFeature: (id: string, partial: Partial<HarnessFeature>) => void;
} {
  const workspaceId = useWorkspaceId(); // EI-1763: tenant-scope sync reads
  const [features, setFeatures] = useState<HarnessFeature[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { data: syncRows, loading, error: syncError } = useSyncQuery<SyncFeatureRow>({
    queryName: 'featuresConsolidated.bySlug',
    args: slug ? { harnessSlug: slug, workspaceId } : undefined,
    enabled: !!slug,
  });
  useEffect(() => {
    if (!slug) {
      setFeatures(null);
      setError(null);
      return;
    }
    if (loading || !Array.isArray(syncRows)) return;
    setFeatures(
      syncRows.map(
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
          workingUsers: parseWorkingUsers(zf.workingUsers ?? zf.working_users),
        }),
      ),
    );
  }, [slug, syncRows, loading]);
  useEffect(() => {
    setError(syncError ? (syncError instanceof Error ? syncError.message : String(syncError)) : null);
  }, [syncError]);

  // Optimistic local patch — merge a partial into one feature in the local
  // state for instant feedback on a mutation. The sync result reconciles to
  // the authoritative value when it next pushes (or the patch stands if the
  // harness isn't consolidated). No-op if the id isn't present.
  const patchFeature = useCallback((id: string, partial: Partial<HarnessFeature>) => {
    setFeatures((prev) => (prev ? prev.map((f) => (f.id === id ? { ...f, ...partial } : f)) : prev));
  }, []);

  return { features, loading: features === null && !error, error, patchFeature };
}

// ───────── Issues ─────────

type SyncIssueRow = {
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

function syncRowToIssue(r: SyncIssueRow): Issue {
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

export function useHarnessIssues(slug: string): {
  issues: Issue[] | null;
  pendingCount: number;
  loading: boolean;
  error: string | null;
  patchIssue: (id: string, partial: Partial<Issue>) => void;
} {
  const workspaceId = useWorkspaceId(); // EI-1763: tenant-scope sync reads
  const [issues, setIssues] = useState<Issue[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { data: syncRows, loading, error: syncError } = useSyncQuery<SyncIssueRow>({
    queryName: 'issuesConsolidated.bySlug',
    args: slug ? { harnessSlug: slug, workspaceId } : undefined,
    enabled: !!slug,
  });
  useEffect(() => {
    if (!slug) {
      setIssues(null);
      setError(null);
      return;
    }
    if (loading || !Array.isArray(syncRows)) return;
    setIssues(syncRows.map(syncRowToIssue));
  }, [slug, syncRows, loading]);
  useEffect(() => {
    setError(syncError ? (syncError instanceof Error ? syncError.message : String(syncError)) : null);
  }, [syncError]);

  // Pending validator findings share the same sync cache.
  const { data: pendingRows } = useSyncQuery<{ issueId: string }>({
    queryName: 'harnessPendingIssues.byHarness',
    args: slug ? { harnessSlug: slug, phase: 'staging', workspaceId } : undefined,
    enabled: !!slug,
  });
  const pendingCount = Array.isArray(pendingRows) ? pendingRows.length : 0;

  // Optimistic local patch (see patchFeature). Reconciled by the sync result.
  const patchIssue = useCallback((id: string, partial: Partial<Issue>) => {
    setIssues((prev) => (prev ? prev.map((i) => (i.id === id ? { ...i, ...partial } : i)) : prev));
  }, []);

  return { issues, pendingCount, loading: issues === null && !error, error, patchIssue };
}

// ───────── Agents (recent agent runs) ─────────

export interface HarnessAgentRun {
  runId: string;
  role: string;
  ts?: number;
  sizeBytes: number;
  running: boolean;
  lastEventTs?: number;
  costUsd?: number;
  featureId?: string | null;
}

// Consolidated agent-run row returned by the named resolver (camelCase).
type SyncAgentRow = {
  runId: string;
  role: string;
  ts?: number | string | null;
  sizeBytes?: number | string | null;
  running?: boolean;
  lastEventTs?: number | string | null;
  costUsd?: number | string | null;
  featureId?: string | null;
};

function toMs(v: number | string | null | undefined): number | undefined {
  if (v == null) return undefined;
  if (typeof v === 'number') return v;
  const ms = Date.parse(String(v));
  return Number.isFinite(ms) ? ms : undefined;
}

/**
 * Recent agent runs for a harness. The shared sync query is authoritative,
 * including an empty result. `refresh()` invalidates that same cache entry.
 */
export function useHarnessAgents(slug: string): {
  agents: HarnessAgentRun[] | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
} {
  const [agents, setAgents] = useState<HarnessAgentRun[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const query = useSyncQuery<SyncAgentRow>({
    queryName: 'agentRunsConsolidated.bySlug',
    args: slug ? { harnessSlug: slug } : undefined,
    enabled: !!slug,
  });
  const { data: syncRows, loading, error: syncError, invalidate } = query;
  const refresh = useCallback(() => invalidate(), [invalidate]);
  useEffect(() => {
    if (!slug) {
      setAgents(null);
      setError(null);
      return;
    }
    if (loading || !Array.isArray(syncRows)) return;
    setAgents(
      syncRows.map(
        (r): HarnessAgentRun => ({
          runId: r.runId,
          role: r.role,
          ts: toMs(r.ts),
          sizeBytes: Number(r.sizeBytes) || 0,
          running: !!r.running,
          lastEventTs: toMs(r.lastEventTs),
          costUsd: r.costUsd != null ? Number(r.costUsd) : undefined,
          featureId: r.featureId ?? undefined,
        }),
      ),
    );
  }, [slug, syncRows, loading]);
  useEffect(() => {
    setError(syncError ? (syncError instanceof Error ? syncError.message : String(syncError)) : null);
  }, [syncError]);

  return { agents, loading: agents === null && !error, error, refresh };
}

// ───────── Logs (run.log.jsonl history) ─────────

// One parsed line from run.log.jsonl. The harness writer's schema is
// loose; `ts` is reliable, the rest is best-effort. Read the message
// under whichever key the writer used.
export interface HarnessLogEvent {
  ts: string;
  source?: string;
  level?: string;
  msg?: string;
  message?: string;
  [k: string]: unknown;
}

/**
 * Recent structured log events from `run.log.jsonl` (+ rotated peers),
 * via `/log/history`. Append-only file source with no database mirror, so
 * this is a one-shot REST read + manual `refresh()` (no auto-poll — the
 * legacy panel's 3s interval is dropped per the /adv no-polling ethos).
 */
export function useHarnessLogs(
  slug: string,
  limit = 300,
): {
  events: HarnessLogEvent[] | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
} {
  const [events, setEvents] = useState<HarnessLogEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    if (!slug) {
      setEvents(null);
      return;
    }
    let cancel = false;
    setError(null);
    fetch(`/api/harness/${encodeURIComponent(slug)}/log/history?limit=${limit}&phase=staging`)
      .then((r) => (r.ok ? (r.json() as Promise<{ events?: HarnessLogEvent[] }>) : Promise.reject(new Error(`log/history ${r.status}`))))
      .then((j) => {
        if (cancel) return;
        setEvents(Array.isArray(j.events) ? j.events : []);
      })
      .catch((e: Error) => {
        if (!cancel) setError(e.message);
      });
    return () => {
      cancel = true;
    };
  }, [slug, limit, tick]);

  return { events, loading: events === null && !error, error, refresh };
}
