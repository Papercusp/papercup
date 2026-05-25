'use client';

/**
 * Cupboard harness detail view — Phase 9 P-052d.
 *
 * Shows full metadata + claimed/unclaimed status + install CTA.
 */

import React, { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import {
  Shield, ExternalLink, Users, Clock, GitBranch,
  ArrowLeft, Loader2, AlertTriangle,
} from 'lucide-react';
import type { HarnessListing } from '@/lib/cupboard/types';
import { COLORS, FONTS, RADIUS, SIZES } from '../../harness/theme';

export default function CupboardDetailPage() {
  const params = useParams();
  const router = useRouter();
  const id = params?.id as string;
  const [listing, setListing] = useState<HarnessListing | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    setLoading(true);
    fetch(`/api/cupboard/listings/${id}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((data: { listing: HarnessListing }) => { setListing(data.listing); })
      .catch((err: unknown) => { setError(String(err)); })
      .finally(() => setLoading(false));
  }, [id]);

  const handleInstall = () => {
    if (!listing) return;
    router.push(`/harness?join=${encodeURIComponent(listing.harness_link)}`);
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
          {error ?? 'Harness not found.'}
        </div>
      </div>
    );
  }

  return (
    <div style={{ padding: SIZES.lg, maxWidth: 700, margin: '0 auto' }}>
      <button onClick={() => router.back()} style={backBtnStyle}>
        <ArrowLeft size={13} /> Back to Cupboard
      </button>

      <div style={{ marginTop: SIZES.lg }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
          <h1 style={{ fontFamily: FONTS.ui, fontWeight: 700, fontSize: 20, color: COLORS.text, margin: 0 }}>
            {listing.title || listing.slug}
          </h1>
          {listing.claim_status === 'claimed' && (
            <span style={{
              display: 'inline-flex', alignItems: 'center', gap: 4,
              background: 'rgba(16,185,129,0.12)', color: '#6ee7b7',
              borderRadius: RADIUS.sm, padding: '3px 9px',
              fontSize: SIZES.sm, fontFamily: FONTS.ui, flexShrink: 0,
            }}>
              <Shield size={12} /> Claimed
            </span>
          )}
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
          <MetaRow label="GitHub repo">
            <a
              href={`https://github.com/${listing.github_repo}`}
              target="_blank" rel="noopener noreferrer"
              style={{ color: COLORS.accent, fontFamily: FONTS.mono, fontSize: SIZES.sm, display: 'inline-flex', alignItems: 'center', gap: 4 }}
            >
              {listing.github_repo} <ExternalLink size={11} />
            </a>
          </MetaRow>
          <MetaRow label="Claim status">
            <span style={{ fontFamily: FONTS.ui, fontSize: SIZES.sm, color: COLORS.text, textTransform: 'capitalize' }}>
              {listing.claim_status}
            </span>
          </MetaRow>
          {listing.contributor_count_estimate > 0 && (
            <MetaRow label="Contributors">
              <span style={valueStyle}><Users size={12} /> {listing.contributor_count_estimate}</span>
            </MetaRow>
          )}
          {listing.last_activity_at && (
            <MetaRow label="Last activity">
              <span style={valueStyle}><Clock size={12} /> {new Date(listing.last_activity_at).toLocaleDateString()}</span>
            </MetaRow>
          )}
          {listing.language && (
            <MetaRow label="Language">
              <span style={valueStyle}><GitBranch size={12} /> {listing.language}</span>
            </MetaRow>
          )}
          {listing.tags.length > 0 && (
            <MetaRow label="Tags">
              <span style={valueStyle}>{listing.tags.join(', ')}</span>
            </MetaRow>
          )}
        </div>

        {/* Install CTA */}
        <div style={{ marginTop: SIZES.lg, display: 'flex', gap: 8 }}>
          <button
            onClick={handleInstall}
            style={{
              background: COLORS.accent, color: '#fff', border: 'none',
              borderRadius: RADIUS.md, padding: '9px 20px', cursor: 'pointer',
              fontFamily: FONTS.ui, fontSize: SIZES.sm, fontWeight: 600,
            }}
          >
            Install this harness
          </button>
          <a
            href={`https://github.com/${listing.github_repo}`}
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
        </div>

        {listing.claim_status === 'unclaimed' && (
          <p style={{ fontFamily: FONTS.ui, fontSize: 12, color: COLORS.textMuted, marginTop: SIZES.sm }}>
            This harness is unclaimed. If you are the maintainer, you can claim it from the harness settings after installing.
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
