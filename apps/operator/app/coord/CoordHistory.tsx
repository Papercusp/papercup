'use client';

/**
 * /coord — coordination history viewer (Phase B remainder of
 * agent-coordination-architecture-v2).
 *
 * Single page; polls /api/coord/history every 5s. Filters:
 *
 *   - source (plan_event / message / escalation / handoff)
 *   - plan_slug (free-text exact-match)
 *   - owner   (matches from/to/'*' on messages + handoffs)
 *
 * State lives in nuqs (URL-backed) so a particular filter view is
 * shareable / bookmarkable, per the operator's app-wide convention.
 */

import { useQueryState, parseAsArrayOf, parseAsString } from 'nuqs';
import { useCallback, useEffect, useMemo, useState } from 'react';
import styles from './coord.module.css';

interface HistoryItem {
  ts: string;
  msg_id: string;
  source: 'plan_event' | 'message' | 'escalation' | 'handoff';
  kind: string;
  from?: string;
  to?: string[];
  plan_slug?: string;
  harness_slug?: string;
  summary?: string;
  payload: Record<string, unknown>;
}

interface HistoryResponse {
  items: HistoryItem[];
  total: number;
  truncated: boolean;
}

const ALL_SOURCES: HistoryItem['source'][] = [
  'plan_event',
  'message',
  'escalation',
  'handoff',
];

const SOURCE_LABEL: Record<HistoryItem['source'], string> = {
  plan_event: 'Plan event',
  message: 'Message',
  escalation: 'Escalation',
  handoff: 'Handoff',
};

const SOURCE_BADGE: Record<HistoryItem['source'], string> = {
  plan_event: styles.sourceBadgePlanEvent,
  message: styles.sourceBadgeMessage,
  escalation: styles.sourceBadgeEscalation,
  handoff: styles.sourceBadgeHandoff,
};

function cx(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(' ');
}

export default function CoordHistory() {
  const [sources, setSources] = useQueryState<string[]>(
    'sources',
    parseAsArrayOf(parseAsString).withDefault([...ALL_SOURCES]),
  );
  const [planSlug, setPlanSlug] = useQueryState('plan_slug', parseAsString.withDefault(''));
  const [owner, setOwner] = useQueryState('owner', parseAsString.withDefault(''));
  const [expanded, setExpanded] = useState<string | null>(null);

  const [data, setData] = useState<HistoryResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const queryString = useMemo(() => {
    const params = new URLSearchParams();
    if (sources && sources.length > 0 && sources.length < ALL_SOURCES.length) {
      params.set('kinds', sources.join(','));
    }
    if (planSlug) params.set('plan_slug', planSlug);
    if (owner) params.set('owner', owner);
    params.set('limit', '200');
    return params.toString();
  }, [sources, planSlug, owner]);

  // In-flight request is aborted on filter change/unmount so a slow stale
  // response can never clobber a newer one (audit P-064 poll race).
  const refresh = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch(`/api/coord/history?${queryString}`, { signal });
      if (!r.ok) throw new Error(`status ${r.status}`);
      const j = (await r.json()) as HistoryResponse;
      setData(j);
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return;
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [queryString]);

  // Documented polling exception (audit P-058): coord_event_log — the
  // fleet's highest-write table — has no emit_change_notify trigger, so
  // there is no sync invalidation to subscribe to (dev.coordFeed exists in
  // the resolver but nothing fires it). Attaching a per-row NOTIFY trigger
  // there is an owner-gated trade-off; until then this dev viewer polls 5s
  // while visible and pauses when the tab is hidden.
  useEffect(() => {
    let controller = new AbortController();
    void refresh(controller.signal);
    const tick = () => {
      if (document.visibilityState === 'hidden') return;
      controller.abort();
      controller = new AbortController();
      void refresh(controller.signal);
    };
    const id = window.setInterval(tick, 5000);
    const onVisible = () => {
      if (document.visibilityState === 'visible') tick();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      controller.abort();
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [refresh]);

  const toggleSource = (s: HistoryItem['source']) => {
    const cur = new Set(sources ?? ALL_SOURCES);
    if (cur.has(s)) cur.delete(s);
    else cur.add(s);
    setSources(cur.size === 0 ? [...ALL_SOURCES] : [...cur]);
  };

  const items = data?.items ?? [];

  return (
    <div>
      <div className={styles.toolbar}>
        <button
          onClick={() => void refresh()}
          className={styles.button}
          disabled={loading}
        >
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      <div className={styles.filterBar}>
        <div className={styles.filterGroup}>
          <span className={styles.filterLabel}>Sources</span>
          {ALL_SOURCES.map((s) => {
            const active = (sources ?? ALL_SOURCES).includes(s);
            return (
              <button
                key={s}
                onClick={() => toggleSource(s)}
                className={cx(
                  styles.sourcePill,
                  active ? SOURCE_BADGE[s] : styles.sourcePillInactive,
                )}
              >
                {SOURCE_LABEL[s]}
              </button>
            );
          })}
        </div>
        <label className={styles.filterControl}>
          <span className={styles.filterLabel}>plan_slug</span>
          <input
            value={planSlug ?? ''}
            onChange={(e) => setPlanSlug(e.target.value || null)}
            className={styles.filterInput}
            placeholder="(any)"
          />
        </label>
        <label className={styles.filterControl}>
          <span className={styles.filterLabel}>owner</span>
          <input
            value={owner ?? ''}
            onChange={(e) => setOwner(e.target.value || null)}
            className={styles.filterInput}
            placeholder="(any)"
          />
        </label>
        {data && (
          <span className={styles.resultCount}>
            {items.length} of {data.total}
            {data.truncated && ' (truncated)'}
          </span>
        )}
      </div>

      {error && (
        <div className={styles.alert}>
          Error: {error}
        </div>
      )}

      <ul className={styles.listCompact}>
        {items.length === 0 && !loading && (
          <li className={cx(styles.cardRow, styles.cardRowPadded, styles.emptyCopy)}>
            No coordination events match these filters.
          </li>
        )}
        {items.map((it) => {
          const key = `${it.source}:${it.msg_id}`;
          const isOpen = expanded === key;
          return (
            <li
              key={key}
              className={styles.cardRow}
            >
              <button
                onClick={() => setExpanded(isOpen ? null : key)}
                className={styles.eventButton}
              >
                <span
                  className={cx(styles.kindBadge, SOURCE_BADGE[it.source])}
                >
                  {it.kind}
                </span>
                <div className={styles.contentColumn}>
                  <div className={styles.eventTitleRow}>
                    <span className={styles.eventSummary}>
                      {it.summary ?? '—'}
                    </span>
                    {it.plan_slug && (
                      <span className={styles.miniBadge}>
                        plan: {it.plan_slug}
                      </span>
                    )}
                  </div>
                  <div className={styles.rowMeta}>
                    {new Date(it.ts).toLocaleString()}
                    {it.from && ` · from ${it.from}`}
                    {it.to && it.to.length > 0 && ` · to ${it.to.join(', ')}`}
                  </div>
                </div>
              </button>
              {isOpen && (
                <pre className={cx(styles.payloadPre, styles.historyPayload)}>
{JSON.stringify(it.payload, null, 2)}
                </pre>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
