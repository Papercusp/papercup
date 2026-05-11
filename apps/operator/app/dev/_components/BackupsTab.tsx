'use client';

/**
 * /dev → Backups tab.
 *
 * Custom metric bar + kopia's web UI in an iframe + restore-to-clone
 * panel + failure log. The timeline / diff explorer / live progress
 * come for free from kopia's UI; we wrap rather than rebuild.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import type { RepoStats, SnapshotInfo } from '@/lib/backup';

interface ServerInfo { workspaceId: string; port: number; url: string; startedAt: string; }

function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n; let i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v < 10 ? 2 : 1)} ${u[i]}`;
}
function fmtAgo(iso: string | null): string {
  if (!iso) return '—';
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h`;
  return `${Math.round(ms / 86_400_000)}d`;
}

export default function BackupsTab() {
  const [stats, setStats] = useState<RepoStats | null>(null);
  const [snapshots, setSnapshots] = useState<SnapshotInfo[]>([]);
  const [failures, setFailures] = useState<SnapshotInfo[]>([]);
  const [server, setServer] = useState<ServerInfo | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [restorePick, setRestorePick] = useState<string>('');
  const iframeRef = useRef<HTMLIFrameElement>(null);

  const load = useCallback(async () => {
    try {
      const [a, b, c] = await Promise.all([
        fetch('/api/backups').then((r) => r.json()),
        fetch('/api/backups/snapshots?limit=200').then((r) => r.json()),
        fetch('/api/backups/failures?limit=50').then((r) => r.json()),
      ]);
      setStats(a.stats);
      setSnapshots(b.snapshots ?? []);
      setFailures(c.failures ?? []);
    } catch (err) {
      toast.error(`load failed: ${(err as Error).message}`);
    }
  }, []);

  const startServer = useCallback(async () => {
    try {
      const r = await fetch('/api/backups/server');
      if (!r.ok) throw new Error((await r.json()).error ?? `HTTP ${r.status}`);
      const d = await r.json() as { server: ServerInfo };
      setServer(d.server);
    } catch (err) {
      toast.error(`server start: ${(err as Error).message}`);
    }
  }, []);

  useEffect(() => { load(); startServer(); }, [load, startServer]);
  useEffect(() => {
    const t = setInterval(load, 15_000);
    return () => clearInterval(t);
  }, [load]);

  const fire = useCallback(async (label: string, fn: () => Promise<Response>) => {
    setBusy(label);
    try {
      const r = await fn();
      if (!r.ok) throw new Error((await r.json()).error ?? `HTTP ${r.status}`);
      toast.success(`${label} ok`);
      await load();
    } catch (err) {
      toast.error(`${label} failed: ${(err as Error).message}`);
    } finally {
      setBusy(null);
    }
  }, [load]);

  const snapshotNow = () => fire('snapshot',
    () => fetch('/api/backups/snapshots', { method: 'POST', body: JSON.stringify({ reason: 'manual' }), headers: { 'content-type': 'application/json' } }));
  const maintenanceQuick = () => fire('quick maintenance',
    () => fetch('/api/backups/maintenance', { method: 'POST', body: JSON.stringify({ level: 'quick' }), headers: { 'content-type': 'application/json' } }));
  const maintenanceFull = () => fire('full maintenance',
    () => fetch('/api/backups/maintenance', { method: 'POST', body: JSON.stringify({ level: 'full' }), headers: { 'content-type': 'application/json' } }));
  const verify = () => fire('verify',
    () => fetch('/api/backups/verify', { method: 'POST' }));

  const doRestore = useCallback(async () => {
    if (!restorePick) return;
    setBusy('restore');
    try {
      const r = await fetch('/api/backups/restore', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kopiaSnapshotId: restorePick }),
      });
      if (!r.ok) throw new Error((await r.json()).error ?? `HTTP ${r.status}`);
      const d = await r.json() as { result: { targetPath: string } };
      toast.success(`restored to ${d.result.targetPath}`);
    } catch (err) {
      toast.error(`restore failed: ${(err as Error).message}`);
    } finally {
      setBusy(null);
    }
  }, [restorePick]);

  const restoreOptions = useMemo(
    () => snapshots.filter((s) => s.kopiaSnapshotId && s.status === 'ok'),
    [snapshots],
  );

  return (
    <div className="pc-dev-backups">
      <div className="pc-dev-backups-metrics">
        <Metric label="Snapshots" value={stats?.totalSnapshots.toLocaleString() ?? '—'} />
        <Metric label="On disk" value={stats ? fmtBytes(stats.bytesOnDisk) : '—'} />
        <Metric label="Raw" value={stats ? fmtBytes(stats.bytesRaw) : '—'} />
        <Metric label="Dedup" value={stats ? `${(stats.dedupRatio * 100).toFixed(0)}%` : '—'} />
        <Metric label="Last ok" value={fmtAgo(stats?.lastSnapshotAt ?? null)} />
        <Metric label="Last fail" value={fmtAgo(stats?.lastFailureAt ?? null)} highlight={!!stats?.lastFailureAt} />
      </div>

      <div className="pc-dev-backups-actions">
        <button type="button" disabled={!!busy} onClick={snapshotNow}>Snapshot now</button>
        <button type="button" disabled={!!busy} onClick={maintenanceQuick}>Quick maintenance</button>
        <button type="button" disabled={!!busy} onClick={maintenanceFull}>Full maintenance</button>
        <button type="button" disabled={!!busy} onClick={verify}>Verify</button>
        <button type="button" onClick={() => iframeRef.current?.contentWindow?.location.reload()}>Reload kopia UI</button>
      </div>

      {server && (
        <iframe
          ref={iframeRef}
          className="pc-dev-backups-iframe"
          src={server.url}
          title="kopia"
        />
      )}

      <section className="pc-dev-backups-restore">
        <h3>Restore (to clone, never overwrites)</h3>
        <select value={restorePick} onChange={(e) => setRestorePick(e.target.value)}>
          <option value="">— pick a snapshot —</option>
          {restoreOptions.map((s) => (
            <option key={s.id} value={s.kopiaSnapshotId ?? ''}>
              {s.startedAt.replace('T', ' ').slice(0, 19)} · {s.triggerReason} · {fmtBytes(s.bytesAdded ?? 0)}
            </option>
          ))}
        </select>
        <button type="button" disabled={!restorePick || busy === 'restore'} onClick={doRestore}>
          {busy === 'restore' ? 'Restoring…' : 'Restore to clone'}
        </button>
        <p className="pc-dev-backups-note">
          Restores into <code>&lt;workspace&gt;/.restored/&lt;snapshot-id&gt;/</code>.
          Live workspace is untouched until you explicitly promote.
        </p>
      </section>

      {failures.length > 0 && (
        <section className="pc-dev-backups-failures">
          <h3>Recent failures ({failures.length})</h3>
          <ul>
            {failures.map((f) => (
              <li key={f.id}>
                <strong>{f.startedAt.replace('T', ' ').slice(0, 19)}</strong>
                {' · '}
                {f.triggerReason}
                {f.error && <pre>{f.error}</pre>}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function Metric({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div className={`pc-dev-backups-metric${highlight ? ' pc-dev-backups-metric-highlight' : ''}`}>
      <span className="pc-dev-backups-metric-label">{label}</span>
      <span className="pc-dev-backups-metric-value">{value}</span>
    </div>
  );
}
