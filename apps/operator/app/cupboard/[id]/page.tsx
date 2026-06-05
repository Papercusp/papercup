'use client';

/**
 * Cupboard listing detail view.
 *
 * Shows full metadata + claim status + the per-kind primary action
 * (Join / Fork / Install — D-005). Renders against either the live-worker row
 * shape or the aspirational HarnessListing shape via the cupboard/types helpers.
 *
 * The fork/install EXECUTION engine (pull blueprint/snapshot + `init --from`;
 * pull plugin code + install-consent) is owned by E1/E2 + the plugin host — the
 * storefront surfaces the listing and routes to the harness create/manage flow
 * with the listing referenced.
 */

import React, { useEffect, useState } from 'react';
import { useParams, useRouter } from '@/lib/router-compat/navigation';
import {
  Shield, ExternalLink, Users, Clock, GitBranch,
  ArrowLeft, Loader2, AlertTriangle, GitFork, Plug, LogIn,
} from 'lucide-react';
import type { HarnessListing, ListingKind } from '@papercusp/operator-core/lib/cupboard/types';
import {
  listingAction,
  listingKindOf,
  listingRepoSlug,
  listingContributorCount,
  listingTopLanguage,
  buildHarnessJoinLink,
  LISTING_ACTION_LABEL,
} from '@papercusp/operator-core/lib/cupboard/types';
import { COLORS, FONTS, RADIUS, SIZES } from '../../harness/theme';
import { toast } from 'sonner';

function ActionIcon({ kind, size = 14 }: { kind: ListingKind; size?: number }) {
  switch (listingAction(kind)) {
    case 'join': return <LogIn size={size} />;
    case 'fork': return <GitFork size={size} />;
    case 'install': return <Plug size={size} />;
  }
}

