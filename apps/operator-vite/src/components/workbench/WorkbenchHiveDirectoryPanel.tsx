/**
 * WorkbenchHiveDirectoryPanel — the desktop workbench's P2P hive-directory
 * browser (p2p-hive-directory-2026-06-06 P-007).
 *
 * Browses the hives this peer has discovered on the well-known directory topic
 * (GET /api/discovery/hives — the HTTP projection of the directory service) and
 * offers a Join CTA per hive. Joining runs the EXISTING join-shared-harness
 * flow (POST /api/harness/join-link) once per member link — so a one-click join
 * needs the hive to carry full member links; a topic-only hive lists fine but
 * its Join is disabled with a "link required" hint (D-002: the directory is
 * discovery; joining still runs the full admission flow).
 *
 * Data-fetch via useEffect + fetch (the loopback /api): the directory is not a
 * sync entity. loading/error/joining are lifecycle state (useState per the nuqs
 * rule). Registered as `workbench:hive-directory` via the workbench route.
 */

'use client';

import { useCallback, useEffect, useState } from 'react';
import { panelRegistry } from '@/app/harness/dock/panel-registry';

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
  }, [load]);

  const join = useCallback(async (hive: HiveRow) => {
    if (hive.memberLinks.length === 0) return;
    setJoining(hive.hiveId);
    setJoinMsg((m) => ({ ...m, [hive.hiveId]: 'Joining…' }));
    let ok = 0;
    for (let i = 0; i < hive.memberLinks.length; i++) {
      try {
        const res = await fetch('/api/harness/join-link', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ slug: `${hive.hiveId}-${i}`, harnessLinkUrl: hive.memberLinks[i] }),
        });
        if (res.ok) ok += 1;
      } catch {
        /* per-link best-effort */
      }
    }
    setJoinMsg((m) => ({ ...m, [hive.hiveId]: `Joined ${ok}/${hive.memberLinks.length} harness(es)` }));
    setJoining(null);
  }, []);

  if (rows === null) return <div style={mute}>Loading the hive directory…</div>;
  if (error && rows.length === 0) return <div style={mute}>Directory unavailable: {error}</div>;
  if (rows.length === 0) {
    return (
      <div style={mute}>
        No hives discovered yet. When a peer announces a public hive on the directory topic, it appears here.
      </div>
    );
  }

  return (
    <div style={fill} data-testid="hive-directory">
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
