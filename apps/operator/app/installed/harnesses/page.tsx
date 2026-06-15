'use client';

// Locally-installed harnesses — i.e. projects scaffolded into this
// workspace via marketplace install or `papercusp scaffold`. Distinct
// from the marketplace catalog view; this is "what do I have here?".
//
// Source of truth: /api/installed returns { projects, harnesses,
// staleCount }. Each project corresponds to one installed harness.

import { useCallback, useEffect, useMemo, useState } from 'react';
import RouteLink from '../../_components/RouteLink';
import { useLexicon } from '@/lib/useLexicon';
import { CreateHarnessPicker } from '../../harness/CreateHarnessPicker';
import { toast } from 'sonner';
import { RichGrid, type ColumnDef } from '@papercusp/grid-core';

interface ProjectRow {
  slug: string;
  path: string;
  harness_kind?: string;
  exists: boolean;
  addedAt?: string;
}

interface HarnessRow {
  slug: string;
  version: string | null;
  description: string | null;
}

interface InstalledResponse {
  projects: ProjectRow[];
  harnesses: HarnessRow[];
  staleCount: number;
}

function ProjectsGrid({ projects }: { projects: ProjectRow[] }) {
  const columns: ColumnDef<ProjectRow>[] = useMemo(() => [
    {
      key: 'slug',
      header: 'Slug',
      width: 1.4,
      render: ({ row }) => (
        <span className="pc-installed-harness-slug" style={{ fontWeight: 600, opacity: row.exists ? 1 : 0.5 }}>{row.slug}</span>
      ),
    },
    {
      key: 'kind',
      header: 'Kind',
      width: 1.2,
      render: ({ row }) => (
        <span className="pc-installed-harness-kind" style={{ color: 'var(--fg-dim)', opacity: row.exists ? 1 : 0.5 }}>
          {row.harness_kind ?? '—'}
        </span>
      ),
    },
    {
      key: 'path',
      header: 'Path',
      width: 2.4,
      render: ({ row }) => (
        <span className="pc-installed-harness-path" style={{ color: 'var(--fg-dim)', fontFamily: 'monospace', fontSize: 12, opacity: row.exists ? 1 : 0.5 }}>{row.path}</span>
      ),
    },
    {
      key: 'state',
      header: 'State',
      width: 0.7,
      render: ({ row }) => (
        row.exists ? (
          <span className="pc-installed-harness-state live" style={{ color: 'var(--accent, #7fc99a)' }}>● live</span>
        ) : (
          <span className="pc-installed-harness-state stale" style={{ color: 'var(--fg-mute)' }} title="Project directory missing on disk">○ stale</span>
        )
      ),
    },
    {
      key: 'added',
      header: 'Added',
      width: 1.2,
      render: ({ row }) => (
        <span style={{ color: 'var(--fg-dim)', opacity: row.exists ? 1 : 0.5 }}>{fmtDate(row.addedAt)}</span>
      ),
    },
    {
      key: 'actions',
      header: '',
      width: 0.8,
      align: 'right',
      render: ({ row }) => (
        row.exists ? (
          <RouteLink href={`/harness?project=${encodeURIComponent(row.slug)}`} className="pc-button pc-installed-harness-open" style={{ padding: '4px 10px' }} onClick={(e) => e.stopPropagation()}>
            Open
          </RouteLink>
        ) : null
      ),
    },
  ], []);

  return (
    <div className="pc-installed-harness-grid">
      <RichGrid<ProjectRow> columns={columns} rows={projects} getRowId={(p) => p.slug} inline />
    </div>
  );
}

function fmtDate(s?: string): string {
  if (!s) return '—';
  try { return new Date(s).toLocaleString(); } catch { return s; }
}

export default function InstalledHarnessesPage() {
  const t = useLexicon();
  const [data, setData] = useState<InstalledResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      setLoading(true);
      const res = await fetch('/api/installed', { cache: 'no-store', signal });
      if (!res.ok) throw new Error(`/api/installed returned ${res.status}`);
      const json: InstalledResponse = await res.json();
      setData(json);
    } catch (e: any) {
      if ((e as Error).name === 'AbortError') return;
      setError(String(e?.message ?? e));
      toast.error(`failed to load harnesses: ${e?.message ?? e}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const handleCreated = useCallback((_slug: string) => {
    void load();
  }, [load]);

  return (
    <div className="pc-installed-ops-shell pc-installed-harnesses-shell" style={{ maxWidth: 1100, margin: '0 auto', padding: '32px 24px' }}>
      <header className="pc-installed-ops-header pc-installed-harnesses-header" style={{ marginBottom: 24, display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16 }}>
        <div>
          <h1 style={{ margin: 0 }}>Harnesses</h1>
          <p style={{ color: 'var(--fg-mute)', marginTop: 8 }}>
            Locally-installed harnesses. Each is a project scaffolded into this workspace.
            Click a harness to open it in mission control.
          </p>
        </div>
        <button
          type="button"
          className="pc-button pc-btn-primary pc-installed-harnesses-add-btn"
          onClick={() => setPickerOpen(true)}
          style={{ whiteSpace: 'nowrap', marginTop: 4 }}
        >
          + Add harness
        </button>
      </header>
      <CreateHarnessPicker
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        onCreated={handleCreated}
      />

      {loading && <p className="pc-installed-ops-loading" style={{ color: 'var(--fg-mute)' }}>Loading…</p>}
      {error && <p className="pc-installed-ops-error" style={{ color: 'var(--warn)' }}>Error: {error}</p>}

      {data && data.projects.length === 0 && !loading && (
        <div className="pc-installed-ops-empty pc-installed-harnesses-empty" style={{ padding: 32, border: '1px dashed var(--border)', borderRadius: 8, textAlign: 'center' }}>
          <p style={{ color: 'var(--fg-mute)' }}>No harnesses installed yet.</p>
          <p>
            <RouteLink href="/cupboard" className="pc-button">Browse the {t('cupboard')}</RouteLink>
          </p>
        </div>
      )}

      {data && data.projects.length > 0 && <ProjectsGrid projects={data.projects} />}

      {data && data.staleCount > 0 && (
        <p className="pc-installed-harnesses-stale" style={{ marginTop: 16, color: 'var(--fg-mute)', fontSize: 13 }}>
          {data.staleCount} stale entr{data.staleCount === 1 ? 'y' : 'ies'} — project directory missing on disk.
        </p>
      )}
    </div>
  );
}
