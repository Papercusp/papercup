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
  plan_event: 'bg-blue-900/40 text-blue-200',
  message: 'bg-slate-700/50 text-slate-200',
  escalation: 'bg-amber-900/50 text-amber-200',
  handoff: 'bg-emerald-900/50 text-emerald-200',
};

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
    <div className="text-slate-100">
      <div className="mb-3 flex justify-end">
        <button
          onClick={() => void refresh()}
          className="rounded bg-slate-700 px-3 py-1 text-sm hover:bg-slate-600 disabled:opacity-50"
          disabled={loading}
        >
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-3 rounded border border-slate-700 bg-slate-900/50 p-3">
        <div className="flex items-center gap-2">
          <span className="text-xs text-slate-400">Sources</span>
          {ALL_SOURCES.map((s) => {
            const active = (sources ?? ALL_SOURCES).includes(s);
            return (
              <button
                key={s}
                onClick={() => toggleSource(s)}
                className={
                  'rounded-full px-2 py-0.5 text-xs ' +
                  (active
                    ? SOURCE_BADGE[s]
                    : 'bg-slate-800 text-slate-500 hover:text-slate-300')
                }
              >
                {SOURCE_LABEL[s]}
              </button>
            );
          })}
        </div>
        <label className="flex items-center gap-1 text-xs">
          <span className="text-slate-400">plan_slug</span>
          <input
            value={planSlug ?? ''}
            onChange={(e) => setPlanSlug(e.target.value || null)}
            className="rounded border border-slate-700 bg-slate-900 px-2 py-0.5 text-xs text-slate-100"
            placeholder="(any)"
          />
        </label>
        <label className="flex items-center gap-1 text-xs">
          <span className="text-slate-400">owner</span>
          <input
            value={owner ?? ''}
            onChange={(e) => setOwner(e.target.value || null)}
            className="rounded border border-slate-700 bg-slate-900 px-2 py-0.5 text-xs text-slate-100"
            placeholder="(any)"
          />
        </label>
        {data && (
          <span className="text-xs text-slate-500">
            {items.length} of {data.total}
            {data.truncated && ' (truncated)'}
          </span>
        )}
      </div>

      {error && (
        <div className="mb-3 rounded border border-rose-900 bg-rose-950/40 p-3 text-sm text-rose-200">
          Error: {error}
        </div>
      )}

      <ul className="space-y-2">
        {items.length === 0 && !loading && (
          <li className="rounded border border-slate-800 bg-slate-900/30 p-4 text-sm text-slate-500">
            No coordination events match these filters.
          </li>
        )}
        {items.map((it) => {
          const key = `${it.source}:${it.msg_id}`;
          const isOpen = expanded === key;
          return (
            <li
              key={key}
              className="rounded border border-slate-800 bg-slate-900/40"
            >
              <button
                onClick={() => setExpanded(isOpen ? null : key)}
                className="flex w-full items-start gap-3 px-3 py-2 text-left hover:bg-slate-800/30"
              >
                <span
                  className={
                    'shrink-0 rounded-full px-2 py-0.5 text-[10px] uppercase tracking-wider ' +
                    SOURCE_BADGE[it.source]
                  }
                >
                  {it.kind}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2">
                    <span className="truncate text-sm text-slate-200">
                      {it.summary ?? '—'}
                    </span>
                    {it.plan_slug && (
                      <span className="shrink-0 rounded bg-slate-800 px-1.5 py-0.5 text-[10px] text-slate-400">
                        plan: {it.plan_slug}
                      </span>
                    )}
                  </div>
                  <div className="mt-0.5 text-xs text-slate-500">
                    {new Date(it.ts).toLocaleString()}
                    {it.from && ` · from ${it.from}`}
                    {it.to && it.to.length > 0 && ` · to ${it.to.join(', ')}`}
                  </div>
                </div>
              </button>
              {isOpen && (
                <pre className="overflow-x-auto border-t border-slate-800 bg-slate-950/60 px-3 py-2 text-[11px] text-slate-300">
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
