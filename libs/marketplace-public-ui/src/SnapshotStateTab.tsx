interface SnapshotMeta {
  takenAt?: string;
  iteration?: number;
  featureCounts?: Record<string, number>;
  sourceHarness?: string;
  sourceProjectPath?: string;
  includesProject?: boolean;
}

interface Props {
  snapshot?: SnapshotMeta;
}

const STATUS_COLOR: Record<string, string> = {
  todo: '#94a3b8',
  doing: '#fbbf24',
  done: '#34d399',
  blocked: '#f87171',
  review: '#a78bfa',
};

export function SnapshotStateTab({ snapshot }: Props) {
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

      <section style={{ marginBottom: 32 }}>
        <h3 style={{ marginBottom: 4 }}>Feature state</h3>
        <p style={{ color: 'var(--fg-dim)', fontSize: 13, marginTop: 0 }}>
          {totalFeatures > 0
            ? `${totalFeatures} feature${totalFeatures === 1 ? '' : 's'} captured at snapshot time.`
            : 'No features captured.'}
        </p>
        {totalFeatures > 0 ? (
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
        ) : null}
      </section>

      <section style={{ marginBottom: 32 }}>
        <h3 style={{ marginBottom: 4 }}>Deeper state</h3>
        <p style={{ color: 'var(--fg-dim)', fontSize: 13, marginTop: 0 }}>
          Issues, decisions, agent transcripts, and the per-harness Postgres dump are bundled in the tarball.
          Fork the snapshot to materialize them in a new harness.
        </p>
      </section>
    </div>
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
