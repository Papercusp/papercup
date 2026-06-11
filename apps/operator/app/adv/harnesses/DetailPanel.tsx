'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { parseAsString, useQueryState } from 'nuqs';
import { toast } from 'sonner';
import { ArrowUpRight } from 'lucide-react';
import { useSyncQuery } from '@papercusp/sync';
import { openFeatureChat } from '@papercusp/papercup-shared';
import type { Issue, IssueNote } from '@papercusp/operator-core/lib/harness/issue-types';
import type { PanelComponentProps } from '../../harness/dock/panel-registry';
import { StatusPill, SeverityPill, IssueStatusPill } from '../../harness/primitives';
import { SEVERITY, type HarnessStatus, type IssueSeverityKey } from '../../harness/theme';
import { Select } from '../../harness/Select';
import { Tooltip } from '../../harness/Tooltip';
import { useConfirmDialog } from '../../harness/useConfirmDialog';
import FeatureEditor from '../../harness/FeatureEditor';
import { useHarnessFeatures, useHarnessIssues, type FeatureStatus, type HarnessFeature } from './useHarnessData';
import { issueAction, issueActionStatus, type IssueActionKind } from './harness-actions';
import type { WorkItemRow } from './WorkItemsPanel';
import { runOutcome } from './run-outcome';

const FEATURE_STATUSES: FeatureStatus[] = [
  'todo',
  'in_progress',
  'validating',
  'passed',
  'failing',
  'blocked',
  'deprecated',
];

// Consolidated agent-run row (camelCase Zero export). Since P-023
// (adv-harness-tab-migration) the resolver joins the spawn outcome +
// native resume session id from spawned_agents — null on legacy rows.
type RunRow = {
  runId: string;
  role: string;
  ts: number | string;
  featureId?: string | null;
  costUsd?: number | string;
  running?: boolean | null;
  spawnStatus?: string | null;
  exitCode?: number | null;
  errorMessage?: string | null;
  sessionId?: string | null;
};

// Selection-history stack, module-scoped so it survives DetailPanel
// re-mounts (a slug change remounts the panel). Only the swap panel
// (no pinned itemId) pushes/pops; pinned panels are read-only viewers.
const selHistory: string[] = [];
let suppressHistoryPush = false;

/**
 * Open a run's recorded agent session in a terminal (P-023): the launch-su
 * resume path spawns `psu --agent=claude --resume-session=<id>` server-side —
 * the same flow the Sessions tab uses, so the resumed session is tracked in
 * adv_sessions like any other launch.
 */
async function openRunSession(slug: string, sessionId: string): Promise<void> {
  try {
    const res = await fetch('/api/adv/sessions/launch-su', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agent: 'claude', harness_slug: slug, resume_session_id: sessionId }),
    });
    const body = (await res.json().catch(() => ({}))) as { status?: string; error?: string };
    if (!res.ok || body.status === 'error') throw new Error(body.error || `${res.status}`);
    toast.success(`Session ${sessionId.slice(0, 12)}… opening in a terminal.`);
  } catch (e) {
    toast.error('Open session failed', { description: String(e) });
  }
}

