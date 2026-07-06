'use client';

import React, { useState } from 'react';
import * as Lucide from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { TemplateConfigTab } from './TemplateConfigTab';
import { SnapshotStateTab } from './SnapshotStateTab';
import { publisherProfileHref } from './publisherProfileHref';

export interface DetailResponse {
  slug: string;
  versions: string[];
  latest: {
    name: string;
    version: string;
    description?: string;
    author?: string;
    license?: string;
    kind?: 'plugin' | 'template' | 'snapshot';
    icon?: string | null;
    homepage?: string | null;
    publishedBy?: string;
    publishedAt?: string;
    capabilities?: string[];
    papercusp?: string;
    plugins?: Array<string | { slug: string; autoEnable?: boolean; config?: unknown; version?: string }>;
    models?: Record<string, unknown>;
    configFiles?: Array<{
      path: string;
      label?: string;
      language?: 'markdown' | 'json' | 'yaml' | 'text';
      description?: string;
      sensitivity?: 'normal' | 'warn' | 'secret';
    }>;
    snapshot?: {
      sourceHarness?: string;
      capturedAt?: string;
      filesCount?: number;
      pluginsCount?: number;
      partial?: boolean;
      redactions?: { verifiedHits?: number; highRecallHits?: number };
    };
  };
  manifest?: Record<string, unknown>;
  readme?: string | null;
  sbom?: {
    format?: string;
    vulnerabilities?: { total: number; critical: number; high: number; medium: number; low: number };
  } | null;
  reviews?: {
    summary?: { reviewCount: number; averageRating: number; histogram: Record<string, number> } | null;
  } | null;
  error?: string;
}

const KIND_LABEL: Record<string, { label: string; tone: string }> = {
  plugin:   { label: 'PLUGIN',   tone: 'plugin' },
  template: { label: 'TEMPLATE', tone: 'template' },
  snapshot: { label: 'SNAPSHOT', tone: 'snapshot' },
};

function HeaderIcon({ name, kind }: { name: string | null | undefined; kind: 'plugin' | 'template' | 'snapshot' }) {
  const fallback = kind === 'plugin' ? Lucide.Puzzle : kind === 'snapshot' ? Lucide.Layers : Lucide.Package;
  const Icon = (name && (Lucide as Record<string, unknown>)[name] as React.ComponentType<{ size?: number }>) ?? fallback;
  return (
    <span className={`pc-marketplace-card-icon ${kind}`} aria-hidden>
      <Icon size={28} />
    </span>
  );
}

interface Props {
  slug: string;
  detail: DetailResponse | null;
  apiBase?: string;
}

