/**
 * PinnedIssuePanel — single-issue detail view, pinnable in the dock.
 *
 * Spec: apps/operator/docs/dockview-migration-plan-v4.md §3.2
 *
 * Backed by /api/harness/<slug>/issues-list (filtered client-side for
 * the one issue). Auto-refresh 10s.
 *
 * Params:
 *   harnessSlug: string (required)
 *   issueId:     string (required, "I-NNNN")
 */

'use client';

import { useEffect, useState } from 'react';
import type { PanelComponentProps } from './panel-registry';

interface Issue {
  id: string;
  title: string;
  severity?: string;
  status?: string;
  source?: string;
  foundAt?: string;
  evidence?: string | null;
  repro?: string | null;
  suggestedFix?: string | null;
  codePointer?: string | null;
  linkedFeatureId?: string | null;
  attempts?: number;
  notes?: Array<unknown>;
}

interface IssuesResponse {
  issues: Issue[];
}

const SEVERITY_COLORS: Record<string, string> = {
  critical: '#dc2626',
  major: '#ea580c',
  minor: '#fbbf24',
  trivial: '#94a3b8',
};

const STATUS_COLORS: Record<string, string> = {
  open: '#f87171',
  triaged: '#fbbf24',
  fixing: '#60a5fa',
  fixed: 'var(--good)',
  closed: '#71717a',
  duplicate: '#71717a',
};

export function PinnedIssuePanel({ params, api }: PanelComponentProps) {
  const slug = (params.harnessSlug as string) || '';
  const issueId = (params.issueId as string) || '';
  const [issue, setIssue] = useState<Issue | null>(null);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (!slug || !issueId) return;
    setError(null);
    let cancel = false;
    const load = async () => {
      try {
        const r = await fetch(`/api/harness/${encodeURIComponent(slug)}/issues-list`);
        if (!r.ok) throw new Error(`status ${r.status}`);
        const j: IssuesResponse = await r.json();
        if (cancel) return;
        const i = j.issues.find((x) => x.id === issueId);
        if (!i) {
          setError(new Error(`Issue ${issueId} not found in ${slug}`));
          return;
        }
        setIssue(i);
        api.setTitle(`📌 ${i.id}: ${i.title.slice(0, 30)}${i.title.length > 30 ? '…' : ''}`);
      } catch (e) {
        if (cancel) return;
        setError(e as Error);
      }
    };
    load();
    const id = setInterval(load, 10_000);
    return () => {
      cancel = true;
      clearInterval(id);
    };
  }, [slug, issueId, api]);

  if (!slug || !issueId) {
    return (
      <div style={{ padding: 16, fontSize: 13, color: 'var(--muted-foreground,#888)' }}>
        Missing required params: harnessSlug + issueId
      </div>
    );
  }
  if (error)
    return (
      <div style={{ padding: 16, fontSize: 13, color: '#f87171' }}>
        Failed: {error.message}
      </div>
    );
  if (!issue)
    return (
      <div style={{ padding: 16, fontSize: 13, color: 'var(--muted-foreground,#888)' }}>
        Loading {issueId}…
      </div>
    );

  return (
    <div
      style={{
        padding: 16,
        height: '100%',
        overflow: 'auto',
        fontSize: 12,
        color: 'var(--foreground,#ccc)',
        fontFamily: 'system-ui, sans-serif',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 8 }}>
        <span
          style={{
            width: 6,
            height: 18,
            borderRadius: 1,
            background: SEVERITY_COLORS[issue.severity ?? ''] ?? '#444',
            flexShrink: 0,
          }}
          title={`severity: ${issue.severity ?? 'unknown'}`}
        />
        <span
          style={{
            fontFamily: 'ui-monospace, monospace',
            fontSize: 11,
            color: 'var(--muted-foreground,#888)',
          }}
        >
          {issue.id}
        </span>
        <span
          style={{
            fontSize: 10,
            padding: '1px 5px',
            background: STATUS_COLORS[issue.status ?? ''] ?? '#333',
            color: '#111',
            borderRadius: 2,
          }}
        >
          {issue.status ?? '?'}
        </span>
        {issue.source && (
          <span style={{ fontSize: 10, color: 'var(--muted-foreground,#888)' }}>
            {issue.source}
          </span>
        )}
      </div>
      <h3 style={{ margin: '0 0 12px', fontSize: 14, fontWeight: 600, lineHeight: 1.3 }}>
        {issue.title}
      </h3>
      {issue.attempts !== undefined && (
        <Row label="attempts" value={String(issue.attempts)} />
      )}
      {issue.linkedFeatureId && <Row label="linked feature" value={issue.linkedFeatureId} />}
      {issue.codePointer && <Row label="code pointer" value={issue.codePointer} />}
      {issue.foundAt && <Row label="found at" value={issue.foundAt} />}
      {issue.repro && <Section label="Reproduction" body={issue.repro} />}
      {issue.evidence && <Section label="Evidence" body={issue.evidence} />}
      {issue.suggestedFix && <Section label="Suggested fix" body={issue.suggestedFix} />}
      {issue.notes && issue.notes.length > 0 && (
        <details style={{ marginTop: 8 }}>
          <summary
            style={{
              cursor: 'pointer',
              color: 'var(--muted-foreground,#888)',
              fontSize: 11,
            }}
          >
            notes ({issue.notes.length})
          </summary>
          <pre
            style={{
              margin: '4px 0 0',
              padding: 8,
              background: 'var(--card,#1a1a1a)',
              fontSize: 11,
              borderRadius: 3,
              overflowX: 'auto',
            }}
          >
            {JSON.stringify(issue.notes, null, 2)}
          </pre>
        </details>
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div
      style={{
        display: 'flex',
        gap: 8,
        padding: '3px 0',
        fontSize: 11,
        color: 'var(--muted-foreground,#aaa)',
        borderTop: '1px solid var(--border-subtle,#222)',
      }}
    >
      <span style={{ minWidth: 100, color: 'var(--muted-foreground,#888)' }}>{label}</span>
      <span style={{ flex: 1, fontFamily: 'ui-monospace, monospace', wordBreak: 'break-word' }}>
        {value}
      </span>
    </div>
  );
}

function Section({ label, body }: { label: string; body: string }) {
  return (
    <details style={{ marginTop: 8 }} open>
      <summary
        style={{
          cursor: 'pointer',
          color: 'var(--muted-foreground,#888)',
          fontSize: 11,
          fontWeight: 600,
        }}
      >
        {label}
      </summary>
      <pre
        style={{
          margin: '4px 0 0',
          padding: 8,
          background: 'var(--card,#1a1a1a)',
          fontSize: 11,
          borderRadius: 3,
          whiteSpace: 'pre-wrap',
          color: 'var(--foreground,#ccc)',
        }}
      >
        {body}
      </pre>
    </details>
  );
}
