'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { parseAsString, useQueryState } from 'nuqs';
import { toast } from 'sonner';
import { useSyncQuery } from '@restart/sync';
import type { Issue, IssueNote, IssueSeverity } from '../../harness/issues/types';
import type { PanelComponentProps } from '../../harness/dock/panel-registry';
import { useHarnessFeatures, useHarnessIssues, type FeatureStatus, type HarnessFeature } from './useHarnessData';
import { issueAction, issueActionStatus, type IssueActionKind } from './harness-actions';

const FEATURE_STATUSES: FeatureStatus[] = [
  'todo',
  'in_progress',
  'validating',
  'passed',
  'failing',
  'blocked',
  'deprecated',
];

const STATUS_TONE: Record<string, { bg: string; fg: string }> = {
  passed: { bg: 'rgba(34, 197, 94, 0.16)', fg: '#86efac' },
  todo: { bg: 'rgba(148, 163, 184, 0.14)', fg: '#cbd5e1' },
  in_progress: { bg: 'rgba(96, 165, 250, 0.18)', fg: '#93c5fd' },
  failing: { bg: 'rgba(239, 68, 68, 0.18)', fg: '#fca5a5' },
  validating: { bg: 'rgba(250, 204, 21, 0.16)', fg: '#fde68a' },
  blocked: { bg: 'rgba(244, 114, 182, 0.16)', fg: '#f9a8d4' },
  deprecated: { bg: 'rgba(113, 113, 122, 0.18)', fg: '#a1a1aa' },
};

const SEVERITY_TONE: Record<IssueSeverity, { bg: string; fg: string }> = {
  critical: { bg: 'rgba(239, 68, 68, 0.22)', fg: '#fca5a5' },
  major: { bg: 'rgba(249, 115, 22, 0.2)', fg: '#fdba74' },
  minor: { bg: 'rgba(250, 204, 21, 0.18)', fg: '#fde68a' },
  nit: { bg: 'rgba(148, 163, 184, 0.16)', fg: '#cbd5e1' },
};

// Consolidated agent-run row (camelCase Zero export).
type RunRow = {
  runId: string;
  role: string;
  ts: number | string;
  featureId?: string | null;
  costUsd?: number | string;
};

