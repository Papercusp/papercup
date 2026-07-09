'use client';

/**
 * FleetStatusPanel — papercusp fleet status at a glance
 * (platform-ops-batch-2026-07-09 P-004). Reads via `@papercusp/sync`
 * (fleet.status), never a hand-rolled fetch/poll — the resolver reuses
 * the same presence-snapshot assembly coord:presence/coord:inbox share,
 * so this panel never diverges from the live coordination roster.
 */
import { useSyncQuery } from '@papercusp/sync';

interface FleetStatusRow {
  ownerId: string;
  label: string;
  role: string | null;
  intent: string | null;
  planSlug: string | null;
  potSlug: string | null;
  fleetSlug: string | null;
  fleetRole: string | null;
  sessionState: string | null;
  lastActiveSecAgo: number | null;
}

function formatLastActive(secAgo: number | null): string {
  if (secAgo == null) return 'unknown';
  if (secAgo < 60) return `${Math.round(secAgo)}s ago`;
  if (secAgo < 3600) return `${Math.round(secAgo / 60)}m ago`;
  return `${Math.round(secAgo / 3600)}h ago`;
}

export default function FleetStatusPanel() {
  const { data, error, loading } = useSyncQuery<FleetStatusRow>({
    queryName: 'fleet.status',
    args: {},
  });

  if (loading) {
    return (
      <div className="pc-fleet-status" role="status">
        Loading fleet status…
      </div>
    );
  }
  if (error) {
    return (
      <div className="pc-fleet-status pc-fleet-status--error" role="status">
        Fleet status unavailable — {String(error)}
      </div>
    );
  }
  const rows = data ?? [];
  if (rows.length === 0) {
    return (
      <div className="pc-fleet-status" role="status">
        No live agents right now.
      </div>
    );
  }

  return (
    <table className="pc-fleet-status">
      <caption>{rows.length} live agent{rows.length === 1 ? '' : 's'}</caption>
      <thead>
        <tr>
          <th scope="col">Agent</th>
          <th scope="col">Role</th>
          <th scope="col">Fleet</th>
          <th scope="col">Current claim</th>
          <th scope="col">State</th>
          <th scope="col">Last activity</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.ownerId}>
            <td>{row.label}</td>
            <td>{row.role ?? '—'}</td>
            <td>{row.fleetSlug ? `${row.fleetSlug}${row.fleetRole ? ` (${row.fleetRole})` : ''}` : '—'}</td>
            <td>{row.planSlug ?? row.intent ?? '—'}</td>
            <td>{row.sessionState ?? '—'}</td>
            <td>{formatLastActive(row.lastActiveSecAgo)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