export function MarketplaceDetail({ slug, detail, apiBase }: Props) {
  const resolvedApiBase =
    apiBase
    ?? (typeof process !== 'undefined' ? process.env.NEXT_PUBLIC_API_BASE : undefined)
    ?? 'http://localhost:3057';
  if (!detail || detail.error || !detail.latest) {
    return (
      <div className="pc-shell">
        <h1>{slug}</h1>
        <p style={{ color: 'var(--bad)' }}>This package isn&rsquo;t in the catalog.</p>
        <p>
          <a href="/marketplace" className="pc-button">← back to marketplace</a>
        </p>
      </div>
    );
  }

  const m = detail.latest;
  const kind = (m.kind ?? 'template') as 'plugin' | 'template' | 'snapshot';
  const kindMeta = KIND_LABEL[kind] ?? KIND_LABEL.template;
  const isSnapshot = kind === 'snapshot';
  const hasConfig =
    (m.configFiles?.length ?? 0) > 0
    || (Array.isArray(m.plugins) && m.plugins.length > 0 && kind !== 'plugin')
    || (m.models && Object.keys(m.models).length > 0);
  const hasState = isSnapshot;
  const tabs: Array<'overview' | 'config' | 'state'> = ['overview'];
  if (hasConfig) tabs.push('config');
  if (hasState) tabs.push('state');
  const [tab, setTab] = useState<'overview' | 'config' | 'state'>('overview');
  // Adapt the new manifest's snapshot shape (capturedAt) to the
  // SnapshotStateTab's expected shape (takenAt) so existing tab UI
  // doesn't fork into two variants.
  const snapForTab = m.snapshot
    ? {
        takenAt: m.snapshot.capturedAt,
        sourceHarness: m.snapshot.sourceHarness,
        // Older snapshots don't carry these on the new shape; pass
        // through whatever's present.
        featureCounts: (m.snapshot as unknown as { featureCounts?: Record<string, number> }).featureCounts,
        iteration: (m.snapshot as unknown as { iteration?: number }).iteration,
        sourceProjectPath: (m.snapshot as unknown as { sourceProjectPath?: string }).sourceProjectPath,
        includesProject: (m.snapshot as unknown as { includesProject?: boolean }).includesProject,
      }
    : undefined;
  const installCmd = isSnapshot
    ? `papercusp snapshot fork ${m.name}`
    : kind === 'plugin'
      ? `papercusp install ${m.name}`
      : `papercusp init my-project --from ${m.name}`;

  return (
    <div className="pc-shell pc-marketplace-detail">
      <p style={{ marginBottom: 12 }}>
        <a href={`/marketplace/${kind === 'plugin' ? 'plugins' : kind === 'snapshot' ? 'snapshots' : 'templates'}`}
           style={{ color: 'var(--fg-mute)', fontSize: 12 }}>
          ← back to {kind === 'plugin' ? 'plugins' : kind === 'snapshot' ? 'snapshots' : 'templates'}
        </a>
      </p>

      <header className="pc-marketplace-detail-head">
        <HeaderIcon name={m.icon} kind={kind} />
        <div>
          <span className={`pc-marketplace-detail-kind ${kindMeta.tone}`}>{kindMeta.label}</span>
          <h1>{m.name}</h1>
          <p className="pc-marketplace-detail-tagline">{m.description ?? 'No description provided.'}</p>
          <div className="pc-marketplace-detail-meta">
            <code>v{m.version}</code>
            <span>{m.license ?? 'unspecified'}</span>
            <span>by {m.publishedBy ? <a href={publisherProfileHref(m.publishedBy)}>@{m.publishedBy}</a> : (m.author ?? 'unknown')}</span>
            {m.publishedAt && <span>published {new Date(m.publishedAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}</span>}
            {m.homepage && <a href={m.homepage} target="_blank" rel="noreferrer">homepage</a>}
          </div>
          <TrustBadges sbom={detail.sbom} reviews={detail.reviews} slug={detail.slug} />
        </div>
      </header>

      <div className="pc-marketplace-detail-layout">
        <article className="pc-card pc-marketplace-detail-readme">
          {tabs.length > 1 ? (
            <div
              role="tablist"
              style={{
                display: 'flex',
                gap: 4,
                borderBottom: '1px solid var(--border)',
                marginBottom: 16,
              }}
            >
              {tabs.map((t) => (
                <button
                  key={t}
                  role="tab"
                  aria-selected={tab === t}
                  onClick={() => setTab(t)}
                  style={{
                    background: 'transparent',
                    border: 'none',
                    borderBottom: tab === t ? '2px solid var(--accent, #3b82f6)' : '2px solid transparent',
                    color: tab === t ? 'var(--fg)' : 'var(--fg-mute)',
                    padding: '8px 14px',
                    fontSize: 13,
                    fontWeight: 600,
                    textTransform: 'capitalize',
                    cursor: 'pointer',
                    marginBottom: -1,
                  }}
                >
                  {t}
                </button>
              ))}
            </div>
          ) : null}
          {tab === 'overview' ? (
            <>
              {isSnapshot && m.snapshot && <SnapshotMeta snap={m.snapshot} />}
              {detail.readme ? (
                <div className="pc-marketplace-detail-readme-body">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{detail.readme}</ReactMarkdown>
                </div>
              ) : (
                <p style={{ color: 'var(--fg-mute)' }}>This package has no README.</p>
              )}
            </>
          ) : tab === 'config' ? (
            <TemplateConfigTab
              configFiles={m.configFiles}
              models={m.models}
              plugins={m.plugins}
            />
          ) : (
            <SnapshotStateTab
              slug={detail.slug}
              version={m.version}
              apiBase={resolvedApiBase}
              snapshot={snapForTab}
            />
          )}
        </article>

        <aside className="pc-marketplace-detail-sidebar">
          <section className="pc-card pc-marketplace-detail-section">
            <h4>{isSnapshot ? 'Fork' : 'Install'}</h4>
            <div className="pc-marketplace-detail-cmd">
              <code>{installCmd}</code>
            </div>
            <p style={{ fontSize: 12, color: 'var(--fg-mute)', marginTop: 8, marginBottom: 0 }}>
              Run from any terminal where the <code>papercusp</code> CLI is installed.
            </p>
          </section>

          {m.plugins && m.plugins.length > 0 && (
            <section className="pc-card pc-marketplace-detail-section">
              <h4>Plugins</h4>
              <ul>
                {m.plugins.map((p, i) => {
                  const pSlug = typeof p === 'string' ? p : p.slug;
                  const autoEnable = typeof p === 'object' && p.autoEnable;
                  return (
                    <li key={`${pSlug}-${i}`}>
                      <a href={`/marketplace/${encodeURIComponent(pSlug)}`}><code>{pSlug}</code></a>
                      {autoEnable && <span className="pc-marketplace-detail-tag">auto-enabled</span>}
                    </li>
                  );
                })}
              </ul>
            </section>
          )}

          <section className="pc-card pc-marketplace-detail-section">
            <h4>Versions</h4>
            <ul>
              {detail.versions.map((v) => (
                <li key={v}>
                  <code style={{ color: v === m.version ? 'var(--accent-strong)' : 'var(--fg-mute)' }}>v{v}</code>
                  {v === m.version && <span className="pc-marketplace-detail-tag">latest</span>}
                </li>
              ))}
            </ul>
          </section>

          {m.papercusp && (
            <section className="pc-card pc-marketplace-detail-section">
              <h4>Substrate compat</h4>
              <code style={{ fontSize: 12, color: 'var(--fg)' }}>papercusp {m.papercusp}</code>
            </section>
          )}

          {m.capabilities && m.capabilities.length > 0 && (
            <section className="pc-card pc-marketplace-detail-section">
              <h4>Capabilities ({m.capabilities.length})</h4>
              <ul className="pc-marketplace-detail-caps">
                {m.capabilities.map((c) => <li key={c}><code>{c}</code></li>)}
              </ul>
            </section>
          )}
        </aside>
      </div>
    </div>
  );
}

function SnapshotMeta({ snap }: { snap: NonNullable<DetailResponse['latest']['snapshot']> }) {
  const r = snap.redactions ?? {};
  const clean = (r.verifiedHits ?? 0) === 0 && (r.highRecallHits ?? 0) === 0;
  return (
    <div className="pc-marketplace-detail-snapshot">
      <div>
        <strong>Source harness</strong>
        <code>{snap.sourceHarness ?? '(unknown)'}</code>
      </div>
      {snap.capturedAt && (
        <div>
          <strong>Captured</strong>
          <span>{new Date(snap.capturedAt).toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
        </div>
      )}
      {typeof snap.filesCount === 'number' && (
        <div>
          <strong>Files</strong>
          <span>{snap.filesCount}{typeof snap.pluginsCount === 'number' ? ` · ${snap.pluginsCount} plugin${snap.pluginsCount === 1 ? '' : 's'}` : ''}</span>
        </div>
      )}
      <div>
        <strong>Redactions</strong>
        <span style={{ color: clean ? 'var(--good)' : 'var(--warn)' }}>
          {clean ? 'clean' : `${r.verifiedHits ?? 0} verified · ${r.highRecallHits ?? 0} warnings`}
        </span>
      </div>
      {snap.partial && <div><strong>Partial</strong><span style={{ color: 'var(--warn)' }}>yes — some files were skipped</span></div>}
    </div>
  );
}

function TrustBadges(props: {
  slug: string;
  sbom: DetailResponse['sbom'];
  reviews: DetailResponse['reviews'];
}) {
  const v = props.sbom?.vulnerabilities;
  const summary = props.reviews?.summary;
  const hasSbom = !!props.sbom?.format;
  const hasReviews = (summary?.reviewCount ?? 0) > 0;
  if (!hasSbom && !hasReviews) return null;
  const totalVulns = v?.total ?? 0;
  const highOrCrit = (v?.critical ?? 0) + (v?.high ?? 0);
  const vulnColor = !hasSbom ? 'var(--fg-mute)'
    : totalVulns === 0 ? 'var(--good)'
    : highOrCrit > 0 ? 'var(--bad)'
    : 'var(--warn)';
  const vulnText = !hasSbom ? 'no SBOM uploaded'
    : totalVulns === 0 ? 'no known vulnerabilities'
    : `${totalVulns} known issue${totalVulns === 1 ? '' : 's'}${highOrCrit > 0 ? ` (${highOrCrit} high/critical)` : ''}`;
  const externalUrl = `https://papercuspai.com/marketplace/${encodeURIComponent(props.slug)}`;
  return (
    <div className="pc-marketplace-detail-trust">
      {hasSbom && (
        <a href={externalUrl} target="_blank" rel="noreferrer" style={{ borderColor: vulnColor }}>
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: vulnColor }} />
          {vulnText}
          <em>· {props.sbom?.format}</em>
        </a>
      )}
      {hasReviews && summary && (
        <a href={externalUrl + '#reviews'} target="_blank" rel="noreferrer">
          ★ {summary.averageRating.toFixed(1)}
          <em>· {summary.reviewCount} review{summary.reviewCount === 1 ? '' : 's'}</em>
        </a>
      )}
    </div>
  );
}
