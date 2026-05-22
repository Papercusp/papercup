'use client';

/**
 * Agents tab — plan-agent-launch P-021.
 *
 * Two stacked sections:
 *   1. **Origin card** — who authored the plan (revision #1). Sourced
 *      from `plan_revisions` via the existing `usePlanRevisions` hook.
 *      Per D-006 the origin is NOT a `plan_runs` row; it's seq 1 of
 *      the revision spine. The card surfaces author + rationale +
 *      timestamp, and a "View conversation" link if the seed-1
 *      revision recorded a session (`session_id !== null` and
 *      `session_kind === 'plan_run'`).
 *   2. **Past runs list** — every agent launched from this plan,
 *      newest-first, via `usePlanRuns`. Each row shows title, status,
 *      who launched it, when, turn count, and (D-018) a stale-version
 *      badge when its `planContentHash` ≠ the plan's current hash.
 *
 * P-021 is the *view* surface. P-022 adds the "Launch agent" button;
 * P-023 the resumable run-detail view. This component renders the
 * launch button row even now (disabled, placeholder copy) so the
 * layout is right when P-022 fills it in.
 */

import { useQueryState, parseAsInteger } from 'nuqs';
import { useMemo } from 'react';
import {
  usePlanRevisions,
  usePlanRuns,
  type PlanRevision,
  type PlanRun,
  type PlanRunStatus,
} from './plans-api';
import { rowSessionTag } from './RevisionConversationModal';

interface Props {
  slug: string;
  /** The plan's current `contentHash` (from `plans:get`) — used to
   *  flag past runs that were seeded against an older revision. */
  currentContentHash: string | undefined;
}

