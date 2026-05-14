'use client';

import { useCallback, useMemo, useRef, useState } from 'react';
import { useConfirmDialog } from './useConfirmDialog';
import { useSyncQuery } from '@restart/sync';
import { Modal } from './Modal';

interface ScreenshotItem {
  id: string;
  sizeBytes: number;
  ts: number;
}

// Row shape from harness_shared.harness_screenshots (mirrored metadata
// only; image bytes still served by /screenshots/<id> REST).
type HarnessScreenshotRow = {
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
}

function fmtTs(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function fmtSize(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(2)}MB`;
}

export default function ScreenshotsPanel({ slug, onClose }: Props) {
  const [selected, setSelected] = useState<ScreenshotItem | null>(null);
  const [uploading, setUploading] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { confirm: askConfirm, element: confirmEl } = useConfirmDialog();

  // Live-pushed via Zero (harness_shared.harness_screenshots, mirrored from
  // .harness/screenshots/* by harness-fs-watcher.ts). Replaces
  // useSseOrPoll(/screenshots/sse, load, 5000).
  const { data: screenshotRows } = useSyncQuery<HarnessScreenshotRow>({
    queryName: 'harnessScreenshots.byHarness',
    args: { harnessSlug: slug, phase: 'staging' },
  });
  const items = useMemo<ScreenshotItem[]>(
    () => (screenshotRows ?? []).map((r) => ({ id: r.id, sizeBytes: r.sizeBytes, ts: r.ts })),
    [screenshotRows],
  );

  const upload = useCallback(async (file: File) => {
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('name', file.name);
      const r = await fetch(`/api/harness/${slug}/screenshots`, { method: 'POST', body: fd });
      if (!r.ok) throw new Error(`${r.status}: ${await r.text()}`);
      setToast(`uploaded ${file.name}`);
      // Zero pushes the new row once chokidar mirrors the file.
    } catch (e) {
      setToast(`upload failed: ${e}`);
    } finally {
      setUploading(false);
      setTimeout(() => setToast(null), 2500);
    }
  }, [slug]);

  const remove = useCallback(async (id: string) => {
    if (!await askConfirm({
      title: `Delete screenshot ${id}?`,
      body: 'The image is removed from .harness/screenshots/.',
      confirmLabel: 'Delete',
      destructive: true,
    })) return;
    try {
      const r = await fetch(`/api/harness/${slug}/screenshots/${id}`, { method: 'DELETE' });
      if (!r.ok) throw new Error(`${r.status}: ${await r.text()}`);
      if (selected?.id === id) setSelected(null);
      // Zero pushes the deletion once chokidar fires the unlink event.
    } catch (e) {
      setToast(`delete failed: ${e}`);
      setTimeout(() => setToast(null), 2500);
    }
  }, [slug, selected, askConfirm]);

  return (
    <>
    {confirmEl}
    <Modal
      open
      onOpenChange={(o) => { if (!o) onClose(); }}
      title={`Screenshots`}
      srOnlyTitle
      zIndex={60}
      contentStyle={{ background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 6, width: '85vw', maxWidth: 1200, height: '85vh', display: 'flex', flexDirection: 'column', overflow: 'hidden', fontFamily: 'system-ui, sans-serif', color: 'var(--fg)' }}
    >
        {/* Header */}
        <div style={{ padding: '0.6rem 1rem', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <strong>Screenshots — {slug}</strong>
          <span style={{ fontFamily: 'monospace', color: 'var(--fg-mute)', fontSize: '0.75rem' }}>.harness/screenshots/</span>
          <span style={{ fontSize: '0.7rem', color: 'var(--fg-mute)' }}>{items.length} items</span>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp"
            style={{ display: 'none' }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) upload(f);
              if (fileInputRef.current) fileInputRef.current.value = '';
            }}
          />
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
            style={{ background: 'var(--bg-2)', color: 'var(--fg)', border: '1px solid var(--border)', borderRadius: 3, padding: '0.3rem 0.65rem', cursor: uploading ? 'wait' : 'pointer', fontSize: '0.75rem' }}
          >
            {uploading ? 'uploading…' : '＋ upload'}
          </button>
          {toast && (
            <span style={{ color: /failed/i.test(toast) ? 'var(--bad)' : 'var(--good)', fontSize: '0.8rem' }}>{toast}</span>
          )}
          <button
            onClick={onClose}
            style={{ marginLeft: 'auto', background: 'transparent', color: 'var(--fg-mute)', border: '1px solid var(--border)', borderRadius: 3, padding: '0.35rem 0.75rem', cursor: 'pointer', fontSize: '0.8rem' }}
          >
            close
          </button>
        </div>

        <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
          {/* Grid */}
          <div style={{ flex: '1 1 60%', overflow: 'auto', padding: '1rem', borderRight: '1px solid var(--border)' }}>
            {items.length === 0 ? (
              <div style={{ color: 'var(--fg-mute)', textAlign: 'center', marginTop: '20%' }}>
                No screenshots yet. Upload via the button above or drop files into <code>.harness/screenshots/</code>.
                <div style={{ marginTop: '1rem', fontSize: '0.75rem' }}>
                  A <code>post-worker.sh</code> hook can capture them automatically:<br/>
                  <pre style={{ background: 'var(--bg-2)', padding: '0.6rem', borderRadius: 4, marginTop: '0.5rem', textAlign: 'left', display: 'inline-block' }}>
verdict screenshot http://localhost:5173 {'>'} "$STATE_DIR/screenshots/$FEATURE_ID.png"
                  </pre>
                </div>
              </div>
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: '0.75rem' }}>
                {items.map((it) => {
                  const isSelected = selected?.id === it.id;
                  return (
                    <div
                      key={it.id}
                      onClick={() => setSelected(it)}
                      style={{
                        cursor: 'pointer',
                        border: `1px solid ${isSelected ? '#3b82f6' : '#1f2937'}`,
                        borderRadius: 4,
                        overflow: 'hidden',
                        background: 'var(--bg-2)',
                      }}
                    >
                      <img
                        src={`/api/harness/${slug}/screenshots/${it.id}`}
                        alt={it.id}
                        style={{ width: '100%', height: 140, objectFit: 'cover', display: 'block', background: '#000' }}
                        loading="lazy"
                      />
                      <div style={{ padding: '0.4rem 0.5rem', fontSize: '0.7rem' }}>
                        <div style={{ fontFamily: 'monospace', color: 'var(--fg-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={it.id}>
                          {it.id}
                        </div>
                        <div style={{ color: 'var(--fg-mute)', marginTop: '0.2rem' }}>
                          {fmtTs(it.ts)} · {fmtSize(it.sizeBytes)}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Detail */}
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
            {selected ? (
              <>
                <div style={{ padding: '0.5rem 0.75rem', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <code style={{ fontSize: '0.8rem', color: 'var(--fg)' }}>{selected.id}</code>
                  <span style={{ fontSize: '0.7rem', color: 'var(--fg-mute)' }}>{fmtSize(selected.sizeBytes)} · {fmtTs(selected.ts)}</span>
                  <button
                    onClick={() => remove(selected.id)}
                    style={{ marginLeft: 'auto', background: 'transparent', color: 'var(--bad)', border: '1px solid #7f1d1d', borderRadius: 3, padding: '0.25rem 0.65rem', cursor: 'pointer', fontSize: '0.7rem' }}
                  >
                    delete
                  </button>
                  <a
                    href={`/api/harness/${slug}/screenshots/${selected.id}`}
                    target="_blank"
                    rel="noreferrer"
                    style={{ background: 'transparent', color: 'var(--fg-mute)', border: '1px solid var(--border)', borderRadius: 3, padding: '0.25rem 0.65rem', fontSize: '0.7rem', textDecoration: 'none' }}
                  >
                    open
                  </a>
                </div>
                <div style={{ flex: 1, overflow: 'auto', background: '#000', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <img
                    src={`/api/harness/${slug}/screenshots/${selected.id}`}
                    alt={selected.id}
                    style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }}
                  />
                </div>
              </>
            ) : (
              <div style={{ color: 'var(--fg-mute)', textAlign: 'center', marginTop: '30%' }}>
                Click a thumbnail to view full-size.
              </div>
            )}
          </div>
        </div>
      </Modal>
    </>
  );
}
