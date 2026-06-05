'use client';

/**
 * CupboardClient — the storefront for the Cupboard registry.
 *
 * ONE storefront, five listing kinds (distribution plan D-005;
 * tool-distribution-granularity D-001), each with its own consumer action:
 *   harness   → join     (shared-harness via the Hypercore topic)
 *   blueprint → fork     (a blueprint stream within a project)
 *   snapshot  → fork     (a captured snapshot)
 *   plugin    → install  (a distributable plugin — a pack WITH a runtime)
 *   pack      → install  (a runtime-less code-tool pack)
 * Plus the **Tools** discovery view (`?kind=tools`) — tool-level discovery over
 * `GET /api/cupboard/tools`, where each tool resolves to its providing unit.
 *
 * - Kind filter is URL-backed (nuqs `?kind=`), forwarded to the worker via the
 *   `/api/cupboard/listings` proxy.
 * - The per-kind action button label comes from `listingAction()`. `harness`
 *   joins inline (the working join flow); `blueprint`/`snapshot`/`plugin` route
 *   to the listing detail where the fork/install is confirmed (the fork/install
 *   EXECUTION engine is owned by E1/E2 `init --from` + the plugin-host
 *   install-consent path — the storefront surfaces the listing + routes to it).
 * - Rendering reads either the live-worker row shape or the aspirational
 *   HarnessListing shape via the `listing*` helpers in cupboard/types.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from '@/lib/router-compat/navigation';
import { useQueryState, parseAsString, parseAsStringEnum } from 'nuqs';
import { Search, Globe, RefreshCw, ExternalLink, GitBranch, Users, Clock, ShieldCheck, AlertTriangle, GitFork, Plug, Boxes, LogIn, Camera, Package, ArrowLeft, Box, Wrench, Sparkles } from 'lucide-react';
import type { HarnessListing, ListingKind } from '@papercusp/operator-core/lib/cupboard/types';
import {
  isPubliclyVisible,
  listingAction,
  listingKindOf,
  listingRepoSlug,
  listingContributorCount,
  listingTopLanguage,
  listingPotRef,
  groupListingsByKind,
  buildHarnessJoinLink,
  LISTING_ACTION_LABEL,
} from '@papercusp/operator-core/lib/cupboard/types';
import { COLORS, FONTS, RADIUS, SIZES } from '../harness/theme';
import { ClaimStatusBadge } from '../_components/ClaimStatusBadge';
import { ToolsSection } from './ToolsSection';

type ClaimFilter = 'all' | 'claimed' | 'unclaimed';
type KindFilter = 'all' | ListingKind;
/** The tab row's domain: listing-kind filters + the tool-level discovery view. */
type ViewFilter = KindFilter | 'tools';

const VIEW_FILTERS: ViewFilter[] = ['all', 'harness', 'blueprint', 'snapshot', 'plugin', 'pack', 'tools'];
const VIEW_FILTER_LABEL: Record<ViewFilter, string> = {
  all: 'All',
  harness: 'Harnesses',
  blueprint: 'Blueprints',
  snapshot: 'Snapshots',
  plugin: 'Plugins',
  pack: 'Packs',
  tools: 'Tools',
};

/** Per-kind icon for the card badge + action button. */
function KindIcon({ kind, size = 11 }: { kind: ListingKind; size?: number }) {
  switch (kind) {
    case 'harness': return <Globe size={size} />;
    case 'blueprint': return <Boxes size={size} />;
    case 'snapshot': return <Camera size={size} />;
    case 'plugin': return <Plug size={size} />;
    case 'pack': return <Box size={size} />;
    default: return <Package size={size} />; // forward-compat: unknown kind from a newer worker
  }
}

/** Icon for a listing's action button (join/fork/install). */
function ActionIcon({ kind, size = 13 }: { kind: ListingKind; size?: number }) {
  switch (listingAction(kind)) {
    case 'join': return <LogIn size={size} />;
    case 'fork': return <GitFork size={size} />;
    case 'install': return <Plug size={size} />;
  }
}

