'use client';

/**
 * /coord — coordination history viewer (Phase B remainder of
 * agent-coordination-architecture-v2).
 *
 * Single page; subscribes to the coord.history projection. Filters:
 *
 *   - source (plan_event / message / escalation / handoff)
 *   - plan_slug (free-text exact-match)
 *   - owner   (matches from/to/'*' on messages + handoffs)
 *
 * State lives in nuqs (URL-backed) so a particular filter view is
 * shareable / bookmarkable, per the operator's app-wide convention.
 */

import { useQueryState, parseAsArrayOf, parseAsString } from 'nuqs';
import { useState } from 'react';
import { useSyncQuery } from '@papercusp/sync';
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

  const historySync = useSyncQuery<HistoryItem>({
    queryName: 'coord.history',
    args: {
      kinds: sources && sources.length < ALL_SOURCES.length ? sources : undefined,
      planSlug: planSlug || undefined,
      owner: owner || undefined,
      limit: 200,
    },
    staleTime: 30_000,
  });
  const loading = historySync.loading || historySync.fetching;
  const error = historySync.error?.message ?? null;

  const toggleSource = (s: HistoryItem['source']) => {
    const cur = new Set(sources ?? ALL_SOURCES);
    if (cur.has(s)) cur.delete(s);
    else cur.add(s);
    setSources(cur.size === 0 ? [...ALL_SOURCES] : [...cur]);
  };

  const items = historySync.data ?? [];

  return (
    <div>
      <div className={styles.toolbar}>
        <button
          onClick={historySync.invalidate}
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
        {!historySync.loading && (
          <span className={styles.resultCount}>
            {items.length} events
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
