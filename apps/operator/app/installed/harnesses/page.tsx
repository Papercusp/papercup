'use client';

// Locally-installed harnesses — i.e. projects scaffolded into this
// workspace via marketplace install or `papercusp scaffold`. Distinct
// from the marketplace catalog view; this is "what do I have here?".
//
// Source of truth: /api/installed returns { projects, harnesses,
// staleCount }. Each project corresponds to one installed harness.

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { toast } from 'sonner';
import { RichGrid, type ColumnDef } from '@restart/grid-core';

interface ProjectRow {
  slug: string;
  path: string;
  harness_kind?: string;
  department_slug?: string;
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
        <span style={{ fontWeight: 600, opacity: row.exists ? 1 : 0.5 }}>{row.slug}</span>
      ),
    },
    {
      key: 'kind',
      header: 'Kind',
      width: 1.2,
      render: ({ row }) => (
        <span style={{ color: 'var(--fg-dim)', opacity: row.exists ? 1 : 0.5 }}>
          {row.harness_kind ?? (row.department_slug ? `department:${row.department_slug}` : '—')}
        </span>
      ),
    },
    {
      key: 'path',
      header: 'Path',
      width: 2.4,
      render: ({ row }) => (
        <span style={{ color: 'var(--fg-dim)', fontFamily: 'monospace', fontSize: 12, opacity: row.exists ? 1 : 0.5 }}>{row.path}</span>
      ),
    },
    {
      key: 'state',
      header: 'State',
      width: 0.7,
      render: ({ row }) => (
        row.exists ? (
          <span style={{ color: 'var(--accent, #7fc99a)' }}>● live</span>
        ) : (
          <span style={{ color: 'var(--fg-mute)' }} title="Project directory missing on disk">○ stale</span>
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
          <Link href={`/harness?project=${encodeURIComponent(row.slug)}`} className="pc-button" style={{ padding: '4px 10px' }} onClick={(e) => e.stopPropagation()}>
            Open
          </Link>
        ) : null
      ),
    },
  ], []);

  return <RichGrid<ProjectRow> columns={columns} rows={projects} getRowId={(p) => p.slug} inline />;
}

function fmtDate(s?: string): string {
  if (!s) return '—';
  try { return new Date(s).toLocaleString(); } catch { return s; }
}

export default function InstalledHarnessesPage() {
  const [data, setData] = useState<InstalledResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        setLoading(true);
        const res = await fetch('/api/installed', { cache: 'no-store' });
        if (!res.ok) throw new Error(`/api/installed returned ${res.status}`);
        const json: InstalledResponse = await res.json();
        if (!cancelled) setData(json);
      } catch (e: any) {
        if (!cancelled) {
          setError(String(e?.message ?? e));
          toast.error(`failed to load harnesses: ${e?.message ?? e}`);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, []);

  return (
    <div style={{ maxWidth: 1100, margin: '0 auto', padding: '32px 24px' }}>
      <header style={{ marginBottom: 24 }}>
        <h1 style={{ margin: 0 }}>Harnesses</h1>
        <p style={{ color: 'var(--fg-mute)', marginTop: 8 }}>
          Locally-installed harnesses. Each is a project scaffolded into this workspace.
          Click a harness to open it in mission control.
        </p>
      </header>

      {loading && <p style={{ color: 'var(--fg-mute)' }}>Loading…</p>}
      {error && <p style={{ color: 'var(--accent-warn, #f97583)' }}>Error: {error}</p>}

      {data && data.projects.length === 0 && !loading && (
        <div style={{ padding: 32, border: '1px dashed var(--border)', borderRadius: 8, textAlign: 'center' }}>
          <p style={{ color: 'var(--fg-mute)' }}>No harnesses installed yet.</p>
          <p>
            <Link href="/marketplace/templates" className="pc-button">Browse the marketplace</Link>
          </p>
        </div>
      )}

      {data && data.projects.length > 0 && <ProjectsGrid projects={data.projects} />}

      {data && data.staleCount > 0 && (
        <p style={{ marginTop: 16, color: 'var(--fg-mute)', fontSize: 13 }}>
          {data.staleCount} stale entr{data.staleCount === 1 ? 'y' : 'ies'} — project directory missing on disk.
        </p>
      )}
    </div>
  );
}