const KIND_TONES: Record<ListingKind, { fg: string; bg: string; border: string }> = {
  harness: { fg: '#93c5fd', bg: 'rgba(59,130,246,0.14)', border: 'rgba(147,197,253,0.26)' },
  blueprint: { fg: '#a7f3d0', bg: 'rgba(16,185,129,0.14)', border: 'rgba(167,243,208,0.24)' },
  snapshot: { fg: '#fcd34d', bg: 'rgba(245,158,11,0.14)', border: 'rgba(252,211,77,0.24)' },
  plugin: { fg: '#c4b5fd', bg: 'rgba(139,92,246,0.14)', border: 'rgba(196,181,253,0.24)' },
  pack: { fg: '#67e8f9', bg: 'rgba(6,182,212,0.13)', border: 'rgba(103,232,249,0.24)' },
};

const filterButtonStyle = (active: boolean): React.CSSProperties => ({
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 6,
  background: active
    ? `linear-gradient(135deg, ${COLORS.accent}, ${COLORS.accentHover})`
    : 'rgba(15,20,32,0.72)',
  color: active ? '#fff' : COLORS.textMuted,
  border: `1px solid ${active ? 'rgba(255,255,255,0.18)' : COLORS.border}`,
  borderRadius: 999,
  padding: '7px 13px',
  cursor: 'pointer',
  fontSize: 12,
  fontFamily: FONTS.ui,
  boxShadow: active ? '0 12px 26px rgba(94,106,210,0.24)' : 'none',
});

const ghostButtonStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 6,
  background: 'rgba(15,20,32,0.72)',
  border: `1px solid ${COLORS.border}`,
  borderRadius: 999,
  padding: '7px 12px',
  cursor: 'pointer',
  color: COLORS.textMuted,
  fontSize: 12,
  fontFamily: FONTS.ui,
};

