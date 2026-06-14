'use client';

/**
 * DecisionLog — the shared Queen decision-ledger feed
 * (queue-authorization-redesign-2026-06-14 P-003).
 *
 * Factored out of settings/autonomy/RecentAutoDecisions.tsx so BOTH the autonomy
 * settings page and the Queue view's "Queen's log" tab (P-006) render one
 * component over the `decision.ledger` sync query — no duplication (D-002).
 *
 * Parameterized by `layer`:
 *   - `disposition` (default) — what the Queen CHOSE per item she considered
 *     (act / defer / reject / route-to-research / no-op).
 *   - `action` — every governed action that ran (the broad audit trail).
 *
 * A row's one-click Undo appears when `tripwireId` is set — a reversible
 * auto-decision with an armed tripwire (decision.ledger ⟕ autonomy_tripwires).
 * Undo rejects the decision (owner thumbs-down) + demotes the category one step
 * via the autonomy-tripwire-revert loopback route. Empty-until-armed: no rows
 * carry a tripwireId until autonomy is armed and queen-execution threads decisionId.
 *
 * The only interactive state is the transient per-row "reverting" lifecycle
 * (useState — not user-meaningful, so not nuqs).
 */
import { type CSSProperties, useMemo, useState } from 'react';
import { useSyncQuery } from '@papercusp/sync';
import { toast } from 'sonner';

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
  tripwireId: string | null;
  links: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
}

export interface DecisionLogProps {
  /** Which ledger layer to read. Default `disposition`. */
  layer?: 'disposition' | 'action';
  /** Max rows. Default 25. */
  limit?: number;
  /** Optional server-side filters passed to the sync query. */
  category?: string;
  posture?: string;
  /** Section heading. Default "Decision log". */
  title?: string;
  /** Optional sub-heading paragraph. */
  description?: string;
  /** Empty-state line. */
  emptyText?: string;
  /** Show the one-click Undo affordance (default true). */
  showUndo?: boolean;
  /** Passthrough for the root <section> (lets the settings page keep its spacing). */
  className?: string;
  style?: CSSProperties;
}

/** POST the revert to the dedicated loopback route (mirrors GraduationPrompts'
 *  ratify): autonomy:tripwire_revert REQUIRES args so it's palette-excluded — the
 *  feed writes through /api/agent-mcp/autonomy-tripwire-revert instead. */
async function revertDecision(tripwireId: string, reason: string): Promise<void> {
  const r = await fetch('/api/agent-mcp/autonomy-tripwire-revert', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tripwireId, reason }),
  });
  const text = await r.text();
  let data: { ok?: boolean; error?: string } = {};
  try {
    data = JSON.parse(text) as { ok?: boolean; error?: string };
  } catch {
    /* non-JSON */
  }
  if (!r.ok || data.ok === false) throw new Error(data.error ?? `HTTP ${r.status}`);
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

