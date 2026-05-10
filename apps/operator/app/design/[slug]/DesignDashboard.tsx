'use client';

/**
 * Design tab — v0.1.
 *
 * Reads features with `needs_design=true` from
 * /api/design/features and groups them by `design_status`. Embeds
 * the registry browser and memo backlog via the design-phase plugin.
 *
 * Plan §6 — apps/operator/content/docs/design/design-phase-plan.mdx.
 *
 * Deliberately self-contained — does not import HarnessDashboard or
 * FeatureList. The shared mode-parameterized FeatureList is deferred
 * until the existing component is refactored without paperclip
 * collision risk.
 */
import { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useWorkspaceId } from '@/lib/use-workspace-id';
import SketchPane from './SketchPane';
import RegressionPane from './RegressionPane';

interface DesignFeature {
  featureId: string;
  title: string | null;
  summary: string | null;
  status: string | null;
  needsDesign: boolean;
  designStatus: 'pending' | 'accepted' | 'ignored' | null;
  designSpecId: string | null;
  discardedDesignWork: boolean;
  updatedTs: number | null;
}

interface RegistryEntry {
  id: string;
  kind: string;
  summary: string;
  inputs?: Array<{ name: string; type: string; required?: boolean }>;
  variants?: string[];
}

interface MemoEntry {
  slug: string;
  title: string;
  status: string;
}

interface DtcgToken {
  id: string;
  type: string;
  value: unknown;
  description: string | null;
  group: string | null;
}

type Pane = 'features' | 'memos' | 'registry' | 'tokens' | 'sketch' | 'regressions';

