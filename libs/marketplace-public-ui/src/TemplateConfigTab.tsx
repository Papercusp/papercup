import type { CSSProperties } from 'react';

export interface ConfigFileSpec {
  path: string;
  label?: string;
  language?: 'markdown' | 'json' | 'yaml' | 'text';
  description?: string;
  sensitivity?: 'normal' | 'warn' | 'secret';
}

interface Props {
  configFiles?: ConfigFileSpec[];
  models?: Record<string, unknown>;
  plugins?: Array<string | { slug: string; version?: string; autoEnable?: boolean }>;
}

const langColor: Record<string, string> = {
  markdown: '#a78bfa',
  json: '#fbbf24',
  yaml: '#34d399',
  text: '#94a3b8',
};

const sensitivityStyle: Record<string, CSSProperties> = {
  warn: { background: 'rgba(245, 158, 11, 0.12)', color: '#fbbf24' },
  secret: { background: 'rgba(239, 68, 68, 0.12)', color: '#f87171' },
};

export function TemplateConfigTab({ configFiles, models, plugins }: Props) {
  const hasFiles = configFiles && configFiles.length > 0;
  const hasModels = models && Object.keys(models).length > 0;
  const hasPlugins = plugins && plugins.length > 0;

  if (!hasFiles && !hasModels && !hasPlugins) {
    return (
      <div style={{ color: 'var(--fg-dim)', padding: '24px 0' }}>
        This template does not declare any config files, models, or plugins.
      </div>
    );
  }

  return (
    <div style={{ paddingTop: 8 }}>
      {hasFiles && (
        <section style={{ marginBottom: 32 }}>
          <h3 style={{ marginBottom: 4 }}>Config files</h3>
          <p style={{ color: 'var(--fg-dim)', fontSize: 13, marginTop: 0 }}>
            Files you can edit after installing this template. Each one is surfaced in the operator&apos;s Config tab.
          </p>
          <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {configFiles!.map((f) => (
              <li
                key={f.path}
                style={{
                  borderBottom: '1px solid var(--border)',
                  padding: '12px 0',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 4,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
                  <code style={{ fontSize: 13, fontWeight: 600 }}>{f.label ?? f.path}</code>
                  {f.label && f.label !== f.path ? (
                    <code style={{ fontSize: 11, color: 'var(--fg-dim)' }}>{f.path}</code>
                  ) : null}
                  {f.language ? (
                    <span
                      style={{
                        fontSize: 10,
                        textTransform: 'uppercase',
                        letterSpacing: '0.04em',
                        color: langColor[f.language] ?? 'var(--fg-dim)',
                      }}
                    >
                      {f.language}
                    </span>
                  ) : null}
                  {f.sensitivity && f.sensitivity !== 'normal' ? (
                    <span
                      style={{
                        fontSize: 10,
                        padding: '1px 6px',
                        borderRadius: 3,
                        textTransform: 'uppercase',
                        letterSpacing: '0.04em',
                        ...(sensitivityStyle[f.sensitivity] ?? {}),
                      }}
                    >
                      {f.sensitivity}
                    </span>
                  ) : null}
                </div>
                {f.description ? (
                  <div style={{ fontSize: 12, color: 'var(--fg-muted)' }}>{f.description}</div>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      )}

      {hasModels && (
        <section style={{ marginBottom: 32 }}>
          <h3 style={{ marginBottom: 4 }}>Models</h3>
          <p style={{ color: 'var(--fg-dim)', fontSize: 13, marginTop: 0 }}>
            Default model assignment per role. You can override these per-harness after install.
          </p>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ textAlign: 'left', color: 'var(--fg-dim)', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                <th style={{ padding: '6px 0', borderBottom: '1px solid var(--border)' }}>Role</th>
                <th style={{ padding: '6px 0', borderBottom: '1px solid var(--border)' }}>Preferred</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(models!).map(([role, conf]) => {
                const preferred = (conf as { preferred?: string })?.preferred ?? '—';
                return (
                  <tr key={role}>
                    <td style={{ padding: '6px 0', borderBottom: '1px solid var(--border)', color: 'var(--fg-muted)' }}>{role}</td>
                    <td style={{ padding: '6px 0', borderBottom: '1px solid var(--border)', fontFamily: "'SF Mono', monospace", fontSize: 12 }}>{preferred}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      )}

      {hasPlugins && (
        <section style={{ marginBottom: 32 }}>
          <h3 style={{ marginBottom: 4 }}>Plugins</h3>
          <p style={{ color: 'var(--fg-dim)', fontSize: 13, marginTop: 0 }}>
            Bundled with this template. Auto-enabled plugins activate on install; the rest are recommendations.
          </p>
          <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {plugins!.map((p) => {
              const slug = typeof p === 'string' ? p : p.slug;
              const version = typeof p === 'string' ? undefined : p.version;
              const autoEnable = typeof p === 'string' ? false : !!p.autoEnable;
              return (
                <li
                  key={slug}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    padding: '8px 0',
                    borderBottom: '1px solid var(--border)',
                    fontSize: 13,
                  }}
                >
                  <code style={{ fontWeight: 600 }}>{slug}</code>
                  {version ? <span style={{ color: 'var(--fg-dim)', fontSize: 12 }}>v{version}</span> : null}
                  {autoEnable ? (
                    <span
                      style={{
                        marginLeft: 'auto',
                        fontSize: 10,
                        textTransform: 'uppercase',
                        letterSpacing: '0.04em',
                        color: '#34d399',
                      }}
                    >
                      auto-enable
                    </span>
                  ) : (
                    <span
                      style={{
                        marginLeft: 'auto',
                        fontSize: 10,
                        textTransform: 'uppercase',
                        letterSpacing: '0.04em',
                        color: 'var(--fg-dim)',
                      }}
                    >
                      recommended
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </div>
  );
}