export default function CupboardClient() {
  const router = useRouter();
  const [q, setQ] = useQueryState('q', parseAsString.withDefault(''));
  const [claimFilter, setClaimFilter] = useQueryState<ClaimFilter>(
    'claim',
    {
      defaultValue: 'all',
      parse: (v) => (['all', 'claimed', 'unclaimed'].includes(v) ? (v as ClaimFilter) : 'all'),
      serialize: (v) => v,
    },
  );
  const [kindFilter, setKindFilter] = useQueryState<ViewFilter>(
    'kind',
    parseAsStringEnum<ViewFilter>(VIEW_FILTERS).withDefault('all'),
  );
  const toolsView = kindFilter === 'tools';
  // Per-Pot rollup (D-005): when set, the storefront narrows to one project
  // ("Pot") and presents its recipe/snapshot/plugin/harness facets grouped by
  // kind. `null` = normal flat browse. A Pot is identified by `project_ref`
  // (or the repo slug for legacy rows) — see `listingPotRef`.
  const [pot, setPot] = useQueryState('pot', parseAsString);
  const [listings, setListings] = useState<HarnessListing[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const fetchListings = useCallback(async () => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (q) params.set('q', q);
      if (claimFilter !== 'all') params.set('claim_status', claimFilter);
      if (pot) {
        // Pot rollup: fetch every kind for this project (the worker's
        // server-side `project` filter, forwarded by the proxy) so the rollup
        // can present all facets grouped. The kind tabs are hidden in this
        // mode, so `kind` is intentionally not forwarded.
        params.set('project', pot);
      } else if (kindFilter !== 'all' && kindFilter !== 'tools') {
        params.set('kind', kindFilter);
      }
      const res = await fetch(`/api/cupboard/listings?${params}`, { signal: ctrl.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { listings: HarnessListing[] };
      if (!ctrl.signal.aborted) {
        setListings((data.listings ?? []).filter(isPubliclyVisible));
      }
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        setError(String(err));
      }
    } finally {
      if (!ctrl.signal.aborted) setLoading(false);
    }
  }, [q, claimFilter, kindFilter, pot]);

  useEffect(() => {
    // The Tools view has its own fetch (ToolsSection); skip the listings read.
    if (toolsView && !pot) return;
    void fetchListings();
  }, [fetchListings, toolsView, pot]);

  // Pot rollup: client-side safety filter (the server `project` filter only
  // matches rows that actually carry `project_ref`; this keeps the grouping
  // correct regardless) + group by kind. Empty unless `pot` is set.
  const potListings = pot ? listings.filter((l) => listingPotRef(l) === pot) : [];
  const potGroups = pot ? groupListingsByKind(potListings) : [];
  const groupedListings = groupListingsByKind(listings);
  const facetCount = groupedListings.length;
  const activeViewLabel = toolsView && !pot
    ? 'Tool discovery'
    : pot
      ? 'Pot rollup'
      : kindFilter === 'all'
        ? 'All facets'
        : VIEW_FILTER_LABEL[kindFilter];

  const gridStyle: React.CSSProperties = {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))',
    gap: 14,
  };

  // Per-kind primary action. harness joins inline (the working join flow);
  // blueprint/snapshot/plugin open the listing detail where the fork/install
  // is confirmed + executed (the engine is E1/E2 / plugin-host — see file head).
  const handleAction = useCallback(
    (listing: HarnessListing) => {
      const kind = listingKindOf(listing);
      if (listingAction(kind) === 'join') {
        const link = buildHarnessJoinLink(listing);
        if (link) router.push(`/harness?join=${encodeURIComponent(link)}`);
        else router.push(`/cupboard/${listing.id}`);
        return;
      }
      // fork / install → the listing detail (act-on surface).
      router.push(`/cupboard/${listing.id}`);
    },
    [router],
  );

  return (
    <div
      style={{
        minHeight: '100%',
        padding: 24,
        background: `
          radial-gradient(circle at 12% 0%, rgba(94,106,210,0.20), transparent 32%),
          radial-gradient(circle at 92% 8%, rgba(14,165,233,0.12), transparent 28%),
          linear-gradient(180deg, #0b0e14 0%, #0d121d 46%, #0b0e14 100%)
        `,
      }}
    >
      <div style={{ maxWidth: 1180, margin: '0 auto' }}>
      {/* Header */}
      <div
        style={{
          position: 'relative',
          overflow: 'hidden',
          border: `1px solid ${COLORS.border}`,
          borderRadius: 18,
          padding: 24,
          marginBottom: 16,
          background: 'linear-gradient(135deg, rgba(17,24,39,0.96), rgba(15,20,32,0.84))',
          boxShadow: '0 24px 80px rgba(0,0,0,0.34)',
        }}
      >
        <div
          aria-hidden
          style={{
            position: 'absolute',
            inset: 0,
            background: 'linear-gradient(120deg, transparent 0%, rgba(255,255,255,0.045) 42%, transparent 68%)',
            pointerEvents: 'none',
          }}
        />
        <div style={{ position: 'relative', display: 'flex', justifyContent: 'space-between', gap: 18, flexWrap: 'wrap' }}>
          <div style={{ maxWidth: 680 }}>
            <div
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 7,
                color: '#bfdbfe',
                border: '1px solid rgba(147,197,253,0.22)',
                background: 'rgba(59,130,246,0.10)',
                borderRadius: 999,
                padding: '5px 10px',
                fontFamily: FONTS.ui,
                fontSize: 11,
                marginBottom: 12,
              }}
            >
              <Sparkles size={12} /> Distribution shelf
            </div>
            <h1 style={{ fontFamily: FONTS.ui, fontWeight: 760, fontSize: 30, lineHeight: 1.05, color: COLORS.text, margin: 0 }}>
              Cupboard
            </h1>
            <p style={{ fontFamily: FONTS.ui, fontSize: 13, lineHeight: 1.6, color: COLORS.textMuted, margin: '10px 0 0' }}>
              Discover installable harnesses, blueprints, snapshots, plugins, packs, and tools from the shared Papercusp registry.
            </p>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(92px, 1fr))', gap: 10, minWidth: 300, flex: '0 1 360px' }}>
            <MetricTile label={toolsView && !pot ? 'Mode' : 'Listings'} value={toolsView && !pot ? 'Tools' : String(pot ? potListings.length : listings.length)} />
            <MetricTile label="Facets" value={toolsView && !pot ? '1' : String(pot ? potGroups.length : facetCount)} />
            <MetricTile label="View" value={activeViewLabel} />
          </div>
        </div>
      </div>

      {/* Kind filter tabs (+ the Tools discovery view) — hidden in Pot rollup
          mode (the rollup shows all kinds, grouped) */}
      {!pot && (
        <div
          style={{
            display: 'flex',
            gap: 6,
            marginBottom: 12,
            flexWrap: 'wrap',
            padding: 6,
            border: `1px solid ${COLORS.border}`,
            borderRadius: 999,
            background: 'rgba(15,20,32,0.72)',
            width: 'fit-content',
            maxWidth: '100%',
          }}
        >
          {VIEW_FILTERS.map((k) => (
            <button
              key={k}
              onClick={() => void setKindFilter(k === 'all' ? null : k)}
              data-testid={`cupboard-kind-tab-${k}`}
              aria-pressed={kindFilter === k}
              style={filterButtonStyle(kindFilter === k)}
            >
              {k === 'tools' ? <Wrench size={11} /> : k !== 'all' ? <KindIcon kind={k} /> : null}
              {VIEW_FILTER_LABEL[k]}
            </button>
          ))}
        </div>
      )}

      {/* Pot rollup header — "this Pot and its facets together" (D-005) */}
      {pot && (
        <div
          data-testid="cupboard-pot-header"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: SIZES.sm,
            marginBottom: 12,
            flexWrap: 'wrap',
            padding: 12,
            border: `1px solid ${COLORS.border}`,
            borderRadius: RADIUS.lg,
            background: 'rgba(15,20,32,0.78)',
          }}
        >
          <button
            onClick={() => void setPot(null)}
            data-testid="cupboard-pot-back"
            style={ghostButtonStyle}
          >
            <ArrowLeft size={13} /> All listings
          </button>
          <span
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 6,
              fontFamily: FONTS.ui, fontSize: 13, color: COLORS.text,
            }}
          >
            <Package size={14} /> Pot:{' '}
            <strong style={{ fontFamily: FONTS.mono }} data-testid="cupboard-pot-name">{pot}</strong>
          </span>
        </div>
      )}

      {/* Search + claim filter bar */}
      <div
        style={{
          display: 'flex',
          gap: SIZES.sm,
          marginBottom: 16,
          flexWrap: 'wrap',
          alignItems: 'center',
          padding: 12,
          border: `1px solid ${COLORS.border}`,
          borderRadius: RADIUS.lg,
          background: 'rgba(15,20,32,0.82)',
          boxShadow: '0 14px 40px rgba(0,0,0,0.20)',
        }}
      >
        <div style={{ position: 'relative', flex: 1, minWidth: 200 }}>
          <Search
            size={14}
            style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: COLORS.textMuted }}
          />
          <input
            value={q}
            onChange={(e) => void setQ(e.target.value || null)}
            placeholder="Search the Cupboard…"
            style={{
              width: '100%',
              boxSizing: 'border-box',
              paddingLeft: 32,
              paddingRight: 10,
              paddingTop: 7,
              paddingBottom: 7,
              background: COLORS.bg,
              border: `1px solid ${COLORS.border}`,
              borderRadius: 999,
              color: COLORS.text,
              fontFamily: FONTS.ui,
              fontSize: 12,
              outline: 'none',
            }}
          />
        </div>

        {!toolsView && <div style={{ display: 'flex', gap: 4 }}>
          {(['all', 'claimed', 'unclaimed'] as ClaimFilter[]).map((f) => (
            <button
              key={f}
              onClick={() => void setClaimFilter(f)}
              style={{ ...filterButtonStyle(claimFilter === f), textTransform: 'capitalize' }}
            >
              {f}
            </button>
          ))}
        </div>}

        {!toolsView && <button
          onClick={fetchListings}
          disabled={loading}
          style={ghostButtonStyle}
          title="Refresh"
        >
          <RefreshCw size={14} style={loading ? { animation: 'spin 1s linear infinite' } : {}} />
        </button>}
      </div>

      {/* Tools discovery view (?kind=tools) — tool-level discovery with its own
          fetch/empty/error handling; the listing branches below are skipped. */}
      {toolsView && !pot ? (
        <ToolsSection q={q} onOpenListing={(id) => router.push(`/cupboard/${id}`)} />
      ) : (
        <>
      {/* Error */}
      {error && !loading && (
        <div
          style={{
            color: '#fca5a5',
            fontSize: 12,
            marginBottom: SIZES.md,
            padding: 12,
            border: '1px solid rgba(239,68,68,0.24)',
            borderRadius: RADIUS.lg,
            background: 'rgba(127,29,29,0.16)',
          }}
        >
          {error === 'HTTP 503' || error.includes('fetch')
            ? 'Cupboard server unreachable. Is PAPERCUSP_CUPBOARD_URL configured?'
            : error}
        </div>
      )}

      {/* Results — empty state (kind-aware in flat mode, Pot-aware in rollup mode) */}
      {!loading && !error && (pot ? potGroups.length === 0 : listings.length === 0) && (
        <div
          style={{
            color: COLORS.textMuted,
            fontSize: 12,
            textAlign: 'center',
            padding: '44px 18px',
            border: `1px dashed ${COLORS.borderStrong}`,
            borderRadius: RADIUS.lg,
            background: 'rgba(15,20,32,0.48)',
          }}
        >
          {pot
            ? `No listings found for Pot "${pot}"${q ? ` matching "${q}"` : ''}.`
            : `No ${kindFilter === 'all' ? 'listings' : VIEW_FILTER_LABEL[kindFilter].toLowerCase()} found${q ? ` matching "${q}"` : ''}.`}
        </div>
      )}

      {pot ? (
        /* Pot rollup — the Pot's facets grouped by kind (D-005) */
        <div data-testid="cupboard-pot-rollup">
          {potGroups.map((group) => (
            <section
              key={group.kind}
              data-testid={`cupboard-pot-group-${group.kind}`}
              style={{ marginBottom: SIZES.lg }}
            >
              <h2
                style={{
                  display: 'flex', alignItems: 'center', gap: 6,
                  fontFamily: FONTS.ui, fontWeight: 600, fontSize: 14, color: COLORS.text,
                  margin: `0 0 ${SIZES.sm}`,
                }}
              >
                <KindIcon kind={group.kind} size={13} />
                {VIEW_FILTER_LABEL[group.kind]}
                <span style={{ color: COLORS.textMuted, fontWeight: 400, fontSize: 12 }}>
                  {group.listings.length}
                </span>
              </h2>
              <div style={gridStyle}>
                {group.listings.map((listing) => (
                  <ListingCard
                    key={listing.id}
                    listing={listing}
                    onAction={() => handleAction(listing)}
                    onDetail={() => router.push(`/cupboard/${listing.id}`)}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
      ) : (
        /* Flat browse — each card links to its Pot via the Pot chip */
        <div style={gridStyle}>
          {listings.map((listing) => (
            <ListingCard
              key={listing.id}
              listing={listing}
              potRef={listingPotRef(listing)}
              onPot={() => void setPot(listingPotRef(listing))}
              onAction={() => handleAction(listing)}
              onDetail={() => router.push(`/cupboard/${listing.id}`)}
            />
          ))}
        </div>
      )}
        </>
      )}
      </div>
    </div>
  );
}

// ─── ListingCard ─────────────────────────────────────────────────

export function ListingCard({
  listing,
  onAction,
  onDetail,
  potRef,
  onPot,
}: {
  listing: HarnessListing;
  onAction: () => void;
  onDetail: () => void;
  /** The Pot (project) this listing belongs to. When set with `onPot`, renders
   *  a clickable chip that enters the per-Pot rollup. Omit in rollup mode. */
  potRef?: string;
  onPot?: () => void;
}) {
  const kind = listingKindOf(listing);
  const repoSlug = listingRepoSlug(listing);
  const contributors = listingContributorCount(listing);
  const language = listingTopLanguage(listing);
  const tone = KIND_TONES[kind];
  return (
    <div
      style={{
        position: 'relative',
        overflow: 'hidden',
        background: 'linear-gradient(180deg, rgba(17,24,39,0.96), rgba(15,20,32,0.92))',
        border: `1px solid ${COLORS.border}`,
        borderRadius: 14,
        padding: 15,
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        cursor: 'default',
        minHeight: 208,
        boxShadow: '0 18px 42px rgba(0,0,0,0.22)',
      }}
    >
      <div
        aria-hidden
        style={{
          position: 'absolute',
          inset: '0 0 auto',
          height: 3,
          background: `linear-gradient(90deg, ${tone.fg}, transparent)`,
          opacity: 0.86,
        }}
      />
      {/* Title + kind + claim badge */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }}>
        <button
          onClick={onDetail}
          style={{
            background: 'none',
            border: 'none',
            padding: 0,
            cursor: 'pointer',
            fontFamily: FONTS.ui,
            fontWeight: 600,
            fontSize: 15,
            lineHeight: 1.3,
            color: COLORS.text,
            textAlign: 'left',
          }}
        >
          {listing.title || listing.slug || repoSlug || 'Untitled'}
        </button>
        <span style={{ flexShrink: 0, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <KindBadge kind={kind} />
          <ClaimStatusBadge status={listing.claim_status} />
        </span>
      </div>

      {/* Description */}
      {listing.description && (
        <p
          style={{
            fontFamily: FONTS.ui,
            fontSize: 12,
            lineHeight: 1.5,
            color: COLORS.textMuted,
            margin: 0,
            display: '-webkit-box',
            WebkitLineClamp: 2,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
          }}
        >
          {listing.description}
        </p>
      )}

      {/* Tier-A stats (P-076) */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {contributors > 0 && (
          <Stat icon={<Users size={11} />} label={`${contributors} contributors`} />
        )}
        {listing.last_activity_at != null && (
          <Stat
            icon={<Clock size={11} />}
            label={formatRelativeTime(listing.last_activity_at)}
          />
        )}
        {language && (
          <Stat icon={<GitBranch size={11} />} label={language} />
        )}
      </div>

      <PublisherSignal permission={listing.publisher_permission} />

      {/* Pot chip — enters the per-Pot rollup (D-005). Hidden when ungroupable
          (no project identity) or in rollup mode (no onPot passed). */}
      {potRef && onPot && (
        <button
          onClick={onPot}
          data-testid="cupboard-pot-chip"
          data-pot={potRef}
          title={`View all of ${potRef}'s listings`}
          style={{
            alignSelf: 'flex-start',
            display: 'inline-flex', alignItems: 'center', gap: 4,
            background: 'rgba(17,24,39,0.82)',
            border: `1px solid ${COLORS.border}`,
            borderRadius: 999,
            padding: '3px 8px',
            cursor: 'pointer',
            fontSize: 10,
            fontFamily: FONTS.mono,
            color: COLORS.textMuted,
          }}
        >
          <Package size={10} /> {potRef}
        </button>
      )}

      {/* Footer — per-kind action */}
      <div style={{ display: 'flex', gap: 8, marginTop: 'auto', paddingTop: 4 }}>
        <button
          onClick={onAction}
          data-testid="cupboard-action"
          data-action={listingAction(kind)}
          style={{
            flex: 1,
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
            background: `linear-gradient(135deg, ${COLORS.accent}, ${COLORS.accentHover})`,
            color: '#fff',
            border: '1px solid rgba(255,255,255,0.16)',
            borderRadius: 999,
            padding: '8px 0',
            cursor: 'pointer',
            fontFamily: FONTS.ui,
            fontSize: 12,
            boxShadow: '0 12px 24px rgba(94,106,210,0.22)',
          }}
        >
          <ActionIcon kind={kind} /> {LISTING_ACTION_LABEL[listingAction(kind)]}
        </button>
        {repoSlug && (
          <a
            href={`https://github.com/${repoSlug}`}
            target="_blank"
            rel="noopener noreferrer"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: '8px 11px',
              background: 'rgba(17,24,39,0.82)',
              border: `1px solid ${COLORS.border}`,
              borderRadius: 999,
              color: COLORS.textMuted,
            }}
            title={`github.com/${repoSlug}`}
          >
            <ExternalLink size={13} />
          </a>
        )}
      </div>
    </div>
  );
}

/** Small kind tag on a card. */
function KindBadge({ kind }: { kind: ListingKind }) {
  const tone = KIND_TONES[kind];
  return (
    <span
      data-testid="cupboard-kind-badge"
      data-kind={kind}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 3,
        background: tone.bg,
        border: `1px solid ${tone.border}`,
        borderRadius: 999,
        padding: '3px 8px',
        fontSize: 10,
        fontFamily: FONTS.ui,
        color: tone.fg,
        textTransform: 'capitalize',
      }}
    >
      <KindIcon kind={kind} size={10} /> {kind}
    </span>
  );
}

function Stat({ icon, label }: { icon: React.ReactNode; label: string }) {
  return (
    <div
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        color: COLORS.textMuted,
        fontSize: 11,
        fontFamily: FONTS.ui,
        border: `1px solid ${COLORS.border}`,
        background: 'rgba(11,14,20,0.34)',
        borderRadius: 999,
        padding: '3px 7px',
      }}
    >
      {icon}
      {label}
    </div>
  );
}