export default function DesignDashboard({ slug }: { slug: string }) {
  const workspaceId = useWorkspaceId();
  const [activePane, setActivePane] = useState<Pane>('features');
  const [bucket, setBucket] = useState<'all' | 'pending' | 'accepted' | 'ignored'>('all');
  const [selectedFeatureId, setSelectedFeatureId] = useState<string | null>(null);
  const [registryQuery, setRegistryQuery] = useState('');

  const featuresQ = useQuery({
    queryKey: ['design-features', slug, workspaceId],
    queryFn: async () => {
      const r = await fetch(
        `/api/design/features?harness=${encodeURIComponent(slug)}&workspace=${encodeURIComponent(workspaceId ?? 'default')}`,
      );
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = await r.json();
      return (d.features as DesignFeature[]) ?? [];
    },
    refetchInterval: 30_000,
  });

  const memosQ = useQuery({
    queryKey: ['design-memos', slug, workspaceId],
    enabled: activePane === 'memos',
    queryFn: async () => {
      const r = await fetch(
        `/api/plugins/design-phase/list_memos?harness=${encodeURIComponent(slug)}&workspace=${encodeURIComponent(workspaceId ?? 'default')}&role=operator&run=design-tab&spawn=design-tab`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
      );
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = await r.json();
      const text = d?.content?.[0]?.text ?? '[]';
      return JSON.parse(text) as MemoEntry[];
    },
    refetchInterval: 60_000,
  });

  const registryQ = useQuery({
    queryKey: ['design-registry', slug, workspaceId, registryQuery],
    enabled: activePane === 'registry',
    queryFn: async () => {
      const r = await fetch(
        `/api/plugins/design-phase/search_registry?harness=${encodeURIComponent(slug)}&workspace=${encodeURIComponent(workspaceId ?? 'default')}&role=operator&run=design-tab&spawn=design-tab`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: registryQuery }),
        },
      );
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = await r.json();
      const text = d?.content?.[0]?.text ?? '{}';
      const parsed = JSON.parse(text) as { ecosystem: string; results: RegistryEntry[] };
      return parsed.results;
    },
    refetchInterval: 60_000,
  });

  const tokensQ = useQuery({
    queryKey: ['design-tokens', slug, workspaceId],
    enabled: activePane === 'tokens',
    queryFn: async () => {
      const r = await fetch(
        `/api/plugins/design-phase/list_tokens?harness=${encodeURIComponent(slug)}&workspace=${encodeURIComponent(workspaceId ?? 'default')}&role=operator&run=design-tab&spawn=design-tab`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
      );
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = await r.json();
      const text = d?.content?.[0]?.text ?? '{}';
      const parsed = JSON.parse(text) as { source: string | null; error: string | null; count: number; tokens: DtcgToken[] };
      return parsed;
    },
    refetchInterval: 60_000,
  });

  const features = featuresQ.data ?? [];
  const counts = useMemo(() => {
    const c = { all: 0, pending: 0, accepted: 0, ignored: 0 };
    for (const f of features) {
      c.all++;
      if (f.designStatus === 'pending') c.pending++;
      else if (f.designStatus === 'accepted') c.accepted++;
      else if (f.designStatus === 'ignored') c.ignored++;
      else c.pending++; // null/unset → treated as pending in counts
    }
    return c;
  }, [features]);

  const filteredFeatures = useMemo(() => {
    if (bucket === 'all') return features;
    if (bucket === 'pending') {
      return features.filter((f) => f.designStatus === null || f.designStatus === 'pending');
    }
    return features.filter((f) => f.designStatus === bucket);
  }, [features, bucket]);

  const selectedFeature = useMemo(
    () => filteredFeatures.find((f) => f.featureId === selectedFeatureId) ?? null,
    [filteredFeatures, selectedFeatureId],
  );

  return (
    <div className="d-root" style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 16,
          padding: '12px 16px',
          borderBottom: '1px solid #e5e7eb',
        }}
      >
        <h1 style={{ fontSize: 18, fontWeight: 600, margin: 0 }}>
          Design <span style={{ color: '#9ca3af' }}>· {slug}</span>
        </h1>
        <nav style={{ display: 'flex', gap: 4, marginLeft: 'auto' }}>
          {(['features', 'memos', 'registry', 'tokens', 'sketch', 'regressions'] as const).map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => setActivePane(p)}
              style={{
                padding: '6px 12px',
                borderRadius: 6,
                border: '1px solid #e5e7eb',
                background: activePane === p ? '#eef2ff' : 'transparent',
                color: activePane === p ? '#4338ca' : '#374151',
                cursor: 'pointer',
                fontSize: 13,
                textTransform: 'capitalize',
              }}
            >
              {p}
            </button>
          ))}
        </nav>
      </header>

      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        {/* Left rail: feature list, always visible */}
        <aside
          style={{
            width: 320,
            borderRight: '1px solid #e5e7eb',
            display: 'flex',
            flexDirection: 'column',
            minHeight: 0,
          }}
        >
          <div style={{ padding: 8, borderBottom: '1px solid #f3f4f6' }}>
            <div style={{ display: 'flex', gap: 4, fontSize: 12 }}>
              {(['all', 'pending', 'accepted', 'ignored'] as const).map((b) => (
                <button
                  key={b}
                  type="button"
                  onClick={() => setBucket(b)}
                  style={{
                    padding: '4px 8px',
                    borderRadius: 4,
                    border: '1px solid #e5e7eb',
                    background: bucket === b ? '#dbeafe' : 'transparent',
                    color: bucket === b ? '#1e40af' : '#374151',
                    cursor: 'pointer',
                    textTransform: 'capitalize',
                  }}
                >
                  {b} ({counts[b]})
                </button>
              ))}
            </div>
          </div>
          <ul style={{ flex: 1, overflow: 'auto', margin: 0, padding: 0, listStyle: 'none' }}>
            {featuresQ.isLoading ? (
              <li style={{ padding: 12, color: '#6b7280', fontSize: 13 }}>Loading…</li>
            ) : featuresQ.isError ? (
              <li style={{ padding: 12, color: '#b91c1c', fontSize: 13 }}>
                Failed to load: {String(featuresQ.error)}
              </li>
            ) : filteredFeatures.length === 0 ? (
              <li style={{ padding: 12, color: '#6b7280', fontSize: 13 }}>
                No features {bucket === 'all' ? '' : `with design_status=${bucket}`}.
              </li>
            ) : (
              filteredFeatures.map((f) => (
                <li
                  key={f.featureId}
                  onClick={() => setSelectedFeatureId(f.featureId)}
                  style={{
                    padding: '8px 12px',
                    borderBottom: '1px solid #f3f4f6',
                    cursor: 'pointer',
                    background: selectedFeatureId === f.featureId ? '#f9fafb' : 'transparent',
                  }}
                >
                  <div style={{ fontSize: 13, fontWeight: 500, color: '#111827' }}>
                    {f.title || f.featureId}
                  </div>
                  <div style={{ fontSize: 11, color: '#6b7280', marginTop: 2, display: 'flex', gap: 8 }}>
                    <code style={{ fontFamily: 'monospace' }}>{f.featureId}</code>
                    <span>·</span>
                    <span>
                      design:{' '}
                      <strong style={{ color: designStatusColor(f.designStatus) }}>
                        {f.designStatus ?? 'pending'}
                      </strong>
                    </span>
                  </div>
                </li>
              ))
            )}
          </ul>
        </aside>

        {/* Main: active pane */}
        <main style={{ flex: 1, padding: 16, overflow: 'auto', minHeight: 0 }}>
          {activePane === 'features' && (
            <FeatureDetailPane feature={selectedFeature} />
          )}
          {activePane === 'memos' && (
            <MemosPane
              memos={memosQ.data ?? []}
              loading={memosQ.isLoading}
              error={memosQ.isError ? String(memosQ.error) : null}
            />
          )}
          {activePane === 'registry' && (
            <RegistryPane
              entries={registryQ.data ?? []}
              loading={registryQ.isLoading}
              error={registryQ.isError ? String(registryQ.error) : null}
              query={registryQuery}
              onQueryChange={setRegistryQuery}
            />
          )}
          {activePane === 'tokens' && (
            <TokensPane
              data={tokensQ.data ?? null}
              loading={tokensQ.isLoading}
              error={tokensQ.isError ? String(tokensQ.error) : null}
            />
          )}
          {activePane === 'sketch' && (
            <SketchPane slug={slug} featureId={selectedFeatureId} />
          )}
          {activePane === 'regressions' && <RegressionPane />}
        </main>
      </div>
    </div>
  );
}

