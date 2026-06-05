'use client';

import { useEffect, useState } from 'react';

interface SnapshotMeta {
  takenAt?: string;
  iteration?: number;
  featureCounts?: Record<string, number>;
  sourceHarness?: string;
  sourceProjectPath?: string;
  includesProject?: boolean;
}

interface Props {
  slug: string;
  version: string;
  apiBase: string;
  snapshot?: SnapshotMeta;
}

interface IssueRow {
  id?: string;
  title?: string;
  severity?: string;
  status?: string;
}

interface FeatureRow {
  id?: string;
  title?: string;
  status?: string;
}

const STATUS_COLOR: Record<string, string> = {
  todo: '#94a3b8',
  doing: '#fbbf24',
  done: '#34d399',
  passed: '#34d399',
  blocked: '#f87171',
  review: '#a78bfa',
  validating: '#a78bfa',
};

const SEVERITY_COLOR: Record<string, string> = {
  blocker: '#f87171',
  major: '#fbbf24',
  minor: '#94a3b8',
  nit: 'var(--fg-dim)',
};

export function SnapshotStateTab({ slug, version, apiBase, snapshot }: Props) {
  const [issues, setIssues] = useState<IssueRow[] | null>(null);
  const [features, setFeatures] = useState<FeatureRow[] | null>(null);
  const [memory, setMemory] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const fileUrl = (path: string) =>
      `${apiBase}/v1/packages/${encodeURIComponent(slug)}/${encodeURIComponent(version)}/file?path=${encodeURIComponent(path)}`;

    async function fetchJson<T>(path: string, key: 'issues' | 'features'): Promise<T[] | null> {
      try {
        const r = await fetch(fileUrl(path), { cache: 'no-store' });
        if (r.status === 404) return [];
        if (!r.ok) return null;
        const j = await r.json() as Record<string, unknown>;
        const rows = j[key];
        return Array.isArray(rows) ? rows as T[] : [];
      } catch {
        return null;
      }
    }

    async function fetchText(path: string): Promise<string | null> {
      try {
        const r = await fetch(fileUrl(path), { cache: 'no-store' });
        if (r.status === 404) return '';
        if (!r.ok) return null;
        return await r.text();
      } catch {
        return null;
      }
    }

    Promise.all([
      fetchJson<IssueRow>('source/.papercusp/issues.json', 'issues'),
      fetchJson<FeatureRow>('source/.papercusp/features.json', 'features'),
      fetchText('state/harness/memory/summary.md'),
    ]).then(([is, fs, mem]) => {
      if (cancelled) return;
      if (is === null && fs === null && mem === null) {
        setLoadError('could not read tarball — snapshot may be on cold storage');
      }
      setIssues(is);
      setFeatures(fs);
      setMemory(mem);
    });

    return () => { cancelled = true; };
  }, [slug, version, apiBase]);

  if (!snapshot) {
    return (
      <div style={{ color: 'var(--fg-dim)', padding: '24px 0' }}>
        This snapshot has no captured state metadata.
      </div>
    );
  }

  const counts = snapshot.featureCounts ?? {};
  const totalFeatures = Object.values(counts).reduce((a, b) => a + b, 0);

  return (
    <div style={{ paddingTop: 8 }}>
      <section style={{ marginBottom: 32 }}>
        <h3 style={{ marginBottom: 4 }}>Capture metadata</h3>
        <p style={{ color: 'var(--fg-dim)', fontSize: 13, marginTop: 0 }}>
          When and where this snapshot was taken. Forking restores the harness to this point.
        </p>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <tbody>
            {snapshot.sourceHarness ? (
              <tr>
                <td style={cellLabel}>Source harness</td>
                <td style={cellValue}><code>{snapshot.sourceHarness}</code></td>
              </tr>
            ) : null}
            {typeof snapshot.iteration === 'number' ? (
              <tr>
                <td style={cellLabel}>Iteration</td>
                <td style={cellValue}>{snapshot.iteration}</td>
              </tr>
            ) : null}
            {snapshot.takenAt ? (
              <tr>
                <td style={cellLabel}>Taken at</td>
                <td style={cellValue}>{new Date(snapshot.takenAt).toLocaleString()}</td>
              </tr>
            ) : null}
            {snapshot.sourceProjectPath ? (
              <tr>
                <td style={cellLabel}>Source path</td>
                <td style={{ ...cellValue, fontFamily: "'SF Mono', monospace", fontSize: 11 }}>
                  {snapshot.sourceProjectPath}
                </td>
              </tr>
            ) : null}
            <tr>
              <td style={cellLabel}>Project files</td>
              <td style={cellValue}>
                {snapshot.includesProject
                  ? <span style={{ color: '#34d399' }}>included in tarball</span>
                  : <span style={{ color: 'var(--fg-dim)' }}>not included (recipe only)</span>}
              </td>
            </tr>
          </tbody>
        </table>
      </section>

      {totalFeatures > 0 ? (
        <section style={{ marginBottom: 32 }}>
          <h3 style={{ marginBottom: 4 }}>Feature counts</h3>
          <p style={{ color: 'var(--fg-dim)', fontSize: 13, marginTop: 0 }}>
            From <code>manifest.snapshot.featureCounts</code> — captured at snapshot time.
          </p>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: 12 }}>
            {Object.entries(counts).map(([status, n]) => (
              <div
                key={status}
                style={{
                  padding: '10px 14px',
                  border: '1px solid var(--border)',
                  borderRadius: 6,
                  minWidth: 80,
                }}
              >
                <div
                  style={{
                    fontSize: 10,
                    textTransform: 'uppercase',
                    letterSpacing: '0.04em',
                    color: STATUS_COLOR[status] ?? 'var(--fg-dim)',
                    marginBottom: 4,
                  }}
                >
                  {status}
                </div>
                <div style={{ fontSize: 22, fontWeight: 600 }}>{n}</div>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {features === null && issues === null && memory === null ? (
        <div style={{ color: 'var(--fg-dim)', padding: '24px 0' }}>Loading state…</div>
      ) : null}

      {loadError ? (
        <div style={{ color: '#f87171', fontSize: 13, marginBottom: 24 }}>
          {loadError}
        </div>
      ) : null}

      {features && features.length > 0 ? (
        <section style={{ marginBottom: 32 }}>
          <h3 style={{ marginBottom: 4 }}>Features ({features.length})</h3>
          <p style={{ color: 'var(--fg-dim)', fontSize: 13, marginTop: 0 }}>
            From <code>.papercusp/features.json</code> at snapshot time.
          </p>
          <RowList
            rows={features.slice(0, 50)}
            columns={[
              { key: 'id', label: 'id', width: 90, mono: true },
              { key: 'status', label: 'status', width: 90, badge: STATUS_COLOR },
              { key: 'title', label: 'title' },
            ]}
          />
          {features.length > 50 ? (
            <div style={{ fontSize: 12, color: 'var(--fg-dim)', marginTop: 8 }}>
              showing 50 of {features.length} — fork to see the rest
            </div>
          ) : null}
        </section>
      ) : null}

      {issues && issues.length > 0 ? (
        <section style={{ marginBottom: 32 }}>
          <h3 style={{ marginBottom: 4 }}>Issues ({issues.length})</h3>
          <p style={{ color: 'var(--fg-dim)', fontSize: 13, marginTop: 0 }}>
            From <code>.papercusp/issues.json</code> at snapshot time.
          </p>
          <RowList
            rows={issues.slice(0, 50)}
            columns={[
              { key: 'id', label: 'id', width: 90, mono: true },
              { key: 'severity', label: 'severity', width: 90, badge: SEVERITY_COLOR },
              { key: 'status', label: 'status', width: 90, badge: STATUS_COLOR },
              { key: 'title', label: 'title' },
            ]}
          />
          {issues.length > 50 ? (
            <div style={{ fontSize: 12, color: 'var(--fg-dim)', marginTop: 8 }}>
              showing 50 of {issues.length} — fork to see the rest
            </div>
          ) : null}
        </section>
      ) : null}

      {memory ? (
        <section style={{ marginBottom: 32 }}>
          <h3 style={{ marginBottom: 4 }}>Memory summary</h3>
          <p style={{ color: 'var(--fg-dim)', fontSize: 13, marginTop: 0 }}>
            Synthesised harness memory at snapshot time (<code>state/harness/memory/summary.md</code>).
          </p>
          <pre
            style={{
              background: 'var(--bg-elevated, rgba(255,255,255,0.03))',
              border: '1px solid var(--border)',
              borderRadius: 4,
              padding: 12,
              fontSize: 12,
              maxHeight: 360,
              overflow: 'auto',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            }}
          >
            {memory}
          </pre>
        </section>
      ) : null}

      <section style={{ marginBottom: 32 }}>
        <h3 style={{ marginBottom: 4 }}>Postgres dump</h3>
        <p style={{ color: 'var(--fg-dim)', fontSize: 13, marginTop: 0 }}>
          The full per-harness Postgres schema is bundled in the tarball at
          {' '}<code>state/db.sql.gz</code>. Fork the snapshot to restore it into a new harness.
        </p>
      </section>
    </div>
  );
}

interface ColSpec {
  key: string;
  label: string;
  width?: number;
  mono?: boolean;
  badge?: Record<string, string>;
}

function RowList({ rows, columns }: { rows: Record<string, unknown>[]; columns: ColSpec[] }) {
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, marginTop: 12 }}>
      <thead>
        <tr style={{ textAlign: 'left', color: 'var(--fg-dim)', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
          {columns.map((col) => (
            <th key={col.key} style={{ padding: '6px 8px 6px 0', borderBottom: '1px solid var(--border)', width: col.width }}>
              {col.label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, i) => (
          <tr key={String(row.id ?? i)}>
            {columns.map((col) => {
              const raw = row[col.key];
              const v = raw == null ? '' : String(raw);
              const tdStyle: React.CSSProperties = {
                padding: '6px 8px 6px 0',
                borderBottom: '1px solid var(--border)',
                color: 'var(--fg-muted)',
                ...(col.mono ? { fontFamily: "'SF Mono', monospace", fontSize: 12 } : {}),
              };
              if (col.badge && v) {
                return (
                  <td key={col.key} style={tdStyle}>
                    <span
                      style={{
                        fontSize: 10,
                        textTransform: 'uppercase',
                        letterSpacing: '0.04em',
                        color: col.badge[v] ?? 'var(--fg-dim)',
                      }}
                    >
                      {v}
                    </span>
                  </td>
                );
              }
              return <td key={col.key} style={tdStyle}>{v}</td>;
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const cellLabel = {
  padding: '6px 12px 6px 0',
  borderBottom: '1px solid var(--border)',
  color: 'var(--fg-dim)',
  fontSize: 12,
  textTransform: 'uppercase' as const,
  letterSpacing: '0.04em',
  width: '30%',
};

const cellValue = {
  padding: '6px 0',
  borderBottom: '1px solid var(--border)',
  color: 'var(--fg-muted)',
};
