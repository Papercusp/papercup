'use client';

/**
 * The "recent auto-decisions" feed (queen-autonomy-policy-2026-06-13 P-031 /
 * P-113) — a filtered view of the Queen decision ledger's DISPOSITION layer: what
 * she chose for each item she considered (act / defer / reject / route-to-research
 * / no-op), newest first, with the category, posture, and why. Reads the live
 * `decision.ledger` sync query (layer=disposition); the row's `revertHandle` lights
 * up one-click undo once the tripwire (B-16 / P-080) populates it — until then the
 * feed is read-only.
 *
 * Self-contained so the B-15 settings page drops it in where the P-031 placeholder
 * was; no interactive state (a read-only list), so nothing to put in nuqs.
 */
import { useMemo, type CSSProperties } from 'react';
import { useSyncQuery } from '@papercusp/sync';

/* Wire type — mirrors DecisionLedgerEntry (operator-core/lib/decision-ledger/read.ts),
 * kept local per the client wire-type decoupling convention. */
interface DecisionRow {
  id: number;
  ts: string;
  layer: string;
  action: string | null;
  category: string | null;
  riskTier: string | null;
  reversibility: string | null;
  authority: string | null;
  posture: string;
  disposition: string | null;
  why: string | null;
  revertHandle: string | null;
  links: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
}

const POSTURE_STYLE: Record<string, { fg: string; bg: string; label: string }> = {
  auto: { fg: 'var(--accent)', bg: 'color-mix(in srgb, var(--accent), transparent 85%)', label: 'Auto' },
  proposed: { fg: 'var(--warn)', bg: 'color-mix(in srgb, var(--warn), transparent 85%)', label: 'Proposed' },
  gated: { fg: 'var(--fg-mute)', bg: 'color-mix(in srgb, var(--fg-mute), transparent 88%)', label: 'Gated' },
  rejected: { fg: 'var(--bad)', bg: 'color-mix(in srgb, var(--bad), transparent 85%)', label: 'Rejected' },
};

const DISPOSITION_LABEL: Record<string, string> = {
  act: 'Acted',
  defer: 'Deferred',
  reject: 'Rejected',
  'route-to-research': 'Routed to research',
  'no-op': 'No-op',
};

function chip(style: CSSProperties): CSSProperties {
  return { display: 'inline-block', padding: '1px 8px', borderRadius: 999, fontSize: 11, fontWeight: 600, ...style };
}

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '';
  const sec = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.round(hr / 24)}d ago`;
}

export default function RecentAutoDecisions() {
  const { data, loading, error } = useSyncQuery<DecisionRow>({
    queryName: 'decision.ledger',
    args: { layer: 'disposition', limit: 25 },
  });
  const rows = useMemo<DecisionRow[]>(() => data ?? [], [data]);

  return (
    <section className="pc-settings-section" aria-label="Recent auto-decisions" style={{ marginTop: 28 }}>
      <h2>Recent auto-decisions</h2>
      <p style={{ color: 'var(--fg-mute)', fontSize: 13, marginTop: 0 }}>
        What the Queen has decided per item she considered — newest first. One-click undo lights up
        per row once the auto-revert tripwire records a revert handle (B-16).
      </p>

      {error && (
        <p role="alert" style={{ color: 'var(--bad)', fontSize: 13 }}>
          Couldn’t load the decision feed: {error.message}
        </p>
      )}
      {loading && rows.length === 0 && (
        <p role="status" style={{ color: 'var(--fg-mute)', fontSize: 13 }}>
          Loading recent decisions…
        </p>
      )}
      {!loading && rows.length === 0 && !error && (
        <p style={{ color: 'var(--fg-mute)', fontSize: 13 }}>
          No decisions logged yet. As the Queen considers items, her dispositions appear here.
        </p>
      )}

      {rows.map((row) => {
        const p = POSTURE_STYLE[row.posture] ?? { fg: 'var(--fg-mute)', bg: 'var(--bg-2)', label: row.posture };
        return (
          <div
            key={row.id}
            style={{
              border: '1px solid var(--border)',
              borderRadius: 8,
              padding: '10px 12px',
              marginBottom: 8,
              background: 'var(--bg)',
            }}
          >
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
              <span style={{ fontWeight: 600, color: 'var(--fg)', fontSize: 13 }}>
                {DISPOSITION_LABEL[row.disposition ?? ''] ?? row.disposition ?? '—'}
              </span>
              {row.category && (
                <span style={chip({ color: 'var(--fg)', background: 'var(--bg-2)' })}>{row.category}</span>
              )}
              <span style={chip({ color: p.fg, background: p.bg })}>{p.label}</span>
              {row.riskTier && (
                <span style={{ fontSize: 11, color: 'var(--fg-mute)' }}>risk: {row.riskTier}</span>
              )}
              <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--fg-mute)' }} title={row.ts}>
                {relativeTime(row.ts)}
              </span>
              {row.revertHandle ? (
                <button
                  type="button"
                  style={{
                    fontSize: 11,
                    padding: '2px 8px',
                    borderRadius: 6,
                    border: '1px solid var(--border)',
                    background: 'var(--bg-2)',
                    color: 'var(--fg)',
                    cursor: 'pointer',
                  }}
                  title="Undo this auto-decision (B-16 revert handle)"
                  // The revert action is B-16's (auto-revert tripwire / P-080); the
                  // handle exists, the wiring lands with that brief.
                  disabled
                >
                  Undo
                </button>
              ) : null}
            </div>
            {(row.why || row.action) && (
              <div style={{ marginTop: 4, fontSize: 12, color: 'var(--fg-mute)' }}>
                {row.action && <code style={{ fontSize: 11 }}>{row.action}</code>}
                {row.action && row.why ? ' — ' : ''}
                {row.why}
              </div>
            )}
          </div>
        );
      })}
    </section>
  );
}