export default function DecisionLog({
  layer = 'disposition',
  limit = 25,
  category,
  posture,
  title = 'Decision log',
  description,
  emptyText = 'No decisions logged yet.',
  showUndo = true,
  className,
  style,
}: DecisionLogProps) {
  const args = useMemo(
    () => ({
      layer,
      limit,
      ...(category ? { category } : {}),
      ...(posture ? { posture } : {}),
    }),
    [layer, limit, category, posture],
  );
  const { data, loading, error, invalidate } = useSyncQuery<DecisionRow>({
    queryName: 'decision.ledger',
    args,
  });
  const rows = useMemo<DecisionRow[]>(() => data ?? [], [data]);
  const [reverting, setReverting] = useState<string | null>(null);

  const onUndo = async (row: DecisionRow) => {
    if (!row.tripwireId) return;
    setReverting(row.tripwireId);
    try {
      await revertDecision(
        row.tripwireId,
        `Owner undo of ${row.category ?? 'decision'}${row.action ? ` (${row.action})` : ''}`,
      );
      // The revert trips + demotes server-side and invalidates decision.ledger;
      // nudge the local query so the row reflects it promptly.
      invalidate();
      toast.success('Auto-decision rejected — category demoted one step.');
    } catch (err) {
      toast.error(`Couldn’t undo: ${err instanceof Error ? err.message : 'failed'}`);
    } finally {
      setReverting(null);
    }
  };

  return (
    <section className={className} aria-label={title} style={style}>
      <h2>{title}</h2>
      {description && (
        <p style={{ color: 'var(--fg-mute)', fontSize: 13, marginTop: 0 }}>{description}</p>
      )}

      {error && (
        <p role="alert" style={{ color: 'var(--bad)', fontSize: 13 }}>
          Couldn’t load the decision feed: {error.message}
        </p>
      )}
      {loading && rows.length === 0 && (
        <p role="status" style={{ color: 'var(--fg-mute)', fontSize: 13 }}>
          Loading decisions…
        </p>
      )}
      {!loading && rows.length === 0 && !error && (
        <p style={{ color: 'var(--fg-mute)', fontSize: 13 }}>{emptyText}</p>
      )}

      {rows.map((row) => {
        const p = POSTURE_STYLE[row.posture] ?? { fg: 'var(--fg-mute)', bg: 'var(--bg-2)', label: row.posture };
        // Single-line row: fixed-width identity chips on the left, the (truncated)
        // action/why as the one flexible middle, time + Undo pinned right. The
        // primary label is the disposition when present (disposition layer), else
        // the posture (action layer) so an audit row is never a bare "—".
        const primaryLabel = DISPOSITION_LABEL[row.disposition ?? ''] ?? row.disposition ?? p.label;
        const detail = [row.action, row.why].filter(Boolean).join(' — ');
        return (
          <div
            key={row.id}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              border: '1px solid var(--border)',
              borderRadius: 8,
              padding: '6px 12px',
              marginBottom: 6,
              background: 'var(--bg)',
              minWidth: 0,
            }}
          >
            <span style={{ flex: '0 0 auto', fontWeight: 600, color: 'var(--fg)', fontSize: 13, whiteSpace: 'nowrap' }}>
              {primaryLabel}
            </span>
            {row.category && (
              <span style={{ ...chip({ color: 'var(--fg)', background: 'var(--bg-2)' }), flex: '0 0 auto', whiteSpace: 'nowrap' }}>
                {row.category}
              </span>
            )}
            <span style={{ ...chip({ color: p.fg, background: p.bg }), flex: '0 0 auto', whiteSpace: 'nowrap' }}>{p.label}</span>
            {row.riskTier && (
              <span style={{ flex: '0 0 auto', fontSize: 11, color: 'var(--fg-mute)', whiteSpace: 'nowrap' }}>
                risk: {row.riskTier}
              </span>
            )}
            <span
              style={{
                flex: '1 1 auto',
                minWidth: 0,
                fontSize: 12,
                color: 'var(--fg-mute)',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
              title={detail || undefined}
            >
              {row.action && <code style={{ fontSize: 11 }}>{row.action}</code>}
              {row.action && row.why ? ' — ' : ''}
              {row.why}
            </span>
            <span style={{ flex: '0 0 auto', marginLeft: 'auto', fontSize: 11, color: 'var(--fg-mute)', whiteSpace: 'nowrap' }} title={row.ts}>
              {relativeTime(row.ts)}
            </span>
            {showUndo && row.tripwireId ? (
              <button
                type="button"
                onClick={() => void onUndo(row)}
                disabled={reverting === row.tripwireId}
                style={{
                  flex: '0 0 auto',
                  fontSize: 11,
                  padding: '2px 8px',
                  borderRadius: 6,
                  border: '1px solid var(--border)',
                  background: 'var(--bg-2)',
                  color: 'var(--fg)',
                  cursor: reverting === row.tripwireId ? 'default' : 'pointer',
                }}
                title="Undo: reject this auto-decision (owner thumbs-down) and demote the category one step. The literal action-revert lands with the queen execution layer."
              >
                {reverting === row.tripwireId ? 'Undoing…' : 'Undo'}
              </button>
            ) : null}
          </div>
        );
      })}
    </section>
  );
}
