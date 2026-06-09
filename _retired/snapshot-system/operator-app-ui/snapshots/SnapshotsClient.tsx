'use client';

import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { RichGrid, type ColumnDef } from '@papercusp/grid-core';
import RouteLink from '../_components/RouteLink';
import { useConfirmDialog } from '../harness/useConfirmDialog';
import { usePromptDialog } from '../harness/usePromptDialog';
import { navigateClient } from '@papercusp/operator-core/lib/client-navigation';

interface PublishRecord {
  slug: string;
  version: string;
  browseUrl: string;
  publishedAtMs: number;
}

interface SnapshotRow {
  id: string;
  harnessSlug: string;
  bytes: number;
  createdAtMs: number;
  name: string;
  description: string | null;
  template: { name: string; version: string };
  filesCount: number;
  excludedCount: number;
  pluginsCount: number;
  partial: boolean;
  license: string;
  redactions: { blockedSecretsTier: string; verifiedHits: number; highRecallHits: number };
  publishes: PublishRecord[];
}

function formatBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
}

function formatDate(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

export default function SnapshotsClient() {
  const [rows, setRows] = useState<SnapshotRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const { confirm: askConfirm, element: confirmEl } = useConfirmDialog();
  const { prompt: askPrompt, element: promptEl } = usePromptDialog();

  const load = async () => {
    setLoading(true);
    try {
      const r = await fetch('/api/snapshots', { cache: 'no-store' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = await r.json();
      setRows(d.snapshots ?? []);
    } catch (e: unknown) {
      toast.error(`load failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, []);

  const onInstantiate = async (row: SnapshotRow) => {
    const proposed = `${row.harnessSlug}-fork-${new Date().toISOString().slice(2, 10).replace(/-/g, '')}`;
    const name = await askPrompt({
      title: 'Instantiate snapshot',
      body: 'Letters, digits, dots, underscores, dashes only. Submit blank to use the auto-generated name.',
      label: 'New harness slug',
      defaultValue: proposed,
      allowEmpty: true,
      submitLabel: 'Instantiate',
    });
    if (name === null) return;
    setBusyId(row.id);
    try {
      const r = await fetch(`/api/snapshots/${row.id}/instantiate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: name?.trim() || undefined }),
      });
      const d = await r.json();
      if (!r.ok || !d.ok) throw new Error(d.error ?? `HTTP ${r.status}`);
      toast.success(`Instantiated as ${d.newSlug}`, {
        description: 'Open the Harnesses tab to find it.',
        action: {
          label: 'Open',
          onClick: () => { navigateClient(`/harness?slug=${d.newSlug}`); },
        },
        duration: 8000,
      });
    } catch (e: unknown) {
      toast.error(`instantiate failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusyId(null);
    }
  };

  const onPublish = async (row: SnapshotRow) => {
    const ok = await askConfirm({
      title: `Publish "${row.name}"?`,
      body: `Size ${formatBytes(row.bytes)} → marketplace at localhost:3060.`,
      confirmLabel: 'Publish',
    });
    if (!ok) return;
    setBusyId(row.id);
    try {
      const r = await fetch(`/api/snapshots/${row.id}/publish`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      const d = await r.json();
      if (!r.ok || !d.ok) throw new Error(d.error ?? `HTTP ${r.status}`);
      toast.success(`Published ${d.slug}@${d.version}`, {
        action: {
          label: 'Open marketplace',
          onClick: () => { window.open(d.browseUrl, '_blank'); },
        },
        duration: 10000,
      });
    } catch (e: unknown) {
      toast.error(`publish failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusyId(null);
    }
  };

  const onRetract = async (row: SnapshotRow) => {
    if (row.publishes.length === 0) {
      toast.error('This snapshot has not been published — nothing to retract.');
      return;
    }
    // If multiple publishes, default to the most recent. Operator can edit.
    const last = row.publishes[row.publishes.length - 1]!;
    const defaultSlug = last.slug;
    const known = row.publishes.map((p) => `${p.slug}@${p.version}`).join(', ');
    const slug = await askPrompt({
      title: 'Retract published snapshot',
      body: `Known publishes: ${known}`,
      label: 'Marketplace slug',
      defaultValue: defaultSlug,
      submitLabel: 'Next',
    });
    if (!slug) return;
    const action = await askPrompt({
      title: 'Retract action',
      body: 'deprecate: warn on install, still installable. withdraw: refuse new installs. yank: remove a specific version (requires version).',
      label: 'Action',
      defaultValue: 'deprecate',
      validate: (v) => ['deprecate', 'withdraw', 'yank'].includes(v) ? null : 'Must be deprecate, withdraw, or yank',
      submitLabel: 'Next',
    });
    if (!action) return;
    let version: string | null = null;
    if (action === 'yank') {
      const matchingVersion = row.publishes.filter((p) => p.slug === slug).map((p) => p.version).pop();
      version = await askPrompt({
        title: `Version to yank`,
        label: 'Version',
        defaultValue: matchingVersion ?? '',
        submitLabel: 'Next',
      });
      if (!version) return;
    }
    const reason = (await askPrompt({
      title: 'Reason (optional)',
      label: 'Reason',
      placeholder: '≤1000 chars',
      allowEmpty: true,
      submitLabel: 'Retract',
    })) ?? '';
    setBusyId(row.id);
    try {
      const r = await fetch(`/api/snapshots/${row.id}/retract`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ marketplaceSlug: slug, action, version, reason }),
      });
      const d = await r.json();
      if (!r.ok || !d.ok) throw new Error(d.error ?? `HTTP ${r.status}`);
      toast.success(`Retracted ${slug}${version ? `@${version}` : ''} (${action})`, { duration: 6000 });
    } catch (e: unknown) {
      toast.error(`retract failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusyId(null);
    }
  };

  const onDelete = async (row: SnapshotRow) => {
    const ok = await askConfirm({
      title: `Delete local snapshot ${row.id}?`,
      body: 'Tarball is removed; published copies on the marketplace are unaffected.',
      confirmLabel: 'Delete',
      destructive: true,
    });
    if (!ok) return;
    setBusyId(row.id);
    try {
      const r = await fetch(`/api/snapshots/${row.id}`, { method: 'DELETE' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      toast.success(`Deleted ${row.id}`);
      await load();
    } catch (e: unknown) {
      toast.error(`delete failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="pc-shell pc-snapshot-forge-shell">
      {confirmEl}
      {promptEl}
      <div className="pc-snapshot-forge-topbar" style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 8 }}>
        <h1 style={{ margin: 0 }}>Snapshots</h1>
        <button type="button" className="h-btn ghost pc-snapshot-refresh" onClick={() => void load()} disabled={loading}>
          {loading ? 'Loading…' : 'Refresh'}
        </button>
      </div>
      <p className="pc-snapshot-forge-intro" style={{ color: 'var(--fg-mute)', marginTop: 0, marginBottom: 24 }}>
        Frozen tarballs of harness state — DB rows, project files, plugin enablement.
        Created from a harness via <strong>Save snapshot</strong>; instantiate to fork into a new harness, or publish to the marketplace.
      </p>

      {!loading && rows.length === 0 && (
        <div className="pc-callout pc-snapshot-empty">
          <strong>No snapshots yet.</strong> Open a harness from the{' '}
          <RouteLink href="/harness">Harnesses</RouteLink> tab and click <code>Save snapshot</code>.
        </div>
      )}

      {rows.length > 0 && (
        <SnapshotsGrid
          rows={rows}
          busyId={busyId}
          onInstantiate={onInstantiate}
          onPublish={onPublish}
          onRetract={onRetract}
          onDelete={onDelete}
        />
      )}
    </div>
  );
}

