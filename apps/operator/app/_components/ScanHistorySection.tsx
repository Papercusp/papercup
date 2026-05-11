'use client';

/**
 * Scan history tab in the operator panel main section.
 *
 * Lists past Operator scans (newest first) with a one-line summary
 * and the count of suggestions emitted. Click a row to expand and
 * see all suggestions from that scan + the request text + cost.
 *
 * Server-side persistence is in `harness_shared.operator_scans` —
 * see lib/operator-scans.ts and the operator-scan route's done/error
 * handlers that write the row.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useSyncQuery } from '@restart/sync';
import { useWorkspaceId } from '@/lib/use-workspace-id';

interface ScanRow {
  id: number;
  workspaceId: string;
  startedAt: string;
  endedAt: string | null;
  agentSessionId: string | null;
  requestText: string | null;
  summary: string | null;
  suggestions: Array<Record<string, unknown>>;
  suggestionCount: number;
  costUsd: number;
  cached: boolean;
  error: string | null;
}

interface ScanZeroRow {
  id: number;
  workspaceId: string;
  startedAt: number;
  endedAt: number | null;
  agentSessionId: string | null;
  requestText: string | null;
  summary: string | null;
  suggestions: Array<Record<string, unknown>>;
  suggestionCount: number;
  costUsd: number;
  cached: boolean;
  error: string | null;
}

function fmtAge(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '';
  const m = Math.round(ms / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

function fmtCost(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) return '';
  if (usd < 0.01) return '<$0.01';
  return `$${usd.toFixed(2)}`;
}

export default function ScanHistorySection(): JSX.Element {
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const workspaceId = useWorkspaceId();

  // Operator scan history streams from harness_shared.operator_scans via Zero.
  // The 60s REST poll is gone; the SSE-bridged 'operator:scan-complete' event
  // is also redundant now (the new row appears via WS push) but leaving the
  // listener wire in place is harmless.
  const { data: zeroRows, loading } = useSyncQuery<ScanZeroRow>({
    queryName: 'operatorScans.byWorkspace',
    args: { workspaceId, limit: 50 },
  });

  const rows: ScanRow[] = useMemo(() => {
    if (!Array.isArray(zeroRows)) return [];
    return zeroRows.map((r) => ({
      id: r.id,
      workspaceId: r.workspaceId,
      startedAt: r.startedAt ? new Date(r.startedAt).toISOString() : '',
      endedAt: r.endedAt ? new Date(r.endedAt).toISOString() : null,
      agentSessionId: r.agentSessionId,
      requestText: r.requestText,
      summary: r.summary,
      suggestions: Array.isArray(r.suggestions) ? r.suggestions : [],
      suggestionCount: r.suggestionCount,
      costUsd: r.costUsd,
      cached: r.cached,
      error: r.error,
    }));
  }, [zeroRows]);

  const error: string | null = null; // Zero handles transport errors transparently

  const expanded = useMemo(
    () => rows.find((r) => r.id === expandedId) ?? null,
    [rows, expandedId],
  );

  if (loading) return <p className="operator-empty-small">Loading scan history…</p>;
  if (error) {
    return (
      <p className="operator-empty-small">
        Couldn't load scan history: {error}.
      </p>
    );
  }
  if (rows.length === 0) {
    return (
      <p className="operator-empty-small">
        No scans yet. Run a scan from the operator button or wait for the next
        background tick.
      </p>
    );
  }

  return (
    <section className="operator-section operator-scan-history">
      <ul role="list" className="operator-scan-history__list">
        {rows.map((s) => {
          const isOpen = s.id === expandedId;
          const errored = !!s.error;
          const isCached = s.cached;
          const summary = errored
            ? `Scan errored: ${s.error}`
            : (s.summary ?? `${s.suggestionCount} suggestion${s.suggestionCount === 1 ? '' : 's'}`);
          return (
            <li
              key={s.id}
              className="operator-scan-history__item"
              data-open={isOpen}
              data-errored={errored}
              data-cached={isCached}
            >
              <button
                type="button"
                className="operator-scan-history__row"
                onClick={() => setExpandedId(isOpen ? null : s.id)}
                aria-expanded={isOpen}
              >
                <span className="operator-scan-history__title">{summary}</span>
                <span className="operator-scan-history__meta">
                  {isCached ? 'cached · ' : ''}
                  {s.suggestionCount}c
                  {fmtCost(s.costUsd) ? ` · ${fmtCost(s.costUsd)}` : ''}
                  {' · '}{fmtAge(s.startedAt)}
                </span>
              </button>
              {isOpen && expanded && expanded.id === s.id && (
                <div className="operator-scan-history__body">
                  {s.requestText && (
                    <p className="operator-scan-history__request">
                      <strong>Request:</strong> {s.requestText}
                    </p>
                  )}
                  {s.summary && !errored && (
                    <p className="operator-scan-history__summary">{s.summary}</p>
                  )}
                  {s.error && (
                    <pre className="operator-scan-history__error">{s.error}</pre>
                  )}
                  {expanded.suggestions.length > 0 && (
                    <div className="operator-scan-history__cards">
                      <p className="operator-scan-history__cards-label">
                        Cards emitted ({expanded.suggestions.length})
                      </p>
                      <ul role="list">
                        {expanded.suggestions.map((c, i) => {
                          const card = c as any;
                          return (
                            <li key={card.id ?? i}>
                              <strong>{card.title ?? '(untitled)'}</strong>
                              {card.actualTier && (
                                <span className={`operator-scan-history__tier tier-${card.actualTier}`}>
                                  {card.actualTier}
                                </span>
                              )}
                              {card.reason && <span className="operator-scan-history__reason"> — {card.reason}</span>}
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
