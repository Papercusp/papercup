/**
 * Hives tab (left-sidebar-tauri-2026-06-07) — the p2p swarm roster, the
 * desktop twin of the pui Hives tab: every remote Papercusp install that has
 * announced into the Model-B substrate (`shared_presence`), grouped per
 * DEVICE. Stale hives stay listed (joined but quiet), flagged. Honest empty
 * state until a real peer announces.
 */
import { useMemo } from 'react';
import { useSyncQuery } from '@papercusp/sync';
import { useFlag } from '@papercusp/flags/client';
import { FLAGS } from '@papercusp/flags';
import LocalHivesControl from './LocalHivesControl';

interface FederatedRow {
  ownerId: string;
  ownerLabel: string;
  host: string;
  userId?: string | null;
  intent?: string | null;
  currentView?: string | null;
  harnessSlug?: string | null;
  devicePubkey?: string | null;
  heartbeatAt?: string | null;
  stale: boolean;
}

export interface HiveGroup {
  machine: string;
  devicePubkey: string;
  users: string[];
  harnesses: string[];
  doing: string;
  lastSeen: string;
  stale: boolean;
}

/** Group per-(user, harness) presence rows into one entry per device — the
 *  freshest row wins the doing field; a hive is stale only when ALL its rows
 *  are. Live hives sort first, then by machine (pui group_hives parity). */
export function groupHives(rows: FederatedRow[]): HiveGroup[] {
  const groups: HiveGroup[] = [];
  for (const r of rows) {
    const key = r.devicePubkey?.trim() || r.host;
    let g = groups.find((x) => x.devicePubkey === key);
    if (!g) {
      g = {
        machine: r.host || key,
        devicePubkey: key,
        users: [],
        harnesses: [],
        doing: '',
        lastSeen: '',
        stale: true,
      };
      groups.push(g);
    }
    if (r.userId && !g.users.includes(r.userId)) g.users.push(r.userId);
    if (r.harnessSlug && !g.harnesses.includes(r.harnessSlug)) g.harnesses.push(r.harnessSlug);
    const ts = r.heartbeatAt ?? '';
    if (ts >= g.lastSeen) {
      g.lastSeen = ts;
      g.doing = r.currentView || r.intent || '';
    }
    g.stale = g.stale && r.stale;
  }
  return groups.sort((a, b) =>
    a.stale === b.stale ? a.machine.localeCompare(b.machine) : a.stale ? 1 : -1,
  );
}

export default function HivesTab({ active }: { active: boolean }) {
  const hiveControlOn = useFlag(FLAGS.HIVE_CONTROL);
  const hives = useSyncQuery<FederatedRow>({
    queryName: 'sidebar.hives',
    enabled: active,
    staleTime: 10_000,
  });

  const groups = useMemo(() => groupHives(hives.data ?? []), [hives.data]);
  const live = groups.filter((g) => !g.stale).length;

  return (
    <div className="pclsb-panel" data-testid="left-sidebar-hives">
      {hiveControlOn && <LocalHivesControl />}
      <div className="pclsb-panel__bar">
        <span className="pclsb-panel__bar-label">
          p2p swarm · {groups.length} joined · {live} live
        </span>
      </div>
      {hives.error && <div className="pclsb-panel__error">{String(hives.error)}</div>}
      {groups.length === 0 && !hives.loading && (
        <div className="pclsb-panel__empty">
          no remote hives in the p2p swarm yet — this hive flies solo
          <br />
          <br />A hive appears here once another Papercusp install joins the substrate and its
          announce lands in shared_presence.
        </div>
      )}
      {groups.map((g) => (
        <div className="pclsb-row" key={g.devicePubkey} data-testid={`hive-${g.machine}`}>
          <span className={`pclsb-dot ${g.stale ? 'is-down' : 'is-up'}`} aria-hidden="true" />
          <div className="pclsb-row__main">
            <div className="pclsb-row__title" title={g.devicePubkey}>
              {g.machine}
              {g.users.length > 0 ? `  ·  gh:${g.users.join(',')}` : ''}
            </div>
            <div className="pclsb-row__sub" title={g.doing}>
              {g.doing || (g.stale ? 'quiet' : 'idle')}
              {g.harnesses.length > 0 ? `  ·  [${g.harnesses.join(', ')}]` : ''}
            </div>
          </div>
          {g.stale && <span className="pclsb-pill">stale</span>}
        </div>
      ))}
    </div>
  );
}
