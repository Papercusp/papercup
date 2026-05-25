'use client';

/**
 * ClaimAttemptTimeline — Phase 6 P-039b.
 *
 * Plan: papercusp-dogfood-phase6-orchestrator-claim-2026-05-24.
 *
 * Renders the last N claim attempts for a harness — feature_id, who
 * claimed it, outcome (won / lost / error), timestamp, optional detail
 * line. Pure UI; the client wrapper fetches /api/harness/:slug/claim-
 * attempts (no `?stats=1`) and feeds the rows in.
 *
 * Read-only diagnostic surface. Today the orchestrator's pre-dispatch
 * P-037 fetch is observability-only, so the table fills with `won`
 * rows when the substrate is booted + `PAPERCUSP_GITHUB_USER_ID` is
 * set. Once multi-engineer contention exists the rows will show real
 * `lost` outcomes with winner pubkeys.
 */

import type { CSSProperties, ReactNode } from 'react';

export interface ClaimAttemptDisplayRow {
  id: number;
  feature_id: string;
  claimer_pubkey: string;
  claimer_github_user_id: number;
  /** Epoch ms. */
  ts: number;
  outcome: 'won' | 'lost' | 'error' | string;
  detail: string | null;
}

export interface ClaimAttemptTimelineProps {
  attempts: ClaimAttemptDisplayRow[];
  /** Highlight rows whose outcome matches this filter (empty = no filter). */
  highlightOutcome?: 'won' | 'lost' | 'error';
  /** Loading flag — defer empty-state text until at least one fetch resolved. */
  loaded?: boolean;
}

const WRAP: CSSProperties = {
  border: '1px solid var(--border, #2a2a2a)',
  borderRadius: 8,
  background: 'var(--surface, #1a1a1a)',
  fontSize: 12,
  color: 'var(--fg, #ddd)',
  overflow: 'hidden',
};

const HEADER: CSSProperties = {
  padding: '8px 12px',
  borderBottom: '1px solid var(--border, #2a2a2a)',
  fontWeight: 600,
  fontSize: 13,
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
};

const COUNT_PILL: CSSProperties = {
  fontSize: 11,
  fontWeight: 400,
  color: 'var(--fg-dim, #888)',
};

const TABLE: CSSProperties = {
  width: '100%',
  borderCollapse: 'collapse',
};

const TH: CSSProperties = {
  textAlign: 'left',
  padding: '6px 12px',
  borderBottom: '1px solid var(--border, #2a2a2a)',
  fontWeight: 500,
  color: 'var(--fg-dim, #aaa)',
  fontSize: 11,
};

const TD: CSSProperties = {
  padding: '6px 12px',
  borderBottom: '1px solid var(--border-dim, #2222)',
  verticalAlign: 'top',
  fontFamily: 'inherit',
};

const TD_MONO: CSSProperties = {
  ...TD,
  fontFamily: 'ui-monospace, SF Mono, Menlo, monospace',
  fontSize: 11,
  color: 'var(--fg-dim, #aaa)',
};

const OUTCOME_PILL_BASE: CSSProperties = {
  display: 'inline-block',
  padding: '0px 6px',
  borderRadius: 4,
  fontSize: 11,
  fontWeight: 500,
  textTransform: 'uppercase',
  letterSpacing: 0.5,
};

const OUTCOME_STYLES: Record<string, CSSProperties> = {
  won: { ...OUTCOME_PILL_BASE, background: 'rgba(40,140,80,0.18)', color: '#6ec98c' },
  lost: { ...OUTCOME_PILL_BASE, background: 'rgba(180,80,80,0.18)', color: '#d68a8a' },
  error: { ...OUTCOME_PILL_BASE, background: 'rgba(180,140,60,0.18)', color: '#d6c08a' },
};

const EMPTY: CSSProperties = {
  padding: 16,
  color: 'var(--fg-dim, #888)',
  fontStyle: 'italic',
  fontSize: 12,
};

function fmtTime(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  try {
    return new Date(ms).toLocaleTimeString();
  } catch {
    return String(ms);
  }
}

function shortPubkey(p: string): string {
  if (!p) return '—';
  if (p.length <= 12) return p;
  return `${p.slice(0, 8)}…${p.slice(-4)}`;
}

function outcomeStyle(outcome: string): CSSProperties {
  return OUTCOME_STYLES[outcome] ?? OUTCOME_PILL_BASE;
}

export function ClaimAttemptTimeline(props: ClaimAttemptTimelineProps): ReactNode {
  const attempts = props.attempts ?? [];
  return (
    <div data-testid="claim-attempt-timeline" style={WRAP}>
      <div style={HEADER}>
        <span>Claim attempts</span>
        <span style={COUNT_PILL}>{attempts.length} recent</span>
      </div>
      {attempts.length === 0 ? (
        <div data-testid="claim-attempt-timeline-empty" style={EMPTY}>
          {props.loaded === false
            ? 'Loading…'
            : 'No claim attempts recorded yet. Substrate may be off, or the orchestrator has not dispatched a worker on a feature claim this run.'}
        </div>
      ) : (
        <table style={TABLE}>
          <thead>
            <tr>
              <th style={TH}>Feature</th>
              <th style={TH}>Claimer</th>
              <th style={TH}>Outcome</th>
              <th style={TH}>When</th>
              <th style={TH}>Detail</th>
            </tr>
          </thead>
          <tbody>
            {attempts.map((row) => {
              const highlighted =
                props.highlightOutcome !== undefined &&
                row.outcome === props.highlightOutcome;
              return (
                <tr
                  key={row.id}
                  data-testid={`claim-attempt-row-${row.id}`}
                  data-outcome={row.outcome}
                  style={
                    highlighted
                      ? { background: 'rgba(80, 120, 200, 0.06)' }
                      : undefined
                  }
                >
                  <td style={TD_MONO}>{row.feature_id}</td>
                  <td style={TD_MONO} title={row.claimer_pubkey}>
                    @{row.claimer_github_user_id || '?'} ·{' '}
                    {shortPubkey(row.claimer_pubkey)}
                  </td>
                  <td style={TD}>
                    <span style={outcomeStyle(row.outcome)}>{row.outcome}</span>
                  </td>
                  <td style={TD_MONO}>{fmtTime(row.ts)}</td>
                  <td style={TD}>{row.detail ?? ''}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
