'use client';

/**
 * Design tab — v0.1.
 *
 * Reads features with `needs_design=true` through @papercusp/sync and
 * groups them by `design_status`. Embeds the registry browser and memo
 * backlog through sync-backed design-phase query names.
 *
 * Plan §6 — apps/operator/content/internal-docs/design/design-phase-plan.mdx.
 *
 * Deliberately self-contained — does not import HarnessDashboard or
 * FeatureList. The shared mode-parameterized FeatureList is deferred
 * until the existing component is refactored without paperclip
 * collision risk.
 */
import { useState, useMemo } from 'react';
import { useQueryState, parseAsString, parseAsStringEnum } from 'nuqs';
import type React from 'react';
import { useSyncQuery } from '@papercusp/sync';
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

interface DtcgTokenList {
  source: string | null;
  error: string | null;
  count: number;
  tokens: DtcgToken[];
}

type Pane = 'features' | 'memos' | 'registry' | 'tokens' | 'sketch' | 'regressions';

type Bucket = 'all' | 'pending' | 'accepted' | 'ignored';

const PANES: Pane[] = ['features', 'memos', 'registry', 'tokens', 'sketch', 'regressions'];
const BUCKETS: Bucket[] = ['all', 'pending', 'accepted', 'ignored'];

export default function DesignDashboard({ slug }: { slug: string }) {
  const workspaceId = useWorkspaceId();
  // Pane + bucket are user-meaningful selectors → URL via nuqs (agents read
  // the URL through ui:get_state; useState would make them invisible).
  const [activePane, setActivePane] = useQueryState('pane', parseAsStringEnum<Pane>(PANES).withDefault('features'));
  const [bucket, setBucket] = useQueryState('bucket', parseAsStringEnum<Bucket>(BUCKETS).withDefault('all'));
  const [selectedFeatureId, setSelectedFeatureId] = useQueryState('feature', parseAsString);
  const [registryQuery, setRegistryQuery] = useState('');

  const featuresQ = useSyncQuery<DesignFeature>({
    queryName: 'designFeatures.byHarness',
    args: { harnessSlug: slug, workspaceId: workspaceId ?? 'default' },
    enabled: Boolean(slug),
  });

  const memosQ = useSyncQuery<MemoEntry>({
    queryName: 'designMemos.list',
    args: { status: 'any' },
    enabled: activePane === 'memos',
  });

  const registryQ = useSyncQuery<RegistryEntry>({
    queryName: 'designRegistry.search',
    args: { ecosystem: 'react-tailwind', query: registryQuery },
    enabled: activePane === 'registry',
  });

  const tokensQ = useSyncQuery<DtcgToken>({
    queryName: 'designTokens.list',
    enabled: activePane === 'tokens',
  });

  const features = featuresQ.data ?? [];
  const tokenRows = tokensQ.data ?? [];
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
    <div className="d-root pc-animate-in pc-animate-in--fast">
      <header className="d-header">
        <div className="d-titleblock">
          <div className="d-eyebrow">design workspace</div>
          <h1 className="d-title">
            Design <span>· {slug}</span>
          </h1>
          <p className="d-subtitle">IR specs, registry, tokens, sketches, and visual regression review.</p>
        </div>
        <div className="d-metrics" aria-label="Design queue summary">
          <Metric label="features" value={counts.all} tone="info" />
          <Metric label="pending" value={counts.pending} tone="warn" />
          <Metric label="accepted" value={counts.accepted} tone="good" />
        </div>
        <nav className="d-pane-tabs" aria-label="Design workspace panes">
          {PANES.map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => setActivePane(p)}
              className="d-pane-tab"
              data-active={activePane === p}
              aria-pressed={activePane === p}
            >
              {p}
            </button>
          ))}
        </nav>
      </header>

      <div className="d-shell">
        <aside className="d-rail" aria-label="Design feature queue">
          <div className="d-rail-head">
            <div>
              <div className="d-section-label">Feature queue</div>
              <div className="d-rail-subtitle">Needs design handoff</div>
            </div>
            <span className="d-chip d-chip--info">{filteredFeatures.length}/{counts.all}</span>
          </div>
          <div className="d-buckets" role="group" aria-label="Filter design features by status">
            {BUCKETS.map((b) => (
              <button
                key={b}
                type="button"
                onClick={() => setBucket(b)}
                className="d-bucket"
                data-active={bucket === b}
                aria-pressed={bucket === b}
              >
                <span>{b}</span>
                <strong>{counts[b]}</strong>
              </button>
            ))}
          </div>
          <ul className="d-feature-list">
            {featuresQ.loading ? (
              <StateRow tone="info">Loading design features…</StateRow>
            ) : featuresQ.error ? (
              <StateRow tone="bad">Failed to load: {featuresQ.error.message}</StateRow>
            ) : filteredFeatures.length === 0 ? (
              <StateRow tone="muted">No features {bucket === 'all' ? '' : `with design_status=${bucket}`}.</StateRow>
            ) : (
              filteredFeatures.map((f) => (
                <li key={f.featureId}>
                  <button
                    type="button"
                    onClick={() => setSelectedFeatureId(f.featureId)}
                    className="d-feature-row"
                    data-active={selectedFeatureId === f.featureId}
                  >
                    <span className="d-feature-title">{f.title || f.featureId}</span>
                    <span className="d-feature-meta">
                      <code>{f.featureId}</code>
                      <span className={designStatusClass(f.designStatus)}>{f.designStatus ?? 'pending'}</span>
                    </span>
                  </button>
                </li>
              ))
            )}
          </ul>
        </aside>

        <main className="d-content">
          {activePane === 'features' && <FeatureDetailPane feature={selectedFeature} counts={counts} />}
          {activePane === 'memos' && (
            <MemosPane
              memos={memosQ.data ?? []}
              loading={memosQ.loading}
              error={memosQ.error ? memosQ.error.message : null}
            />
          )}
          {activePane === 'registry' && (
            <RegistryPane
              entries={registryQ.data ?? []}
              loading={registryQ.loading}
              error={registryQ.error ? registryQ.error.message : null}
              query={registryQuery}
              onQueryChange={setRegistryQuery}
            />
          )}
          {activePane === 'tokens' && (
            <TokensPane
              data={{ source: 'design/tokens/base.json', error: null, count: tokenRows.length, tokens: tokenRows } satisfies DtcgTokenList}
              loading={tokensQ.loading}
              error={tokensQ.error ? tokensQ.error.message : null}
            />
          )}
          {activePane === 'sketch' && <SketchPane slug={slug} featureId={selectedFeatureId} />}
          {activePane === 'regressions' && <RegressionPane />}
        </main>
      </div>
    </div>
  );
}

