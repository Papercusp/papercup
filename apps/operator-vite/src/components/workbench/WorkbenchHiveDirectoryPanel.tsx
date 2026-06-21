/**
 * WorkbenchHiveDirectoryPanel — the desktop workbench's P2P hive-directory
 * browser (p2p-hive-directory-2026-06-06 P-007).
 *
 * Browses the hives this peer has discovered on the well-known directory topic
 * (GET /api/discovery/hives — the HTTP projection of the directory service) and
 * offers a Join CTA per hive. Joining runs the composed hive-join flow
 * (POST /api/discovery/join-hive — every member link in one call) — so a
 * one-click join needs the hive to carry full member links; a topic-only hive
 * lists fine but its Join is disabled with a "link required" hint (D-002: the
 * directory is discovery; joining still runs the full admission flow).
 *
 * Data-fetch via useEffect + fetch (the loopback /api): the directory is not a
 * sync entity. loading/error/joining are lifecycle state (useState per the nuqs
 * rule). Registered as `workbench:hive-directory` via the workbench route.
 */

'use client';

import { useCallback, useEffect, useState } from 'react';
import { panelRegistry } from '@/app/harness/dock/panel-registry';
import { Tooltip } from '@/app/harness/Tooltip';

interface HiveRow {
  hiveId: string;
  title: string;
  description: string;
  owner: string;
  visibility: 'public' | 'invite';
  memberTopics: string[];
  memberLinks: string[];
  memberCount: number;
  createdAt: number;
  lastSeenMs: number;
}

const fill: React.CSSProperties = { width: '100%', height: '100%', overflow: 'auto', minHeight: 0 };
const mute: React.CSSProperties = {
  color: 'var(--fg-mute, #888)',
  fontSize: 12,
  fontFamily: 'system-ui, sans-serif',
  textAlign: 'center',
  padding: 16,
};
const card: React.CSSProperties = {
  border: '1px solid var(--border, #2a2a2a)',
  borderRadius: 8,
  padding: 12,
  margin: '8px 12px',
  fontFamily: 'system-ui, sans-serif',
};
const headerRow: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'flex-end',
  padding: '8px 12px 0',
};

/** G-003: re-fetch the live directory on this cadence so withdrawn hives drop
 *  out and new announces show up without a panel remount. */
const DIRECTORY_REFRESH_MS = 30_000;

export function WorkbenchHiveDirectoryPanel(): React.ReactElement {
  const [rows, setRows] = useState<HiveRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [joining, setJoining] = useState<string | null>(null);
  const [joinMsg, setJoinMsg] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/discovery/hives');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { rows: HiveRow[] };
      setRows(data.rows ?? []);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setRows([]);
    }
  }, []);

  useEffect(() => {
    void load();
    // G-003 (Brief G): the directory is a LIVE P2P set — a withdrawn/stale hive
    // must disappear and a newly-announced one appear WITHOUT remounting the
    // panel. A single mount-time fetch froze a point-in-time snapshot. Poll to
    // converge automatically; the Refresh button forces it on demand.
    const id = setInterval(() => void load(), DIRECTORY_REFRESH_MS);
    return () => clearInterval(id);
  }, [load]);

  const join = useCallback(async (hive: HiveRow) => {
    if (hive.memberLinks.length === 0) return;
    setJoining(hive.hiveId);
    setJoinMsg((m) => ({ ...m, [hive.hiveId]: 'Joining…' }));
    // P-007 (hive-from-repo-hardening D-007): join the HIVE, not N loose
    // harnesses — one composed call that runs every member join AND
    // materializes the local hive view (grouping/rail/strip on our side).
    try {
      const res = await fetch('/api/discovery/join-hive', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hiveId: hive.hiveId, title: hive.title, memberLinks: hive.memberLinks }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        hiveSlug?: string;
        members?: { ok: boolean }[];
        error?: string;
      };
      const okCount = body.members?.filter((m) => m.ok).length ?? 0;
      setJoinMsg((m) => ({
        ...m,
        [hive.hiveId]:
          res.ok && body.ok
            ? `Joined hive '${body.hiveSlug}' — ${okCount}/${hive.memberLinks.length} member(s)`
            : `Join failed: ${body.error ?? `HTTP ${res.status}`}${okCount ? ` (${okCount} member(s) joined)` : ''}`,
      }));
    } catch (e) {
      setJoinMsg((m) => ({ ...m, [hive.hiveId]: `Join failed: ${e instanceof Error ? e.message : e}` }));
    }
    setJoining(null);
  }, []);

  if (rows === null) return <div style={mute}>Loading the hive directory…</div>;

  const refreshBtn = (
    <div style={headerRow}>
      <Tooltip label="Re-fetch the discovered hives now">
        <button type="button" data-testid="hive-directory-refresh" onClick={() => void load()}>
          Refresh
        </button>
      </Tooltip>
    </div>
  );

  if (error && rows.length === 0) {
    return (
      <div style={fill} data-testid="hive-directory">
        {refreshBtn}
        <div style={mute}>Directory unavailable: {error}</div>
      </div>
    );
  }
  if (rows.length === 0) {
    return (
      <div style={fill} data-testid="hive-directory">
        {refreshBtn}
        <div style={mute}>
          No hives discovered yet. When a peer announces a public hive on the directory topic, it appears here.
        </div>
      </div>
    );
  }

  return (
    <div style={fill} data-testid="hive-directory">
      {refreshBtn}
      {rows.map((h) => {
        const joinable = h.memberLinks.length > 0;
        return (
          <div key={h.hiveId} style={card}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
              <strong>{h.title}</strong>
              <span style={{ fontSize: 11, color: 'var(--fg-mute, #888)' }}>
                {h.visibility} · {h.memberCount} harness{h.memberCount === 1 ? '' : 'es'}
              </span>
            </div>
            {h.description ? <div style={{ fontSize: 13, margin: '4px 0' }}>{h.description}</div> : null}
            <div style={{ fontSize: 11, color: 'var(--fg-mute, #888)' }}>owner: {h.owner}</div>
            <div style={{ marginTop: 8 }}>
              <button
                type="button"
                disabled={!joinable || joining === h.hiveId}
                onClick={() => void join(h)}
                title={joinable ? 'Join every member harness of this hive' : 'This hive published topics only — a full join link is required'}
              >
                {joining === h.hiveId ? 'Joining…' : 'Join'}
              </button>
              {!joinable ? <span style={{ ...mute, padding: 0, marginLeft: 8 }}>link required</span> : null}
              {joinMsg[h.hiveId] ? <span style={{ ...mute, padding: 0, marginLeft: 8 }}>{joinMsg[h.hiveId]}</span> : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}

let registered = false;

/** Register the `workbench:hive-directory` panel type. Idempotent. */
export function registerWorkbenchHiveDirectoryPanel(): void {
  if (registered) return;
  registered = true;
  panelRegistry.register('workbench:hive-directory', WorkbenchHiveDirectoryPanel, {
    keepAlive: true,
    title: 'Hives',
  });
}
