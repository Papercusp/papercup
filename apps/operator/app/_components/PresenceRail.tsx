'use client';

/**
 * Live-agents rail — the Discord "member list" analog (Mod+U,
 * discord-shortcuts 2026-06-06, deferred-items pass).
 *
 * A right-side drawer listing the ACTIVE coordination agents (fresh
 * heartbeat) with their declared intent + plan, from the public
 * `GET /api/coord/presence` route (the same source the /coord dashboard
 * reads). Refreshes every 30 s while open; fetches nothing while closed.
 *
 * Open state lives in nuqs (`?members=1`) per the repo rule — deep-linkable,
 * survives reload, agent-driveable. Reuses the portable LivenessDot from the
 * /coord dashboard.
 */
import { useEffect, useState } from 'react';
import { parseAsBoolean, useQueryState } from 'nuqs';
import { useShortcutAction } from '../../lib/hotkeys';
import { LivenessDot, livenessFromHeartbeat } from '../coord/presence-ui';

export interface PresenceRow {
  ownerId: string;
  ownerLabel: string;
  intent: string;
  currentPlanSlug: string | null;
  heartbeatAt: string;
}

const REFRESH_MS = 30_000;

export default function PresenceRail() {
  const [open, setOpen] = useQueryState('members', parseAsBoolean.withDefault(false));
  const [rows, setRows] = useState<PresenceRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useShortcutAction('panel.togglePresence', () => {
    void setOpen(!open);
  });

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const load = () => {
      fetch('/api/coord/presence', { cache: 'no-store' })
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
        .then((d) => {
          if (cancelled) return;
          setRows(Array.isArray(d?.active) ? (d.active as PresenceRow[]) : []);
          setError(null);
        })
        .catch((e) => {
          if (!cancelled) setError(String((e as Error)?.message ?? e));
        });
    };
    load();
    const t = setInterval(load, REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [open]);

  if (!open) return null;

  return (
    <aside
      aria-label="Live agents"
      data-testid="presence-rail"
      style={{
        position: 'fixed',
        top: 0,
        right: 0,
        bottom: 0,
        width: 320,
        zIndex: 900,
        background: 'var(--pc-surface, #16181d)',
        color: 'var(--pc-text, #e5e7eb)',
        borderLeft: '1px solid var(--pc-border, #2a2e37)',
        boxShadow: '-12px 0 30px rgba(0,0,0,.35)',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '10px 12px',
          borderBottom: '1px solid var(--pc-border, #2a2e37)',
        }}
      >
        <span style={{ fontSize: 13, fontWeight: 600 }}>
          Live agents{rows ? ` — ${rows.length}` : ''}
        </span>
        <button
          type="button"
          onClick={() => void setOpen(false)}
          aria-label="Close live agents rail"
          style={{
            background: 'none',
            border: 'none',
            color: 'inherit',
            cursor: 'pointer',
            fontSize: 16,
            opacity: 0.7,
          }}
        >
          ×
        </button>
      </header>
      <div style={{ overflowY: 'auto', flex: 1, padding: '6px 0' }}>
        {error && (
          <div role="alert" style={{ fontSize: 12, color: '#f87171', padding: '8px 12px' }}>
            Failed to load presence: {error}
          </div>
        )}
        {rows && rows.length === 0 && !error && (
          <div style={{ fontSize: 12, opacity: 0.6, padding: '8px 12px' }}>
            No agents active right now.
          </div>
        )}
        {(rows ?? []).map((r) => (
          <div
            key={r.ownerId}
            data-testid="presence-row"
            style={{ padding: '8px 12px', borderBottom: '1px solid var(--pc-border, #20242c)' }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <LivenessDot liveness={livenessFromHeartbeat(r.heartbeatAt)} />
              <span style={{ fontSize: 12.5, fontWeight: 600 }}>{r.ownerLabel || r.ownerId}</span>
            </div>
            {r.intent && (
              <div
                style={{
                  fontSize: 11.5,
                  opacity: 0.75,
                  marginTop: 3,
                  display: '-webkit-box',
                  WebkitLineClamp: 3,
                  WebkitBoxOrient: 'vertical',
                  overflow: 'hidden',
                }}
              >
                {r.intent}
              </div>
            )}
            {r.currentPlanSlug && (
              <div style={{ fontSize: 10.5, opacity: 0.55, marginTop: 3 }}>
                ▸ {r.currentPlanSlug}
              </div>
            )}
          </div>
        ))}
      </div>
    </aside>
  );
}