function Metric({ label, value, tone }: { label: string; value: number; tone: 'info' | 'warn' | 'good' }) {
  return (
    <div className={`d-metric d-metric--${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function StateRow({ children, tone }: { children: React.ReactNode; tone: 'info' | 'bad' | 'muted' }) {
  return <li className={`d-state-row d-state-row--${tone}`}>{children}</li>;
}

function designStatusClass(s: 'pending' | 'accepted' | 'ignored' | null): string {
  return `d-chip d-chip--${s ?? 'pending'}`;
}

function memoStatusChipClass(status: string): string {
  if (status === 'addressed') return 'd-chip d-chip--accepted';
  if (status === 'wontfix') return 'd-chip d-chip--ignored';
  return 'd-chip d-chip--pending';
}

function FeatureDetailPane({ feature, counts }: { feature: DesignFeature | null; counts: Record<Bucket, number> }) {
  if (!feature) {
    return (
      <section className="d-empty-card">
        <div className="d-empty-icon">◇</div>
        <h2>Pick a feature to inspect</h2>
        <p>
          Choose a queue item on the left to review its design status, linked design spec, discarded work flag,
          and implementation summary.
        </p>
        <div className="d-empty-chips">
          <span className="d-chip d-chip--info">{counts.all} total</span>
          <span className="d-chip d-chip--pending">{counts.pending} pending</span>
          <span className="d-chip d-chip--accepted">{counts.accepted} accepted</span>
        </div>
      </section>
    );
  }
  return (
    <article className="d-detail-card">
      <header className="d-card-head">
        <div>
          <div className="d-section-label">Selected feature</div>
          <h2>{feature.title || feature.featureId}</h2>
        </div>
        <span className={designStatusClass(feature.designStatus)}>{feature.designStatus ?? 'pending'}</span>
      </header>
      <div className="d-kv-grid">
        <div>
          <dt>Feature ID</dt>
          <dd><code>{feature.featureId}</code></dd>
        </div>
        <div>
          <dt>Status</dt>
          <dd>{feature.status ?? '—'}</dd>
        </div>
        <div>
          <dt>Design spec</dt>
          <dd><code>{feature.designSpecId ?? '—'}</code></dd>
        </div>
        <div>
          <dt>Discarded work</dt>
          <dd>{feature.discardedDesignWork ? 'yes' : 'no'}</dd>
        </div>
      </div>
      {feature.summary && (
        <section className="d-summary-card">
          <h3>Summary</h3>
          <p>{feature.summary}</p>
        </section>
      )}
    </article>
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
  if (loading) return <PanelState>Loading design memos…</PanelState>;
  if (error) return <PanelState tone="bad">Failed: {error}</PanelState>;
  if (memos.length === 0) return <PanelState>No memos yet.</PanelState>;
  return (
    <section className="d-pane-card">
      <header className="d-card-head">
        <div>
          <div className="d-section-label">Memo backlog</div>
          <h2>Design memos</h2>
        </div>
        <span className="d-chip d-chip--info">{memos.length}</span>
      </header>
      <ul className="d-list-stack">
        {memos.map((m) => (
          <li key={m.slug} className="d-memo-row">
            <a href={`/docs/design/${m.slug}`} target="_blank" rel="noreferrer">
              {m.title}
            </a>
            <span className={memoStatusChipClass(m.status)}>{m.status}</span>
            <code>{m.slug}</code>
          </li>
        ))}
      </ul>
    </section>
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
  if (loading) return <PanelState>Loading tokens…</PanelState>;
  if (error) return <PanelState tone="bad">Failed: {error}</PanelState>;
  if (!data) return <PanelState>No tokens loaded.</PanelState>;
  if (data.error) return <PanelState tone="bad">Token store error: {data.error}</PanelState>;
  if (data.tokens.length === 0) {
    return (
      <PanelState>
        No DTCG tokens found at workspace root <code>design/tokens/base.json</code>.
      </PanelState>
    );
  }

  const groups = new Map<string, DtcgToken[]>();
  for (const t of data.tokens) {
    const top = t.id.split('.')[0] || 'misc';
    const arr = groups.get(top) ?? [];
    arr.push(t);
    groups.set(top, arr);
  }

  return (
    <section className="d-pane-card">
      <header className="d-card-head">
        <div>
          <div className="d-section-label">Token source</div>
          <h2>Tokens</h2>
        </div>
        <span className="d-chip d-chip--info">{data.count} DTCG</span>
        {data.source && <code className="d-source-chip">{data.source}</code>}
      </header>
      {[...groups.entries()].map(([group, tokens]) => (
        <section key={group} className="d-token-group">
          <h3>
            {group} <span>({tokens.length})</span>
          </h3>
          <ul className="d-token-grid">
            {tokens.map((t) => (
              <li key={t.id} className="d-token-card">
                <TokenSwatch token={t} />
                <div>
                  <code>{t.id}</code>
                  <span>{String(t.value)} · {t.type}</span>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </section>
  );
}

function TokenSwatch({ token }: { token: DtcgToken }) {
  if (token.type === 'color' && typeof token.value === 'string') {
    return <span className="d-token-swatch" title={String(token.value)} style={{ background: token.value }} />;
  }
  if (token.type === 'dimension' && typeof token.value === 'string') {
    const px = parseFloat(token.value);
    if (Number.isFinite(px) && px > 0 && px < 80) {
      return (
        <span className="d-token-swatch d-token-swatch--dimension" aria-hidden>
          <span style={{ width: px, height: px }} />
        </span>
      );
    }
  }
  return <span className="d-token-swatch d-token-swatch--type">{token.type.slice(0, 3)}</span>;
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
    <section className="d-pane-card">
      <header className="d-card-head d-card-head--stacked">
        <div>
          <div className="d-section-label">Component registry</div>
          <h2>React + Tailwind primitives</h2>
        </div>
        <span className="d-chip d-chip--info">{entries.length} matches</span>
      </header>
      <input
        type="search"
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
        placeholder="Filter by id, summary, or input name…"
        className="d-search-input"
      />
      {loading ? (
        <PanelState>Loading registry…</PanelState>
      ) : error ? (
        <PanelState tone="bad">Failed: {error}</PanelState>
      ) : entries.length === 0 ? (
        <PanelState>No matches.</PanelState>
      ) : (
        <ul className="d-list-stack d-registry-list">
          {entries.map((e) => (
            <li key={e.id} className="d-registry-row">
              <div className="d-registry-title">
                <code>{e.id}</code>
                <span className="d-chip d-chip--info">{e.kind}</span>
              </div>
              <p>{e.summary}</p>
              {e.inputs && e.inputs.length > 0 && (
                <div className="d-registry-meta">
                  inputs: {e.inputs.map((i) => `${i.name}${i.required ? '*' : ''}: ${i.type}`).join(', ')}
                </div>
              )}
              {e.variants && e.variants.length > 0 && (
                <div className="d-registry-meta">variants: {e.variants.join(' · ')}</div>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function PanelState({ children, tone = 'muted' }: { children: React.ReactNode; tone?: 'muted' | 'bad' }) {
  return <div className={`d-panel-state d-panel-state--${tone}`}>{children}</div>;
}
