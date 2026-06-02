'use client';

/**
 * CupboardClient — Phase 9 P-052.
 *
 * Card grid for the Cupboard harness registry.
 * Fetches from ${NEXT_PUBLIC_CUPBOARD_URL}/api/harnesses (or the
 * operator's /api/cupboard/listings proxy when the env is unset).
 *
 * P-052a: navbar item + /cupboard route (done via Next.js routing).
 * P-052b: card grid with tier-A stats (contributor count, last-activity, languages).
 * P-052c: search + filter by claimed/unclaimed.
 * P-052d: detail view is in ./[id]/page.tsx.
 * P-052e: "Install this harness" triggers Phase 1b P-009 Entry 4 flow.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from '@/lib/router-compat/navigation';
import { useQueryState, parseAsString } from 'nuqs';
import { Search, Globe, RefreshCw, ExternalLink, GitBranch, Users, Clock, ShieldCheck, AlertTriangle } from 'lucide-react';
import type { HarnessListing } from '@/lib/cupboard/types';
import { isPubliclyVisible } from '@/lib/cupboard/types';
import { COLORS, FONTS, RADIUS, SIZES } from '../harness/theme';
import { ClaimStatusBadge } from '../_components/ClaimStatusBadge';

type ClaimFilter = 'all' | 'claimed' | 'unclaimed';

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
  }, [q, claimFilter]);

  useEffect(() => {
    void fetchListings();
  }, [fetchListings]);

  const handleInstall = useCallback(
    (listing: HarnessListing) => {
      // Encode the harness_link and navigate to the join flow.
      const encoded = encodeURIComponent(listing.harness_link);
      router.push(`/harness?join=${encoded}`);
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
          Discover and join shared Papercusp harnesses.
        </p>
      </div>

      {/* Search + filter bar */}
      <div style={{ display: 'flex', gap: SIZES.sm, marginBottom: SIZES.lg, flexWrap: 'wrap' }}>
        <div style={{ position: 'relative', flex: 1, minWidth: 200 }}>
          <Search
            size={14}
            style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: COLORS.textMuted }}
          />
          <input
            value={q}
            onChange={(e) => void setQ(e.target.value || null)}
            placeholder="Search harnesses…"
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

        <div style={{ display: 'flex', gap: 4 }}>
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
        </div>

        <button
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
        </button>
      </div>

      {/* Error */}
      {error && !loading && (
        <div style={{ color: '#f87171', fontSize: 12, marginBottom: SIZES.md }}>
          {error === 'HTTP 503' || error.includes('fetch')
            ? 'Cupboard server unreachable. Is NEXT_PUBLIC_CUPBOARD_URL configured?'
            : error}
        </div>
      )}

      {/* Card grid */}
      {!loading && !error && listings.length === 0 && (
        <div style={{ color: COLORS.textMuted, fontSize: 12, textAlign: 'center', paddingTop: 40 }}>
          No harnesses found{q ? ` matching "${q}"` : ''}.
        </div>
      )}

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))',
          gap: SIZES.md,
        }}
      >
        {listings.map((listing) => (
          <HarnessCard
            key={listing.id}
            listing={listing}
            onInstall={() => handleInstall(listing)}
            onDetail={() => router.push(`/cupboard/${listing.id}`)}
          />
        ))}
      </div>
    </div>
  );
}

// ─── HarnessCard ─────────────────────────────────────────────────

export function HarnessCard({
  listing,
  onInstall,
  onDetail,
}: {
  listing: HarnessListing;
  onInstall: () => void;
  onDetail: () => void;
}) {
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
      {/* Title + claim badge */}
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
          {listing.title || listing.slug}
        </button>
        {/* Claim badge — canonical ClaimStatusBadge for ALL states so an
            `unclaimed` (provisional) listing surfaces a tag too, not just
            claimed ones. Provisional listings are exactly the ones a viewer
            most needs flagged; previously they rendered unlabeled. The
            `HarnessListing` wire shape carries no claimant login, so a
            claimed listing shows the bare "Claimed" label. */}
        <span style={{ flexShrink: 0 }}>
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
        {listing.contributor_count_estimate > 0 && (
          <Stat icon={<Users size={11} />} label={`${listing.contributor_count_estimate} contributors`} />
        )}
        {listing.last_activity_at != null && (
          <Stat
            icon={<Clock size={11} />}
            label={formatRelativeTime(listing.last_activity_at)}
          />
        )}
        {listing.language && (
          <Stat icon={<GitBranch size={11} />} label={listing.language} />
        )}
      </div>

      <PublisherSignal permission={listing.publisher_permission} />

      {/* Footer */}
      <div style={{ display: 'flex', gap: 6, marginTop: 'auto', paddingTop: 4 }}>
        <button
          onClick={onInstall}
          style={{
            flex: 1,
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
          Install
        </button>
        <a
          href={`https://github.com/${listing.github_repo}`}
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
          title={`github.com/${listing.github_repo}`}
        >
          <ExternalLink size={13} />
        </a>
      </div>
    </div>
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
