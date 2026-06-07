import { useEffect, useMemo, useRef, useState } from 'react';
import { parseAsString, useQueryState } from 'nuqs';
import { MonitorPlay, MonitorOff, RefreshCw, X } from 'lucide-react';
import { createResilientEventSource, type ResilientEventSource } from '@papercusp/sse';

/**
 * AdvFramesTab — the Swarm live view
 * (`hive-frame-desktops-live-view-2026-06-06` P-006, D-001/D-003/D-005).
 *
 * One tile per agent-display across every DEPLOYED frame in the workspace:
 * the frame-side capture loop writes a JPEG per active display, the operator
 * pulls them over SSH while ≥1 of these tabs is open (viewer-driven, D-003),
 * and `/api/deploy/:slug/frame-view` fans them out here as SSE `thumb` events.
 *
 * Selection rides nuqs (`?frame=<slug>:<display>`) so agents can drive the
 * viewer (`ui:dispatch`) and deep links survive reload. The enlarged panel is
 * Phase 3's mount point for the noVNC live view (P-009).
 */

export interface DeployedFrameRow {
  slug: string;
  frame: { id: string; host?: string; region?: string; kind?: string; target: string };
  desktop: boolean | { displays?: number; geometry?: string };
}

export interface FrameThumbEvent {
  slug: string;
  display: number;
  jpegBase64: string;
  capturedAtMs: number;
  role?: string;
  leaseSinceMs?: number;
}

export interface FrameStatusEvent {
  slug: string;
  state: 'polling' | 'no-frame' | 'error';
  frameId?: string;
  host?: string;
  displays?: number[];
  error?: string;
}

/** A thumb is stale once it's older than ~3 capture intervals. */
export const STALE_AFTER_MS = 20_000;

const tileKey = (slug: string, display: number) => `${slug}:${display}`;

