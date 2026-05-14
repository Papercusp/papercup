'use client';

import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { useConfirmDialog } from './useConfirmDialog';
import { useSyncQuery } from '@restart/sync';
import { Modal } from './Modal';
import { RichGrid, type ColumnDef } from '@restart/grid-core';
import { Checkbox } from './Checkbox';
import type { SnapshotConsolidatedRow } from '@restart/zero-harness';

interface Snapshot {
  id: string;
  ts: number;
  iterNum: number;
  files: string[];
  featureCounts: Record<string, number>;
}

type LocalSnapshotRow = {
  snapshotId: string; ts: number | string; iterNum?: number | string;
  files?: unknown; featureCounts?: unknown;
};
function rowToSnapshot(rRaw: SnapshotConsolidatedRow): Snapshot {
  const r = rRaw as unknown as LocalSnapshotRow;
  return {
    id: r.snapshotId,
    ts: Number(r.ts) || 0,
    iterNum: Number(r.iterNum) || 0,
    files: (r.files as string[]) ?? [],
    featureCounts: (r.featureCounts as Record<string, number>) ?? {},
  };
}

interface Props {
  slug: string;
  onClose: () => void;
  onRestored: () => void;
}

const STATUS_COLOR: Record<string, string> = {
  todo: 'var(--fg-mute)',
  in_progress: '#3b82f6',
  validating: '#a855f7',
  failing: 'var(--bad)',
  blocked: 'var(--warn)',
  passed: 'var(--good)',
};

