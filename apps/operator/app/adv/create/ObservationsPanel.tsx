'use client';

/**
 * create:observations — the Observations browse pane (turn-end-reflection-
 * observations-2026-06-14 P-043 / D-005).
 *
 * PRE-IDEA sensor readings agents record at the END of a turn (the reflection
 * step), filed in the SEPARATE observation lane. This pane is BROWSE-ONLY:
 * observations never enter the work/triage queue (that is the whole point), so
 * there is deliberately NO triage / dispatch / claim affordance here. Data is
 * the `learning.observations` sync resolver (newest first); the only path from
 * an observation to actual work is Scout clustering a RECURRING one and
 * promoting it to a real idea — never from this surface.
 */

import { useSyncQuery } from '@papercusp/sync';
import type { PanelComponentProps } from '@/app/harness/dock/panel-registry';
import { useItemPlanFilter } from './use-create-data';

interface ObservationRow {
  id: string;
  title: string;
  body: string | null;
  kind: string | null;
  scope: string | null;
  confidence: string | null;
  refs: string[];
  sourceRole: string | null;
  createdAt: string;
}

const KIND_LABEL: Record<string, string> = {
  friction: 'Friction',
  workaround: 'Workaround',
  gap: 'Gap',
  surprise: 'Surprise',
  reinforce: 'Reinforce',
};

// Browse-feed fetch cap. The resolver counts a topic-filtered set by RE-listing
// (countIssues({topic}) does a full second list), so carrying an exact total via
// attachListMeta isn't cheap here — instead we show an honest "newest N" note
// when the read fills the cap, rather than silently presenting the page as all.
const OBSERVATIONS_LIMIT = 200;

export default function ObservationsPanel(_props?: Partial<PanelComponentProps>) {
  const [itemPlans] = useItemPlanFilter();
  const { data, loading } = useSyncQuery<ObservationRow>({
    queryName: 'learning.observations',
    args: { limit: OBSERVATIONS_LIMIT },
  });
  const allRows = data ?? [];
  const rows = itemPlans.length
    ? allRows.filter((row) => observationMatchesPlan(row, itemPlans))
    : allRows;
  // When the feed exactly fills the cap, there may be older observations not
  // shown — say so instead of letting `rows.length` read as the true total.
  const capped = !itemPlans.length && rows.length >= OBSERVATIONS_LIMIT;

  return (
    <div style={{ height: '100%', overflow: 'auto', padding: 16 }}>
      <div style={{ marginBottom: 12, color: 'var(--fg-mute)', fontSize: 12, lineHeight: 1.5 }}>
        <strong style={{ color: 'var(--fg)' }}>Observations</strong> — pre-idea sensor readings agents
        record at the end of a turn. They never enter the work queue; a recurring one is promoted to a
        real idea by Scout. Browse only.
        {rows.length > 0 ? (
          <span style={{ marginLeft: 6, color: 'var(--fg)' }}>
            {capped ? `newest ${OBSERVATIONS_LIMIT}` : rows.length}
          </span>
        ) : null}
      </div>
      {loading && rows.length === 0 ? (
        <div style={{ color: 'var(--fg-mute)', padding: 12 }}>Loading observations…</div>
      ) : rows.length === 0 ? (
        <div style={{ color: 'var(--fg-mute)', padding: 12 }}>
          {itemPlans.length
            ? 'No observations match the selected plan.'
            : 'No observations yet — they appear as agents reflect at the end of their turns.'}
        </div>
      ) : (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
          {rows.map((o) => (
            <li
              key={o.id}
              style={{ border: '1px solid var(--border)', borderRadius: 8, padding: '10px 12px', background: 'var(--surface)' }}
            >
              <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
                {o.kind ? (
                  <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--accent, #f59e0b)' }}>
                    {KIND_LABEL[o.kind] ?? o.kind}
                  </span>
                ) : null}
                <span style={{ fontWeight: 500 }}>{o.title}</span>
              </div>
              {o.body ? (
                <div style={{ marginTop: 4, fontSize: 12, color: 'var(--fg-mute)', whiteSpace: 'pre-wrap' }}>{o.body}</div>
              ) : null}
              <div style={{ marginTop: 6, display: 'flex', gap: 10, flexWrap: 'wrap', fontSize: 11, color: 'var(--fg-mute)' }}>
                {o.sourceRole ? <span>{o.sourceRole}</span> : null}
                {o.scope ? <span>scope: {o.scope}</span> : null}
                {o.confidence ? <span>conf: {o.confidence}</span> : null}
                {o.refs.length ? <span>{o.refs.join(' · ')}</span> : null}
                <span style={{ marginLeft: 'auto' }}>{new Date(o.createdAt).toLocaleString()}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function observationMatchesPlan(row: ObservationRow, planSlugs: readonly string[]): boolean {
  if (planSlugs.length === 0) return true;
  const refs = row.refs.map((r) => r.toLowerCase());
  return planSlugs.some((slug) => {
    const s = slug.toLowerCase();
    return refs.some((ref) => ref === s || ref === `plan:${s}` || ref.includes(s));
  });
}