function MetricTile({ label, value }: { label: string; value: string }) {
  return (
    <div
      style={{
        minWidth: 0,
        border: `1px solid ${COLORS.border}`,
        borderRadius: RADIUS.lg,
        padding: '11px 12px',
        background: 'rgba(11,14,20,0.52)',
      }}
    >
      <div style={{ fontFamily: FONTS.ui, fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase', color: COLORS.textDim }}>
        {label}
      </div>
      <div style={{ marginTop: 4, fontFamily: FONTS.ui, fontSize: 15, fontWeight: 700, color: COLORS.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {value}
      </div>
    </div>
  );
}

/** GitHub repo permission levels that mean the publisher is an actual
 *  collaborator on the bound repo (not just a public-repo reader). */
const PUBLISHER_COLLAB_ROLES = new Set(['admin', 'maintain', 'write', 'triage']);

/**
 * Trust signal: was this listing published by an actual repo collaborator,
 * or by some GitHub user who merely can read a public repo? Provisional
 * (unclaimed) listings are NOT ownership claims (see the
 * cupboard-provisional-listing-trust memo), so the unverified case is
 * flagged rather than hidden. `null`/undefined permission (legacy rows
 * predating Cupboard migration 002) renders nothing.
 */
function PublisherSignal({ permission }: { permission?: string | null }) {
  if (permission == null) return null;
  const isCollaborator = PUBLISHER_COLLAB_ROLES.has(permission);
  return (
    <div
      data-testid="cupboard-publisher-signal"
      data-collaborator={isCollaborator ? 'true' : 'false'}
      title={
        isCollaborator
          ? `Published by a repo collaborator (${permission} access).`
          : 'Published by someone who is not a collaborator on this repo. A provisional listing is not an ownership claim.'
      }
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        alignSelf: 'flex-start',
        fontSize: 11,
        fontFamily: FONTS.ui,
        color: isCollaborator ? COLORS.successText : '#fbbf24',
        border: `1px solid ${isCollaborator ? 'rgba(16,185,129,0.22)' : 'rgba(245,158,11,0.24)'}`,
        background: isCollaborator ? 'rgba(16,185,129,0.10)' : 'rgba(245,158,11,0.10)',
        borderRadius: 999,
        padding: '3px 8px',
      }}
    >
      {isCollaborator ? (
        <>
          <ShieldCheck size={11} /> publisher: collaborator
        </>
      ) : (
        <>
          <AlertTriangle size={11} /> publisher: not a collaborator
        </>
      )}
    </div>
  );
}

function formatRelativeTime(epochMs: number): string {
  const diff = Date.now() - epochMs;
  const days = Math.floor(diff / 86400000);
  if (days === 0) return 'active today';
  if (days === 1) return '1 day ago';
  if (days < 30) return `${days} days ago`;
  const months = Math.floor(days / 30);
  if (months === 1) return '1 month ago';
  return `${months} months ago`;
}