export default function AdvFramesTab() {
  // ── deployed-frame roster (registry; cheap, refetched on a slow interval) ──
  const [rows, setRows] = useState<DeployedFrameRow[]>([]);
  const [rosterErr, setRosterErr] = useState<string | null>(null);
  const [rosterLoaded, setRosterLoaded] = useState(false);
  useEffect(() => {
    let cancel = false;
    const pull = () => {
      fetch('/api/deploy/frames', { cache: 'no-store' })
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
        .then((d) => {
          if (cancel) return;
          setRows(Array.isArray(d?.frames) ? d.frames : []);
          setRosterErr(null);
          setRosterLoaded(true);
        })
        .catch((e) => {
          if (cancel) return;
          setRosterErr(String(e?.message ?? e));
          setRosterLoaded(true);
        });
    };
    pull();
    const t = setInterval(pull, 30_000);
    return () => {
      cancel = true;
      clearInterval(t);
    };
  }, []);

  // ── per-slug SSE streams → thumbs + statuses ───────────────────────────
  const [thumbs, setThumbs] = useState<Map<string, FrameThumbEvent>>(() => new Map());
  const [statuses, setStatuses] = useState<Map<string, FrameStatusEvent>>(() => new Map());
  const sourcesRef = useRef<Map<string, ResilientEventSource>>(new Map());
  const slugsKey = useMemo(() => rows.map((r) => r.slug).sort().join(','), [rows]);
  useEffect(() => {
    const want = new Set(slugsKey ? slugsKey.split(',') : []);
    const sources = sourcesRef.current;
    // close streams for frames that left the roster
    for (const [slug, src] of sources) {
      if (!want.has(slug)) {
        src.close();
        sources.delete(slug);
      }
    }
    // open streams for new frames
    for (const slug of want) {
      if (sources.has(slug)) continue;
      sources.set(
        slug,
        createResilientEventSource({
          url: `/api/deploy/${encodeURIComponent(slug)}/frame-view`,
          withCredentials: true,
          handlers: {
            thumb: (raw) => {
              try {
                const t = JSON.parse(raw) as FrameThumbEvent;
                setThumbs((prev) => new Map(prev).set(tileKey(t.slug, t.display), t));
              } catch {
                /* skip a malformed event */
              }
            },
            status: (raw) => {
              try {
                const s = JSON.parse(raw) as FrameStatusEvent;
                setStatuses((prev) => new Map(prev).set(s.slug, s));
              } catch {
                /* skip */
              }
            },
          },
        }),
      );
    }
    return undefined;
  }, [slugsKey]);
  // unmount → close everything (last viewer gone stops the SSH pull server-side)
  useEffect(
    () => () => {
      for (const src of sourcesRef.current.values()) src.close();
      sourcesRef.current.clear();
    },
    [],
  );

  // re-render on a slow tick so "Ns ago" ages + staleness flips without events
  const [, setNowTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setNowTick((n) => n + 1), 2_000);
    return () => clearInterval(t);
  }, []);

  // ── selection in nuqs: ?frame=<slug>:<display> ─────────────────────────
  const [selectedKey, setSelectedKey] = useQueryState('frame', parseAsString);
  const selected = useMemo(
    () => (selectedKey ? thumbs.get(selectedKey) : undefined),
    [selectedKey, thumbs],
  );

  const tiles = useMemo(() => {
    const list = [...thumbs.values()];
    list.sort((a, b) => a.slug.localeCompare(b.slug) || a.display - b.display);
    return list;
  }, [thumbs]);

  const now = Date.now();

  return (
    <div className="pc-frames">
      <div className="pc-frames__topbar">
        <MonitorPlay size={14} aria-hidden />
        <span className="pc-frames__title">Swarm live view</span>
        <span className="pc-frames__sub">
          {rows.length === 0
            ? 'no deployed frames'
            : `${rows.length} frame${rows.length === 1 ? '' : 's'} · ${tiles.length} live display${tiles.length === 1 ? '' : 's'}`}
        </span>
        <div className="pc-frames__spacer" />
      </div>

      {rosterErr ? (
        <div className="pc-frames__state" data-error="true">
          {rosterErr}
        </div>
      ) : !rosterLoaded ? (
        <div className="pc-frames__state">Loading deployed frames…</div>
      ) : rows.length === 0 ? (
        <div className="pc-frames__state">
          No deployed frames. Deploy a harness with <code>deployment.desktop: true</code> and its
          agents' screens appear here.
        </div>
      ) : (
        <>
          {/* per-frame status strip (no-desktop / connecting / errors) */}
          <div className="pc-frames__statusrow">
            {rows.map((r) => {
              const s = statuses.get(r.slug);
              const live = s?.state === 'polling' && (s.displays?.length ?? 0) > 0;
              return (
                <span key={r.slug} className="pc-frames__chip" data-live={live} title={s?.error ?? s?.host ?? r.frame.host ?? ''}>
                  <span className="pc-frames__chip-dot" data-state={s?.state ?? 'connecting'} aria-hidden />
                  {r.slug}
                  <span className="pc-frames__chip-meta">
                    {!r.desktop
                      ? 'no desktop'
                      : s?.state === 'error'
                        ? 'unreachable'
                        : s?.state === 'no-frame'
                          ? 'no frame'
                          : live
                            ? `${s?.displays?.length} active`
                            : 'idle'}
                  </span>
                </span>
              );
            })}
          </div>

          {tiles.length === 0 ? (
            <div className="pc-frames__state">
              <MonitorOff size={14} aria-hidden /> No active displays — agents aren't driving a GUI
              right now. Tiles appear when an agent opens something on its display.
            </div>
          ) : (
            <div className="pc-frames__grid">
              {tiles.map((t) => {
                const key = tileKey(t.slug, t.display);
                const ageMs = now - t.capturedAtMs;
                return (
                  <button
                    key={key}
                    type="button"
                    className="pc-frames__tile"
                    data-selected={selectedKey === key}
                    data-stale={ageMs > STALE_AFTER_MS}
                    onClick={() => void setSelectedKey(selectedKey === key ? null : key)}
                    title={`${t.slug} :${t.display}${t.role ? ` — ${t.role}` : ''}`}
                  >
                    <img
                      src={`data:image/jpeg;base64,${t.jpegBase64}`}
                      alt={`${t.slug} display :${t.display}`}
                    />
                    <span className="pc-frames__tile-meta">
                      <span className="pc-frames__tile-slug">{t.slug}</span>
                      <span className="pc-frames__tile-display">:{t.display}</span>
                      {t.role && <span className="pc-frames__tile-role">{t.role}</span>}
                      <span className="pc-frames__tile-age">{formatAge(ageMs)}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </>
      )}

      {/* enlarged panel — Phase 3 (P-009) swaps the <img> for the noVNC viewer */}
      {selected && (
        <div className="pc-frames__panel" role="dialog" aria-label="Frame live view">
          <div className="pc-frames__panel-head">
            <MonitorPlay size={13} aria-hidden />
            <span>
              {selected.slug} <code>:{selected.display}</code>
              {selected.role ? ` — ${selected.role}` : ''}
            </span>
            <span className="pc-frames__tile-age">{formatAge(now - selected.capturedAtMs)}</span>
            <button
              type="button"
              className="pc-frames__panel-close"
              onClick={() => void setSelectedKey(null)}
              aria-label="Close live view"
            >
              <X size={14} aria-hidden />
            </button>
          </div>
          <img
            className="pc-frames__panel-img"
            src={`data:image/jpeg;base64,${selected.jpegBase64}`}
            alt={`${selected.slug} display :${selected.display} (enlarged)`}
          />
          <div className="pc-frames__panel-foot">
            <RefreshCw size={11} aria-hidden /> refreshing every few seconds — live VNC + takeover
            land with Phase 3
          </div>
        </div>
      )}

      <style>{`
        .pc-frames { display: flex; flex-direction: column; gap: 10px; flex: 1; min-height: 0; padding: 14px 16px 16px; position: relative; }
        .pc-frames__topbar {
          display: flex; align-items: center; gap: 8px;
          padding: 10px 12px;
          border: 1px solid var(--border, rgba(125, 211, 252, 0.16));
          border-radius: 12px;
          background: var(--bg-2, rgba(255, 255, 255, 0.04));
          color: var(--fg, #e7f7ff);
        }
        .pc-frames__topbar svg { color: #22d3ee; }
        .pc-frames__title { font-size: 12px; font-weight: 760; letter-spacing: 0.04em; text-transform: uppercase; }
        .pc-frames__sub { font-size: 11.5px; color: var(--fg-mute, #7f9bb4); }
        .pc-frames__spacer { flex: 1; }
        .pc-frames__state {
          display: flex; align-items: center; gap: 7px;
          font-size: 12px; color: var(--fg-mute, #7f9bb4); padding: 10px 2px;
        }
        .pc-frames__state[data-error='true'] { color: #fca5a5; }
        .pc-frames__state code { font-size: 11px; color: var(--fg-dim, #b9d4e8); }
        .pc-frames__statusrow { display: flex; flex-wrap: wrap; gap: 6px; }
        .pc-frames__chip {
          display: inline-flex; align-items: center; gap: 6px;
          font-size: 11px; font-weight: 600; color: var(--fg-dim, #b9d4e8);
          border: 1px solid var(--border, rgba(125, 211, 252, 0.18));
          border-radius: 999px; padding: 3px 9px;
          background: rgba(255, 255, 255, 0.03);
        }
        .pc-frames__chip-dot { width: 7px; height: 7px; border-radius: 50%; background: #475569; }
        .pc-frames__chip-dot[data-state='polling'] { background: #4ade80; box-shadow: 0 0 6px rgba(74, 222, 128, 0.5); }
        .pc-frames__chip-dot[data-state='error'] { background: #f87171; }
        .pc-frames__chip-meta { font-size: 9.5px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; color: var(--fg-mute, #7f9bb4); }
        .pc-frames__grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
          gap: 12px;
          overflow-y: auto;
          min-height: 0;
        }
        .pc-frames__tile {
          position: relative;
          aspect-ratio: 16 / 9;
          border: 1px solid var(--border, rgba(125, 211, 252, 0.18));
          border-radius: 12px;
          overflow: hidden;
          background: var(--bg-2, rgba(255, 255, 255, 0.035));
          cursor: pointer;
          padding: 0;
          transition: border-color 150ms, box-shadow 150ms, opacity 150ms;
        }
        .pc-frames__tile:hover { border-color: #22d3ee; box-shadow: 0 0 0 2px rgba(34, 211, 238, 0.18); }
        .pc-frames__tile[data-selected='true'] { border-color: #22d3ee; box-shadow: 0 0 10px rgba(34, 211, 238, 0.35); }
        .pc-frames__tile[data-stale='true'] { opacity: 0.55; }
        .pc-frames__tile img { width: 100%; height: 100%; object-fit: cover; display: block; }
        .pc-frames__tile-meta {
          position: absolute; left: 0; right: 0; bottom: 0;
          display: flex; align-items: center; gap: 6px;
          padding: 14px 10px 7px;
          background: linear-gradient(to top, rgba(7, 16, 29, 0.92), transparent);
          font-size: 11px; color: var(--fg, #e7f7ff); text-align: left;
        }
        .pc-frames__tile-slug { font-weight: 700; }
        .pc-frames__tile-display { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--fg-dim, #b9d4e8); }
        .pc-frames__tile-role {
          font-size: 9.5px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em;
          color: #22d3ee; border: 1px solid rgba(34, 211, 238, 0.4); border-radius: 5px; padding: 0 5px;
        }
        .pc-frames__tile-age { margin-left: auto; font-size: 10px; color: var(--fg-mute, #7f9bb4); font-variant-numeric: tabular-nums; }
        .pc-frames__panel {
          position: absolute; inset: 56px 16px 16px;
          display: flex; flex-direction: column;
          border: 1px solid rgba(34, 211, 238, 0.4);
          border-radius: 14px;
          background: rgba(7, 16, 29, 0.97);
          box-shadow: 0 12px 48px rgba(0, 0, 0, 0.5);
          z-index: 5;
          overflow: hidden;
        }
        .pc-frames__panel-head {
          display: flex; align-items: center; gap: 8px;
          padding: 9px 12px;
          font-size: 12px; font-weight: 600; color: var(--fg, #e7f7ff);
          border-bottom: 1px solid var(--border, rgba(125, 211, 252, 0.14));
        }
        .pc-frames__panel-head svg { color: #22d3ee; }
        .pc-frames__panel-head code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--fg-dim, #b9d4e8); }
        .pc-frames__panel-close { margin-left: auto; background: transparent; border: none; color: var(--fg-mute, #7f9bb4); cursor: pointer; }
        .pc-frames__panel-close:hover { color: var(--fg, #e7f7ff); }
        .pc-frames__panel-img { flex: 1; min-height: 0; object-fit: contain; background: #000; }
        .pc-frames__panel-foot {
          display: flex; align-items: center; gap: 6px;
          padding: 7px 12px; font-size: 10.5px; color: var(--fg-mute, #7f9bb4);
          border-top: 1px solid var(--border, rgba(125, 211, 252, 0.14));
        }
      `}</style>
    </div>
  );
}

export function formatAge(ms: number): string {
  if (ms < 0) return 'now';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  return `${m}m ago`;
}