function designStatusColor(s: 'pending' | 'accepted' | 'ignored' | null): string {
  switch (s) {
    case 'accepted': return '#15803d';
    case 'ignored': return '#6b7280';
    case 'pending':
    default: return '#a16207';
  }
}

function FeatureDetailPane({ feature }: { feature: DesignFeature | null }) {
  if (!feature) {
    return <p style={{ color: '#6b7280' }}>Pick a feature on the left to inspect its design state.</p>;
  }
  return (
    <div>
      <h2 style={{ fontSize: 16, fontWeight: 600, marginTop: 0 }}>{feature.title}</h2>
      <p style={{ color: '#6b7280', fontSize: 13, marginTop: 4 }}>
        <code>{feature.featureId}</code>
      </p>
      <dl style={{ fontSize: 13, marginTop: 16, display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '4px 16px' }}>
        <dt style={{ color: '#6b7280' }}>Status</dt>
        <dd style={{ margin: 0 }}>{feature.status ?? '—'}</dd>
        <dt style={{ color: '#6b7280' }}>Design status</dt>
        <dd style={{ margin: 0, color: designStatusColor(feature.designStatus), fontWeight: 500 }}>
          {feature.designStatus ?? 'pending'}
        </dd>
        <dt style={{ color: '#6b7280' }}>Design spec id</dt>
        <dd style={{ margin: 0, fontFamily: 'monospace', fontSize: 12 }}>{feature.designSpecId ?? '—'}</dd>
        <dt style={{ color: '#6b7280' }}>Discarded design work</dt>
        <dd style={{ margin: 0 }}>{feature.discardedDesignWork ? 'yes' : 'no'}</dd>
      </dl>
      {feature.summary && (
        <section style={{ marginTop: 24 }}>
          <h3 style={{ fontSize: 13, fontWeight: 600, color: '#374151' }}>Summary</h3>
          <p style={{ fontSize: 13, color: '#374151', whiteSpace: 'pre-wrap' }}>{feature.summary}</p>
        </section>
      )}
    </div>
  );
}

