'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { parseAsString, useQueryState } from 'nuqs';
import { toast } from 'sonner';
import type { PanelComponentProps } from '../../harness/dock/panel-registry';
import type { Issue, IssueSeverity, IssueStatus } from '../../harness/issues/types';
import { useHarnessFeatures, useHarnessIssues, type FeatureStatus, type HarnessFeature } from './useHarnessData';

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
  const [urlSel] = useQueryState('sel', parseAsString.withDefault(''));
  const selectedId = pinnedId ?? urlSel;

  // Phase 3: live data via Zero (REST bootstrap + Zero overlay), no polling.
  // The Features/Issues panels subscribe to the same queries → Zero dedups.
  const { features } = useHarnessFeatures(slug);
  const { issues } = useHarnessIssues(slug);

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

  if (feature) return <FeatureDetail slug={slug} feature={feature} />;
  if (issue) return <IssueDetail slug={slug} issue={issue} />;
  return null;
}

function FeatureDetail({ slug, feature }: { slug: string; feature: HarnessFeature }) {
  const [working, setWorking] = useState<string | null>(null);

  const tone = STATUS_TONE[feature.status] ?? STATUS_TONE.todo;

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
      setWorking(`status:${next}`);
      try {
        await callJson(`/features/${feature.id}?phase=staging`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ status: next }),
        });
        toast.success(`${feature.id} → ${next}`);
      } catch (e) {
        toast.error('Status change failed', { description: String(e) });
      } finally {
        setWorking(null);
      }
    },
    [callJson, feature.id],
  );

  const resetFeature = useCallback(async () => {
    if (!window.confirm(`Reset ${feature.id} back to todo?`)) return;
    setWorking('reset');
    try {
      await callJson(`/features/${feature.id}/reset?phase=staging`, { method: 'POST' });
      toast.success(`${feature.id} reset`);
    } catch (e) {
      toast.error('Reset failed', { description: String(e) });
    } finally {
      setWorking(null);
    }
  }, [callJson, feature.id]);

  return (
    <div className="pc-adv-detail">
      <header className="pc-adv-detail__header">
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

function IssueDetail({ slug, issue }: { slug: string; issue: Issue }) {
  const [working, setWorking] = useState<string | null>(null);
  const sevTone = SEVERITY_TONE[issue.severity] ?? SEVERITY_TONE.minor;

  const runAction = useCallback(
    async (action: 'promote' | 'acknowledge' | 'close' | 'wontfix') => {
      setWorking(action);
      try {
        const body = action === 'promote' ? {} : { status: action === 'acknowledge' ? 'acknowledged' : action };
        const res = await fetch(
          `/api/harness/${encodeURIComponent(slug)}/issues/${encodeURIComponent(issue.id)}/${
            action === 'promote' ? 'promote' : 'update'
          }`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          },
        );
        if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
        toast.success(`${issue.id} → ${action}`);
      } catch (e) {
        toast.error(`${action} failed`, { description: String(e) });
      } finally {
        setWorking(null);
      }
    },
    [slug, issue.id],
  );

  return (
    <div className="pc-adv-detail">
      <header className="pc-adv-detail__header">
        <div className="pc-adv-detail__id">{issue.id}</div>
        <div className="pc-adv-detail__title">{issue.title}</div>
        <div className="pc-adv-detail__meta">
          <span className="pc-adv-detail__pill" style={{ background: sevTone.bg, color: sevTone.fg }}>
            {issue.severity}
          </span>
          <span className="pc-adv-detail__status">{issue.status}</span>
          {issue.linkedFeatureId && (
            <span className="pc-adv-detail__link" title={`Linked feature: ${issue.linkedFeatureId}`}>
              ↗ {issue.linkedFeatureId}
            </span>
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