function SnapshotsGrid({
  rows, busyId, onInstantiate, onPublish, onRetract, onDelete,
}: {
  rows: SnapshotRow[];
  busyId: string | null;
  onInstantiate: (row: SnapshotRow) => void;
  onPublish: (row: SnapshotRow) => void;
  onRetract: (row: SnapshotRow) => void;
  onDelete: (row: SnapshotRow) => void;
}) {
  const columns: ColumnDef<SnapshotRow>[] = useMemo(() => [
    {
      key: 'snapshot',
      header: 'Snapshot',
      width: 3,
      render: ({ row }) => (
        <div className="pc-snapshot-cell-main" style={{ minWidth: 0 }}>
          <div className="pc-snapshot-title" style={{ fontWeight: 500 }}>{row.name}</div>
          {row.description && (
            <div className="pc-snapshot-description" style={{ color: 'var(--fg)', fontSize: 12, marginTop: 2 }}>{row.description}</div>
          )}
          <div className="pc-snapshot-id" style={{ color: 'var(--fg-mute)', fontSize: 12, fontFamily: "'SF Mono', monospace" }}>{row.id}</div>
          {row.partial && <div className="pc-snapshot-partial" style={{ color: 'var(--warn)', fontSize: 11 }}>partial</div>}
          {row.publishes.length > 0 && (
            <div className="pc-snapshot-published-wrap" style={{ marginTop: 4, fontSize: 11 }}>
              <a
                href={row.publishes[row.publishes.length - 1]!.browseUrl}
                target="_blank"
                rel="noreferrer"
                title={row.publishes.map((p) => `${p.slug}@${p.version}`).join('\n')}
                className="pc-snapshot-published-link"
                style={{
                  display: 'inline-block',
                  padding: '1px 8px',
                  borderRadius: 999,
                  background: '#1e3a5f',
                  color: '#bfdbfe',
                  textDecoration: 'none',
                  border: '1px solid #2e5288',
                }}
              >
                ↗ published{row.publishes.length > 1 ? ` ×${row.publishes.length}` : ''}
              </a>
            </div>
          )}
        </div>
      ),
    },
    { key: 'harness', header: 'Harness', width: 1.2, render: ({ row }) => <code className="pc-snapshot-harness">{row.harnessSlug}</code> },
    {
      key: 'created',
      header: 'Created',
      width: 1.4,
      render: ({ row }) => (
        <span className="pc-snapshot-created" style={{ color: 'var(--fg-mute)', fontSize: 12 }}>{formatDate(row.createdAtMs)}</span>
      ),
    },
    { key: 'size', header: 'Size', width: 0.7, align: 'right', render: ({ row }) => <>{formatBytes(row.bytes)}</> },
    { key: 'files', header: 'Files', width: 0.5, align: 'right', render: ({ row }) => <>{row.filesCount}</> },
    { key: 'plugins', header: 'Plugins', width: 0.6, align: 'right', render: ({ row }) => <>{row.pluginsCount}</> },
    {
      key: 'redactions',
      header: 'Redactions',
      width: 1.1,
      render: ({ row }) => (
        <span className="pc-snapshot-redactions" style={{ fontSize: 12 }}>
          {row.redactions.verifiedHits > 0 && (
            <span className="pc-snapshot-redaction verified" style={{ color: 'var(--bad)' }}>{row.redactions.verifiedHits} verified </span>
          )}
          {row.redactions.highRecallHits > 0 && (
            <span className="pc-snapshot-redaction warning" style={{ color: 'var(--warn)' }}>{row.redactions.highRecallHits} warns</span>
          )}
          {row.redactions.verifiedHits === 0 && row.redactions.highRecallHits === 0 && (
            <span className="pc-snapshot-redaction clean" style={{ color: 'var(--fg-mute)' }}>clean</span>
          )}
        </span>
      ),
    },
    {
      key: 'actions',
      header: '',
      width: 2.4,
      align: 'right',
      render: ({ row }) => {
        const busy = busyId === row.id;
        return (
          <span className="pc-snapshot-actions" style={{ whiteSpace: 'nowrap' }} onClick={(e) => e.stopPropagation()}>
            <button type="button" className="h-btn ghost pc-snapshot-action pc-snapshot-action--instantiate" disabled={busy} onClick={() => onInstantiate(row)} style={{ marginRight: 6 }}>
              {busy ? '…' : 'Instantiate'}
            </button>
            <button type="button" className="h-btn ghost pc-snapshot-action pc-snapshot-action--publish" disabled={busy} onClick={() => onPublish(row)} style={{ marginRight: 6 }}>
              Publish
            </button>
            <button type="button" className="h-btn ghost pc-snapshot-action pc-snapshot-action--retract" disabled={busy} onClick={() => onRetract(row)} style={{ marginRight: 6 }} title="Retract a previously-published copy from the marketplace">
              Retract
            </button>
            <button type="button" className="h-btn ghost pc-snapshot-action pc-snapshot-action--delete" disabled={busy} onClick={() => onDelete(row)}>
              Delete
            </button>
          </span>
        );
      },
    },
  ], [busyId, onInstantiate, onPublish, onRetract, onDelete]);

  return (
    <div className="pc-snapshot-grid">
      <RichGrid<SnapshotRow> columns={columns} rows={rows} getRowId={(r) => r.id} inline />
    </div>
  );
}