export default function CupboardDetailPage() {
  const params = useParams();
  const router = useRouter();
  const id = params?.id as string;
  const [listing, setListing] = useState<HarnessListing | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [forking, setForking] = useState(false);

  useEffect(() => {
    if (!id) return;
    setLoading(true);
    fetch(`/api/cupboard/listings/${id}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((data: { listing: HarnessListing }) => { setListing(data.listing); })
      .catch((err: unknown) => { setError(String(err)); })
      .finally(() => setLoading(false));
  }, [id]);

  const handleAction = () => {
    if (!listing) return;
    const kind = listingKindOf(listing);
    if (listingAction(kind) === 'join') {
      const link = buildHarnessJoinLink(listing);
      if (link) router.push(`/harness?join=${encodeURIComponent(link)}`);
      return;
    }
    // Snapshot fork is CROSS-MACHINE (revive-cupboard D-008): pull the tarball
    // from the Cupboard R2 blob store, verify the sha256, and restore() into a
    // new local harness. Blueprint fork + plugin install hand off to the
    // E1/E2 `init --from` / plugin-host install-consent create flow.
    if (kind === 'snapshot') {
      void forkSnapshotFromCupboard();
      return;
    }
    router.push(`/harness?cupboardListing=${encodeURIComponent(listing.id)}&action=${listingAction(kind)}`);
  };

  const forkSnapshotFromCupboard = async () => {
    if (!listing || forking) return;
    setForking(true);
    try {
      const r = await fetch('/api/snapshots/fork-from-cupboard', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ listing_id: listing.id }),
      });
      const d = (await r.json().catch(() => ({}))) as { ok?: boolean; newSlug?: string; error?: string; hint?: string };
      if (!r.ok || !d.ok) {
        toast.error(`Fork failed: ${d.error ?? `HTTP ${r.status}`}${d.hint ? ` — ${d.hint}` : ''}`);
        return;
      }
      toast.success(`Forked snapshot → ${d.newSlug}`);
      router.push(`/harness/${encodeURIComponent(d.newSlug ?? '')}`);
    } catch (e) {
      toast.error(`Fork crashed: ${(e as Error)?.message ?? String(e)}`);
    } finally {
      setForking(false);
    }
  };

  if (loading) {
    return (
      <div style={{ padding: SIZES.lg, display: 'flex', alignItems: 'center', gap: 8, color: COLORS.textMuted }}>
        <Loader2 size={16} style={{ animation: 'spin 1s linear infinite' }} /> Loading…
      </div>
    );
  }

  if (error || !listing) {
    return (
      <div style={{ padding: SIZES.lg }}>
        <button onClick={() => router.back()} style={backBtnStyle}>
          <ArrowLeft size={13} /> Back
        </button>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: '#f87171', marginTop: SIZES.md }}>
          <AlertTriangle size={14} />
          {error ?? 'Listing not found.'}
        </div>
      </div>
    );
  }

  const kind = listingKindOf(listing);
  const repoSlug = listingRepoSlug(listing);
  const contributors = listingContributorCount(listing);
  const language = listingTopLanguage(listing);
  const action = listingAction(kind);

  return (
    <div style={{ padding: SIZES.lg, maxWidth: 700, margin: '0 auto' }}>
      <button onClick={() => router.back()} style={backBtnStyle}>
        <ArrowLeft size={13} /> Back to Cupboard
      </button>

      <div style={{ marginTop: SIZES.lg }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
          <h1 style={{ fontFamily: FONTS.ui, fontWeight: 700, fontSize: 20, color: COLORS.text, margin: 0 }}>
            {listing.title || listing.slug || repoSlug || 'Untitled'}
          </h1>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
            <span style={{
              display: 'inline-flex', alignItems: 'center', gap: 4,
              background: COLORS.surfaceRaised, border: `1px solid ${COLORS.border}`,
              borderRadius: RADIUS.sm, padding: '3px 9px',
              fontSize: SIZES.sm, fontFamily: FONTS.ui, color: COLORS.textMuted, textTransform: 'capitalize',
            }} data-testid="cupboard-detail-kind" data-kind={kind}>
              <ActionIcon kind={kind} size={12} /> {kind}
            </span>
            {listing.claim_status === 'claimed' && (
              <span style={{
                display: 'inline-flex', alignItems: 'center', gap: 4,
                background: 'rgba(16,185,129,0.12)', color: '#6ee7b7',
                borderRadius: RADIUS.sm, padding: '3px 9px',
                fontSize: SIZES.sm, fontFamily: FONTS.ui,
              }}>
                <Shield size={12} /> Claimed
              </span>
            )}
          </span>
        </div>

        {/* Description */}
        <p style={{ fontFamily: FONTS.ui, fontSize: SIZES.sm, color: COLORS.textMuted, marginTop: 8 }}>
          {listing.description || 'No description.'}
        </p>

        {/* Metadata grid */}
        <div style={{
          display: 'grid', gridTemplateColumns: '1fr 1fr', gap: SIZES.sm,
          background: COLORS.surface, border: `1px solid ${COLORS.border}`,
          borderRadius: RADIUS.lg, padding: SIZES.md, marginTop: SIZES.md,
        }}>
          {repoSlug && (
            <MetaRow label="GitHub repo">
              <a
                href={`https://github.com/${repoSlug}`}
                target="_blank" rel="noopener noreferrer"
                style={{ color: COLORS.accent, fontFamily: FONTS.mono, fontSize: SIZES.sm, display: 'inline-flex', alignItems: 'center', gap: 4 }}
              >
                {repoSlug} <ExternalLink size={11} />
              </a>
            </MetaRow>
          )}
          {listing.listing_ref && (
            <MetaRow label={kind === 'plugin' ? 'Plugin' : 'Listing'}>
              <span style={{ fontFamily: FONTS.mono, fontSize: SIZES.sm, color: COLORS.text }}>{listing.listing_ref}</span>
            </MetaRow>
          )}
          {listing.project_ref && (
            <MetaRow label="Project">
              <span style={{ fontFamily: FONTS.mono, fontSize: SIZES.sm, color: COLORS.text }}>{listing.project_ref}</span>
            </MetaRow>
          )}
          <MetaRow label="Claim status">
            <span style={{ fontFamily: FONTS.ui, fontSize: SIZES.sm, color: COLORS.text, textTransform: 'capitalize' }}>
              {listing.claim_status}
            </span>
          </MetaRow>
          {contributors > 0 && (
            <MetaRow label="Contributors">
              <span style={valueStyle}><Users size={12} /> {contributors}</span>
            </MetaRow>
          )}
          {listing.last_activity_at && (
            <MetaRow label="Last activity">
              <span style={valueStyle}><Clock size={12} /> {new Date(listing.last_activity_at).toLocaleDateString()}</span>
            </MetaRow>
          )}
          {language && (
            <MetaRow label="Language">
              <span style={valueStyle}><GitBranch size={12} /> {language}</span>
            </MetaRow>
          )}
          {listing.tags && listing.tags.length > 0 && (
            <MetaRow label="Tags">
              <span style={valueStyle}>{listing.tags.join(', ')}</span>
            </MetaRow>
          )}
        </div>

        {/* Per-kind primary CTA */}
        <div style={{ marginTop: SIZES.lg, display: 'flex', gap: 8 }}>
          <button
            onClick={handleAction}
            disabled={forking}
            data-testid="cupboard-detail-action"
            data-action={action}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 7,
              background: COLORS.accent, color: '#fff', border: 'none',
              borderRadius: RADIUS.md, padding: '9px 20px',
              cursor: forking ? 'default' : 'pointer',
              opacity: forking ? 0.7 : 1,
              fontFamily: FONTS.ui, fontSize: SIZES.sm, fontWeight: 600,
            }}
          >
            {forking ? (
              <><Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> Forking snapshot…</>
            ) : (
              <><ActionIcon kind={kind} /> {LISTING_ACTION_LABEL[action]}{action === 'install' ? ' plugin' : action === 'fork' ? ` ${kind}` : ' harness'}</>
            )}
          </button>
          {repoSlug && (
            <a
              href={`https://github.com/${repoSlug}`}
              target="_blank" rel="noopener noreferrer"
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 6,
                background: COLORS.surface, border: `1px solid ${COLORS.border}`,
                borderRadius: RADIUS.md, padding: '9px 14px', color: COLORS.textMuted,
                fontFamily: FONTS.ui, fontSize: SIZES.sm, textDecoration: 'none',
              }}
            >
              <ExternalLink size={13} /> View on GitHub
            </a>
          )}
        </div>

        {/* Trust note for code-pulling kinds (D-007/D-009). */}
        {action !== 'join' && (
          <p style={{ fontFamily: FONTS.ui, fontSize: 12, color: COLORS.textMuted, marginTop: SIZES.sm }}>
            {action === 'fork' ? 'Forking' : 'Installing'} pulls code from this listing. Plugin capabilities are gated by manifest + your install-time consent; review the source on GitHub first.
          </p>
        )}

        {listing.claim_status === 'unclaimed' && kind === 'harness' && (
          <p style={{ fontFamily: FONTS.ui, fontSize: 12, color: COLORS.textMuted, marginTop: SIZES.sm }}>
            This harness is unclaimed. If you are the maintainer, you can claim it from the harness settings after joining.
          </p>
        )}
      </div>
    </div>
  );
}

function MetaRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div style={{ fontFamily: FONTS.ui, fontSize: 11, color: COLORS.textMuted, marginBottom: 2, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
        {label}
      </div>
      {children}
    </div>
  );
}

const valueStyle: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 4,
  fontFamily: FONTS.ui, fontSize: SIZES.sm, color: COLORS.text,
};

const backBtnStyle: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 5,
  background: 'none', border: 'none', cursor: 'pointer',
  color: COLORS.textMuted, fontFamily: FONTS.ui, fontSize: SIZES.sm, padding: 0,
};