function fmtAgo(ts: number | string): string {
  const ms = typeof ts === 'number' ? ts : Date.parse(String(ts));
  if (!Number.isFinite(ms)) return '';
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/**
 * Detail panel — renders the currently-selected feature or issue.
 *
 * Two modes:
 *   - Swap (default): reads `?sel=<id>` from the URL and follows selection
 *     changes made in the Features / Issues panels.
 *   - Pinned: if `params.itemId` is set, the panel locks to that id and
 *     ignores `?sel=`. Spawned via the "Pin to new panel" context menu;
 *     stays put while the user keeps clicking around.
 */
export default function DetailPanel({ params, api }: PanelComponentProps) {
  const slug = (params.harnessSlug as string) || '';
  const pinnedId = (params.itemId as string) || null;
  const [urlSel, setUrlSel] = useQueryState('sel', parseAsString.withDefault(''));
  // `?edit=<featureId>` opens the embedded FeatureEditor for that feature in
  // this pane. Navigating to another item clears it (back to the read view).
  const [editId, setEditId] = useQueryState('edit', parseAsString.withDefault(''));
  const selectedId = pinnedId ?? urlSel;

  // Phase 3: live data via Zero (REST bootstrap + Zero overlay), no polling.
  // The Features/Issues panels subscribe to the same queries → Zero dedups.
  const { features, patchFeature } = useHarnessFeatures(slug);
  const { issues, patchIssue } = useHarnessIssues(slug);
  const { data: runRows } = useSyncQuery<RunRow>({
    queryName: 'agentRunsConsolidated.bySlug',
    args: slug ? { harnessSlug: slug } : undefined,
    enabled: !!slug,
  });

  // Select-from-Detail (related issue/feature cross-links) drives the global
  // ?sel so the swap panel follows, even when invoked from a pinned panel.
  const onSelect = useCallback(
    (id: string) => {
      void setUrlSel(id || null);
      void setEditId(null); // navigating away exits edit mode
    },
    [setUrlSel, setEditId],
  );

  // Selection history: push the previous ?sel whenever it changes (swap panel
  // only), so a Back affordance can retrace feature↔issue cross-links.
  const prevSelRef = useRef<string>('');
  useEffect(() => {
    if (pinnedId) return;
    if (suppressHistoryPush) {
      suppressHistoryPush = false;
      prevSelRef.current = urlSel;
      return;
    }
    const prev = prevSelRef.current;
    if (prev && prev !== urlSel) {
      selHistory.push(prev);
      if (selHistory.length > 50) selHistory.shift();
    }
    prevSelRef.current = urlSel;
  }, [urlSel, pinnedId]);
  const goBack = useCallback(() => {
    const prev = selHistory.pop();
    if (prev !== undefined) {
      suppressHistoryPush = true;
      void setUrlSel(prev || null);
    }
  }, [setUrlSel]);
  const onBack = !pinnedId && selHistory.length > 0 ? goBack : undefined;

  // Resolve the selected item. F-* → feature, I-* → issue (legacy surface),
  // WI-* → unified work item (the WorkItemsPanel grid sets these).
  const kind: 'feature' | 'issue' | 'workItem' | null = useMemo(() => {
    if (!selectedId) return null;
    if (selectedId.startsWith('F-')) return 'feature';
    if (selectedId.startsWith('I-')) return 'issue';
    if (selectedId.startsWith('WI-')) return 'workItem';
    return null;
  }, [selectedId]);

  const feature = useMemo(
    () => (kind === 'feature' ? (features ?? []).find((f) => f.id === selectedId) ?? null : null),
    [kind, features, selectedId],
  );
  const issue = useMemo(
    () => (kind === 'issue' ? (issues ?? []).find((i) => i.id === selectedId) ?? null : null),
    [kind, issues, selectedId],
  );
  // WI-* resolves against the same `workItems.byHarness` sync query the
  // WorkItemsPanel grid reads (one assembly, identical rows). Only subscribed
  // while a work item is actually selected.
  const workItemsQuery = useSyncQuery<WorkItemRow>({
    queryName: 'workItems.byHarness',
    args: { harnessSlug: slug, limit: 300 },
    enabled: Boolean(slug) && kind === 'workItem',
  });
  const workItemRows = workItemsQuery.loading ? null : workItemsQuery.data;
  const workItem = useMemo(
    () => (kind === 'workItem' ? (workItemRows ?? []).find((w) => w.id === selectedId) ?? null : null),
    [kind, workItemRows, selectedId],
  );

  useEffect(() => {
    if (pinnedId) {
      api.setTitle(pinnedId);
    } else if (feature) {
      api.setTitle(`Detail · ${feature.id}`);
    } else if (issue) {
      api.setTitle(`Detail · ${issue.id}`);
    } else if (workItem) {
      api.setTitle(`Detail · ${workItem.id}`);
    } else {
      api.setTitle('Detail');
    }
  }, [api, pinnedId, feature, issue, workItem]);

  if (!slug) {
    return <Empty>Pick a harness to inspect its work items.</Empty>;
  }

  if (!selectedId) {
    return <Empty>Pick a work item from the list to inspect.</Empty>;
  }

  if (selectedId && !feature && !issue && !workItem) {
    // The id is in the URL but the lists haven't settled yet (or it's a
    // stale selection). Show a brief loading state until the lists load.
    if (features === null || issues === null || (kind === 'workItem' && workItemRows === null)) {
      return <Empty>Loading {selectedId}…</Empty>;
    }
    return <Empty tone="error">No item found for {selectedId}.</Empty>;
  }

  if (feature) {
    return (
      <FeatureDetail
        slug={slug}
        feature={feature}
        issues={issues ?? []}
        runs={Array.isArray(runRows) ? runRows : []}
        onSelect={onSelect}
        onBack={onBack}
        patchFeature={patchFeature}
        isEditing={!pinnedId && editId === feature.id}
        onStartEdit={() => void setEditId(feature.id)}
        onCloseEdit={() => void setEditId(null)}
      />
    );
  }
  if (issue) {
    return <IssueDetail slug={slug} issue={issue} onSelect={onSelect} onBack={onBack} patchIssue={patchIssue} />;
  }
  if (workItem) {
    return <WorkItemDetail workItem={workItem} onSelect={onSelect} onBack={onBack} />;
  }
  return null;
}

/**
 * WorkItemDetail — read-only detail for a unified WI-* work item (the rows the
 * WorkItemsPanel grid serves). Issue-family items (bug/change/task) have no
 * legacy I-* row, so this is their only detail view; mutation verbs stay on
 * the agent surface (`work_items:*`) for now.
 */
function WorkItemDetail({
  workItem,
  onSelect,
  onBack,
}: {
  workItem: WorkItemRow;
  onSelect: (id: string) => void;
  onBack?: () => void;
}) {
  const fields: Array<[string, React.ReactNode]> = [
    ['Kind', `${workItem.kind} (${workItem.family} family)`],
    ['State', workItem.state],
    ['Severity', workItem.severity ?? '—'],
    [
      'Assignee',
      workItem.assignee
        ? `${workItem.assignee}${workItem.assignedBy ? ` · by ${workItem.assignedBy}` : ''}`
        : '—',
    ],
    ['Priority', workItem.priority ?? '—'],
    ['Rank', workItem.rank ?? '—'],
    [
      'Stage',
      workItem.spineRole ? `${workItem.spineRole}${workItem.spineStatus ? ` (${workItem.spineStatus})` : ''}` : '—',
    ],
    ['Updated', workItem.updatedAt ? new Date(workItem.updatedAt).toLocaleString() : '—'],
  ];
  return (
    <div className="pc-adv-detail">
      <header className="pc-adv-detail__header">
        <BackChip onBack={onBack} />
        <div className="pc-adv-detail__id">{workItem.id}</div>
        <div className="pc-adv-detail__title">{workItem.title}</div>
      </header>
      <div className="pc-adv-detail__body">
        <div className="pc-adv-detail__section">
          {fields.map(([label, value]) => (
            <div key={label} className="pc-adv-detail__status-row">
              <span className="pc-adv-detail__muted">{label}</span>
              <span>{value}</span>
            </div>
          ))}
          {workItem.planSlug ? (
            <div className="pc-adv-detail__status-row">
              <span className="pc-adv-detail__muted">Plan</span>
              <code className="pc-adv-detail__code">{workItem.planSlug}</code>
            </div>
          ) : null}
        </div>
        {workItem.summary ? (
          <div className="pc-adv-detail__section">
            <div className="pc-adv-detail__prose">{workItem.summary}</div>
          </div>
        ) : null}
        {/* Feature-family rows keep their richer F-* detail: cross-link to it. */}
        {workItem.family === 'feature' && workItem.id.startsWith('F-') ? (
          <button type="button" className="pc-adv-detail__link-btn" onClick={() => onSelect(workItem.id)}>
            Open feature detail <ArrowUpRight size={12} />
          </button>
        ) : null}
      </div>
    </div>
  );
}

function BackChip({ onBack }: { onBack?: () => void }) {
  if (!onBack) return null;
  return (
    <Tooltip label="Back to previous selection">
      <button type="button" className="pc-adv-detail__back" onClick={onBack}>
        ← Back
      </button>
    </Tooltip>
  );
}

function FeatureDetail({
  slug,
  feature,
  issues,
  runs,
  onSelect,
  onBack,
  patchFeature,
  isEditing,
  onStartEdit,
  onCloseEdit,
}: {
  slug: string;
  feature: HarnessFeature;
  issues: Issue[];
  runs: RunRow[];
  onSelect: (id: string) => void;
  onBack?: () => void;
  patchFeature: (id: string, partial: Partial<HarnessFeature>) => void;
  isEditing: boolean;
  onStartEdit: () => void;
  onCloseEdit: () => void;
}) {
  const [working, setWorking] = useState<string | null>(null);
  const [notes, setNotes] = useState<string[] | null>(null);
  const [notesOpen, setNotesOpen] = useState(false);
  const [steerNote, setSteerNote] = useState('');
  const { confirm, element: confirmEl } = useConfirmDialog();

  // Add a steer note for the worker — POSTs a block to .papercusp/notes/<id>.md
  // (the OperatorNoteForm contract). Optimistically appends to the local list.
  const addSteerNote = useCallback(async () => {
    const content = steerNote.trim();
    if (!content) return;
    setWorking('steer');
    try {
      const res = await fetch(`/api/harness/${encodeURIComponent(slug)}/features/${encodeURIComponent(feature.id)}/notes`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content }),
      });
      if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
      setNotes((prev) => [...(prev ?? []), content]); // optimistic append
      setSteerNote('');
      setNotesOpen(true);
      toast.success('Steer note added');
    } catch (e) {
      toast.error('Add steer note failed', { description: String(e) });
    } finally {
      setWorking(null);
    }
  }, [slug, feature.id, steerNote]);

  // Issues filed against this feature: linked as the fix (linkedFeatureId) or
  // found while working on it (foundDuring).
  const relatedIssues = useMemo(
    () => issues.filter((i) => i.linkedFeatureId === feature.id || i.foundDuring === feature.id),
    [issues, feature.id],
  );
  // Recent agent runs for this feature (consolidated row carries feature_id).
  const featureRuns = useMemo(
    () =>
      runs
        .filter((r) => r.featureId === feature.id)
        .sort((a, b) => Date.parse(String(b.ts)) - Date.parse(String(a.ts)))
        .slice(0, 3),
    [runs, feature.id],
  );

  // Steer notes (operator notes for this feature). Collapsed unless populated.
  useEffect(() => {
    let aborted = false;
    setNotes(null);
    fetch(`/api/harness/${encodeURIComponent(slug)}/features/${encodeURIComponent(feature.id)}/notes`)
      .then((r) => (r.ok ? r.json() : { blocks: [] }))
      .then((d: { blocks?: unknown[] }) => {
        if (aborted) return;
        const texts = (d.blocks ?? [])
          .map((b) => {
            if (typeof b === 'string') return b;
            if (b && typeof b === 'object') {
              const o = b as Record<string, unknown>;
              return String(o.text ?? o.body ?? o.markdown ?? o.content ?? '');
            }
            return '';
          })
          .filter((t) => t.trim().length > 0);
        setNotes(texts);
      })
      .catch(() => !aborted && setNotes([]));
    return () => {
      aborted = true;
    };
  }, [slug, feature.id]);

  const callJson = useCallback(
    async (path: string, init?: RequestInit) => {
      const res = await fetch(`/api/harness/${encodeURIComponent(slug)}${path}`, init);
      if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
      return res.json();
    },
    [slug],
  );

  const setStatus = useCallback(
    async (next: FeatureStatus) => {
      const prev = feature.status;
      patchFeature(feature.id, { status: next }); // optimistic
      setWorking(`status:${next}`);
      try {
        await callJson(`/features/${feature.id}?phase=staging`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ status: next }),
        });
        toast.success(`${feature.id} → ${next}`);
      } catch (e) {
        patchFeature(feature.id, { status: prev }); // rollback
        toast.error('Status change failed', { description: String(e) });
      } finally {
        setWorking(null);
      }
    },
    [callJson, feature.id, feature.status, patchFeature],
  );

  const resetFeature = useCallback(async () => {
    if (
      !(await confirm({
        title: `Reset ${feature.id}?`,
        body: `Reset ${feature.id} back to todo and clear its attempts. The worker will pick it up fresh.`,
        destructive: true,
        confirmLabel: 'Reset',
      }))
    )
      return;
    const prev = { status: feature.status, attempts: feature.attempts };
    patchFeature(feature.id, { status: 'todo', attempts: 0 }); // optimistic
    setWorking('reset');
    try {
      await callJson(`/features/${feature.id}/reset?phase=staging`, { method: 'POST' });
      toast.success(`${feature.id} reset`);
    } catch (e) {
      patchFeature(feature.id, prev); // rollback
      toast.error('Reset failed', { description: String(e) });
    } finally {
      setWorking(null);
    }
  }, [callJson, feature.id, feature.status, feature.attempts, patchFeature, confirm]);

  // Edit mode — render the full FeatureEditor inline in this pane.
  if (isEditing) {
    return (
      <FeatureEditor
        embedded
        slug={slug}
        feature={{
          id: feature.id,
          title: feature.title,
          claims: feature.claims,
          status: feature.status,
          attempts: feature.attempts ?? 0,
        }}
        onClose={onCloseEdit}
        onSaved={() => {}}
      />
    );
  }

  return (
    <div className="pc-adv-detail">
      <header className="pc-adv-detail__header">
        <BackChip onBack={onBack} />
        <div className="pc-adv-detail__id">{feature.id}</div>
        <div className="pc-adv-detail__title">{feature.title}</div>
        <div className="pc-adv-detail__meta">
          <StatusPill status={feature.status as HarnessStatus} />
          {typeof feature.attempts === 'number' && feature.attempts > 0 && (
            <span className="pc-adv-detail__attempts">{feature.attempts}× attempts</span>
          )}
          {feature.sourcePlanSlug && (
            <Tooltip label={`From plan: ${feature.sourcePlanSlug}`}>
              <span className="pc-adv-detail__plan">↗ {feature.sourcePlanSlug}</span>
            </Tooltip>
          )}
        </div>
      </header>

      <section className="pc-adv-detail__body">
        <div className="pc-adv-detail__section">
          <h3>Description</h3>
          {feature.summary ? (
            <p className="pc-adv-detail__prose">{feature.summary}</p>
          ) : (
            <p className="pc-adv-detail__muted">No description.</p>
          )}
        </div>

        <div className="pc-adv-detail__section">
          <h3>Status</h3>
          <div className="pc-adv-detail__status-row">
            <Select
              value={feature.status}
              onChange={(v) => void setStatus(v as FeatureStatus)}
              disabled={working !== null}
              ariaLabel="Change status"
              triggerClassName="pc-adv-detail__select"
              options={FEATURE_STATUSES.map((s) => ({
                value: s,
                label: <StatusPill status={s as HarnessStatus} size="xs" />,
              }))}
            />
          </div>
        </div>

        {relatedIssues.length > 0 && (
          <div className="pc-adv-detail__section">
            <h3>Issues ({relatedIssues.length})</h3>
            <div className="pc-adv-detail__related">
              {relatedIssues.map((i) => (
                <Tooltip key={i.id} label={i.title}>
                  <button
                    type="button"
                    className="pc-adv-detail__related-row"
                    onClick={() => onSelect(i.id)}
                  >
                    <span className="pc-adv-detail__related-id">{i.id}</span>
                    <span
                      className="pc-adv-detail__related-dot"
                      style={{ background: SEVERITY[i.severity as IssueSeverityKey].solid }}
                    />
                    <span className="pc-adv-detail__related-title">{i.title}</span>
                  </button>
                </Tooltip>
              ))}
            </div>
          </div>
        )}

        <div className="pc-adv-detail__section">
          <h3>Recent activity</h3>
          {featureRuns.length === 0 ? (
            <p className="pc-adv-detail__muted">No agent runs for this feature yet.</p>
          ) : (
            <div className="pc-adv-detail__runs">
              {featureRuns.map((r) => {
                // P-023: outcome chip + error line from the joined spawn row;
                // "Open session" resumes the run's recorded Claude session in
                // a terminal (the launch-su resume path).
                const outcome = runOutcome(r);
                return (
                  <div key={r.runId} className="pc-adv-detail__run-block">
                    <div className="pc-adv-detail__run">
                      <span className="pc-adv-detail__run-role">{r.role}</span>
                      <span className="pc-adv-detail__run-time">{fmtAgo(r.ts)}</span>
                      <span className="pc-adv-detail__run-right">
                        {r.costUsd != null && Number(r.costUsd) > 0 && (
                          <span className="pc-adv-detail__run-cost">${Number(r.costUsd).toFixed(2)}</span>
                        )}
                        {outcome && (
                          <span
                            className={`pc-adv-detail__run-outcome is-${outcome.kind}`}
                            title={outcome.detail}
                          >
                            {outcome.label}
                          </span>
                        )}
                        {r.sessionId && (
                          <Tooltip label="Open this run's agent session in a terminal (claude --resume)">
                            <button
                              type="button"
                              className="pc-adv-detail__run-open"
                              onClick={() => void openRunSession(slug, r.sessionId!)}
                            >
                              Open session
                            </button>
                          </Tooltip>
                        )}
                      </span>
                    </div>
                    {outcome?.kind === 'failed' && outcome.detail && (
                      <div className="pc-adv-detail__run-error" title={outcome.detail}>
                        {outcome.detail}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="pc-adv-detail__section">
          <h3>
            <button type="button" className="pc-adv-detail__collapse" onClick={() => setNotesOpen((o) => !o)}>
              {notesOpen ? '▾' : '▸'} Steer notes{notes && notes.length > 0 ? ` (${notes.length})` : ''}
            </button>
          </h3>
          {notesOpen && (
            <>
              {notes && notes.length > 0 && (
                <div className="pc-adv-detail__notes">
                  {notes.map((n, idx) => (
                    <p key={idx} className="pc-adv-detail__note">
                      {n}
                    </p>
                  ))}
                </div>
              )}
              <div className="pc-adv-detail__note-form">
                <textarea
                  value={steerNote}
                  onChange={(e) => setSteerNote(e.target.value)}
                  placeholder="Add a steer note for the worker…"
                  rows={2}
                  aria-label="Add a steer note"
                />
                <button type="button" disabled={working !== null || !steerNote.trim()} onClick={() => void addSteerNote()}>
                  Add steer note
                </button>
              </div>
            </>
          )}
        </div>

        <div className="pc-adv-detail__section">
          <h3>Actions</h3>
          <div className="pc-adv-detail__actions">
            <button
              type="button"
              disabled={working !== null}
              onClick={async () => {
                setWorking('chat');
                try {
                  const res = await openFeatureChat({
                    slug,
                    role: 'worker',
                    featureId: feature.id,
                    title: feature.summary || feature.title,
                    mode: 'discuss',
                  });
                  if (res && typeof res === 'object' && 'error' in res) {
                    throw new Error(String((res as { error: unknown }).error));
                  }
                } catch (e) {
                  toast.error('Open chat failed', { description: String(e) });
                } finally {
                  setWorking(null);
                }
              }}
            >
              💬 Chat
            </button>
            <button type="button" disabled={working !== null} onClick={resetFeature}>
              Reset
            </button>
            <button type="button" disabled={working !== null} onClick={onStartEdit}>
              Edit
            </button>
          </div>
        </div>
      </section>
      {confirmEl}
      <DetailStyles />
    </div>
  );
}

function IssueDetail({
  slug,
  issue,
  onSelect,
  onBack,
  patchIssue,
}: {
  slug: string;
  issue: Issue;
  onSelect: (id: string) => void;
  onBack?: () => void;
  patchIssue: (id: string, partial: Partial<Issue>) => void;
}) {
  const [working, setWorking] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [extraNotes, setExtraNotes] = useState<IssueNote[]>([]);

  // Reset optimistic notes when the selected issue changes.
  useEffect(() => {
    setExtraNotes([]);
  }, [issue.id]);

  const allNotes = useMemo(() => [...(issue.notes ?? []), ...extraNotes], [issue.notes, extraNotes]);

  const runAction = useCallback(
    async (action: IssueActionKind) => {
      const target = issueActionStatus(action); // null for promote (server-computed)
      const prev = issue.status;
      if (target) patchIssue(issue.id, { status: target }); // optimistic
      setWorking(action);
      try {
        await issueAction(slug, issue.id, action);
        toast.success(`${issue.id} → ${action}`);
      } catch (e) {
        if (target) patchIssue(issue.id, { status: prev }); // rollback
        toast.error(`${action} failed`, { description: String(e) });
      } finally {
        setWorking(null);
      }
    },
    [slug, issue.id, issue.status, patchIssue],
  );

  const addNote = useCallback(async () => {
    const text = note.trim();
    if (!text) return;
    setWorking('note');
    try {
      const res = await fetch(`/api/harness/${encodeURIComponent(slug)}/issues/${encodeURIComponent(issue.id)}/update`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ note: text, by: 'human' }),
      });
      if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
      // Optimistic: Zero will also push the updated issue, but show it now.
      setExtraNotes((prev) => [...prev, { ts: new Date().toISOString(), by: 'human', text }]);
      setNote('');
      toast.success('Note added');
    } catch (e) {
      toast.error('Add note failed', { description: String(e) });
    } finally {
      setWorking(null);
    }
  }, [slug, issue.id, note]);

  return (
    <div className="pc-adv-detail">
      <header className="pc-adv-detail__header">
        <BackChip onBack={onBack} />
        <div className="pc-adv-detail__id">{issue.id}</div>
        <div className="pc-adv-detail__title">{issue.title}</div>
        <div className="pc-adv-detail__meta">
          <SeverityPill severity={issue.severity} />
          <IssueStatusPill status={issue.status} />
          {issue.linkedFeatureId && (
            <Tooltip label={`Go to linked feature ${issue.linkedFeatureId}`}>
              <button
                type="button"
                className="pc-adv-detail__link pc-adv-detail__link-btn"
                onClick={() => onSelect(issue.linkedFeatureId!)}
              >
                <ArrowUpRight size={11} aria-hidden /> {issue.linkedFeatureId}
              </button>
            </Tooltip>
          )}
        </div>
      </header>
      <section className="pc-adv-detail__body">
        {issue.evidence && (
          <div className="pc-adv-detail__section">
            <h3>Evidence</h3>
            <pre className="pc-adv-detail__code">{issue.evidence}</pre>
          </div>
        )}
        {issue.repro && (
          <div className="pc-adv-detail__section">
            <h3>Reproduction</h3>
            <pre className="pc-adv-detail__code">{issue.repro}</pre>
          </div>
        )}
        {issue.suggestedFix && (
          <div className="pc-adv-detail__section">
            <h3>Suggested fix</h3>
            <pre className="pc-adv-detail__code">{issue.suggestedFix}</pre>
          </div>
        )}
        {issue.codePointer && (
          <div className="pc-adv-detail__section">
            <h3>Code pointer</h3>
            <code className="pc-adv-detail__pointer">{issue.codePointer}</code>
          </div>
        )}

        <div className="pc-adv-detail__section">
          <h3>Notes{allNotes.length > 0 ? ` (${allNotes.length})` : ''}</h3>
          {allNotes.length > 0 && (
            <div className="pc-adv-detail__notes">
              {allNotes.map((n, idx) => (
                <div key={idx} className="pc-adv-detail__note-row">
                  <div className="pc-adv-detail__note-meta">
                    {n.by} · {n.ts ? new Date(n.ts).toLocaleString() : ''}
                  </div>
                  <p className="pc-adv-detail__note">{n.text}</p>
                </div>
              ))}
            </div>
          )}
          <div className="pc-adv-detail__note-form">
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Add a note…"
              rows={2}
              aria-label="Add a note"
            />
            <button type="button" disabled={working !== null || !note.trim()} onClick={() => void addNote()}>
              Add note
            </button>
          </div>
        </div>

        <div className="pc-adv-detail__section">
          <h3>Actions</h3>
          <div className="pc-adv-detail__actions">
            {!issue.linkedFeatureId && issue.status !== 'closed' && issue.status !== 'wontfix' && (
              <button type="button" disabled={working !== null} onClick={() => void runAction('promote')}>
                Promote
              </button>
            )}
            {issue.status !== 'acknowledged' && issue.status !== 'closed' && (
              <button type="button" disabled={working !== null} onClick={() => void runAction('acknowledge')}>
                Acknowledge
              </button>
            )}
            {issue.status !== 'closed' && (
              <button type="button" disabled={working !== null} onClick={() => void runAction('close')}>
                Close
              </button>
            )}
            {issue.status !== 'wontfix' && (
              <button type="button" disabled={working !== null} onClick={() => void runAction('wontfix')}>
                Won't fix
              </button>
            )}
          </div>
        </div>
      </section>
      <DetailStyles />
    </div>
  );
}

function Empty({ children, tone }: { children: React.ReactNode; tone?: 'error' }) {
  return (
    <div
      style={{
        height: '100%',
        display: 'grid',
        placeItems: 'center',
        padding: 24,
        color: tone === 'error' ? 'var(--bad, #fb7185)' : 'var(--fg-mute, #7f9bb4)',
        fontSize: 13,
        textAlign: 'center',
      }}
    >
      {children}
    </div>
  );
}

function DetailStyles() {
  return (
    <style>{`
      .pc-adv-detail {
        display: flex;
        flex-direction: column;
        height: 100%;
        min-height: 0;
        background: var(--bg-1, #0b1220);
        color: var(--fg-dim, #b9d4e8);
      }
      .pc-adv-detail__header {
        flex-shrink: 0;
        padding: 14px 18px 12px;
        border-bottom: 1px solid var(--border, color-mix(in srgb, var(--accent-strong), transparent 85%));
      }
      .pc-adv-detail__back {
        display: inline-flex;
        align-items: center;
        margin-bottom: 8px;
        padding: 2px 8px;
        font-size: 11px;
        font-weight: 600;
        color: var(--accent-strong, #7dd3fc);
        background: var(--bg-2, rgba(255, 255, 255, 0.045));
        border: 1px solid var(--border-strong, color-mix(in srgb, var(--accent-strong), transparent 68%));
        border-radius: 999px;
        cursor: pointer;
      }
      .pc-adv-detail__back:hover {
        background: var(--bg-3, rgba(255, 255, 255, 0.075));
        border-color: var(--accent, #38bdf8);
      }
      .pc-adv-detail__id {
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 11px;
        font-weight: 700;
        color: var(--fg-mute, #7f9bb4);
        letter-spacing: 0.04em;
      }
      .pc-adv-detail__title {
        font-size: 16px;
        font-weight: 700;
        line-height: 1.3;
        color: var(--fg, #e7f7ff);
        margin-top: 4px;
      }
      .pc-adv-detail__meta {
        display: flex;
        gap: 10px;
        align-items: center;
        margin-top: 10px;
        flex-wrap: wrap;
      }
      .pc-adv-detail__attempts {
        font-size: 11px;
        color: var(--fg-mute, #7f9bb4);
      }
      .pc-adv-detail__plan,
      .pc-adv-detail__link {
        font-size: 11px;
        color: var(--accent-strong, #7dd3fc);
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      }
      .pc-adv-detail__link-btn {
        display: inline-flex;
        align-items: center;
        gap: 3px;
        background: none;
        border: none;
        padding: 0;
        cursor: pointer;
        text-decoration: underline;
        text-underline-offset: 2px;
      }
      .pc-adv-detail__link-btn:hover {
        color: var(--fg, #e7f7ff);
      }
      .pc-adv-detail__body {
        flex: 1;
        overflow: auto;
        padding: 16px 18px;
        display: flex;
        flex-direction: column;
        gap: 16px;
      }
      .pc-adv-detail__section h3 {
        margin: 0 0 6px;
        font-size: 10px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.11em;
        color: var(--fg-mute, #7f9bb4);
      }
      .pc-adv-detail__collapse {
        background: none;
        border: none;
        padding: 0;
        font: inherit;
        text-transform: uppercase;
        letter-spacing: 0.11em;
        color: var(--fg-mute, #7f9bb4);
        cursor: pointer;
      }
      .pc-adv-detail__prose {
        margin: 0;
        font-size: 13px;
        line-height: 1.55;
        white-space: pre-wrap;
        color: var(--fg, #e7f7ff);
      }
      .pc-adv-detail__muted {
        margin: 0;
        font-size: 12px;
        font-style: italic;
        color: var(--fg-mute, #7f9bb4);
      }
      .pc-adv-detail__related {
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .pc-adv-detail__related-row {
        display: grid;
        grid-template-columns: auto auto 1fr;
        gap: 8px;
        align-items: center;
        padding: 5px 8px;
        font-size: 12px;
        text-align: left;
        color: var(--fg-dim, #b9d4e8);
        background: var(--bg-2, rgba(255, 255, 255, 0.045));
        border: 1px solid var(--border, color-mix(in srgb, var(--accent-strong), transparent 85%));
        border-radius: 6px;
        cursor: pointer;
      }
      .pc-adv-detail__related-row:hover {
        background: var(--bg-3, rgba(255, 255, 255, 0.075));
        border-color: var(--border-strong, color-mix(in srgb, var(--accent-strong), transparent 68%));
      }
      .pc-adv-detail__related-id {
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 11px;
        color: var(--fg-mute, #7f9bb4);
      }
      .pc-adv-detail__related-dot {
        width: 7px;
        height: 7px;
        border-radius: 50%;
      }
      .pc-adv-detail__related-title {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        color: var(--fg, #e7f7ff);
      }
      .pc-adv-detail__runs {
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .pc-adv-detail__run {
        display: flex;
        gap: 10px;
        align-items: baseline;
        font-size: 12px;
      }
      .pc-adv-detail__run-role {
        font-weight: 600;
        color: var(--accent-strong, #7dd3fc);
        min-width: 80px;
      }
      .pc-adv-detail__run-time {
        color: var(--fg-mute, #7f9bb4);
      }
      .pc-adv-detail__run-right {
        margin-left: auto;
        display: inline-flex;
        gap: 8px;
        align-items: baseline;
      }
      .pc-adv-detail__run-cost {
        color: var(--fg-mute, #7f9bb4);
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      }
      /* P-023 outcome chip — colour buckets from runOutcome(). */
      .pc-adv-detail__run-outcome {
        font-size: 10.5px;
        font-weight: 700;
        letter-spacing: 0.02em;
        padding: 1px 7px;
        border-radius: 999px;
        white-space: nowrap;
      }
      .pc-adv-detail__run-outcome.is-done {
        background: color-mix(in oklab, var(--good, #34d399), transparent 84%);
        color: color-mix(in oklab, var(--good, #34d399), white 35%);
      }
      .pc-adv-detail__run-outcome.is-failed {
        background: color-mix(in oklab, var(--bad, #f87171), transparent 82%);
        color: color-mix(in oklab, var(--bad, #f87171), white 35%);
      }
      .pc-adv-detail__run-outcome.is-cancelled {
        background: color-mix(in oklab, var(--warn, #fbbf24), transparent 84%);
        color: color-mix(in oklab, var(--warn, #fbbf24), white 35%);
      }
      .pc-adv-detail__run-outcome.is-running {
        background: color-mix(in oklab, var(--accent, #38bdf8), transparent 84%);
        color: var(--accent-strong, #7dd3fc);
      }
      .pc-adv-detail__run-outcome.is-muted {
        background: var(--bg-3, rgba(255, 255, 255, 0.075));
        color: var(--fg-mute, #7f9bb4);
      }
      .pc-adv-detail__run-open {
        font-size: 10.5px;
        font-weight: 600;
        padding: 1px 8px;
        border-radius: 999px;
        background: transparent;
        border: 1px solid color-mix(in oklab, var(--accent-strong, #7dd3fc), transparent 60%);
        color: var(--accent-strong, #7dd3fc);
        cursor: pointer;
        white-space: nowrap;
      }
      .pc-adv-detail__run-open:hover {
        background: color-mix(in oklab, var(--accent-strong, #7dd3fc), transparent 86%);
      }
      .pc-adv-detail__run-error {
        margin: 1px 0 2px 90px;
        font-size: 11px;
        color: color-mix(in oklab, var(--bad, #f87171), white 35%);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .pc-adv-detail__notes {
        display: flex;
        flex-direction: column;
        gap: 8px;
      }
      .pc-adv-detail__note-row {
        border-left: 2px solid var(--border-strong, color-mix(in srgb, var(--accent-strong), transparent 68%));
        padding-left: 10px;
      }
      .pc-adv-detail__note-meta {
        font-size: 10px;
        color: var(--fg-mute, #7f9bb4);
        margin-bottom: 2px;
      }
      .pc-adv-detail__note {
        margin: 0;
        font-size: 12px;
        line-height: 1.5;
        white-space: pre-wrap;
        color: var(--fg, #e7f7ff);
      }
      .pc-adv-detail__note-form {
        display: flex;
        flex-direction: column;
        gap: 6px;
        margin-top: 8px;
      }
      .pc-adv-detail__note-form textarea {
        width: 100%;
        resize: vertical;
        padding: 6px 8px;
        font: inherit;
        font-size: 12px;
        background: var(--bg-2, rgba(255, 255, 255, 0.045));
        color: var(--fg, #e7f7ff);
        border: 1px solid var(--border-strong, color-mix(in srgb, var(--accent-strong), transparent 68%));
        border-radius: 6px;
      }
      .pc-adv-detail__note-form textarea:focus {
        outline: none;
        border-color: var(--accent, #38bdf8);
        box-shadow: 0 0 0 2px color-mix(in oklab, var(--accent, #38bdf8), transparent 78%);
      }
      .pc-adv-detail__note-form button {
        align-self: flex-start;
        padding: 5px 12px;
        font-size: 12px;
        font-weight: 600;
        background: var(--bg-2, rgba(255, 255, 255, 0.045));
        color: var(--fg, #e7f7ff);
        border: 1px solid var(--border-strong, color-mix(in srgb, var(--accent-strong), transparent 68%));
        border-radius: 6px;
        cursor: pointer;
      }
      .pc-adv-detail__note-form button:hover:not(:disabled) {
        border-color: var(--accent, #38bdf8);
      }
      .pc-adv-detail__note-form button:disabled {
        opacity: 0.45;
        cursor: default;
      }
      .pc-adv-detail__code {
        margin: 0;
        padding: 10px;
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 11px;
        background: var(--bg-2, rgba(255, 255, 255, 0.045));
        border: 1px solid var(--border, color-mix(in srgb, var(--accent-strong), transparent 85%));
        border-radius: 6px;
        color: var(--fg, #e7f7ff);
        white-space: pre-wrap;
        word-break: break-word;
        max-height: 240px;
        overflow: auto;
      }
      .pc-adv-detail__pointer {
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 11px;
        padding: 3px 8px;
        background: var(--bg-2, rgba(255, 255, 255, 0.045));
        border-radius: 4px;
        color: var(--fg, #e7f7ff);
      }
      .pc-adv-detail__select {
        display: inline-flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        min-width: 160px;
        min-height: 32px;
        padding: 0 10px;
        font-size: 12px;
        background: var(--bg-2, rgba(255, 255, 255, 0.045));
        color: var(--fg, #e7f7ff);
        border: 1px solid var(--border-strong, color-mix(in srgb, var(--accent-strong), transparent 68%));
        border-radius: 6px;
        cursor: pointer;
      }
      .pc-adv-detail__actions {
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
      }
      .pc-adv-detail__actions button {
        padding: 6px 12px;
        font-size: 12px;
        font-weight: 600;
        background: var(--bg-2, rgba(255, 255, 255, 0.045));
        color: var(--fg, #e7f7ff);
        border: 1px solid var(--border-strong, color-mix(in srgb, var(--accent-strong), transparent 68%));
        border-radius: 6px;
        cursor: pointer;
      }
      .pc-adv-detail__actions button:hover:not(:disabled) {
        background: var(--bg-3, rgba(255, 255, 255, 0.075));
        border-color: var(--accent, #38bdf8);
      }
      .pc-adv-detail__actions button:disabled {
        opacity: 0.45;
        cursor: default;
      }
    `}</style>
  );
}