function MemosPane({
  memos,
  loading,
  error,
}: {
  memos: MemoEntry[];
  loading: boolean;
  error: string | null;
}) {
  if (loading) return <p style={{ color: '#6b7280' }}>Loading memos…</p>;
  if (error) return <p style={{ color: '#b91c1c' }}>Failed: {error}</p>;
  if (memos.length === 0) return <p style={{ color: '#6b7280' }}>No memos.</p>;
  return (
    <div>
      <h2 style={{ fontSize: 16, fontWeight: 600, marginTop: 0 }}>
        Design memos <span style={{ color: '#9ca3af', fontWeight: 400 }}>({memos.length})</span>
      </h2>
      <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
        {memos.map((m) => (
          <li
            key={m.slug}
            style={{
              padding: '10px 0',
              borderBottom: '1px solid #f3f4f6',
              display: 'flex',
              alignItems: 'baseline',
              gap: 12,
            }}
          >
            <a
              href={`/docs/design/${m.slug}`}
              target="_blank"
              rel="noreferrer"
              style={{ fontSize: 13, color: '#1d4ed8', textDecoration: 'none', fontWeight: 500 }}
            >
              {m.title}
            </a>
            <span
              style={{
                fontSize: 11,
                padding: '2px 6px',
                borderRadius: 10,
                background:
                  m.status === 'addressed' ? '#dcfce7' :
                  m.status === 'wontfix' ? '#fee2e2' : '#fef3c7',
                color:
                  m.status === 'addressed' ? '#166534' :
                  m.status === 'wontfix' ? '#991b1b' : '#92400e',
              }}
            >
              {m.status}
            </span>
            <code style={{ fontSize: 11, color: '#6b7280', marginLeft: 'auto' }}>{m.slug}</code>
          </li>
        ))}
      </ul>
    </div>
  );
}

