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

export default function ObservationsPanel(_props?: Partial<PanelComponentProps>) {
  const { data, loading } = useSyncQuery<ObservationRow>({
    queryName: 'learning.observations',
    args: { limit: 200 },
  });
  const rows = data ?? [];

  return (
    <div style={{ height: '100%', overflow: 'auto', padding: 16 }}>
      <div style={{ marginBottom: 12, color: 'var(--fg-mute)', fontSize: 12, lineHeight: 1.5 }}>
        <strong style={{ color: 'var(--fg)' }}>Observations</strong> — pre-idea sensor readings agents
        record at the end of a turn. They never enter the work queue; a recurring one is promoted to a
        real idea by Scout. Browse only.
      </div>
      {loading && rows.length === 0 ? (
        <div style={{ color: 'var(--fg-mute)', padding: 12 }}>Loading observations…</div>
      ) : rows.length === 0 ? (
        <div style={{ color: 'var(--fg-mute)', padding: 12 }}>
          No observations yet — they appear as agents reflect at the end of their turns.
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