// Selection-history stack, module-scoped so it survives DetailPanel
// re-mounts (a slug change remounts the panel). Only the swap panel
// (no pinned itemId) pushes/pops; pinned panels are read-only viewers.
const selHistory: string[] = [];
let suppressHistoryPush = false;

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
  const onSelect = useCallback((id: string) => void setUrlSel(id || null), [setUrlSel]);

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

  // Resolve the selected item. F-* → feature, I-* → issue.
  const kind: 'feature' | 'issue' | null = useMemo(() => {
    if (!selectedId) return null;
    if (selectedId.startsWith('F-')) return 'feature';
    if (selectedId.startsWith('I-')) return 'issue';
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

  useEffect(() => {
    if (pinnedId) {
      api.setTitle(pinnedId);
    } else if (feature) {
      api.setTitle(`Detail · ${feature.id}`);
    } else if (issue) {
      api.setTitle(`Detail · ${issue.id}`);
    } else {
      api.setTitle('Detail');
    }
  }, [api, pinnedId, feature, issue]);

  if (!slug) {
    return <Empty>Pick a harness to inspect features and issues.</Empty>;
  }

  if (!selectedId) {
    return <Empty>Pick a feature or issue from the lists to inspect.</Empty>;
  }

  if (selectedId && !feature && !issue) {
    // The id is in the URL but the lists haven't settled yet (or it's a
    // stale selection). Show a brief loading state until both lists load.
    if (features === null || issues === null) {
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
      />
    );
  }
  if (issue) {
    return <IssueDetail slug={slug} issue={issue} onSelect={onSelect} onBack={onBack} patchIssue={patchIssue} />;
  }
  return null;
}

function BackChip({ onBack }: { onBack?: () => void }) {
  if (!onBack) return null;
  return (
    <button type="button" className="pc-adv-detail__back" onClick={onBack} title="Back to previous selection">
      ← Back
    </button>
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
}: {
  slug: string;
  feature: HarnessFeature;
  issues: Issue[];
  runs: RunRow[];
  onSelect: (id: string) => void;
  onBack?: () => void;
  patchFeature: (id: string, partial: Partial<HarnessFeature>) => void;
}) {
  const [working, setWorking] = useState<string | null>(null);
  const [notes, setNotes] = useState<string[] | null>(null);
  const [notesOpen, setNotesOpen] = useState(false);

  const tone = STATUS_TONE[feature.status] ?? STATUS_TONE.todo;

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
    if (!window.confirm(`Reset ${feature.id} back to todo?`)) return;
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
  }, [callJson, feature.id, feature.status, feature.attempts, patchFeature]);

  return (
    <div className="pc-adv-detail">
      <header className="pc-adv-detail__header">
        <BackChip onBack={onBack} />
        <div className="pc-adv-detail__id">{feature.id}</div>
        <div className="pc-adv-detail__title">{feature.title}</div>
        <div className="pc-adv-detail__meta">
          <span className="pc-adv-detail__pill" style={{ background: tone.bg, color: tone.fg }}>
            {feature.status}
          </span>
          {typeof feature.attempts === 'number' && feature.attempts > 0 && (
            <span className="pc-adv-detail__attempts">{feature.attempts}× attempts</span>
          )}
          {feature.sourcePlanSlug && (
            <span className="pc-adv-detail__plan" title={`From plan: ${feature.sourcePlanSlug}`}>
              ↗ {feature.sourcePlanSlug}
            </span>
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
            <select
              value={feature.status}
              onChange={(e) => void setStatus(e.target.value as FeatureStatus)}
              disabled={working !== null}
              aria-label="Change status"
            >
              {FEATURE_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </div>
        </div>

        {relatedIssues.length > 0 && (
          <div className="pc-adv-detail__section">
            <h3>Issues ({relatedIssues.length})</h3>
            <div className="pc-adv-detail__related">
              {relatedIssues.map((i) => {
                const t = SEVERITY_TONE[i.severity] ?? SEVERITY_TONE.minor;
                return (
                  <button
                    key={i.id}
                    type="button"
                    className="pc-adv-detail__related-row"
                    onClick={() => onSelect(i.id)}
                    title={i.title}
                  >
                    <span className="pc-adv-detail__related-id">{i.id}</span>
                    <span className="pc-adv-detail__related-dot" style={{ background: t.fg }} />
                    <span className="pc-adv-detail__related-title">{i.title}</span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        <div className="pc-adv-detail__section">
          <h3>Recent activity</h3>
          {featureRuns.length === 0 ? (
            <p className="pc-adv-detail__muted">No agent runs for this feature yet.</p>
          ) : (
            <div className="pc-adv-detail__runs">
              {featureRuns.map((r) => (
                <div key={r.runId} className="pc-adv-detail__run">
                  <span className="pc-adv-detail__run-role">{r.role}</span>
                  <span className="pc-adv-detail__run-time">{fmtAgo(r.ts)}</span>
                  {r.costUsd != null && Number(r.costUsd) > 0 && (
                    <span className="pc-adv-detail__run-cost">${Number(r.costUsd).toFixed(2)}</span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {notes && notes.length > 0 && (
          <div className="pc-adv-detail__section">
            <h3>
              <button type="button" className="pc-adv-detail__collapse" onClick={() => setNotesOpen((o) => !o)}>
                {notesOpen ? '▾' : '▸'} Steer notes ({notes.length})
              </button>
            </h3>
            {notesOpen && (
              <div className="pc-adv-detail__notes">
                {notes.map((n, idx) => (
                  <p key={idx} className="pc-adv-detail__note">
                    {n}
                  </p>
                ))}
              </div>
            )}
          </div>
        )}

        <div className="pc-adv-detail__section">
          <h3>Actions</h3>
          <div className="pc-adv-detail__actions">
            <button type="button" disabled={working !== null} onClick={resetFeature}>
              Reset
            </button>
            <button
              type="button"
              disabled={working !== null}
              onClick={() => {
                // /admin/features/<F-NN> is the canonical editor surface.
                window.open(
                  `/admin/features?slug=${encodeURIComponent(slug)}&id=${encodeURIComponent(feature.id)}`,
                  '_blank',
                );
              }}
            >
              Edit
            </button>
          </div>
        </div>
      </section>
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
  const sevTone = SEVERITY_TONE[issue.severity] ?? SEVERITY_TONE.minor;

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
          <span className="pc-adv-detail__pill" style={{ background: sevTone.bg, color: sevTone.fg }}>
            {issue.severity}
          </span>
          <span className="pc-adv-detail__status">{issue.status}</span>
          {issue.linkedFeatureId && (
            <button
              type="button"
              className="pc-adv-detail__link pc-adv-detail__link-btn"
              title={`Go to linked feature ${issue.linkedFeatureId}`}
              onClick={() => onSelect(issue.linkedFeatureId!)}
            >
              ↗ {issue.linkedFeatureId}
            </button>
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
        color: tone === 'error' ? '#fca5a5' : 'rgba(220, 214, 248, 0.6)',
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
        background: rgba(8, 10, 22, 0.6);
        color: rgba(220, 214, 248, 0.92);
      }
      .pc-adv-detail__header {
        flex-shrink: 0;
        padding: 14px 18px 12px;
        border-bottom: 1px solid rgba(167, 139, 250, 0.14);
      }
      .pc-adv-detail__back {
        display: inline-block;
        margin-bottom: 8px;
        padding: 2px 8px;
        font-size: 11px;
        font-weight: 600;
        color: rgba(199, 188, 252, 0.85);
        background: rgba(20, 18, 38, 0.7);
        border: 1px solid rgba(167, 139, 250, 0.24);
        border-radius: 999px;
        cursor: pointer;
      }
      .pc-adv-detail__back:hover {
        background: rgba(31, 23, 56, 0.96);
        border-color: rgba(167, 139, 250, 0.5);
      }
      .pc-adv-detail__id {
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 11px;
        font-weight: 700;
        color: rgba(199, 188, 252, 0.78);
        letter-spacing: 0.04em;
      }
      .pc-adv-detail__title {
        font-size: 16px;
        font-weight: 700;
        line-height: 1.3;
        color: #f7f5ff;
        margin-top: 4px;
      }
      .pc-adv-detail__meta {
        display: flex;
        gap: 10px;
        align-items: center;
        margin-top: 10px;
        flex-wrap: wrap;
      }
      .pc-adv-detail__pill {
        display: inline-block;
        padding: 2px 9px;
        font-size: 10px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        border-radius: 999px;
      }
      .pc-adv-detail__attempts,
      .pc-adv-detail__plan,
      .pc-adv-detail__status,
      .pc-adv-detail__link {
        font-size: 11px;
        color: rgba(220, 214, 248, 0.66);
      }
      .pc-adv-detail__plan,
      .pc-adv-detail__link {
        color: rgba(199, 188, 252, 0.78);
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      }
      .pc-adv-detail__link-btn {
        background: none;
        border: none;
        padding: 0;
        cursor: pointer;
        text-decoration: underline;
        text-underline-offset: 2px;
      }
      .pc-adv-detail__link-btn:hover {
        color: #ddd6fe;
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
        color: rgba(199, 188, 252, 0.72);
      }
      .pc-adv-detail__collapse {
        background: none;
        border: none;
        padding: 0;
        font: inherit;
        text-transform: uppercase;
        letter-spacing: 0.11em;
        color: rgba(199, 188, 252, 0.72);
        cursor: pointer;
      }
      .pc-adv-detail__prose {
        margin: 0;
        font-size: 13px;
        line-height: 1.55;
        white-space: pre-wrap;
        color: #f7f5ff;
      }
      .pc-adv-detail__muted {
        margin: 0;
        font-size: 12px;
        font-style: italic;
        color: rgba(220, 214, 248, 0.5);
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
        color: rgba(220, 214, 248, 0.86);
        background: rgba(20, 18, 38, 0.6);
        border: 1px solid rgba(167, 139, 250, 0.14);
        border-radius: 6px;
        cursor: pointer;
      }
      .pc-adv-detail__related-row:hover {
        background: rgba(31, 23, 56, 0.9);
        border-color: rgba(167, 139, 250, 0.4);
      }
      .pc-adv-detail__related-id {
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 11px;
        color: rgba(199, 188, 252, 0.78);
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
        color: #f7f5ff;
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
        color: #c4b5fd;
        min-width: 80px;
      }
      .pc-adv-detail__run-time {
        color: rgba(220, 214, 248, 0.55);
      }
      .pc-adv-detail__run-cost {
        margin-left: auto;
        color: rgba(220, 214, 248, 0.5);
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      }
      .pc-adv-detail__notes {
        display: flex;
        flex-direction: column;
        gap: 8px;
      }
      .pc-adv-detail__note-row {
        border-left: 2px solid rgba(167, 139, 250, 0.3);
        padding-left: 10px;
      }
      .pc-adv-detail__note-meta {
        font-size: 10px;
        color: rgba(220, 214, 248, 0.5);
        margin-bottom: 2px;
      }
      .pc-adv-detail__note {
        margin: 0;
        font-size: 12px;
        line-height: 1.5;
        white-space: pre-wrap;
        color: #f7f5ff;
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
        background: rgba(20, 18, 38, 0.96);
        color: #f7f5ff;
        border: 1px solid rgba(167, 139, 250, 0.24);
        border-radius: 6px;
      }
      .pc-adv-detail__note-form button {
        align-self: flex-start;
        padding: 5px 12px;
        font-size: 12px;
        font-weight: 600;
        background: rgba(20, 18, 38, 0.7);
        color: #f7f5ff;
        border: 1px solid rgba(167, 139, 250, 0.3);
        border-radius: 6px;
        cursor: pointer;
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
        background: rgba(20, 18, 38, 0.85);
        border: 1px solid rgba(167, 139, 250, 0.18);
        border-radius: 6px;
        color: #f7f5ff;
        white-space: pre-wrap;
        word-break: break-word;
        max-height: 240px;
        overflow: auto;
      }
      .pc-adv-detail__pointer {
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 11px;
        padding: 3px 8px;
        background: rgba(20, 18, 38, 0.85);
        border-radius: 4px;
        color: #f7f5ff;
      }
      .pc-adv-detail__status-row select {
        padding: 6px 10px;
        font-size: 12px;
        background: rgba(20, 18, 38, 0.96);
        color: #f7f5ff;
        border: 1px solid rgba(167, 139, 250, 0.3);
        border-radius: 6px;
        min-width: 160px;
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
        background: rgba(20, 18, 38, 0.7);
        color: #f7f5ff;
        border: 1px solid rgba(167, 139, 250, 0.3);
        border-radius: 6px;
        cursor: pointer;
      }
      .pc-adv-detail__actions button:hover:not(:disabled) {
        background: rgba(31, 23, 56, 0.96);
        border-color: rgba(167, 139, 250, 0.5);
      }
      .pc-adv-detail__actions button:disabled {
        opacity: 0.45;
        cursor: default;
      }
    `}</style>
  );
}