export default function AgentsPanel({ slug, currentContentHash }: Props) {
  const revisions = usePlanRevisions(slug);
  const runs = usePlanRuns(slug);
  // Open conversation drill-down for the origin's recorded session
  // (drives the same nuqs key as the Revisions tab — PlanDetail
  // renders the modal regardless of which tab is showing).
  const [, setOpenConvo] = useQueryState('convo', parseAsInteger);

  const origin = useMemo(() => pickOriginRevision(revisions.data ?? []), [revisions.data]);

  return (
    <div className="pc-agents-panel" aria-label="Agents">
      <OriginCard
        loading={revisions.loading}
        error={revisions.error}
        origin={origin}
        onOpenConvo={(id) => setOpenConvo(id)}
      />
      <RunsHeader runs={runs.data ?? []} loading={runs.loading} />
      {runs.error ? (
        <div className="pc-agents-panel__error">{runs.error}</div>
      ) : null}
      {runs.data && runs.data.length === 0 && !runs.loading ? (
        <div className="pc-agents-panel__empty">
          No agents have been launched from this plan yet.
        </div>
      ) : null}
      {runs.data && runs.data.length > 0 ? (
        <ul className="pc-agents-panel__list">
          {runs.data.map((r) => (
            <RunRow
              key={r.id}
              run={r}
              stale={isStaleAgainst(r, currentContentHash)}
            />
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function OriginCard({
  loading,
  error,
  origin,
  onOpenConvo,
}: {
  loading: boolean;
  error: string | null;
  origin: PlanRevision | null;
  onOpenConvo: (id: number) => void;
}) {
  if (loading && !origin) {
    return <div className="pc-agents-origin">Loading author…</div>;
  }
  if (error) {
    return <div className="pc-agents-origin pc-agents-origin--error">{error}</div>;
  }
  if (!origin) {
    return (
      <div className="pc-agents-origin pc-agents-origin--empty">
        No origin recorded — this plan has no revisions yet (the spine
        hasn't been backfilled).
      </div>
    );
  }
  const tag = rowSessionTag(origin.sessionId, origin.sessionKind);
  const drillable = tag === null;
  return (
    <section className="pc-agents-origin">
      <header className="pc-agents-origin__head">
        <span className="pc-agents-origin__kicker">Origin</span>
        <span className="pc-agents-origin__author">{formatOriginAuthor(origin)}</span>
        <span className="pc-agents-origin__when">{formatOriginWhen(origin.createdAt)}</span>
      </header>
      <p className="pc-agents-origin__rationale">
        {origin.rationale && origin.rationale.trim().length > 0
          ? origin.rationale
          : '(no recorded rationale for the original write)'}
      </p>
      <footer className="pc-agents-origin__foot">
        {drillable ? (
          <button
            type="button"
            className="pc-agents-origin__convo"
            onClick={() => onOpenConvo(origin.id)}
          >
            View authoring conversation
          </button>
        ) : (
          <span className="pc-agents-origin__tag">{tag}</span>
        )}
      </footer>
    </section>
  );
}

function RunsHeader({ runs, loading }: { runs: PlanRun[]; loading: boolean }) {
  return (
    <header className="pc-agents-panel__head">
      <h3 className="pc-agents-panel__title">Past agents</h3>
      <span className="pc-agents-panel__count">
        {loading && runs.length === 0 ? '…' : runs.length}
      </span>
      <button
        type="button"
        className="pc-agents-panel__launch"
        disabled
        title="Launch button lands in P-022"
      >
        Launch agent
      </button>
    </header>
  );
}

function RunRow({ run, stale }: { run: PlanRun; stale: boolean }) {
  return (
    <li
      className="pc-agent-row"
      data-status={run.status}
    >
      <div className="pc-agent-row__head">
        <span className="pc-agent-row__title">
          {run.title ?? `Run #${run.id}`}
        </span>
        <span className={`pc-agent-row__status pc-agent-row__status--${run.status}`}>
          {run.status}
        </span>
        {stale ? (
          <span
            className="pc-agent-row__stale"
            title="Seeded against an older revision of this plan"
          >
            ⚠ stale
          </span>
        ) : null}
      </div>
      <div className="pc-agent-row__meta">
        <span title={run.launchedBy}>{formatRunLaunchedBy(run.launchedBy)}</span>
        <span>·</span>
        <span>{formatOriginWhen(run.launchedAt)}</span>
        <span>·</span>
        <span>{run.turnCount} {run.turnCount === 1 ? 'turn' : 'turns'}</span>
      </div>
      {run.note ? <p className="pc-agent-row__note">{run.note}</p> : null}
    </li>
  );
}

/* ── Pure helpers (exported for tests) ─────────────────────────────── */

/** The origin of a plan is `plan_revisions` seq 1 (D-006). The
 *  `plans:revisions` list is newest-first, so the origin is the LAST
 *  element with `seq === 1` (defensive — older plans without a
 *  backfilled spine may have no seq 1 at all). Pure. */
export function pickOriginRevision(revs: PlanRevision[]): PlanRevision | null {
  if (revs.length === 0) return null;
  // Newest-first → origin is at the end. Walk backwards to find seq 1.
  for (let i = revs.length - 1; i >= 0; i--) {
    if (revs[i]!.seq === 1) return revs[i]!;
  }
  return null;
}

/** True when a run's seeded plan_content_hash differs from the plan's
 *  current hash — drives the ⚠ stale badge (D-018). False if either
 *  side is missing (no spurious warnings on incomplete data). Pure. */
export function isStaleAgainst(run: PlanRun, currentHash: string | undefined): boolean {
  if (!currentHash || !run.planContentHash) return false;
  return run.planContentHash !== currentHash;
}

export function formatOriginAuthor(rev: PlanRevision): string {
  const id = rev.authorId.trim();
  if (rev.authorKind === 'human') {
    const at = id.indexOf('@');
    return at > 0 ? id.slice(0, at) : id.slice(0, 24);
  }
  const parts = id.split('-');
  return parts.length >= 2 ? `${parts[0]}-${parts[1]}` : id.slice(0, 16);
}

/** Pure: format a launched-by id — strip the email domain when present,
 *  otherwise short-prefix. Same heuristic as the row author. */
export function formatRunLaunchedBy(launchedBy: string): string {
  const id = launchedBy.trim();
  const at = id.indexOf('@');
  if (at > 0) return id.slice(0, at);
  return id.length > 24 ? `${id.slice(0, 24)}…` : id;
}

export function formatOriginWhen(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const d = new Date(ms);
  return d.toLocaleString();
}

/** Pure: human label for a `PlanRunStatus` — used by the dot/pill
 *  className and the run-row title attribute. */
export function describeRunStatus(s: PlanRunStatus): string {
  switch (s) {
    case 'running':  return 'a turn is in progress';
    case 'idle':     return 'between turns, resumable';
    case 'done':     return 'manually marked done';
    case 'archived': return 'archived (resume to reactivate)';
    case 'failed':   return 'the run failed or was orphaned';
  }
}