function fmtTs(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function SnapshotsPanelInner({ slug, onClose, onRestored }: Props) {
  // Snapshots stream live from Zero (`harness_<slug>.harness_snapshots`).
  // Polling /api/harness/<slug>/snapshots stays as a sync ping that triggers
  // the FS scan + PG dual-write on the server.
  // Slug-agnostic Zero query (Migration 031).
  const { data: zeroRows, loading } = useSyncQuery<SnapshotConsolidatedRow>({
    queryName: 'snapshotsConsolidated.bySlug',
    args: { harnessSlug: slug },
  });
  const snapshots: Snapshot[] = useMemo(() => {
    if (loading || !Array.isArray(zeroRows)) return [];
    return zeroRows.map(rowToSnapshot);
  }, [zeroRows, loading]);

  const [selected, setSelected] = useState<Snapshot | null>(null);
  const [includeNotes, setIncludeNotes] = useState(true);
  const [includeConfig, setIncludeConfig] = useState(true);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const { confirm: askConfirm, element: confirmEl } = useConfirmDialog();

  const load = useCallback(async () => {
    // Sync ping — server scans FS + dual-writes to PG. Zero subscription
    // delivers the resulting rows back to this panel.
    try {
      await fetch(`/api/harness/${slug}/snapshots`);
    } catch (e) {
      setToast(`load failed: ${e}`);
    }
  }, [slug]);

  useEffect(() => {
    load();
    // 30s, not 5s: snapshots write per-iteration (~minutes apart). Zero
    // pushes the row the moment dual-write lands, so the only role of
    // this poll is to trigger the server-side FS scan + dual-write at
    // a cadence that's not wasteful while the panel is open.
    const t = setInterval(load, 30000);
    return () => clearInterval(t);
  }, [load]);

  const restore = useCallback(async () => {
    if (!selected) return;
    const overwriteList = [
      'harness_features (Postgres)',
      'validation-contract.md',
      includeNotes ? 'supervisor-notes.md' : null,
      includeConfig ? 'config.json' : null,
    ].filter(Boolean).join(', ');
    if (!await askConfirm({
      title: `Restore from snapshot ${selected.id}?`,
      body: <>Current state will be overwritten: <code style={{ fontSize: 11 }}>{overwriteList}</code></>,
      confirmLabel: 'Restore',
      destructive: true,
    })) return;
    setBusy(true);
    try {
      const r = await fetch(`/api/harness/${slug}/snapshots/${selected.id}/restore`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ includeSupervisorNotes: includeNotes, includeConfig }),
      });
      if (!r.ok) throw new Error(`${r.status}: ${await r.text()}`);
      const d = await r.json();
      setToast(`restored: ${d.restored.join(', ')}`);
      onRestored();
      setTimeout(() => { setToast(null); onClose(); }, 900);
    } catch (e) {
      setToast(`restore failed: ${e}`);
      setTimeout(() => setToast(null), 3000);
    } finally {
      setBusy(false);
    }
  }, [selected, includeNotes, includeConfig, slug, onRestored, onClose, askConfirm]);

  const remove = useCallback(async (id: string) => {
    if (!await askConfirm({
      title: `Delete snapshot ${id}?`,
      body: 'Cannot be undone.',
      confirmLabel: 'Delete',
      destructive: true,
    })) return;
    setBusy(true);
    try {
      const r = await fetch(`/api/harness/${slug}/snapshots/${id}`, { method: 'DELETE' });
      if (!r.ok) throw new Error(`${r.status}: ${await r.text()}`);
      if (selected?.id === id) setSelected(null);
      await load();
    } catch (e) {
      setToast(`delete failed: ${e}`);
      setTimeout(() => setToast(null), 2500);
    } finally {
      setBusy(false);
    }
  }, [slug, selected, load, askConfirm]);

  return (
    <Modal
      open
      onOpenChange={(o) => { if (!o) onClose(); }}
      title={`Snapshots`}
      srOnlyTitle
      zIndex={60}
      contentStyle={{ background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 6, width: '80vw', maxWidth: 1100, height: '75vh', display: 'flex', flexDirection: 'column', overflow: 'hidden', fontFamily: 'system-ui, sans-serif', color: 'var(--fg)' }}
    >
        {confirmEl}
        {/* Header */}
        <div style={{ padding: '0.6rem 1rem', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <strong>Snapshots — {slug}</strong>
          <span style={{ fontFamily: 'monospace', color: 'var(--fg-mute)', fontSize: '0.75rem' }}>.harness/snapshots/</span>
          <span style={{ marginLeft: 'auto', fontSize: '0.75rem', color: 'var(--fg-mute)' }}>live (Zero)</span>
          {toast && (
            <span style={{ color: /failed/i.test(toast) ? 'var(--bad)' : 'var(--good)', fontSize: '0.8rem' }}>{toast}</span>
          )}
          <button
            onClick={onClose}
            style={{ background: 'transparent', color: 'var(--fg-mute)', border: '1px solid var(--border)', borderRadius: 3, padding: '0.35rem 0.75rem', cursor: 'pointer', fontSize: '0.8rem' }}
          >
            close
          </button>
        </div>

        <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
          {/* List */}
          <div style={{ flex: '0 0 55%', borderRight: '1px solid var(--border)', overflow: 'auto' }}>
            {snapshots.length === 0 ? (
              <div style={{ padding: '2rem', color: 'var(--fg-mute)', textAlign: 'center' }}>
                No snapshots yet. Each iteration of the main loop creates one.
              </div>
            ) : (
              <SnapshotsGrid
                snapshots={snapshots}
                selected={selected}
                onSelect={setSelected}
                onRemove={remove}
                busy={busy}
              />
            )}
          </div>

          {/* Detail */}
          <div style={{ flex: 1, padding: '1rem', overflow: 'auto', display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            {selected ? (
              <>
                <div>
                  <div style={{ fontSize: '0.7rem', color: 'var(--fg-mute)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Snapshot</div>
                  <div style={{ fontFamily: 'monospace', fontSize: '0.85rem', marginTop: '0.25rem' }}>{selected.id}</div>
                  <div style={{ color: 'var(--fg-mute)', fontSize: '0.75rem', marginTop: '0.2rem' }}>
                    iteration <b style={{ color: 'var(--fg)' }}>{selected.iterNum}</b> · {fmtTs(selected.ts)}
                  </div>
                </div>

                <div>
                  <div style={{ fontSize: '0.7rem', color: 'var(--fg-mute)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.3rem' }}>Files captured</div>
                  {selected.files.map((f) => (
                    <div key={f} style={{ fontFamily: 'monospace', fontSize: '0.75rem', color: 'var(--fg-dim)' }}>· {f}</div>
                  ))}
                </div>

                <div>
                  <div style={{ fontSize: '0.7rem', color: 'var(--fg-mute)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.3rem' }}>Restore options</div>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.8rem', color: 'var(--fg-dim)', cursor: selected.files.includes('supervisor-notes.md') ? 'pointer' : 'not-allowed', opacity: selected.files.includes('supervisor-notes.md') ? 1 : 0.5 }}>
                    <Checkbox
                      checked={includeNotes && selected.files.includes('supervisor-notes.md')}
                      disabled={!selected.files.includes('supervisor-notes.md')}
                      onChange={setIncludeNotes}
                      ariaLabel="Include supervisor-notes.md"
                    />
                    also restore supervisor-notes.md
                  </label>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.8rem', color: 'var(--fg-dim)', cursor: selected.files.includes('config.json') ? 'pointer' : 'not-allowed', opacity: selected.files.includes('config.json') ? 1 : 0.5 }}>
                    <Checkbox
                      checked={includeConfig && selected.files.includes('config.json')}
                      disabled={!selected.files.includes('config.json')}
                      onChange={setIncludeConfig}
                      ariaLabel="Include config.json"
                    />
                    also restore config.json (per-role models)
                  </label>
                  <div style={{ marginTop: '0.25rem', color: 'var(--fg-mute)', fontSize: '0.7rem' }}>
                    features (harness_features rows) and validation-contract.md are always restored when present.
                  </div>
                </div>

                <button
                  onClick={restore}
                  disabled={busy}
                  style={{
                    background: '#b45309', color: 'white', border: '1px solid #d97706',
                    borderRadius: 3, padding: '0.5rem 1rem',
                    cursor: busy ? 'wait' : 'pointer', fontWeight: 600, fontSize: '0.85rem',
                    marginTop: '0.5rem',
                  }}
                >
                  {busy ? '…' : '↻ restore mission state'}
                </button>

                <div style={{ fontSize: '0.7rem', color: 'var(--fg-mute)', marginTop: '0.25rem' }}>
                  This overwrites current state with the snapshot. If the harness is running, the next iteration will read the restored files.
                </div>
              </>
            ) : (
              <div style={{ color: 'var(--fg-mute)', textAlign: 'center', marginTop: '20%' }}>
                Select a snapshot to see restore options.
              </div>
            )}
          </div>
        </div>
      </Modal>
  );
}

function SnapshotsGrid({
  snapshots, selected, onSelect, onRemove, busy,
}: {
  snapshots: Snapshot[];
  selected: Snapshot | null;
  onSelect: (s: Snapshot) => void;
  onRemove: (id: string) => void;
  busy: boolean;
}) {
  const columns: ColumnDef<Snapshot>[] = useMemo(
    () => [
      {
        key: 'when',
        header: 'When',
        width: 1.3,
        sortKey: 'ts',
        defaultSortDir: 'desc',
        render: ({ row }) => <span style={{ color: 'var(--fg-mute)' }}>{fmtTs(row.ts)}</span>,
      },
      {
        key: 'iter',
        header: 'Iter',
        width: 0.4,
        align: 'right',
        sortKey: 'iterNum',
        render: ({ row }) => <span style={{ fontFamily: 'monospace' }}>{row.iterNum}</span>,
      },
      {
        key: 'featureCounts',
        header: 'Feature counts',
        width: 3,
        render: ({ row }) => (
          <div style={{ display: 'flex', gap: '0.35rem', flexWrap: 'wrap' }}>
            {Object.entries(row.featureCounts).map(([status, n]) => (
              <span
                key={status}
                style={{
                  fontSize: '0.65rem',
                  padding: '0.1rem 0.4rem',
                  borderRadius: 3,
                  background: STATUS_COLOR[status] ?? '#374151',
                  color: 'white',
                  fontWeight: 600,
                }}
                title={`${status}: ${n}`}
              >
                {status.slice(0, 4)} {n}
              </span>
            ))}
          </div>
        ),
      },
      {
        key: 'action',
        header: '',
        width: 0.6,
        align: 'right',
        render: ({ row }) => (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onRemove(row.id);
            }}
            disabled={busy}
            style={{
              background: 'transparent',
              color: 'var(--fg-mute)',
              border: '1px solid var(--border)',
              borderRadius: 3,
              padding: '0.1rem 0.45rem',
              cursor: 'pointer',
              fontSize: '0.7rem',
            }}
            title="Delete this snapshot"
          >
            delete
          </button>
        ),
      },
    ],
    [onRemove, busy],
  );
  const richGetRowBg = (row: Snapshot) => (selected?.id === row.id ? '#1f2937' : 'transparent');
  return (
    <RichGrid<Snapshot>
      rows={snapshots}
      columns={columns}
      getRowId={(s) => s.id}
      onRowClick={onSelect}
      getRowBg={richGetRowBg}
      inline
    />
  );
}

const SnapshotsPanel = memo(SnapshotsPanelInner);
export default SnapshotsPanel;
