/**
 * HiveFederationStatus — Brief M / G-004: the desktop's first LIVE federation
 * status surface, mounted in the always-visible left-sidebar Hives tab.
 *
 * Before this the desktop had member counts + a declared-visibility badge but NO
 * way to see "is my hive reaching peers / is my substrate live" — so a user who
 * published to 0 peers (the G-001 stranded-publish case) had no corrective in-app
 * signal (findings-G G-004). Push-driven via the `network.federationStatus` sync
 * query (data-sync-push-completion P-009 — the same composition the
 * /api/discovery/federation-status loopback GET serves), it renders the HONEST
 * signals available today.
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
import { useSyncQuery } from '@papercusp/sync';
import { useLexicon } from '@/lib/useLexicon';

export interface FedHive {
  hiveId: string;
  title: string;
  visibility: 'public' | 'invite' | 'private';
  memberCount: number;
  reachablePeers: number;
}
/** Install-wide drain (SYNC) health — EI-1618/EI-1599. Optional so an older route
 *  response (or a test fixture) without it still renders. */
export interface FedDrain {
  /** Booted harnesses whose outbox has rows captured-but-not-federating past the stall lag. */
  stalledHarnesses: number;
  /** Largest undrained row count across the stalled harnesses. */
  worstUndrainedCount: number;
  /** Oldest undrained age (ms) across the stalled harnesses; null when none stalled. */
  worstOldestUndrainedAgeMs: number | null;
}
export interface FedStatus {
  ok: boolean;
  substrate: {
    active: boolean;
    bootedHarnesses: number;
    healthy: number;
    booting: number;
    degraded: number;
    drain?: FedDrain;
  };
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

/**
 * Honest install-wide SYNC line (EI-1618/EI-1599). Returns null when nothing is
 * stalled — silence is the honest healthy state, NOT a false "all synced" claim —
 * or the stall copy when ≥1 booted harness has content captured-but-not-federating
 * (the EI-681 silent-stall). NEVER says "synced" / "in sync"; it only ever reports
 * a stall, because the shared swarm has no clean per-peer count to back a positive
 * sync claim (see findings-M / the route honesty contract).
 */
export function drainLabel(d: FedStatus['substrate']['drain']): string | null {
  if (!d || d.stalledHarnesses <= 0) return null;
  const ageS = d.worstOldestUndrainedAgeMs != null ? Math.round(d.worstOldestUndrainedAgeMs / 1000) : 0;
  const h = `${d.stalledHarnesses} harness${d.stalledHarnesses === 1 ? '' : 'es'}`;
  const c = `${d.worstUndrainedCount} change${d.worstUndrainedCount === 1 ? '' : 's'}`;
  return `⚠ not syncing — ${h} with content captured but not federating (${c} undrained, oldest ${ageS}s)`;
}

/** Install substrate one-liner — honest install-wide boot health, not a sync claim. */
export function substrateLabel(s: FedStatus['substrate']): string {
  if (!s.active) return 'substrate inactive';
  const parts = [`${s.bootedHarnesses} harness${s.bootedHarnesses === 1 ? '' : 'es'} booted`, `${s.healthy} healthy`];
  if (s.booting > 0) parts.push(`${s.booting} booting`);
  if (s.degraded > 0) parts.push(`⚠ ${s.degraded} degraded`);
  return `substrate active · ${parts.join(' · ')}`;
}

export default function HiveFederationStatus() {
  const t = useLexicon();
  // P-009 (data-sync-push-completion): push-driven federation status. The
  // `network.federationStatus` resolver serves the SAME { ok, substrate, hives }
  // FedStatus the GET /api/discovery/federation-status endpoint did, as a flat
  // one-element array (the resolver contract) — read data[0]. Pushed by the
  // directory ingest path + announce/withdraw/beacon writers; substrate/drain
  // changes (harness boots) converge via the sync library's drift-repair tick.
  // No poll. While the first push is in flight `rows` is undefined → data null.
  const { data: rows, error } = useSyncQuery({ queryName: 'network.federationStatus' });
  const data = (rows as FedStatus[] | undefined)?.[0] ?? null;

  const degraded = data?.substrate.degraded ?? 0;

  return (
    <div className="pclsb-panel" data-testid="hive-federation-status">
      <div className="pclsb-panel__bar">
        <span className="pclsb-panel__bar-label">federation status</span>
      </div>

      {error && !data && (
        <div className="pclsb-panel__error">
          status unavailable: {error instanceof Error ? error.message : String(error)}
        </div>
      )}

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

          {/* SYNC-health line (EI-1618/EI-1599) — rendered ONLY when a harness's
              outbox is stalled (content captured but not federating). Silence = the
              honest healthy state; this never claims a positive "synced". */}
          {(() => {
            const drainMsg = drainLabel(data.substrate.drain);
            return drainMsg ? (
              <div
                className="pclsb-row"
                data-testid="fed-drain"
                title="A local change was captured but its outbox has not drained to the federation log — content is NOT reaching peers yet (EI-681 class stall)."
              >
                <span className="pclsb-dot is-down" aria-hidden="true" />
                <div className="pclsb-row__main">
                  <div className="pclsb-row__sub">{drainMsg}</div>
                </div>
              </div>
            ) : null;
          })()}

          {data.hives.length === 0 ? (
            <div className="pclsb-panel__empty" data-testid="fed-no-hives">
              No {t('pot', { plural: true, lower: true })} published from this install yet. Publish a {t('pot', { lower: true })} and its live peer
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

          {/* Honest scope note — reach is discovery; sync-health is install-wide. */}
          <div className="pclsb-panel__empty" style={{ fontSize: 11, opacity: 0.7 }} data-testid="fed-scope-note">
            Reach = peers who can discover this {t('pot', { lower: true })} on its announce topic. Sync-health
            is install-wide (is local content draining to the federation log); per-{t('pot', { lower: true })}
            content-sync peer counts are not yet surfaced.
          </div>
        </>
      )}
    </div>
  );
}
