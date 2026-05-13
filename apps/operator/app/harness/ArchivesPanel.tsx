'use client';

import { useCallback, useMemo, useState } from 'react';
import { useConfirmDialog } from './useConfirmDialog';
import { useSyncQuery } from '@restart/sync';
import { Modal } from './Modal';
import { RichGrid, type ColumnDef } from '@restart/grid-core';
import { Checkbox } from './Checkbox';

interface Archive {
  id: string;
  sizeBytes: number;
  ts: number;
}

// Row shape from the harness_shared.harness_archives Zero query.
type HarnessArchiveRow = {
  harnessSlug: string;
  phase: string;
  id: string;
  sizeBytes: number;
  ts: number;
  workspaceId: string;
};

interface Props {
  slug: string;
  onClose: () => void;
  onChanged: () => void;
}

function fmtTs(ts: number): string {
  return new Date(ts).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
function fmtSize(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(2)}MB`;
}

export default function ArchivesPanel({ slug, onClose, onChanged }: Props) {
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [resetOnArchive, setResetOnArchive] = useState(false);
  const { confirm: askConfirm, element: confirmEl } = useConfirmDialog();

  // Live-pushed via Zero (harness_shared.harness_archives, mirrored from
  // .harness/archives/*.tar.gz by harness-fs-watcher.ts). Replaces the
  // useSseOrPoll(/archives/sse, load, 5000) pattern; mutations still use
  // the existing REST routes below.
  const { data: archiveRows } = useSyncQuery<HarnessArchiveRow>({
    queryName: 'harnessArchives.byHarness',
    args: { harnessSlug: slug, phase: 'staging' },
  });
  const items = useMemo<Archive[]>(
    () => (archiveRows ?? []).map((r) => ({ id: r.id, sizeBytes: r.sizeBytes, ts: r.ts })),
    [archiveRows],
  );

  const archive = useCallback(async () => {
    if (resetOnArchive && !await askConfirm({
      title: 'Archive AND reset .harness/?',
      body: 'Archives the current mission state, then resets .harness/ for a fresh mission. Transient files are removed (config.json, hooks/, knowledge.md preserved).',
      confirmLabel: 'Archive & reset',
      destructive: true,
    })) return;
    setBusy(true);
    try {
      const r = await fetch(`/api/harness/${slug}/archive`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reset: resetOnArchive }),
      });
      if (!r.ok) throw new Error(`${r.status}: ${await r.text()}`);
      const d = await r.json();
      setToast(`archived ${d.id} (${fmtSize(d.sizeBytes)})${d.reset ? ` · reset: ${d.resetRemoved?.join(', ')}` : ''}`);
      onChanged();
      // Zero pushes the new row once chokidar mirrors the file — no manual reload.
    } catch (e) {
      setToast(`archive failed: ${e}`);
    } finally {
      setBusy(false);
      setTimeout(() => setToast(null), 3500);
    }
  }, [slug, resetOnArchive, onChanged, askConfirm]);

  const restore = useCallback(async (id: string) => {
    if (!await askConfirm({
      title: `Restore from archive ${id}?`,
      body: 'Current .harness/ will be overwritten. A pre-restore snapshot is created first.',
      confirmLabel: 'Restore',
      destructive: true,
    })) return;
    setBusy(true);
    try {
      const r = await fetch(`/api/harness/${slug}/archives/${id}/restore`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ confirm: true }),
      });
      if (!r.ok) throw new Error(`${r.status}: ${await r.text()}`);
      const d = await r.json();
      setToast(`restored from ${d.restored} (undo: ${d.undoSnapshot})`);
      onChanged();
      // Zero pushes the (potentially new) snapshot rows on the next mirror tick.
    } catch (e) {
      setToast(`restore failed: ${e}`);
    } finally {
      setBusy(false);
      setTimeout(() => setToast(null), 3500);
    }
  }, [slug, onChanged, askConfirm]);

  return (
    <Modal
      open
      onOpenChange={(o) => { if (!o) onClose(); }}
      title={`Archives`}
      srOnlyTitle
      zIndex={60}
      contentStyle={{ background: '#0b0e14', border: '1px solid #374151', borderRadius: 6, width: '70vw', maxWidth: 900, height: '70vh', display: 'flex', flexDirection: 'column', overflow: 'hidden', fontFamily: 'system-ui, sans-serif', color: '#e5e7eb' }}
    >
        {confirmEl}
        <div style={{ padding: '0.6rem 1rem', borderBottom: '1px solid #1f2937', display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <strong>Archives — {slug}</strong>
          <span style={{ fontFamily: 'monospace', color: '#6b7280', fontSize: '0.75rem' }}>.harness/archives/</span>
          <span style={{ fontSize: '0.7rem', color: '#6b7280' }}>{items.length} archive(s)</span>
          {toast && (
            <span style={{ color: /failed/i.test(toast) ? '#f87171' : '#10b981', fontSize: '0.75rem' }}>{toast}</span>
          )}
          <button
            onClick={onClose}
            style={{ marginLeft: 'auto', background: 'transparent', color: '#9ca3af', border: '1px solid #374151', borderRadius: 3, padding: '0.35rem 0.75rem', cursor: 'pointer', fontSize: '0.8rem' }}
          >
            close
          </button>
        </div>

        <div style={{ padding: '0.75rem 1rem', borderBottom: '1px solid #1f2937', display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.8rem', cursor: 'pointer' }}>
            <Checkbox checked={resetOnArchive} onChange={setResetOnArchive} ariaLabel="also reset for fresh mission" />
            also reset for fresh mission
          </label>
          <button
            onClick={archive}
            disabled={busy}
            style={{ marginLeft: 'auto', background: '#2563eb', color: 'white', border: 'none', borderRadius: 3, padding: '0.4rem 1rem', fontWeight: 600, cursor: busy ? 'wait' : 'pointer', fontSize: '0.85rem' }}
          >
            {busy ? 'working…' : `archive ${resetOnArchive ? '+ reset' : ''}`}
          </button>
        </div>

        <div style={{ flex: 1, overflow: 'auto' }}>
          {items.length === 0 ? (
            <div style={{ padding: '2rem', color: '#6b7280', textAlign: 'center' }}>
              No archives yet. Click "archive" above to create one.
            </div>
          ) : (
            <ArchivesGrid items={items} restore={restore} busy={busy} />
          )}
        </div>
      </Modal>
  );
}

function ArchivesGrid({
  items, restore, busy,
}: {
  items: Archive[];
  restore: (id: string) => void;
  busy: boolean;
}) {
  const columns: ColumnDef<Archive>[] = useMemo(
    () => [
      {
        key: 'when',
        header: 'When',
        width: 1.2,
        sortKey: 'ts',
        defaultSortDir: 'desc',
        render: ({ row }) => <span style={{ color: '#9ca3af' }}>{fmtTs(row.ts)}</span>,
      },
      {
        key: 'id',
        header: 'ID',
        width: 2,
        sortKey: 'id',
        render: ({ row }) => <span style={{ fontFamily: 'monospace', color: '#d1d5db' }}>{row.id}</span>,
      },
      {
        key: 'size',
        header: 'Size',
        width: 0.7,
        align: 'right',
        sortKey: 'sizeBytes',
        render: ({ row }) => <span style={{ color: '#6b7280' }}>{fmtSize(row.sizeBytes)}</span>,
      },
      {
        key: 'action',
        header: '',
        width: 0.7,
        align: 'right',
        render: ({ row }) => (
          <button
            onClick={(e) => { e.stopPropagation(); restore(row.id); }}
            disabled={busy}
            style={{ background: 'transparent', color: '#fbbf24', border: '1px solid #78350f', borderRadius: 3, padding: '0.2rem 0.6rem', cursor: busy ? 'wait' : 'pointer', fontSize: '0.75rem' }}
          >
            restore
          </button>
        ),
      },
    ],
    [restore, busy],
  );
  return <RichGrid<Archive> rows={items} columns={columns} getRowId={(a) => a.id} inline />;
}