function TokensPane({
  data,
  loading,
  error,
}: {
  data: { source: string | null; error: string | null; count: number; tokens: DtcgToken[] } | null;
  loading: boolean;
  error: string | null;
}) {
  if (loading) return <p style={{ color: '#6b7280' }}>Loading tokens…</p>;
  if (error) return <p style={{ color: '#b91c1c' }}>Failed: {error}</p>;
  if (!data) return <p style={{ color: '#6b7280' }}>No tokens loaded.</p>;
  if (data.error) return <p style={{ color: '#b91c1c' }}>Token store error: {data.error}</p>;
  if (data.tokens.length === 0) {
    return (
      <p style={{ color: '#6b7280' }}>
        No DTCG tokens found at workspace root <code>design/tokens/base.json</code>.
      </p>
    );
  }
  // Group tokens by their top-level group (color, space, radius, …)
  const groups = new Map<string, DtcgToken[]>();
  for (const t of data.tokens) {
    const top = t.id.split('.')[0] || 'misc';
    const arr = groups.get(top) ?? [];
    arr.push(t);
    groups.set(top, arr);
  }
  return (
    <div>
      <header style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 12 }}>
        <h2 style={{ fontSize: 16, fontWeight: 600, margin: 0 }}>
          Tokens <span style={{ color: '#9ca3af', fontWeight: 400 }}>({data.count} DTCG)</span>
        </h2>
        {data.source && (
          <code style={{ fontSize: 11, color: '#6b7280' }}>{data.source}</code>
        )}
      </header>
      {[...groups.entries()].map(([group, tokens]) => (
        <section key={group} style={{ marginBottom: 24 }}>
          <h3 style={{ fontSize: 13, fontWeight: 600, color: '#374151', textTransform: 'uppercase', letterSpacing: 0.5 }}>
            {group} <span style={{ color: '#9ca3af', fontWeight: 400 }}>({tokens.length})</span>
          </h3>
          <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 8 }}>
            {tokens.map((t) => (
              <li
                key={t.id}
                style={{
                  border: '1px solid #e5e7eb',
                  borderRadius: 6,
                  padding: '8px 10px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  fontSize: 12,
                }}
              >
                <TokenSwatch token={t} />
                <div style={{ minWidth: 0, flex: 1 }}>
                  <code style={{ fontSize: 11, color: '#111827', display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {t.id}
                  </code>
                  <span style={{ fontSize: 11, color: '#6b7280' }}>
                    {String(t.value)} <span style={{ marginLeft: 4 }}>· {t.type}</span>
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function TokenSwatch({ token }: { token: DtcgToken }) {
  if (token.type === 'color' && typeof token.value === 'string') {
    return (
      <span
        title={String(token.value)}
        style={{
          width: 28,
          height: 28,
          borderRadius: 4,
          background: token.value,
          border: '1px solid #e5e7eb',
          flexShrink: 0,
        }}
      />
    );
  }
  if (token.type === 'dimension' && typeof token.value === 'string') {
    const px = parseFloat(token.value);
    if (Number.isFinite(px) && px > 0 && px < 80) {
      return (
        <span
          aria-hidden
          style={{
            width: 28,
            height: 28,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            border: '1px solid #e5e7eb',
            borderRadius: 4,
            flexShrink: 0,
          }}
        >
          <span style={{ width: px, height: px, background: '#9ca3af', display: 'block', borderRadius: 2 }} />
        </span>
      );
    }
  }
  return (
    <span
      style={{
        width: 28,
        height: 28,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        border: '1px solid #e5e7eb',
        borderRadius: 4,
        fontSize: 10,
        color: '#9ca3af',
        flexShrink: 0,
      }}
    >
      {token.type.slice(0, 3)}
    </span>
  );
}

function RegistryPane({
  entries,
  loading,
  error,
  query,
  onQueryChange,
}: {
  entries: RegistryEntry[];
  loading: boolean;
  error: string | null;
  query: string;
  onQueryChange: (q: string) => void;
}) {
  return (
    <div>
      <h2 style={{ fontSize: 16, fontWeight: 600, marginTop: 0 }}>
        Component registry{' '}
        <span style={{ color: '#9ca3af', fontWeight: 400 }}>react-tailwind</span>
      </h2>
      <input
        type="search"
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
        placeholder="Filter by id, summary, or input name…"
        style={{
          width: '100%',
          padding: '8px 10px',
          borderRadius: 6,
          border: '1px solid #e5e7eb',
          fontSize: 13,
          marginBottom: 12,
        }}
      />
      {loading ? (
        <p style={{ color: '#6b7280' }}>Loading registry…</p>
      ) : error ? (
        <p style={{ color: '#b91c1c' }}>Failed: {error}</p>
      ) : entries.length === 0 ? (
        <p style={{ color: '#6b7280' }}>No matches.</p>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {entries.map((e) => (
            <li
              key={e.id}
              style={{
                padding: '12px 0',
                borderBottom: '1px solid #f3f4f6',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                <code style={{ fontSize: 13, fontWeight: 500, color: '#111827' }}>{e.id}</code>
                <span style={{ fontSize: 11, color: '#6b7280' }}>{e.kind}</span>
              </div>
              <p style={{ fontSize: 13, color: '#374151', margin: '4px 0' }}>{e.summary}</p>
              {e.inputs && e.inputs.length > 0 && (
                <div style={{ fontSize: 12, color: '#6b7280', marginTop: 4 }}>
                  inputs: {e.inputs.map((i) => `${i.name}${i.required ? '*' : ''}: ${i.type}`).join(', ')}
                </div>
              )}
              {e.variants && e.variants.length > 0 && (
                <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>
                  variants: {e.variants.join(' · ')}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
