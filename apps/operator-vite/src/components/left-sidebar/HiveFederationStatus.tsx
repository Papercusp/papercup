/**
 * HiveFederationStatus — Brief M / G-004: the desktop's first LIVE federation
 * status surface, mounted in the always-visible left-sidebar Hives tab.
 *
 * Before this the desktop had member counts + a declared-visibility badge but NO
 * way to see "is my hive reaching peers / is my substrate live" — so a user who
 * published to 0 peers (the G-001 stranded-publish case) had no corrective in-app
 * signal (findings-G G-004). This reads GET /api/discovery/federation-status and
 * renders the HONEST signals available today.
 *
 * HONESTY CONTRACT ("the UI never lies" — the brief's whole point):
 *   - "reach" is the hive's ANNOUNCE/discovery topic peer count (who can FIND it),
 *     NOT content-replication peers — labeled as such; a 0-peer published hive is
 *     shown as "broadcasting into the void", never hidden or dressed as "synced".
 *   - A private hive shows "private — not announced" (it never announces), NOT
 *     "0 peers" (which would imply a failed reach).
 *   - The substrate line is install-wide local boot health, NOT a per-peer sync
 *     claim. There is NO "synced" badge — a per-hive content-sync peer count does
 *     not exist cleanly (shared swarm; see findings-M), and inventing one would be
 *     the exact dishonesty this surface exists to prevent.
 */
import { useCallback, useEffect, useState } from 'react';

export interface FedHive {
  hiveId: string;
  title: string;
  visibility: 'public' | 'invite' | 'private';
  memberCount: number;
  reachablePeers: number;
}
export interface FedStatus {
  ok: boolean;
  substrate: { active: boolean; bootedHarnesses: number; healthy: number; booting: number; degraded: number };
  hives: FedHive[];
}

/** Honest reach copy for one owned hive — the honesty core, pure + exported for tests. */
export function reachLabel(h: Pick<FedHive, 'visibility' | 'reachablePeers'>): string {
  if (h.visibility === 'private') return 'private — not announced';
  if (h.reachablePeers > 0) {
    return `discoverable to ${h.reachablePeers} peer${h.reachablePeers === 1 ? '' : 's'}`;
  }
  // Announced (public/invite) but nobody on the topic — the honest stranded state
  // (mirrors ShareHiveForm's 0-peer copy). NEVER "synced" / "0 peers connected".
  return 'no peers connected yet — broadcasting into the void';
}

/** Install substrate one-liner — honest install-wide boot health, not a sync claim. */
export function substrateLabel(s: FedStatus['substrate']): string {
  if (!s.active) return 'substrate inactive';
  const parts = [`${s.bootedHarnesses} harness${s.bootedHarnesses === 1 ? '' : 'es'} booted`, `${s.healthy} healthy`];
  if (s.booting > 0) parts.push(`${s.booting} booting`);
  if (s.degraded > 0) parts.push(`⚠ ${s.degraded} degraded`);
  return `substrate active · ${parts.join(' · ')}`;
}

/** 10s poll — live-status feedback cadence (the directory panel polls at 30s for a
 *  slower-changing set; reach/health move faster, so a tighter cadence here). */
const FED_REFRESH_MS = 10_000;

export default function HiveFederationStatus() {
  const [data, setData] = useState<FedStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/discovery/federation-status');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as FedStatus;
      setData(body);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), FED_REFRESH_MS);
    return () => clearInterval(id);
  }, [load]);

  const degraded = data?.substrate.degraded ?? 0;

  return (
    <div className="pclsb-panel" data-testid="hive-federation-status">
      <div className="pclsb-panel__bar">
        <span className="pclsb-panel__bar-label">federation status</span>
      </div>

      {error && !data && <div className="pclsb-panel__error">status unavailable: {error}</div>}

      {data && (
        <>
          <div
            className="pclsb-row"
            data-testid="fed-substrate"
            title="Local federation infrastructure boot health (this install) — not a per-peer sync claim."
          >
            <span className={`pclsb-dot ${data.substrate.active && degraded === 0 ? 'is-up' : 'is-down'}`} aria-hidden="true" />
            <div className="pclsb-row__main">
              <div className="pclsb-row__sub">{substrateLabel(data.substrate)}</div>
            </div>
          </div>

          {data.hives.length === 0 ? (
            <div className="pclsb-panel__empty" data-testid="fed-no-hives">
              No hives published from this install yet. Publish a hive and its live peer
              reach appears here.
            </div>
          ) : (
            data.hives.map((h) => {
              const stranded = h.visibility !== 'private' && h.reachablePeers === 0;
              return (
                <div className="pclsb-row" key={h.hiveId} data-testid={`fed-hive-${h.hiveId}`}>
                  <span className={`pclsb-dot ${stranded ? 'is-down' : 'is-up'}`} aria-hidden="true" />
                  <div className="pclsb-row__main">
                    <div className="pclsb-row__title" title={h.hiveId}>
                      {h.title}
                      <span style={{ color: 'var(--fg-mute, #888)', fontWeight: 400 }}>
                        {'  ·  '}
                        {h.visibility}
                      </span>
                    </div>
                    <div className="pclsb-row__sub" data-testid={`fed-reach-${h.hiveId}`}>
                      {reachLabel(h)}
                    </div>
                  </div>
                </div>
              );
            })
          )}

          {/* Honest scope note — reach is discovery, not content-sync. */}
          <div className="pclsb-panel__empty" style={{ fontSize: 11, opacity: 0.7 }} data-testid="fed-scope-note">
            Reach = peers who can discover this hive on its announce topic. Per-hive
            content-sync peer counts are not yet surfaced.
          </div>
        </>
      )}
    </div>
  );
}
