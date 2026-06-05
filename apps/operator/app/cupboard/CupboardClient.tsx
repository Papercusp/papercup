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
import { Search, Globe, RefreshCw, ExternalLink, GitBranch, Users, Clock, ShieldCheck, AlertTriangle, GitFork, Plug, Boxes, LogIn, Camera, Package, ArrowLeft, Box, Wrench } from 'lucide-react';
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
  harness: 'Pots',
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

  const gridStyle: React.CSSProperties = {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))',
    gap: SIZES.md,
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
    <div style={{ padding: SIZES.lg, maxWidth: 1100, margin: '0 auto' }}>
      {/* Header */}
      <div style={{ marginBottom: SIZES.lg }}>
        <h1 style={{ fontFamily: FONTS.ui, fontWeight: 700, fontSize: 22, color: COLORS.text, margin: 0 }}>
          <Globe size={18} style={{ verticalAlign: 'middle', marginRight: 8 }} />
          Cupboard
        </h1>
        <p style={{ fontFamily: FONTS.ui, fontSize: 12, color: COLORS.textMuted, marginTop: 4 }}>
          Discover and install shared harnesses, blueprints, snapshots, plugins, packs, and tools.
        </p>
      </div>

      {/* Kind filter tabs (+ the Tools discovery view) — hidden in Pot rollup
          mode (the rollup shows all kinds, grouped) */}
      {!pot && (
        <div style={{ display: 'flex', gap: 4, marginBottom: SIZES.md, flexWrap: 'wrap' }}>
          {VIEW_FILTERS.map((k) => (
            <button
              key={k}
              onClick={() => void setKindFilter(k === 'all' ? null : k)}
              data-testid={`cupboard-kind-tab-${k}`}
              aria-pressed={kindFilter === k}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 5,
                background: kindFilter === k ? COLORS.accent : COLORS.surface,
                color: kindFilter === k ? '#fff' : COLORS.textMuted,
                border: `1px solid ${kindFilter === k ? COLORS.accent : COLORS.border}`,
                borderRadius: RADIUS.md,
                padding: '6px 12px',
                cursor: 'pointer',
                fontSize: 12,
                fontFamily: FONTS.ui,
              }}
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
          style={{ display: 'flex', alignItems: 'center', gap: SIZES.sm, marginBottom: SIZES.md, flexWrap: 'wrap' }}
        >
          <button
            onClick={() => void setPot(null)}
            data-testid="cupboard-pot-back"
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 5,
              background: COLORS.surface,
              color: COLORS.textMuted,
              border: `1px solid ${COLORS.border}`,
              borderRadius: RADIUS.md,
              padding: '6px 12px',
              cursor: 'pointer',
              fontSize: 12,
              fontFamily: FONTS.ui,
            }}
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
      <div style={{ display: 'flex', gap: SIZES.sm, marginBottom: SIZES.lg, flexWrap: 'wrap' }}>
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
              background: COLORS.surface,
              border: `1px solid ${COLORS.border}`,
              borderRadius: RADIUS.md,
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
              style={{
                background: claimFilter === f ? COLORS.accent : COLORS.surface,
                color: claimFilter === f ? '#fff' : COLORS.textMuted,
                border: `1px solid ${claimFilter === f ? COLORS.accent : COLORS.border}`,
                borderRadius: RADIUS.md,
                padding: '6px 12px',
                cursor: 'pointer',
                fontSize: 12,
                fontFamily: FONTS.ui,
                textTransform: 'capitalize',
              }}
            >
              {f}
            </button>
          ))}
        </div>}

        {!toolsView && <button
          onClick={fetchListings}
          disabled={loading}
          style={{
            background: 'none',
            border: `1px solid ${COLORS.border}`,
            borderRadius: RADIUS.md,
            padding: '6px 10px',
            cursor: 'pointer',
            color: COLORS.textMuted,
          }}
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
        <div style={{ color: '#f87171', fontSize: 12, marginBottom: SIZES.md }}>
          {error === 'HTTP 503' || error.includes('fetch')
            ? 'Cupboard server unreachable. Is PAPERCUSP_CUPBOARD_URL configured?'
            : error}
        </div>
      )}

      {/* Results — empty state (kind-aware in flat mode, Pot-aware in rollup mode) */}
      {!loading && !error && (pot ? potGroups.length === 0 : listings.length === 0) && (
        <div style={{ color: COLORS.textMuted, fontSize: 12, textAlign: 'center', paddingTop: 40 }}>
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
                  margin: `0 0 ${SIZES.sm}px`,
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
  return (
    <div
      style={{
        background: COLORS.surface,
        border: `1px solid ${COLORS.border}`,
        borderRadius: RADIUS.lg,
        padding: SIZES.md,
        display: 'flex',
        flexDirection: 'column',
        gap: SIZES.sm,
        cursor: 'default',
      }}
    >
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
            fontSize: 14,
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
      <div style={{ display: 'flex', gap: SIZES.md, flexWrap: 'wrap' }}>
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
            background: COLORS.surfaceRaised,
            border: `1px solid ${COLORS.border}`,
            borderRadius: RADIUS.sm,
            padding: '2px 7px',
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
      <div style={{ display: 'flex', gap: 6, marginTop: 'auto', paddingTop: 4 }}>
        <button
          onClick={onAction}
          data-testid="cupboard-action"
          data-action={listingAction(kind)}
          style={{
            flex: 1,
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
            background: COLORS.accent,
            color: '#fff',
            border: 'none',
            borderRadius: RADIUS.md,
            padding: '6px 0',
            cursor: 'pointer',
            fontFamily: FONTS.ui,
            fontSize: 12,
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
              padding: '6px 10px',
              background: COLORS.surfaceRaised,
              border: `1px solid ${COLORS.border}`,
              borderRadius: RADIUS.md,
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
  return (
    <span
      data-testid="cupboard-kind-badge"
      data-kind={kind}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 3,
        background: COLORS.surfaceRaised,
        border: `1px solid ${COLORS.border}`,
        borderRadius: RADIUS.sm,
        padding: '2px 7px',
        fontSize: 10,
        fontFamily: FONTS.ui,
        color: COLORS.textMuted,
        textTransform: 'capitalize',
      }}
    >
      <KindIcon kind={kind} size={10} /> {kind}
    </span>
  );
}

function Stat({ icon, label }: { icon: React.ReactNode; label: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4, color: COLORS.textMuted, fontSize: 11, fontFamily: FONTS.ui }}>
      {icon}
      {label}
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
        fontSize: 11,
        fontFamily: FONTS.ui,
        color: isCollaborator ? COLORS.textMuted : '#fbbf24',
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
