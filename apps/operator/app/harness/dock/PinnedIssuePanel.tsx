/**
 * PinnedIssuePanel — single-issue detail view, pinnable in the dock.
 *
 * Spec: apps/operator/docs/dockview-migration-plan-v4.md §3.2
 *
 * Data: useHarnessIssues (one-shot REST bootstrap + live
 * issuesConsolidated.bySlug sync overlay), filtered client-side for the
 * one issue — the consolidated row carries every field rendered here. The
 * legacy 10s fetch poll is gone (audit P-058).
 *
 * Params:
 *   harnessSlug: string (required)
 *   issueId:     string (required, "I-NNNN")
 */

'use client';

import { useEffect } from 'react';
import type { PanelComponentProps } from './panel-registry';
import { useHarnessIssues } from '../../adv/harnesses/useHarnessData';
import { LazyDetails } from '../../_components/LazyDetails';

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
  const { issues, error } = useHarnessIssues(slug);
  const issue = issues?.find((x) => x.id === issueId) ?? null;

  useEffect(() => {
    if (issue) {
      api.setTitle(`📌 ${issue.id}: ${issue.title.slice(0, 30)}${issue.title.length > 30 ? '…' : ''}`);
    }
  }, [issue, api]);

  if (!slug || !issueId) {
    return (
      <div style={{ padding: 16, fontSize: 13, color: 'var(--fg-mute)' }}>
        Missing required params: harnessSlug + issueId
      </div>
    );
  }
  if (error)
    return (
      <div style={{ padding: 16, fontSize: 13, color: '#f87171' }}>
        Failed: {error}
      </div>
    );
  if (issues && !issue)
    return (
      <div style={{ padding: 16, fontSize: 13, color: '#f87171' }}>
        Issue {issueId} not found in {slug}
      </div>
    );
  if (!issue)
    return (
      <div style={{ padding: 16, fontSize: 13, color: 'var(--fg-mute)' }}>
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
        color: 'var(--fg)',
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
            color: 'var(--fg-mute)',
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
          <span style={{ fontSize: 10, color: 'var(--fg-mute)' }}>
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
        <LazyDetails
          style={{ marginTop: 8 }}
          summaryStyle={{ cursor: 'pointer', color: 'var(--fg-mute)', fontSize: 11 }}
          summary={`notes (${issue.notes.length})`}
        >
          <pre
            style={{
              margin: '4px 0 0',
              padding: 8,
              background: 'var(--bg-2)',
              fontSize: 11,
              borderRadius: 3,
              overflowX: 'auto',
            }}
          >
            {JSON.stringify(issue.notes, null, 2)}
          </pre>
        </LazyDetails>
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
        color: 'var(--fg-mute)',
        borderTop: '1px solid var(--border)',
      }}
    >
      <span style={{ minWidth: 100, color: 'var(--fg-mute)' }}>{label}</span>
      <span style={{ flex: 1, fontFamily: 'ui-monospace, monospace', wordBreak: 'break-word' }}>
        {value}
      </span>
    </div>
  );
}

function Section({ label, body }: { label: string; body: string }) {
  return (
    <LazyDetails
      style={{ marginTop: 8 }}
      defaultOpen
      summaryStyle={{ cursor: 'pointer', color: 'var(--fg-mute)', fontSize: 11, fontWeight: 600 }}
      summary={label}
    >
      <pre
        style={{
          margin: '4px 0 0',
          padding: 8,
          background: 'var(--bg-2)',
          fontSize: 11,
          borderRadius: 3,
          whiteSpace: 'pre-wrap',
          color: 'var(--fg)',
        }}
      >
        {body}
      </pre>
    </LazyDetails>
  );
}
